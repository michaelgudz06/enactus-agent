// Does the rubric in src/lib/score.ts actually rank past sponsors highly?
//
//   node --experimental-strip-types scripts/backtest-score.ts <rows.json>
//
// The data file is NOT in this repository and must never be committed: the
// outreach sheets carry well over a hundred real people's names and direct work
// email addresses, which is personal information under PIPEDA and BC PIPA.
// Export it to a path outside the repo and pass that path in.
//
// Expected shape -- an array of:
//   { company, first, last, email, role, status, responded }
//
// WHAT THIS DOES AND DOES NOT TEST
//
// The historical sheets record who was contacted, not what the company was:
// there is no industry, no location and no headcount anywhere in them. So this
// exercises the CONTACT half of the score only (contactPoints). The company
// half -- storefront, headcount, wrong-side-of-the-transaction -- cannot be
// backtested against this data at all, and its weights rest on the tallies in
// the strategy doc rather than on anything measured here.
//
// The weights were derived from REPLY rate. This scores against CONFIRMED
// SPONSORS instead, which is the independent test: if the same features that
// predict a reply also float the sixteen companies that actually signed, the
// rubric is measuring something real rather than restating its own arithmetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contactPoints } from "../src/lib/score.ts";

type Row = {
  company: string;
  first?: string | null;
  last?: string | null;
  email?: string | null;
  role?: string | null;
  status?: string | null;
  responded?: boolean;
};

const path = process.argv[2];
if (!path) {
  console.error("usage: node --experimental-strip-types scripts/backtest-score.ts <rows.json>");
  console.error("(the data file lives outside this repo -- it contains personal information)");
  process.exit(2);
}

const rows: Row[] = JSON.parse(readFileSync(path, "utf8"));
assert.ok(Array.isArray(rows) && rows.length, "expected a non-empty array of rows");

// One row per company: the sheets contact some companies more than once, and a
// company can only be won once. Keep each company's best-scoring attempt.
const byCompany = new Map<string, { score: number; won: boolean; replied: boolean; row: Row }>();
for (const r of rows) {
  const key = (r.company ?? "").trim().toLowerCase();
  if (!key) continue;
  const name = [r.first, r.last].filter(Boolean).join(" ").trim() || null;
  const { score } = contactPoints({
    // No location column exists in the source sheets, so the local-business
    // interaction never fires here. It is the single largest weight, which is
    // the main reason these numbers understate the full rubric.
    location: null,
    contactName: name,
    contactRole: r.role ?? null,
    contactEmail: r.email ?? null,
  });
  const won = (r.status ?? "").trim().toLowerCase() === "confirmed";
  const replied = Boolean(r.responded);
  const prev = byCompany.get(key);
  if (!prev || score > prev.score) byCompany.set(key, { score, won: won || Boolean(prev?.won), replied: replied || Boolean(prev?.replied), row: r });
  else {
    // Separate ifs, not else-if: a duplicate row can be both won and replied.
    if (won) prev.won = true;
    if (replied) prev.replied = true;
  }
}

const all = [...byCompany.values()].sort((a, b) => b.score - a.score);
const wins = all.filter((c) => c.won).length;
const replies = all.filter((c) => c.replied).length;

console.log(`companies:        ${all.length}`);
console.log(`confirmed:        ${wins}`);
console.log(`replied:          ${replies}`);
console.log("");

// Ties matter here. Sixty-odd companies share the top score, so "the top 10"
// is really "10 arbitrary companies out of a tie group of 62" and a raw slice
// would report whatever order the sheet happened to be in. Take the expected
// number of hits instead: whole score groups count in full, and the group
// straddling the cut contributes its hits pro rata. That is the number the
// ranking actually earns, independent of tie order.
const precisionAt = (k: number, pick: (c: (typeof all)[number]) => boolean, total: number) => {
  let hits = 0;
  let left = k;
  for (let i = 0; i < all.length && left > 0; ) {
    let j = i;
    while (j < all.length && all[j].score === all[i].score) j++;
    const size = j - i;
    const groupHits = all.slice(i, j).filter(pick).length;
    hits += size <= left ? groupHits : groupHits * (left / size);
    left -= size;
    i = j;
  }
  const chance = (k / all.length) * total;
  return { hits, chance, lift: chance ? hits / chance : 0 };
};

console.log("rank cut   confirmed in top-k   by chance   lift");
for (const k of [10, 25, 50, 100]) {
  const { hits, chance, lift } = precisionAt(k, (c) => c.won, wins);
  console.log(`top ${String(k).padEnd(4)}   ${hits.toFixed(1).padStart(10)}         ${chance.toFixed(1).padStart(7)}   ${lift.toFixed(2)}x`);
}
console.log("");
console.log("rank cut   replies in top-k     by chance   lift");
for (const k of [10, 25, 50, 100]) {
  const { hits, chance, lift } = precisionAt(k, (c) => c.replied, replies);
  console.log(`top ${String(k).padEnd(4)}   ${hits.toFixed(1).padStart(10)}         ${chance.toFixed(1).padStart(7)}   ${lift.toFixed(2)}x`);
}

// Score bands: the number a volunteer would actually act on.
console.log("");
console.log("score band   companies   confirmed   replied   reply rate");
const bands = [
  { lo: 45, hi: Infinity, label: "45+" },
  { lo: 20, hi: 44, label: "20-44" },
  { lo: 0, hi: 19, label: "0-19" },
  { lo: -Infinity, hi: -1, label: "below 0" },
];
for (const b of bands) {
  const inBand = all.filter((c) => c.score >= b.lo && c.score <= b.hi);
  if (!inBand.length) continue;
  const w = inBand.filter((c) => c.won).length;
  const r = inBand.filter((c) => c.replied).length;
  console.log(
    `${b.label.padEnd(10)}   ${String(inBand.length).padStart(9)}   ${String(w).padStart(9)}   ${String(r).padStart(7)}   ${((r / inBand.length) * 100).toFixed(1).padStart(9)}%`
  );
}

// The false negatives are the most useful output here: a confirmed sponsor
// sitting below zero is a company the rubric would have told a volunteer to
// skip. Company names only -- never print the contact fields.
const buried = all.filter((c) => c.won && c.score < 20).sort((a, b) => a.score - b.score);
if (buried.length) {
  console.log("");
  console.log("confirmed sponsors the rubric ranks low:");
  for (const c of buried) console.log(`  ${String(c.score).padStart(4)}   ${c.row.company}`);
}

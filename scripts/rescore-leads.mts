// Recompute fit_score and board_order for every lead with the current rubric.
//
//   node --env-file=.env.local --experimental-strip-types scripts/rescore-leads.mts
//   node --env-file=.env.local --experimental-strip-types scripts/rescore-leads.mts --write
//
// Reports what would change and writes nothing until --write is passed.
//
// WHY THIS EXISTS
//
// board_order is written correctly by the agent run, but only for leads created
// after src/lib/score.ts landed. Everything older is either unscored or carries
// the model-invented number the rubric replaced, and every one of those rows
// defaults to board_order 0. The board sorts (board_order asc, created_at desc),
// so a few hundred ties collapse the whole ranking to newest-first: the rubric
// is computed, stored, and then sorted away. This is the one-time catch-up.
//
// Idempotent. Run it again after changing a weight and it re-levels the board.
//
// WHAT IT CANNOT SCORE
//
// enactus_leads has no employees column -- headcount is fetched from Apollo
// during a run, used, and never stored -- so rightSize (+15) and enterprise
// (-40) cannot fire here. That is the rubric's documented-safe direction rather
// than a guess: companyPoints() only reads employees when it is a number, on
// the grounds that a missing Apollo record must never look like evidence
// against a company. Scores from this script are therefore correct-but-blunt at
// the extremes, and a genuinely large company keeps whatever it scored on its
// other signals. Storing employees at insert time is the fix; it is a schema
// change, not a backfill.

import { neon } from "@neondatabase/serverless";
import { scoreLead, boardOrderFor } from "../src/lib/score.ts";

const write = process.argv.includes("--write");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.local");
  process.exit(2);
}
const sql = neon(url);

type Row = {
  id: string;
  company: string;
  industry: string | null;
  description: string | null;
  location: string | null;
  connection_type: string | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  fit_score: number | null;
  board_order: number | null;
};

const rows = (await sql.query(
  `select id, company, industry, description, location, connection_type,
          contact_name, contact_role, contact_email, fit_score, board_order
     from enactus_leads
    order by company`
)) as Row[];

if (!rows.length) {
  console.log("No leads. Nothing to do.");
  process.exit(0);
}

// One pass, one array. ids and scores are built from the same element so they
// cannot drift out of alignment before the UPDATE unnests them in parallel.
const scored = rows.map((r) => {
  const { score, reasons } = scoreLead({
    company: r.company,
    industry: r.industry,
    description: r.description,
    location: r.location,
    // employees is deliberately absent -- see the header.
    connectionType: r.connection_type,
    contactName: r.contact_name,
    contactRole: r.contact_role,
    contactEmail: r.contact_email,
  });
  return { row: r, score, order: boardOrderFor(score), reasons };
});

const changed = scored.filter(
  (s) => s.row.fit_score !== s.score || s.row.board_order !== s.order
);
const wasUnranked = scored.filter((s) => (s.row.board_order ?? 0) === 0).length;

console.log(`leads:            ${scored.length}`);
console.log(`unranked now:     ${wasUnranked}  (board_order 0 -- the board cannot sort these)`);
console.log(`rows to update:   ${changed.length}`);
console.log("");

const bands = [
  { lo: 45, hi: Infinity, label: "45+" },
  { lo: 20, hi: 44, label: "20-44" },
  { lo: 0, hi: 19, label: "0-19" },
  { lo: -Infinity, hi: -1, label: "below 0" },
];
console.log("score band   leads");
for (const b of bands) {
  const n = scored.filter((s) => s.score >= b.lo && s.score <= b.hi).length;
  console.log(`${b.label.padEnd(10)}   ${String(n).padStart(5)}`);
}

console.log("");
console.log("top of the board after this runs:");
for (const s of [...scored].sort((a, b) => b.score - a.score).slice(0, 10)) {
  console.log(`  ${String(s.score).padStart(4)}  ${s.row.company.slice(0, 46).padEnd(46)}  ${s.reasons.join(", ")}`);
}

// The rows that were carrying an invented number are the ones worth eyeballing:
// a large move means the old value was not measuring the same thing at all.
const movers = changed
  .filter((s) => s.row.fit_score !== null)
  .sort((a, b) => Math.abs(b.score - (b.row.fit_score ?? 0)) - Math.abs(a.score - (a.row.fit_score ?? 0)))
  .slice(0, 10);
if (movers.length) {
  console.log("");
  console.log("biggest changes to an existing score:");
  for (const s of movers) {
    const from = s.row.fit_score ?? 0;
    console.log(`  ${String(from).padStart(4)} -> ${String(s.score).padStart(4)}   ${s.row.company}`);
  }
}

if (!write) {
  console.log("");
  console.log(`Dry run. Nothing written. Re-run with --write to update ${changed.length} rows.`);
  process.exit(0);
}

if (!changed.length) {
  console.log("");
  console.log("Already up to date.");
  process.exit(0);
}

// One statement, so the board is never left half-ranked. board_order is
// double precision and fit_score is integer; both are derived from the same
// score, so a manual drag still overwrites board_order exactly as before.
await sql.query(
  `update enactus_leads as l
      set fit_score   = v.score,
          board_order = v.ord,
          updated_at  = now()
     from (select unnest($1::uuid[]) as id,
                  unnest($2::int[]) as score,
                  unnest($3::double precision[]) as ord) v
    where l.id = v.id`,
  [changed.map((s) => s.row.id), changed.map((s) => s.score), changed.map((s) => s.order)]
);

console.log("");
console.log(`Updated ${changed.length} rows.`);

// Backfill entity_key on existing leads, and say what changes before it does.
//
//   node --experimental-strip-types scripts/backfill-entities.ts          # dry run
//   node --experimental-strip-types scripts/backfill-entities.ts --write  # apply
//
// Dry run by default, and the dry run is the point. entity_key is a DIFFERENT
// definition of "the same company" from the unique index the board runs on
// today, and it disagrees in both directions:
//
//   MERGES  rows the index thinks are two companies and this thinks are one --
//           "Xenon Pharmaceuticals Inc." and "Xenon Pharmaceuticals". These are
//           duplicate cards on the board right now, and two volunteers emailing
//           one sponsor is the failure that actually costs a relationship.
//
//   SPLITS  rows the index would have BLOCKED and this keeps apart --
//           "Popeyes Burnaby" and "Popeyes Coquitlam". Two outlets, two
//           managers, either of whom can say yes. score.ts already pays a bonus
//           for a name that carries a neighbourhood; the index never let the
//           board hold both.
//
// Read both lists against the real board before anything is changed to depend
// on this column. Writing the column is safe on its own -- nothing dedupes on
// it yet -- so --write can be run as soon as the merges look right.

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { entityKey } from "../src/lib/entity.ts";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
);
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL not found in .env.local");
  process.exit(1);
}
const db = neon(env.DATABASE_URL);
const write = process.argv.includes("--write");

const leads = (await db`
  select id, mode, company, location, website, status from enactus_leads order by created_at`) as {
  id: string;
  mode: string;
  company: string;
  location: string | null;
  website: string | null;
  status: string;
}[];

if (!leads.length) {
  console.log("No leads to backfill.");
  process.exit(0);
}

const byEntity = new Map<string, typeof leads>();
for (const l of leads) {
  const key = `${l.mode}::${entityKey(l.company, l.location)}`;
  const group = byEntity.get(key) ?? [];
  group.push(l);
  byEntity.set(key, group);
}

// Rows the board currently holds as separate companies that this key says are
// one. Each is a duplicate card a volunteer can email twice.
const merges = [...byEntity.entries()].filter(([, group]) => group.length > 1);

// Rows sharing a base name that this key keeps apart, which is the case the
// current unique index would have blocked outright.
const byBase = new Map<string, Set<string>>();
for (const l of leads) {
  const key = entityKey(l.company, l.location);
  const base = key.split("|")[0];
  const set = byBase.get(`${l.mode}::${base}`) ?? new Set<string>();
  set.add(key);
  byBase.set(`${l.mode}::${base}`, set);
}
const splits = [...byBase.entries()].filter(([, keys]) => keys.size > 1);

console.log(`\n${leads.length} leads -> ${byEntity.size} companies\n`);

if (merges.length) {
  console.log(`  ${merges.length} group(s) this treats as ONE company but the board holds separately:\n`);
  for (const [key, group] of merges) {
    console.log(`    ${key.split("::")[1]}`);
    for (const l of group) {
      console.log(`      ${l.company}  (${l.status}${l.website ? `, ${l.website}` : ""})`);
    }
  }
  console.log(`\n  Those are duplicate cards. Merging them is a separate change --`);
  console.log(`  it has to decide which row's status and history survive.\n`);
} else {
  console.log("  No duplicate companies found on the board.\n");
}

if (splits.length) {
  console.log(`  ${splits.length} brand(s) held as separate outlets, which the current index would block:\n`);
  for (const [base, keys] of splits) {
    console.log(`    ${base.split("::")[1]}: ${[...keys].join(", ")}`);
  }
  console.log("");
}

if (!write) {
  console.log("  Dry run. Nothing written. Re-run with --write to fill entity_key.\n");
  process.exit(0);
}

let updated = 0;
for (const l of leads) {
  const key = entityKey(l.company, l.location);
  // One statement per row rather than a batch: this runs once, over a few
  // hundred rows, and a failure partway through should leave the rows it
  // already did rather than roll the whole thing back.
  await db`update enactus_leads set entity_key = ${key} where id = ${l.id}`;
  updated++;
}
console.log(`  entity_key written for ${updated} leads.\n`);

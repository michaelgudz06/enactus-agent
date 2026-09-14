// What did the agent's runs actually cost, and which ones produced leads that
// went anywhere?
//
//   node --experimental-strip-types scripts/run-report.ts          # last 20 runs
//   node --experimental-strip-types scripts/run-report.ts 60       # last 60
//
// Reads DATABASE_URL from .env.local. Read-only: it runs three selects and
// writes nothing.
//
// This exists because the two questions that should drive every tuning decision
// had no answer before enactus_searches carried a trace. Both are joins that
// only became possible once a run, its leads and its spend shared an id:
//
//   What does a qualified lead cost?          runs, cost_usd / result_count
//   Which query found the lead that replied?  leads.search_id -> params.queries
//
// A lead that replied or closed is the only outcome signal the club has, and it
// arrives weeks after the run. Nothing here scores a run on the day it happens;
// the point is to make the retrospective possible at all.

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { costPerLead, type RunTrace } from "../src/lib/trace.ts";

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
const limit = Number(process.argv[2]) || 20;

const money = (n: number) => `$${n.toFixed(4)}`;
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

const runs = (await db`
  select id, created_at, kind, status, prompt, result_count, cost_usd, params, error
    from enactus_searches
   where kind = 'leads'
   order by created_at desc
   limit ${limit}`) as {
  id: string;
  created_at: string;
  status: string;
  prompt: string;
  result_count: number;
  cost_usd: string;
  params: RunTrace | Record<string, never>;
  error: string | null;
}[];

if (!runs.length) {
  console.log("No runs logged yet. Runs started before the run-log migration have no trace.");
  process.exit(0);
}

console.log(`\nLast ${runs.length} lead runs\n`);
console.log(`  ${pad("when", 17)}${pad("status", 9)}${pad("leads", 8)}${pad("cost", 10)}${pad("per lead", 10)}prompt`);
let totalCost = 0;
let totalLeads = 0;
for (const r of runs) {
  const cost = Number(r.cost_usd ?? 0);
  totalCost += cost;
  totalLeads += r.result_count ?? 0;
  const per = costPerLead(cost, r.result_count ?? 0);
  console.log(
    `  ${pad(new Date(r.created_at).toISOString().slice(0, 16).replace("T", " "), 17)}` +
      `${pad(r.status, 9)}${pad(String(r.result_count ?? 0), 8)}${pad(money(cost), 10)}` +
      `${pad(per === null ? "--" : money(per), 10)}${pad(r.prompt.replace(/\s+/g, " "), 60)}`
  );
  if (r.error) console.log(`  ${" ".repeat(17)}error: ${r.error}`);
}
const overall = costPerLead(totalCost, totalLeads);
console.log(
  `\n  ${totalLeads} leads for ${money(totalCost)} -- ${overall === null ? "no leads" : money(overall) + " per lead"}`
);

// Where the funnel actually loses candidates, summed over these runs. The
// shortfall message tells one volunteer about one run; this is the pattern.
const losses: Record<string, number> = {};
let found = 0;
let considered = 0;
for (const r of runs) {
  const t = r.params as RunTrace;
  if (!t?.queries) continue;
  found += t.found ?? 0;
  considered += t.candidates?.length ?? 0;
  if (t.alreadyKnown) losses["already on the board"] = (losses["already on the board"] ?? 0) + t.alreadyKnown;
  for (const [reason, n] of Object.entries(t.dropped ?? {})) losses[reason] = (losses[reason] ?? 0) + n;
}
if (found) {
  console.log(`\n  Funnel: ${found} found -> ${considered} reasoned over -> ${totalLeads} delivered`);
  for (const [reason, n] of Object.entries(losses).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
  }
}

// The join the club cannot currently make any other way: an outcome on the
// board, back to the query that found it.
const replied = (await db`
  select l.company,
         s.prompt,
         s.params -> 'queries' as queries
    from enactus_leads l
    join enactus_searches s on s.id = l.search_id
   where l.status in ('outreach_sent', 'in_conversation', 'closed_won')
   order by l.updated_at desc
   limit 25`) as { company: string; prompt: string; queries: string[] | null }[];

if (replied.length) {
  console.log(`\n  Leads that went somewhere, and the search that found them\n`);
  for (const r of replied) {
    console.log(`    ${pad(r.company, 32)}${(r.queries ?? []).join("  ·  ") || r.prompt}`);
  }
} else {
  console.log(`\n  No leads with a search_id have advanced past prospects yet.`);
  console.log(`  Only runs since the run-log migration carry one.`);
}

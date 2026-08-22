import { db, hasDatabaseUrl } from "./db";
import { billingMonth, capUsd, type BudgetState } from "./budget";

// The Neon half of the budget. src/lib/budget.ts holds the pure arithmetic and
// stays import-free for the selfcheck; everything that touches the database is
// here.
//
// Postgres does the totalling. The Supabase version of this module paged
// through the ledger a thousand rows at a time because PostgREST caps a select
// -- against Neon that is one `sum()` and the ~50 lines of paging go away.

export interface SpendEntry {
  provider: "openrouter" | "exa";
  /** Model id or endpoint, so a surprising month can be read back per source. */
  detail?: string | null;
  costUsd: number;
}

// Spend this process has recorded but may not have re-read yet. The month total
// is one round-trip, and asking for it before every LLM call would add a query
// to the hot path inside a 60s function budget. Instead the DB total is read
// once per TTL and this process's own spend is added on top, so the cap is
// enforced against a figure that is never staler than the calls this run made.
let cachedDbUsd: number | null = null;
let cachedMonth = "";
let cachedAt = 0;
let inProcessUsd = 0;
const CACHE_TTL_MS = 60_000;

// A ledger that cannot be written cannot enforce a cap. Rather than throw --
// which would fail a run for a bookkeeping problem -- the failure is remembered
// and surfaced, so the pipeline never claims a budget it is not actually
// tracking. Silent degradation is the exact failure this codebase keeps being
// repaired for.
let writeProblem: string | null = null;

export function ledgerWriteProblem(): string | null {
  return writeProblem;
}

export function resetSpendCacheForTests(): void {
  cachedDbUsd = null;
  cachedMonth = "";
  cachedAt = 0;
  inProcessUsd = 0;
  writeProblem = null;
}

/** Append one paid call to the ledger. Never throws. */
export async function recordSpend(entry: SpendEntry): Promise<void> {
  const cost = Number(entry.costUsd);
  if (!Number.isFinite(cost) || cost <= 0) return;
  inProcessUsd += cost;
  if (!hasDatabaseUrl()) {
    writeProblem = "DATABASE_URL is not set, so API spend is not being recorded";
    return;
  }
  try {
    await db()`
      insert into enactus_spend (month, provider, detail, cost_usd)
      values (${billingMonth()}, ${entry.provider}, ${entry.detail ?? null}, ${cost})
    `;
  } catch (e) {
    writeProblem = `could not record API spend: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function dbMonthUsd(): Promise<number> {
  const month = billingMonth();
  const fresh = cachedDbUsd !== null && cachedMonth === month && Date.now() - cachedAt < CACHE_TTL_MS;
  if (fresh) return cachedDbUsd as number;
  if (!hasDatabaseUrl()) return 0;
  try {
    const rows = (await db()`
      select coalesce(sum(cost_usd), 0)::float8 as total
      from enactus_spend where month = ${month}
    `) as { total: number }[];
    cachedDbUsd = Number(rows[0]?.total ?? 0);
    cachedMonth = month;
    cachedAt = Date.now();
    // The rows this process wrote are now included in the DB total.
    inProcessUsd = 0;
    return cachedDbUsd;
  } catch (e) {
    writeProblem = `could not read API spend: ${e instanceof Error ? e.message : String(e)}`;
    return cachedDbUsd ?? 0;
  }
}

export async function budgetState(): Promise<BudgetState> {
  const spentUsd = (await dbMonthUsd()) + inProcessUsd;
  return { spentUsd, capUsd: capUsd(), month: billingMonth() };
}

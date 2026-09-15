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
  /**
   * The run that paid for this call, when there is one.
   *
   * Null for anything outside a run -- a contact lookup from a card, say. The
   * column is not a foreign key on purpose: a run row that could not be written
   * must never be able to fail a ledger write.
   */
  searchId?: string | null;
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

// Ledger inserts that have been started but not yet confirmed by Postgres.
//
// recordSpend() is called from the hot path and its callers deliberately do not
// await it -- a run must not pay a round-trip to bill itself. On a long-lived
// server that is harmless, because the promise settles eventually. On a
// serverless function it is not: the runtime is free to tear the process down
// the moment the response stream closes, and any insert still in flight dies
// with it. Every killed insert is spend the NEXT run does not know about, so
// the $20 cap drifts upward silently -- which is the one failure mode a cap
// exists to prevent.
//
// So every write registers here and runAgent() awaits flushSpend() before it
// returns. The cap itself is unaffected either way: inProcessUsd is incremented
// synchronously above, so a run always sees its own spend.
const pending = new Set<Promise<void>>();

/**
 * Wait for every ledger insert this process has started.
 *
 * Loops rather than awaiting once: a flush can itself be racing a write that
 * was started while we were waiting. Never throws -- recordSpend() already
 * records its own failures in writeProblem, and a bookkeeping error must not
 * fail a run that has real leads to hand back.
 */
export async function flushSpend(): Promise<void> {
  while (pending.size) {
    const inflight = [...pending];
    await Promise.allSettled(inflight);
    for (const p of inflight) pending.delete(p);
  }
}

export function resetSpendCacheForTests(): void {
  pending.clear();
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
  const write = (async () => {
    try {
      await db()`
        insert into enactus_spend (month, provider, detail, cost_usd, search_id)
        values (${billingMonth()}, ${entry.provider}, ${entry.detail ?? null}, ${cost}, ${entry.searchId ?? null})
      `;
    } catch (e) {
      writeProblem = `could not record API spend: ${e instanceof Error ? e.message : String(e)}`;
    }
  })();
  pending.add(write);
  await write;
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

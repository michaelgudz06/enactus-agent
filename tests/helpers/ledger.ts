// A hermetic stand-in for the spend ledger. Nothing here reaches a real
// project.
//
// The month's spend is read a page at a time -- `select().eq().order().range()`
// until a page comes back empty -- and every test that replaces `@/lib/supabase`
// while claiming a service key is on that path, because `budgetBlocker` runs
// before anything else does. A double that stops at `select().eq()` does not
// answer the read at all, and the file that owns it then fails for a reason
// that has nothing to do with what it tests.
//
// So the chain is described once, here. A test says what the ledger holds; it
// does not restate how the ledger is queried.
//
// Use it from a test file with:
//   import { ledger, ledgerHolds, resetLedger, spendTable } from "./helpers/ledger";
//
//   vi.mock("@/lib/supabase", async (orig) => {
//     const actual = await orig<typeof import("@/lib/supabase")>();
//     const { ledger: state, spendTable: spend } = await import("./helpers/ledger");
//     const table = (name: string) => (name === actual.SPEND ? spend(name) : ownDoubleFor(name));
//     return { ...actual, hasServiceKey: () => state.hasServiceKey, supabaseAdmin: { from: table } };
//   });

export interface Ledger {
  /** The month's charges on file. */
  rows: { cost_usd: number }[];
  /** Every row the code under test actually wrote. */
  inserted: Record<string, unknown>[];
  /** Set to reproduce a ledger that cannot be read. */
  readFails: string | null;
  /** Supabase reports a rejected insert in `error` rather than by throwing. */
  writeFails: string | null;
  /** What a hosted project caps one response at, however many were asked for. */
  maxRows: number;
  /** A table that never ends: every page comes back full, so no read completes. */
  endless: boolean;
  /** Whether there is a service key, and so anywhere durable to keep spend. */
  hasServiceKey: boolean;
}

function defaults(): Ledger {
  return {
    rows: [],
    inserted: [],
    readFails: null,
    writeFails: null,
    maxRows: 1000,
    endless: false,
    hasServiceKey: true,
  };
}

/** The live state. Per test file: vitest gives each one its own module graph. */
export const ledger: Ledger = defaults();

/** Back to an empty, readable, writable month. Call it in `beforeEach`. */
export function resetLedger(over: Partial<Ledger> = {}): void {
  Object.assign(ledger, defaults(), over);
}

/** Puts `usd` on file as everything this month has cost so far. */
export function ledgerHolds(usd: number): void {
  ledger.rows = [{ cost_usd: usd }];
}

/** The spend table, answering the read the budget module actually makes. */
export function spendTable(name = "enactus_api_spend") {
  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const api = {
    insert(row: Record<string, unknown>) {
      if (ledger.writeFails) return Promise.resolve({ data: null, error: { message: ledger.writeFails } });
      ledger.inserted.push({ table: name, ...row });
      return Promise.resolve({ data: null, error: null });
    },
    select: () => api,
    eq: () => api,
    order: () => api,
    range(start: number, end: number) {
      from = start;
      to = end;
      return api;
    },
    then(resolve: (v: unknown) => unknown) {
      if (ledger.readFails) {
        return Promise.resolve({ data: null, error: { message: ledger.readFails } }).then(resolve);
      }
      const size = Math.min(to - from + 1, ledger.maxRows);
      const page = ledger.endless
        ? Array.from({ length: size }, () => ({ cost_usd: 0.000001 }))
        : ledger.rows.slice(from, from + size);
      return Promise.resolve({ data: page, error: null }).then(resolve);
    },
  };
  return api;
}

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// A stand-in ledger. Nothing here reaches a real project: `rows` is what the
// month has cost so far and `readFails` reproduces a project whose spend table
// cannot be read.
const db = vi.hoisted(() => ({
  rows: [] as { cost_usd: number }[],
  inserted: [] as Record<string, unknown>[],
  readFails: null as string | null,
  hasKey: true,
}));

vi.mock("@/lib/supabase", async (orig) => {
  const actual = await orig<typeof import("@/lib/supabase")>();
  const table = (name: string) => {
    const api = {
      insert(row: Record<string, unknown>) {
        db.inserted.push({ table: name, ...row });
        return Promise.resolve({ data: null, error: null });
      },
      select: () => api,
      eq: () => api,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          db.readFails ? { data: null, error: { message: db.readFails } } : { data: db.rows, error: null }
        ).then(resolve),
    };
    return api;
  };
  return { ...actual, hasServiceKey: () => db.hasKey, supabaseAdmin: { from: table } };
});

const budget = await import("@/lib/budget");
const { exaSearch } = await import("@/lib/exa");
const { chatJSON, chatText, streamReasoner, STRUCTURED, REASONER } = await import("@/lib/llm");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  db.rows = [];
  db.inserted = [];
  db.readFails = null;
  db.hasKey = true;
  budget.resetSpendCacheForTests();
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("EXA_API_KEY", "test-key");
  globalThis.fetch = vi.fn(async () => {
    throw new Error("no test should have reached the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

/** The error a call was refused with. Fails loudly if it was not refused. */
async function refusalFrom(work: Promise<unknown>): Promise<Error> {
  const outcome = await work.then(
    () => null,
    (e: Error) => e
  );
  if (!outcome) throw new Error("expected the call to be refused, and it went through");
  return outcome;
}

/** Puts the month at `spentCad` already spent. */
function alreadySpent(spentCad: number) {
  db.rows = [{ cost_usd: spentCad / budget.usdToCad() }];
  budget.resetSpendCacheForTests();
}

// ── The number itself ────────────────────────────────────────────────────

describe("the cap is $20 CAD a month", () => {
  test("defaults to the captain's number", () => {
    expect(budget.capCad()).toBe(20);
    expect(budget.DEFAULT_CAP_CAD).toBe(20);
  });

  test("the VP External can raise or lower it through the environment", () => {
    vi.stubEnv("API_BUDGET_CAD", "35");

    expect(budget.capCad()).toBe(35);
  });

  // A cap that a typo can remove is not a cap. Every one of these used to be a
  // plausible way to end up with `Number(undefined)` or a zero ceiling.
  const NOT_A_CAP: Record<string, string> = {
    "an empty value": "",
    "whitespace": "   ",
    "words": "twenty",
    "zero": "0",
    "a negative number": "-5",
    "infinity": "Infinity",
  };

  for (const [shape, value] of Object.entries(NOT_A_CAP)) {
    test(`falls back to the default rather than lifting the cap on ${shape}`, () => {
      vi.stubEnv("API_BUDGET_CAD", value);

      expect(budget.capCad()).toBe(budget.DEFAULT_CAP_CAD);
    });
  }

  test("the cap the providers are measured against is the CAD cap converted once", () => {
    expect(budget.capUsd()).toBeCloseTo(20 / budget.DEFAULT_USD_TO_CAD, 6);
  });
});

// ── Prices ───────────────────────────────────────────────────────────────

// Verified live against OpenRouter's own model list on 2026-08-06. This test is
// the record of that: if a pin in src/lib/llm.ts moves to a model with no entry
// here, the cap starts guessing.
describe("provider prices", () => {
  test("prices both pinned models", () => {
    expect(budget.OPENROUTER_PRICES[REASONER]).toEqual({ input: 0.435, output: 0.87 });
    expect(budget.OPENROUTER_PRICES[STRUCTURED]).toEqual({ input: 0.09, output: 0.18 });
  });

  test("charges tokens at the published per-million rate", () => {
    expect(budget.openRouterCostUsd(STRUCTURED, 1_000_000, 0)).toBeCloseTo(0.09, 9);
    expect(budget.openRouterCostUsd(STRUCTURED, 0, 1_000_000)).toBeCloseTo(0.18, 9);
  });

  // A model nobody priced must not be free: free-by-default would let a new pin
  // spend the whole month invisibly.
  test("charges an unpriced model at the most expensive known rate", () => {
    const unknown = budget.openRouterCostUsd("someone/brand-new-model", 1_000_000, 1_000_000);
    const dearest = budget.openRouterCostUsd(REASONER, 1_000_000, 1_000_000);

    expect(unknown).toBe(dearest);
    expect(unknown).toBeGreaterThan(0);
  });

  // $7 per 1,000 requests covers up to ten results with their text; results past
  // the tenth are $1 per 1,000.
  test("charges an Exa search at its flat base price up to ten results", () => {
    expect(budget.exaSearchCostUsd(6)).toBeCloseTo(0.007, 9);
    expect(budget.exaSearchCostUsd(10)).toBeCloseTo(0.007, 9);
  });

  test("charges for results past the tenth", () => {
    expect(budget.exaSearchCostUsd(15)).toBeCloseTo(0.012, 9);
  });

  // Exa is the reason $20 buys depth rather than breadth: searching is most of
  // what a run costs, and thinking harder about what a search found is nearly
  // free next to searching again.
  test("searching costs more than all the models in a run put together", () => {
    const searches = budget.RUN_SHAPE.searchQueries * budget.exaSearchCostUsd(budget.RUN_SHAPE.resultsPerSearch);
    const models = budget.estimateAgentRunUsd({ reasoner: REASONER, structured: STRUCTURED }) - searches;

    expect(searches).toBeGreaterThan(models * 2);
  });
});

// ── Stopping ─────────────────────────────────────────────────────────────

describe("reaching the cap stops the work", () => {
  test("lets a call through while there is room for it", async () => {
    alreadySpent(1);

    await expect(budget.assertHeadroom(0.01, "a call")).resolves.toBeUndefined();
  });

  test("refuses the call that would cross the cap", async () => {
    alreadySpent(19.99);

    await expect(budget.assertHeadroom(1, "a full agent run")).rejects.toBeInstanceOf(
      budget.BudgetExceededError
    );
  });

  // "Stopped" is only useful if the student can see what stopped it.
  test("names the cap, the spend and the month it stopped in", async () => {
    alreadySpent(19.97);

    const error = await refusalFrom(budget.assertHeadroom(0.05, "a full agent run"));

    expect(error.message).toContain("The cap is $20.00 CAD");
    expect(error.message).toContain("$19.97 CAD has already been spent");
    expect(error.message).toContain(budget.billingMonthLabel());
    expect(error.message).toContain("a full agent run");
  });

  test("counts what this process has already spent, not only what was on file", async () => {
    alreadySpent(19.9);
    await budget.recordSpend({ provider: "exa", model: "search", operation: "search", costUsd: 0.5 });

    await expect(budget.assertHeadroom(0.01, "a call")).rejects.toBeInstanceOf(budget.BudgetExceededError);
  });

  // Unknown spend is not zero spend. Assuming zero here could cost the month.
  test("a ledger it cannot read stops the work rather than assuming nothing was spent", async () => {
    db.readFails = "permission denied for table enactus_api_spend";
    budget.resetSpendCacheForTests();

    const error = await refusalFrom(budget.assertHeadroom(0.01, "a call"));

    expect(error).toBeInstanceOf(budget.BudgetExceededError);
    expect(error.message).toContain("permission denied");
  });

  // A failed read that got cached as zero would fail open on the very next call,
  // which is the silent version of having no cap at all.
  test("does not remember a failed read as a month with nothing spent in it", async () => {
    db.readFails = "connection reset";
    budget.resetSpendCacheForTests();
    await expect(budget.monthToDateUsd()).rejects.toThrow();

    await expect(budget.monthToDateUsd()).rejects.toThrow();
  });

  test("the pre-flight blocker says the same thing before anything runs", async () => {
    alreadySpent(20);

    const blocker = await budget.budgetBlocker(0.05, "a full agent run");

    expect(blocker).toContain("$20.00 CAD");
    expect(blocker).toContain("Nothing was charged");
  });

  test("the pre-flight blocker stands aside when there is room", async () => {
    alreadySpent(1);

    expect(await budget.budgetBlocker(0.05, "a full agent run")).toBeNull();
  });
});

// ── Not defeatable by a caller ───────────────────────────────────────────

// The cap lives inside the provider clients, so it holds for every caller
// whatever options they pass. There is no flag to turn it off because there is
// no code path that reads one.
describe("no caller can spend past the cap", () => {
  beforeEach(() => {
    alreadySpent(20);
  });

  test("Exa refuses and never reaches the network", async () => {
    await expect(exaSearch("burnaby cafes", { numResults: 6 })).rejects.toBeInstanceOf(
      budget.BudgetExceededError
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("chatJSON refuses whatever options it is handed", async () => {
    await expect(
      chatJSON([{ role: "user", content: "hi" }], {
        model: STRUCTURED,
        maxTokens: 10,
        operation: "plan",
      })
    ).rejects.toBeInstanceOf(budget.BudgetExceededError);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("chatText refuses", async () => {
    await expect(chatText([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      budget.BudgetExceededError
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("the reasoning stream refuses", async () => {
    await expect(streamReasoner([{ role: "user", content: "hi" }], {})).rejects.toBeInstanceOf(
      budget.BudgetExceededError
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── Booking what was spent ───────────────────────────────────────────────

describe("the ledger", () => {
  test("writes one row per charge, in the provider's own currency", async () => {
    await budget.recordSpend({
      provider: "openrouter",
      model: STRUCTURED,
      operation: "plan",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: budget.openRouterCostUsd(STRUCTURED, 1000, 500),
    });

    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      provider: "openrouter",
      model: STRUCTURED,
      operation: "plan",
      billing_month: budget.billingMonth(),
    });
  });

  test("books an OpenRouter call from the usage the provider reported", async () => {
    alreadySpent(0);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    await chatJSON([{ role: "user", content: "hi" }], { operation: "plan" });

    const expected = budget.openRouterCostUsd(STRUCTURED, 1_000_000, 1_000_000);
    expect(await budget.monthToDateUsd()).toBeCloseTo(expected, 9);
  });

  test("without a service key the cap is per-process, and says so", async () => {
    db.hasKey = false;
    budget.resetSpendCacheForTests();

    const status = await budget.budgetStatus(0.03);

    expect(status.persisted).toBe(false);
    expect(status.error).toBeNull();
  });

  test("reports the month, the spend and how many runs are left", async () => {
    alreadySpent(10);

    const status = await budget.budgetStatus(0.05 / budget.usdToCad());

    expect(status.capCad).toBe(20);
    expect(status.spentCad).toBeCloseTo(10, 2);
    expect(status.remainingCad).toBeCloseTo(10, 2);
    // $10 CAD left at $0.05 a run. The count floors, so it may be one short of
    // the arithmetic and is never one over: a student is not promised a run the
    // agent would then refuse.
    expect(status.runsRemaining).toBeGreaterThanOrEqual(199);
    expect(status.runsRemaining).toBeLessThanOrEqual(200);
    expect(status.month).toMatch(/^\d{4}-\d{2}$/);
  });

  test("reports an unreadable ledger as unknown rather than as nothing spent", async () => {
    db.readFails = "connection reset";
    budget.resetSpendCacheForTests();

    const status = await budget.budgetStatus(0.03);

    expect(status.error).toContain("connection reset");
    expect(status.runsRemaining).toBe(0);
  });
});

// ── The month boundary ───────────────────────────────────────────────────

describe("the month runs on the club's clock", () => {
  test("late on the last night of the month still counts against that month", () => {
    // 2026-09-01 06:30 UTC is 2026-08-31 23:30 in Vancouver.
    expect(budget.billingMonth(new Date("2026-09-01T06:30:00Z"))).toBe("2026-08");
  });

  test("the first morning of the next month starts fresh", () => {
    expect(budget.billingMonth(new Date("2026-09-01T18:00:00Z"))).toBe("2026-09");
  });
});

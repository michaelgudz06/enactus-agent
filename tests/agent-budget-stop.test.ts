import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";

// A run either happens in full or does not start. This is the file that holds
// that: a budget stop must never reach the user wearing the clothes of a
// finished run, and every catch in the pipeline that exists to keep a run alive
// is a place it could have.

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

const db = vi.hoisted(() => ({ spentUsd: 0 }));

vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());
vi.mock("@/lib/supabase", async (orig) => {
  const actual = await orig<typeof import("@/lib/supabase")>();
  const table = (name: string) => {
    const api = {
      insert: () => api,
      select: () => api,
      eq: () => api,
      order: () => api,
      limit: async () => ({ data: [], error: null }),
      single: async () => ({ data: { id: "row-1" }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          name === actual.SPEND ? { data: [{ cost_usd: db.spentUsd }], error: null } : { data: [], error: null }
        ).then(resolve),
    };
    return api;
  };
  return { ...actual, hasServiceKey: () => true, supabaseAdmin: { from: table } };
});
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  chatJSON: stub.chatJSON,
  streamReasoner: stub.streamReasoner,
}));
vi.mock("@/lib/exa", async (orig) => ({
  ...(await orig<typeof import("@/lib/exa")>()),
  exaSearch: stub.exaSearch,
}));

const budget = await import("@/lib/budget");
const { runAgent } = await import("@/lib/agent");

const INPUT = { prompt: "burnaby cafes near sfu", mode: "sponsor" as const, userName: "Tester", skipClarify: true };

beforeEach(() => {
  vi.clearAllMocks();
  db.spentUsd = 0;
  budget.resetSpendCacheForTests();
  vi.unstubAllEnvs();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Renaissance Coffee is the strongest.", content: "" });
});

/** A month with nothing left in it. */
function budgetSpent() {
  db.spentUsd = budget.capUsd();
  budget.resetSpendCacheForTests();
}

describe("a run that cannot be paid for does not start", () => {
  beforeEach(budgetSpent);

  test("stops with a message naming the cap and the spend", async () => {
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("$20.00 CAD");
    expect(out.errors[0]).toContain("Nothing was charged");
  });

  // The whole point of stopping before the first search: a half-run costs money
  // and produces a shortlist nobody can trust.
  test("spends nothing at all", async () => {
    const { emit } = collector();

    await runAgent(INPUT, emit);

    expect(stub.chatJSON).not.toHaveBeenCalled();
    expect(stub.exaSearch).not.toHaveBeenCalled();
    expect(stub.streamReasoner).not.toHaveBeenCalled();
  });

  // `done` is what the board reads as "this finished". A stopped run must not
  // emit one, at any count, or the UI will report zero leads as a clean result.
  test("never reports itself as done", async () => {
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.events.some((e) => e.type === "done")).toBe(false);
    expect(out.leads).toEqual([]);
  });
});

describe("a run with budget in front of it is untouched", () => {
  test("plans, searches and returns leads exactly as before", async () => {
    stub.chatJSON
      .mockImplementationOnce(respondsWith(PLAN))
      .mockImplementationOnce(respondsWith({ leads: [rawLead()] }));
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.errors).toEqual([]);
    expect(out.leads).toHaveLength(1);
    expect(out.events.some((e) => e.type === "done")).toBe(true);
  });
});

// The cap can be reached part way through: two students running at once, or a
// run that costs more than its estimate. Every one of these is a catch that was
// written to keep a run alive through a bad model response, and every one of
// them would otherwise turn "we ran out of money" into a quieter, wronger story.
describe("a budget stop reached mid-run is still a stop", () => {
  function refuse() {
    return new budget.BudgetExceededError("Monthly API budget reached. The cap is $20.00 CAD.", {
      capCad: 20,
      spentCad: 20,
      neededCad: 0.05,
    });
  }

  test("does not read as an empty web when the search step refuses", async () => {
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN));
    stub.exaSearch.mockRejectedValue(refuse());
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.errors).toEqual(["Monthly API budget reached. The cap is $20.00 CAD."]);
    expect(out.statuses.join(" ")).not.toContain("No candidates found");
    expect(out.events.some((e) => e.type === "done")).toBe(false);
  });

  test("does not read as a planning failure when the plan step refuses", async () => {
    stub.chatJSON.mockRejectedValueOnce(refuse());
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.errors[0]).not.toContain("Planning failed");
    expect(out.errors[0]).toContain("Monthly API budget");
  });

  // This catch exists so a slow reasoner degrades into ranking from the raw
  // research. A refusal is not a slow reasoner.
  test("does not degrade into ranking from the research when the reasoner refuses", async () => {
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN));
    stub.streamReasoner.mockRejectedValue(refuse());
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.errors[0]).toContain("Monthly API budget");
    expect(out.statuses.join(" ")).not.toContain("Reasoning hit a snag");
    expect(out.events.some((e) => e.type === "done")).toBe(false);
  });

  test("does not read as an unusable model response when the structuring step refuses", async () => {
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockRejectedValueOnce(refuse());
    const { emit, out } = collector();

    await runAgent(INPUT, emit);

    expect(out.errors[0]).not.toContain("did not return usable results");
    expect(out.errors[0]).toContain("Monthly API budget");
    expect(out.leads).toEqual([]);
  });
});

// A run's shape and the estimate that gates it have to be the same run. If they
// drift, the gate is approving a run it has not priced.
describe("the gate prices the run the pipeline actually makes", () => {
  test("searches exactly as many queries as the estimate paid for", async () => {
    stub.chatJSON
      .mockImplementationOnce(respondsWith(PLAN))
      .mockImplementationOnce(respondsWith({ leads: [rawLead()] }));
    const { emit } = collector();

    await runAgent(INPUT, emit);

    expect(stub.exaSearch).toHaveBeenCalledTimes(budget.RUN_SHAPE.searchQueries);
    for (const call of stub.exaSearch.mock.calls) {
      expect(call[1]).toMatchObject({ numResults: budget.RUN_SHAPE.resultsPerSearch });
    }
  });
});

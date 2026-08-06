import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  chatJSON: stub.chatJSON,
  streamReasoner: stub.streamReasoner,
}));
vi.mock("@/lib/exa", async (orig) => ({
  ...(await orig<typeof import("@/lib/exa")>()),
  exaSearch: stub.exaSearch,
}));

const { runAgent } = await import("@/lib/agent");

beforeEach(() => {
  // Reset, not clear: a run that stops at planning never consumes the second
  // queued response, and mockImplementationOnce queues survive clearAllMocks.
  vi.resetAllMocks();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

// The plan answers through the real coerce-then-validate boundary, so a schema
// that would abort the run in production aborts it here too.
async function runWithPlan(plan: unknown, opts: { skipClarify?: boolean } = { skipClarify: true }) {
  stub.chatJSON
    .mockImplementationOnce(respondsWith(plan))
    .mockImplementationOnce(respondsWith({ leads: [rawLead()] }));
  const { emit, out } = collector();
  await runAgent(
    { prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", ...opts },
    emit
  );
  return out;
}

function queriesSearched(): string[] {
  return stub.exaSearch.mock.calls.map((c) => c[0] as string);
}

// For a run that stops at the plan: queueing only the plan response leaves no
// unconsumed structuring response behind, so two such runs can be compared
// inside one test.
async function runPlanOnly(plan: unknown) {
  stub.chatJSON.mockImplementationOnce(respondsWith(plan));
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester" }, emit);
  return out;
}

/** The fixture plan with one field genuinely absent, not merely undefined. */
function planWithout(field: keyof typeof PLAN): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...PLAN };
  delete copy[field];
  return copy;
}

// The whole class in one plan: a wrong-typed optional field, a recoverable one,
// and a required set that is perfectly good. Before this, any one of them threw
// out of chatJSON and the run ended on "Planning failed" before a single search.
describe("a defective plan field costs that field only", () => {
  test("searches, reasons and produces leads despite two bad optionals and a damaged query list", async () => {
    const out = await runWithPlan({
      ...PLAN,
      altAngle: { city: "Vancouver" },
      location: 42,
      searchQueries: ["burnaby cafes near sfu", 42, "sfu campus coffee"],
    });

    expect(out.errors).toEqual([]);
    // The recoverable field is normalised: the two usable queries are searched
    // and the unusable entry is the only thing lost.
    expect(queriesSearched()).toEqual(["burnaby cafes near sfu", "sfu campus coffee"]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
    expect(out.events.some((e) => e.type === "done" && e.count === 1)).toBe(true);
  });

  test("announces every plan field it dropped or normalised", async () => {
    const out = await runWithPlan({
      ...PLAN,
      altAngle: { city: "Vancouver" },
      location: 42,
      searchQueries: ["burnaby cafes near sfu", 42, "sfu campus coffee"],
    });

    expect(out.statuses.some((s) => s.includes("altAngle"))).toBe(true);
    expect(out.statuses.some((s) => s.includes("location") && s.includes("42"))).toBe(true);
    expect(out.statuses.some((s) => s.includes("searchQueries"))).toBe(true);
  });

  test("says nothing about a plan that is clean", async () => {
    const out = await runWithPlan(PLAN);

    expect(out.errors).toEqual([]);
    expect(queriesSearched()).toEqual(PLAN.searchQueries);
    expect(out.statuses.some((s) => /altAngle|searchQueries|criteria|needClarification/.test(s))).toBe(false);
  });

  // criteria sharpens the ranking prompt, but the user's own request is in that
  // prompt too, so the next step can still run without it. It is not a blocker.
  test("runs without a usable criteria and announces the loss", async () => {
    const out = await runWithPlan({ ...PLAN, criteria: 42 });

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
    expect(out.statuses.some((s) => s.includes("criteria"))).toBe(true);
  });

  test("runs when criteria is absent entirely", async () => {
    const out = await runWithPlan(planWithout("criteria"));

    expect(out.errors).toEqual([]);
    expect(out.leads).toHaveLength(1);
    expect(out.statuses.some((s) => s.includes("criteria"))).toBe(true);
  });
});

// Dropping an entry is a degradation like any other, and the run says so. A
// silent repair teaches nobody that the model is misbehaving.
describe("an unusable entry in a plan list is announced", () => {
  const withBlankQuery = { ...PLAN, searchQueries: ["burnaby cafes near sfu", "   ", "sfu campus coffee"] };
  const withoutBlankQuery = { ...PLAN, searchQueries: ["burnaby cafes near sfu", "sfu campus coffee"] };

  test("searches the usable queries and loses only the blank one", async () => {
    const out = await runWithPlan(withBlankQuery);

    expect(out.errors).toEqual([]);
    expect(queriesSearched()).toEqual(["burnaby cafes near sfu", "sfu campus coffee"]);
    expect(out.leads).toHaveLength(1);
  });

  // The announcement is what this run says that a run reaching the same two
  // queries without a blank entry does not say.
  test("says what it dropped, which an undamaged list does not", async () => {
    const clean = await runWithPlan(withoutBlankQuery);
    const degraded = await runWithPlan(withBlankQuery);

    expect(degraded.statuses.filter((s) => !clean.statuses.includes(s))).toHaveLength(1);
  });

  test("asks the questions that survived and says what it dropped", async () => {
    const clean = await runPlanOnly({ ...PLAN, needClarification: true, questions: ["Which city?"] });
    const degraded = await runPlanOnly({ ...PLAN, needClarification: true, questions: ["Which city?", "  "] });

    for (const out of [clean, degraded]) {
      expect(out.events.some((e) => e.type === "clarify" && e.questions.length === 1)).toBe(true);
    }
    expect(degraded.statuses.filter((s) => !clean.statuses.includes(s))).toHaveLength(1);
  });
});

// The same reading at the plan envelope as at the leads and draft envelopes: a
// list of one where a single record was asked for is that record.
describe("a plan wrapped in a list of one", () => {
  test("searches from the plan the wrapper carried", async () => {
    const out = await runWithPlan([PLAN]);

    expect(out.errors).toEqual([]);
    expect(queriesSearched()).toEqual(PLAN.searchQueries);
    expect(out.leads).toHaveLength(1);
  });

  test("announces the unwrap, which the same plan unwrapped does not", async () => {
    const plain = await runWithPlan(PLAN);
    const wrapped = await runWithPlan([PLAN]);

    expect(wrapped.statuses.filter((s) => !plain.statuses.includes(s))).toHaveLength(1);
  });

  const NOT_A_PLAN: Record<string, unknown> = {
    "a bare string": "search burnaby cafes",
    "an empty list": [],
    "a list of several plans": [PLAN, PLAN],
  };

  for (const [shape, planned] of Object.entries(NOT_A_PLAN)) {
    test(`stops on ${shape}, without searching`, async () => {
      const out = await runPlanOnly(planned);

      expect(stub.exaSearch).not.toHaveBeenCalled();
      expect(out.errors).toHaveLength(1);
    });
  }
});

// criteria is degradable, so an empty one is reachable. A labelled field with
// nothing after it tells the next model less than no field at all.
describe("the prompt sent onward carries no empty ideal-lead field", () => {
  function promptsSent(): string[] {
    const reasoning = stub.streamReasoner.mock.calls[0][0][1].content as string;
    const structuring = stub.chatJSON.mock.calls[1][0][1].content as string;
    return [reasoning, structuring];
  }

  test("omits the line entirely when criteria degraded away", async () => {
    await runWithPlan({ ...PLAN, criteria: 42 });

    for (const prompt of promptsSent()) expect(prompt).not.toContain("Ideal lead:");
  });

  test("still carries criteria when the model supplied one", async () => {
    await runWithPlan(PLAN);

    for (const prompt of promptsSent()) expect(prompt).toContain(`Ideal lead: ${PLAN.criteria}`);
  });
});

// A wrong type with exactly one possible reading is a slip, not an ambiguity --
// the same rule the per-lead review already applies to fit_score.
describe("a recoverable plan value is read rather than thrown away", () => {
  test("reads a lone search query sent as a bare string", async () => {
    const out = await runWithPlan({ ...PLAN, searchQueries: "burnaby cafes near sfu" });

    expect(out.errors).toEqual([]);
    expect(queriesSearched()).toEqual(["burnaby cafes near sfu"]);
    expect(out.statuses.some((s) => s.includes("searchQueries"))).toBe(true);
  });

  test("reads a stringified needClarification, and the run acts on it", async () => {
    const out = await runWithPlan(
      { ...PLAN, needClarification: "true", questions: ["Which city?", "What budget?"] },
      {}
    );

    // Recovered to true, so the run asks instead of searching.
    expect(out.events.some((e) => e.type === "clarify")).toBe(true);
    expect(stub.exaSearch).not.toHaveBeenCalled();
  });

  test("reads a stringified false and searches instead of asking", async () => {
    const out = await runWithPlan({ ...PLAN, needClarification: "false", questions: ["Which city?"] }, {});

    expect(out.events.some((e) => e.type === "clarify")).toBe(false);
    expect(queriesSearched()).toEqual(PLAN.searchQueries);
    expect(out.leads).toHaveLength(1);
  });

  // "yes" is a guess about whether to stop and ask the user. That is not a guess
  // to make, so the field falls back to its default and the run proceeds.
  test("leaves a needClarification with no single reading alone", async () => {
    const out = await runWithPlan({ ...PLAN, needClarification: "yes", questions: ["Which city?"] }, {});

    expect(out.events.some((e) => e.type === "clarify")).toBe(false);
    expect(queriesSearched()).toEqual(PLAN.searchQueries);
    expect(out.statuses.some((s) => s.includes("needClarification"))).toBe(true);
  });

  test("never lets a malformed questions list become the clarify payload", async () => {
    const out = await runWithPlan({ ...PLAN, needClarification: true, questions: 42 }, {});

    // Nothing usable to ask, so the run searches rather than emitting a broken
    // question list.
    expect(out.events.some((e) => e.type === "clarify")).toBe(false);
    expect(queriesSearched()).toEqual(PLAN.searchQueries);
    expect(out.statuses.some((s) => s.includes("questions"))).toBe(true);
  });
});

// The one genuine blocker: with no query there is nothing to search, so the run
// stops. It must stop honestly, and it must not be softened into a warning.
describe("no search queries at all is a real stop", () => {
  test("stops on an empty query list without searching", async () => {
    const out = await runWithPlan({ ...PLAN, searchQueries: [] });

    expect(stub.exaSearch).not.toHaveBeenCalled();
    expect(out.leads).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.events.some((e) => e.type === "done")).toBe(false);
  });

  test("stops when searchQueries is absent entirely", async () => {
    const out = await runWithPlan(planWithout("searchQueries"));

    expect(stub.exaSearch).not.toHaveBeenCalled();
    expect(out.errors).toHaveLength(1);
  });

  test("stops when no entry in the query list is usable", async () => {
    const out = await runWithPlan({ ...PLAN, searchQueries: [42, null, "   "] });

    expect(stub.exaSearch).not.toHaveBeenCalled();
    expect(out.errors).toHaveLength(1);
  });

  test("names the field that was missing rather than blaming planning generally", async () => {
    const out = await runWithPlan({ ...PLAN, searchQueries: [] });

    expect(out.errors[0]).toContain("searchQueries");
  });

  // The blocker message already names what the model sent, so the entries it
  // dropped on the way there are not reported a second time.
  // However the unusable list arrived -- entries a schema check can see through,
  // or entries it had to recover past first -- the blocker is the one report of
  // that loss.
  const BLANK_QUERY_LISTS: Record<string, unknown[]> = {
    "every entry is a blank string": ["   ", "\t"],
    "the entries had to be recovered first": [42, null, "   "],
  };

  for (const [shape, searchQueries] of Object.entries(BLANK_QUERY_LISTS)) {
    test(`reports a fully blank query list once, when ${shape}`, async () => {
      const out = await runPlanOnly({ ...PLAN, searchQueries });

      expect(out.errors).toHaveLength(1);
      // Only the opening "understanding" status: nothing announced the same loss
      // a second time on the way to the blocker.
      expect(out.statuses).toHaveLength(1);
    });
  }

  // A transport or parse failure is still a stop: there is no plan at all.
  test("still stops when the planning call itself fails", async () => {
    stub.chatJSON.mockRejectedValueOnce(new Error("OpenRouter 429: rate limited"));
    const { emit, out } = collector();

    await runAgent(
      { prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true },
      emit
    );

    expect(stub.exaSearch).not.toHaveBeenCalled();
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("429");
  });
});

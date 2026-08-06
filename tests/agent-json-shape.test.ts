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
  vi.clearAllMocks();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

// The model answers through the real coerce-then-validate boundary, so a schema
// that would reject a payload in production rejects it here too.
async function runWithStructuredResponse(structured: unknown) {
  stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith(structured));
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
}

// Every object node in a schema, so the shape can be asserted as meaning rather
// than as text.
function objectNodes(schema: Record<string, unknown>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "object") found.push(n);
    for (const child of Object.values((n.properties ?? {}) as Record<string, unknown>)) walk(child);
    if (n.items) walk(n.items);
  };
  walk(schema);
  return found;
}

describe("structuring step JSON shape", () => {
  // Live-test report D1: 9 of 17 completed runs (53%) returned a bare array and
  // every lead in them was discarded.
  test("accepts a bare JSON array of leads", async () => {
    const out = await runWithStructuredResponse([
      rawLead(),
      rawLead({ company: "Gabi & Jules", website: "https://gabiandjules.com/pages/about-us", source_index: 2 }),
    ]);

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee", "Gabi & Jules"]);
  });

  test("still accepts the documented {leads:[...]} shape", async () => {
    const out = await runWithStructuredResponse({ leads: [rawLead()] });

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
  });

  test("reports an error when the payload carries no leads at all", async () => {
    const out = await runWithStructuredResponse({ notLeads: true });

    expect(out.leads).toEqual([]);
    expect(out.errors).toHaveLength(1);
  });

  test("asks both model calls for a schema-enforced response", async () => {
    await runWithStructuredResponse({ leads: [rawLead()] });

    const planOpts = stub.chatJSON.mock.calls[0][1];
    const structureOpts = stub.chatJSON.mock.calls[1][1];

    expect(planOpts.schema?.name).toBe("search_plan");
    expect(structureOpts.schema?.name).toBe("leads");
    // The envelope is what the provider is asked for; a bare array is normalised
    // before the schema check rather than rejected by it.
    expect(structureOpts.coerce?.([rawLead()])).toEqual({ leads: [rawLead()] });
  });

  // Strict structured output means every property listed in `required` and no
  // extras. The schema actually handed to the provider is a generated interface,
  // so it is asserted as a parsed shape, not as text.
  test("hands the provider a complete strict schema", async () => {
    await runWithStructuredResponse({ leads: [rawLead()] });

    for (const call of stub.chatJSON.mock.calls) {
      const nodes = objectNodes(call[1].schema.schema);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.additionalProperties).toBe(false);
        expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties as object)));
      }
    }
  });

  // Strictness belongs on a field, never on a batch: the complete schema above
  // must not turn one bad field into another wholesale discard.
  test("keeps the rest of the batch when one lead has an off-enum connection_type", async () => {
    const out = await runWithStructuredResponse({
      leads: [
        rawLead(),
        rawLead({ company: "Gabi & Jules", source_index: 2, connection_type: "partner" }),
        rawLead({ company: "BAK'D Cookies", source_index: 1 }),
      ],
    });

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee", "Gabi & Jules", "BAK'D Cookies"]);
    // The one malformed field costs that one field and nothing else.
    expect(out.leads[1].connection_type).toBe("none");
    expect(out.leads[0].connection_type).toBe("ecosystem");
    expect(out.leads[2].connection_type).toBe("ecosystem");
  });

  test("keeps a batch in which one lead omits every optional field", async () => {
    const out = await runWithStructuredResponse({ leads: [rawLead(), { company: "Corner Bakery" }] });

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee", "Corner Bakery"]);
    expect(out.leads[1].fit_score).toBeNull();
  });

  // A wrong type never reaches the record, but it costs the field it is in --
  // and, when the record has no usable name, only that record. See
  // tests/agent-lead-defects.test.ts for the full class.
  test("still keeps a wrong type out of the record", async () => {
    const out = await runWithStructuredResponse({ leads: [rawLead({ fit_score: "ninety-five" })] });

    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].fit_score).toBeNull();
  });

  // A schema rejection, a rate limit and an unparseable body used to reach the
  // user as the same generic sentence.
  test("says why the structuring step failed instead of a generic message", async () => {
    stub.chatJSON
      .mockImplementationOnce(respondsWith(PLAN))
      .mockRejectedValueOnce(new Error("OpenRouter 429: rate limited"));
    const { emit, out } = collector();

    await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);

    expect(out.leads).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("429");
  });

  // Replays the exact distribution the live-test report measured across the 17
  // runs that reached the structuring step: 9 bare arrays, 8 wrapped objects.
  test("no run in the measured 9-bare/8-wrapped distribution is discarded", async () => {
    const payloads: unknown[] = [
      ...Array.from({ length: 9 }, () => [rawLead()]),
      ...Array.from({ length: 8 }, () => ({ leads: [rawLead()] })),
    ];

    let productive = 0;
    for (const payload of payloads) {
      const out = await runWithStructuredResponse(payload);
      if (out.leads.length > 0 && out.errors.length === 0) productive++;
    }

    expect(productive).toBe(17);
  });
});

// The same single reading recoverValue applies to every other field, one level
// up at the envelope: a lone lead where a list was asked for is a slip, not an
// ambiguity. This payload arrives after the searches and the reasoning stage, so
// discarding it costs the whole run's work.
describe("a lone lead where a list was asked for", () => {
  test("produces the lead when the envelope wraps a single object", async () => {
    const out = await runWithStructuredResponse({ leads: rawLead() });

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
    expect(out.events.some((e) => e.type === "done" && e.count === 1)).toBe(true);
  });

  test("produces the lead when the response is a bare single lead object", async () => {
    const out = await runWithStructuredResponse(
      rawLead({ company: "Gabi & Jules", website: "https://gabiandjules.com/pages/about-us", source_index: 2 })
    );

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Gabi & Jules"]);
    expect(out.events.some((e) => e.type === "done" && e.count === 1)).toBe(true);
  });

  // The announcement is whatever this run says that an identical run whose leads
  // already arrived as a list does not. Asserted as that difference so the test
  // fails if the recovery stops being announced, rather than on a phrase a
  // successful run happens to contain anyway.
  test("announces the reading instead of repairing it silently", async () => {
    const lone = await runWithStructuredResponse({ leads: rawLead() });
    const asList = await runWithStructuredResponse({ leads: [rawLead()] });

    expect(lone.leads.map((l) => l.company)).toEqual(asList.leads.map((l) => l.company));
    const announced = lone.statuses.filter((s) => !asList.statuses.includes(s));
    expect(announced).toHaveLength(1);
    expect(
      lone.events.some((e) => e.type === "status" && e.step === "structure" && e.message === announced[0])
    ).toBe(true);
  });

  test("says nothing when the list arrives as a list", async () => {
    const out = await runWithStructuredResponse({ leads: [rawLead()] });

    expect(out.statuses.some((s) => s.includes("list of one"))).toBe(false);
  });

  // Nothing lead-shaped means the next step has nothing to act on, which is a
  // real stop and stays one.
  test("stops when the lone object is not a lead", async () => {
    const out = await runWithStructuredResponse({ leads: { note: "nothing found" } });

    expect(out.leads).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.events.some((e) => e.type === "done")).toBe(false);
  });

  test("stops when the envelope carries a lone non-object", async () => {
    const out = await runWithStructuredResponse({ leads: "no suitable sponsors" });

    expect(out.leads).toEqual([]);
    expect(out.errors).toHaveLength(1);
  });
});

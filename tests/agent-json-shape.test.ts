import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

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

async function runWithStructuredResponse(structured: unknown) {
  stub.chatJSON.mockResolvedValueOnce(PLAN).mockResolvedValueOnce(structured);
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
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

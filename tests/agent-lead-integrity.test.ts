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

// A multi-company trace of exactly the kind agent.ts forbids inside a lead.
const SHARED_TRACE =
  "Comparing all three: Renaissance Coffee is stronger than Gabi & Jules, and the LinkedIn post is weakest.";

beforeEach(() => {
  vi.clearAllMocks();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: SHARED_TRACE, content: "" });
});

async function runWithLead(over: Record<string, unknown>) {
  stub.chatJSON.mockResolvedValueOnce(PLAN).mockResolvedValueOnce({ leads: [rawLead(over)] });
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out.leads[0];
}

describe("per-lead reasoning", () => {
  test("never carries the shared multi-company trace", async () => {
    const lead = await runWithLead({ reasoning: null });

    expect(lead.reasoning ?? "").not.toContain(SHARED_TRACE);
    expect(lead.reasoning ?? "").not.toContain("Gabi & Jules");
  });

  test("keeps the model's per-company reasoning when it is present", async () => {
    const lead = await runWithLead({ reasoning: "Renaissance Coffee is a campus institution." });

    expect(lead.reasoning).toBe("Renaissance Coffee is a campus institution.");
  });

  test("is empty rather than borrowed when nothing company-specific exists", async () => {
    const lead = await runWithLead({ reasoning: "   ", why_fit: null });

    expect(lead.reasoning).toBeNull();
  });
});

describe("source attribution", () => {
  test("drops the source when source_index is past the end of the candidates", async () => {
    const lead = await runWithLead({ source_index: 99, website: null });

    expect(lead.sources).toEqual([]);
    expect(lead.website).toBeNull();
  });

  test("drops the source when source_index is missing", async () => {
    const lead = await runWithLead({ source_index: undefined, website: null });

    expect(lead.sources).toEqual([]);
  });

  test("drops the source when source_index is not a whole number", async () => {
    const lead = await runWithLead({ source_index: 2.5, website: null });

    expect(lead.sources).toEqual([]);
  });

  test("keeps a source that is genuinely in range", async () => {
    const lead = await runWithLead({ source_index: 2, website: null });

    expect(lead.sources).toEqual([
      { url: "https://gabiandjules.com/pages/about-us", title: "Gabi & Jules" },
    ]);
    expect(lead.website).toBe("https://gabiandjules.com");
  });

  // The live-test report's captured near-miss: BAK'D Cookies had website:null and
  // a source_index pointing at a LinkedIn post, which would have been persisted
  // as the company's own website.
  test("does not turn a social or aggregator source into the company website", async () => {
    const lead = await runWithLead({ company: "BAK'D Cookies", source_index: 3, website: null });

    expect(lead.website).toBeNull();
    expect(lead.sources).toEqual([
      { url: "https://www.linkedin.com/posts/ophelia-yu_sfugivingday", title: "SFU Giving Day post" },
    ]);
  });
});

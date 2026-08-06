import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";
import { lookups } from "./helpers/dns";

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
  lookups.length = 0;
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

async function runWithLead(over: Record<string, unknown>) {
  stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith({ leads: [rawLead(over)] }));
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
}

describe("model-claimed company website", () => {
  test("keeps a claimed website whose domain resolves", async () => {
    const out = await runWithLead({ website: "https://renaissancecoffeesfu.com/" });

    expect(out.leads[0].website).toBe("https://renaissancecoffeesfu.com/");
    expect(out.leads[0].website_status).toBeNull();
  });

  // momentenergy.co: the fabricated domain the live-test report caught. Its real
  // domain is momentenergy.ca.
  test("does not persist a claimed domain that does not resolve", async () => {
    const out = await runWithLead({ website: "https://momentenergy.co", source_index: 99 });

    expect(out.leads[0].website).toBeNull();
    expect(out.leads[0].website_status).toContain("momentenergy.co");
    expect(out.leads[0].website_status).toMatch(/the model claimed/i);
  });

  test("does not persist a claimed social or directory page as the company site", async () => {
    const out = await runWithLead({ website: "https://www.linkedin.com/company/bakd", source_index: 3 });

    expect(out.leads[0].website).toBeNull();
    expect(out.leads[0].website_status).toContain("linkedin.com/company/bakd");
    // An aggregator host is refused on its face, without spending a lookup.
    expect(lookups).toEqual([]);
  });

  // Live evidence from the structuring model: a hedged, narrated answer that
  // used to be persisted verbatim as the company's website.
  test("does not persist a hedged narrated answer as a website", async () => {
    const out = await runWithLead({
      website: "https://renaissancecoffee.ca/ (example website)",
      source_index: 99,
    });

    expect(out.leads[0].website).toBeNull();
    expect(out.leads[0].website_status).toContain("(example website)");
  });

  test("keeps the lead itself when its claimed website cannot be verified", async () => {
    const out = await runWithLead({ website: "https://momentenergy.co", source_index: 99 });

    expect(out.errors).toEqual([]);
    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].company).toBe("Renaissance Coffee");
  });

  // The surviving website and the rejected claim sit on the record together, so
  // the note has to name the model as the source of the string it is about --
  // otherwise it reads as a warning about the site that is being shown.
  test("falls back to the researched source hostname and says whose claim was rejected", async () => {
    const out = await runWithLead({ company: "Gabi & Jules", website: "https://gabiandjules.co", source_index: 2 });

    expect(out.leads[0].website).toBe("https://gabiandjules.com");
    expect(out.leads[0].website_status).toContain("the model claimed https://gabiandjules.co");
    expect(out.leads[0].website_status).toMatch(/rejected/i);
    expect(out.leads[0].website_status).not.toContain("https://gabiandjules.com,");
  });

  test("still uses the source hostname when the model claims no website", async () => {
    const out = await runWithLead({ website: null, source_index: 2 });

    expect(out.leads[0].website).toBe("https://gabiandjules.com");
    expect(out.leads[0].website_status).toBeNull();
  });

  test("spends one lookup for a domain a run sees twice", async () => {
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(
      respondsWith({
        leads: [
          rawLead({ company: "A", website: "https://gabiandjules.com" }),
          rawLead({ company: "B", website: "https://gabiandjules.com/about", contact_email: "hi@gabiandjules.com" }),
        ],
      })
    );
    const { emit } = collector();

    await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);

    expect(lookups).toEqual(["gabiandjules.com"]);
  });
});

import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

// Records how many lookups were ever in flight at the same moment. Verified one
// lead at a time, each lookup finishes before the next begins and the peak is 1;
// verified together, every lookup is outstanding at once. This is the property
// itself, not a stand-in for it, so it does not depend on any timeout.
const dns = vi.hoisted(() => ({
  inFlight: 0,
  peakInFlight: 0,
  looked: [] as string[],
}));

vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async (domain: string) => {
      dns.looked.push(domain);
      dns.inFlight += 1;
      dns.peakInFlight = Math.max(dns.peakInFlight, dns.inFlight);
      try {
        await Promise.resolve();
        throw new Error("ENOTFOUND");
      } finally {
        dns.inFlight -= 1;
      }
    },
    resolve4: async () => {
      throw new Error("ENOTFOUND");
    },
    resolve6: async () => {
      throw new Error("ENOTFOUND");
    },
  },
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

const DOMAINS = ["one-dead.example", "two-dead.example", "three-dead.example", "four-dead.example"];

beforeEach(() => {
  vi.clearAllMocks();
  dns.inFlight = 0;
  dns.peakInFlight = 0;
  dns.looked.length = 0;
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

describe("contact-detail verification latency", () => {
  // The reasoning budget is sized against a 60s serverless limit, so N dead
  // domains must cost one timeout window rather than N.
  test("has every lead's lookup in flight at once rather than one at a time", async () => {
    const leads = DOMAINS.map((domain, i) =>
      rawLead({ company: `Dead ${i}`, website: null, source_index: 99, contact_email: `hello@${domain}` })
    );
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith({ leads }));
    const { emit } = collector();

    await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);

    expect([...dns.looked].sort()).toEqual([...DOMAINS].sort());
    expect(dns.peakInFlight).toBe(DOMAINS.length);
  });

  test("keeps every lead and withholds only the unusable address", async () => {
    const leads = DOMAINS.map((domain, i) =>
      rawLead({ company: `Dead ${i}`, website: null, source_index: 99, contact_email: `hello@${domain}` })
    );
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith({ leads }));
    const { emit, out } = collector();

    await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);

    expect(out.leads).toHaveLength(DOMAINS.length);
    for (const lead of out.leads) {
      expect(lead.contact_email).toBeNull();
      expect(lead.contact_email_status).toMatch(/unverified/i);
    }
  });
});

import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

// A resolver that only answers once every distinct domain in the batch is in
// flight at the same time. Verified one lead at a time, the first lookup waits
// on lookups that have not started yet and the run stalls out; verified
// together, the whole batch clears in a single window.
const barrier = vi.hoisted(() => {
  const inFlight = new Set<string>();
  let release = () => {};
  const open = new Promise<void>((r) => {
    release = r;
  });
  return { inFlight, open, arrive: (d: string, size: number) => {
    inFlight.add(d);
    if (inFlight.size >= size) release();
  } };
});

const DOMAINS = ["one-dead.example", "two-dead.example", "three-dead.example", "four-dead.example"];

vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async (domain: string) => {
      barrier.arrive(domain, DOMAINS.length);
      await barrier.open;
      throw new Error("ENOTFOUND");
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

beforeEach(() => {
  vi.clearAllMocks();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

describe("contact-detail verification latency", () => {
  // The reasoning budget is sized against a 60s serverless limit, so N dead
  // domains must cost one timeout window rather than N.
  test("verifies every lead in the batch concurrently", async () => {
    const leads = DOMAINS.map((domain, i) =>
      rawLead({ company: `Dead ${i}`, website: null, source_index: 99, contact_email: `hello@${domain}` })
    );
    stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith({ leads }));
    const { emit, out } = collector();

    await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);

    expect(out.leads).toHaveLength(DOMAINS.length);
    // Every lead is kept; only the unusable address is withheld.
    for (const lead of out.leads) {
      expect(lead.contact_email).toBeNull();
      expect(lead.contact_email_status).toMatch(/unverified/i);
    }
  });
});

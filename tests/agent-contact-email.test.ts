import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
  mxLookups: [] as string[],
}));

// Only gabiandjules.com can receive mail. Nothing here touches the network.
vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async (domain: string) => {
      stub.mxLookups.push(domain);
      if (domain === "gabiandjules.com") return [{ exchange: "aspmx.l.google.com", priority: 1 }];
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
  stub.mxLookups.length = 0;
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

async function runWithLeads(leads: Record<string, unknown>[]) {
  stub.chatJSON.mockResolvedValueOnce(PLAN).mockResolvedValueOnce({ leads });
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
}

describe("contact email persistence", () => {
  test("keeps an address whose domain can receive mail", async () => {
    const out = await runWithLeads([
      rawLead({ company: "Gabi & Jules", contact_email: "hello@gabiandjules.com", source_index: 2 }),
    ]);

    expect(out.leads[0].contact_email).toBe("hello@gabiandjules.com");
    expect(out.leads[0].contact_email_status).toBeNull();
  });

  test("keeps the lead but not the address when the domain cannot receive mail", async () => {
    const out = await runWithLeads([rawLead({ contact_email: "hello@momentenergy.co" })]);

    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].company).toBe("Renaissance Coffee");
    expect(out.leads[0].contact_email).toBeNull();
    expect(out.leads[0].contact_email_status).toContain("hello@momentenergy.co");
    expect(out.leads[0].contact_email_status).toMatch(/unverified/i);
  });

  // These three assert the exact lookups an email costs, so their leads claim no
  // website: a website claim is verified through the same shared resolver.
  test("keeps the lead but not the address when the format is wrong", async () => {
    const out = await runWithLeads([rawLead({ contact_email: "contact page on their website", website: null })]);

    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].contact_email).toBeNull();
    expect(out.leads[0].contact_email_status).toContain("contact page on their website");
    expect(stub.mxLookups).toEqual([]);
  });

  test("leaves a lead with no address alone and spends no lookup", async () => {
    const out = await runWithLeads([rawLead({ contact_email: null, website: null })]);

    expect(out.leads[0].contact_email).toBeNull();
    expect(out.leads[0].contact_email_status).toBeNull();
    expect(stub.mxLookups).toEqual([]);
  });

  test("looks a repeated domain up only once across a run", async () => {
    await runWithLeads([
      rawLead({ company: "A", contact_email: "a@gabiandjules.com", source_index: 2, website: null }),
      rawLead({ company: "B", contact_email: "b@gabiandjules.com", source_index: 2, website: null }),
    ]);

    expect(stub.mxLookups).toEqual(["gabiandjules.com"]);
  });
});

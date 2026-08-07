import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";
import { resetLedger } from "./helpers/ledger";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

// A stand-in for the leads table. Nothing here reaches a real project: the
// module is replaced wholesale, and `rejectFor` reproduces what Supabase returns
// when the additive column migrations in supabase-setup.sql have not been run.
const db = vi.hoisted(() => ({
  rejectFor: new Set<string>(),
  message: 'column "website_status" of relation "enactus_leads" does not exist',
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());
vi.mock("@/lib/supabase", async (orig) => {
  const actual = await orig<typeof import("@/lib/supabase")>();
  const { ledger, spendTable } = await import("./helpers/ledger");
  const table = (name: string) => {
    // The budget gate reads the ledger before the run starts, and that read has
    // a shape of its own.
    if (name === actual.SPEND) return spendTable(name);
    let pending: Record<string, unknown> = {};
    const api = {
      insert(row: Record<string, unknown>) {
        pending = row;
        return api;
      },
      select: () => api,
      eq: () => api,
      order: () => api,
      limit: async () => ({ data: [], error: null }),
      single: async () => {
        if (name !== actual.LEADS) return { data: { id: "search-1" }, error: null };
        if (db.rejectFor.has(String(pending.company))) return { data: null, error: { message: db.message } };
        db.inserted.push(pending);
        return {
          data: { id: `db-${db.inserted.length}`, board_order: 0, created_at: "t0", updated_at: "t0", ...pending },
          error: null,
        };
      },
    };
    return api;
  };
  return { ...actual, hasServiceKey: () => ledger.hasServiceKey, supabaseAdmin: { from: table } };
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

const { runAgent } = await import("@/lib/agent");

beforeEach(() => {
  vi.clearAllMocks();
  resetLedger();
  db.rejectFor.clear();
  db.inserted.length = 0;
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

async function runWithLeads(leads: unknown[]) {
  stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith({ leads }));
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
}

function doneEvent(out: ReturnType<typeof collector>["out"]) {
  const done = out.events.find((e) => e.type === "done");
  if (done?.type !== "done") throw new Error("the run never finished");
  return done;
}

describe("a lead the database accepted", () => {
  test("is reported as saved and carries the row the database returned", async () => {
    const out = await runWithLeads([rawLead()]);

    expect(out.errors).toEqual([]);
    expect(out.leads[0].id).toBe("db-1");
    expect(doneEvent(out)).toMatchObject({ count: 1, saved: 1 });
  });
});

// The board looking full and being empty on reload is the failure this whole
// change exists to end; a swallowed insert error is the same defect wearing a
// database's clothes rather than a model's.
describe("a lead the database rejected", () => {
  test("is never counted as saved", async () => {
    db.rejectFor.add("Renaissance Coffee");

    const out = await runWithLeads([rawLead()]);

    expect(doneEvent(out)).toMatchObject({ count: 1, saved: 0 });
  });

  test("is reported with the database's own explanation", async () => {
    db.rejectFor.add("Renaissance Coffee");

    const out = await runWithLeads([rawLead()]);

    expect(out.statuses.some((s) => s.includes("Renaissance Coffee") && s.includes("website_status"))).toBe(true);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/could not be written/i);
    expect(out.errors[0]).toMatch(/alter table/i);
  });

  test("costs only itself: the leads the database took are still saved", async () => {
    db.rejectFor.add("Gabi & Jules");

    const out = await runWithLeads([
      rawLead(),
      rawLead({ company: "Gabi & Jules", source_index: 2 }),
      rawLead({ company: "BAK'D Cookies", source_index: 1 }),
    ]);

    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee", "Gabi & Jules", "BAK'D Cookies"]);
    expect(db.inserted.map((r) => r.company)).toEqual(["Renaissance Coffee", "BAK'D Cookies"]);
    expect(doneEvent(out)).toMatchObject({ count: 3, saved: 2 });
    expect(out.errors[0]).toContain("1 of 3");
  });

  test("is still shown, so the work is not lost from the screen", async () => {
    db.rejectFor.add("Renaissance Coffee");

    const out = await runWithLeads([rawLead()]);

    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].company).toBe("Renaissance Coffee");
  });
});

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// The draft route seen from the two operating parameters it now carries: it is
// written to be sent from an SFU inbox, and it stops when the month's budget is
// gone. Neither may interfere with a draft that should simply work.

const stub = vi.hoisted(() => ({ chatJSON: vi.fn() }));

const LEAD = {
  id: "lead-1",
  company: "Renaissance Coffee",
  contact_email: "hello@renaissancecoffeesfu.com",
  mode: "sponsor",
  connection_type: "ecosystem",
  sponsorship_type: ["in_kind"],
};

const db = vi.hoisted(() => ({ spentUsd: 0, logged: [] as Record<string, unknown>[] }));

vi.mock("@/lib/auth", () => ({ getSession: async () => ({ name: "Nikita" }) }));
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  chatJSON: stub.chatJSON,
}));
vi.mock("@/lib/supabase", async (orig) => {
  const actual = await orig<typeof import("@/lib/supabase")>();
  const table = (name: string) => {
    const api = {
      insert(row: Record<string, unknown>) {
        if (name === actual.ACTIVITY) db.logged.push(row);
        return api;
      },
      select: () => api,
      eq: () => api,
      single: async () => ({ data: name === actual.LEADS ? LEAD : { id: "draft-1" }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          name === actual.SPEND ? { data: [{ cost_usd: db.spentUsd }], error: null } : { data: null, error: null }
        ).then(resolve),
    };
    return api;
  };
  return { ...actual, hasServiceKey: () => true, supabaseAdmin: { from: table } };
});

const budget = await import("@/lib/budget");
const { POST } = await import("@/app/api/email/draft/route");

beforeEach(() => {
  vi.clearAllMocks();
  db.spentUsd = 0;
  db.logged = [];
  budget.resetSpendCacheForTests();
  vi.stubEnv("OUTREACH_FROM_EMAIL", "enactus@sfu.ca");
  stub.chatJSON.mockResolvedValue({ subject: "Coffee for Enactus SFU", body: "Hi there, could we borrow 15 minutes?" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function draft() {
  const res = await POST(
    new Request("http://test/api/email/draft", { method: "POST", body: JSON.stringify({ leadId: LEAD.id }) })
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("the draft is written to be sent from an SFU inbox", () => {
  test("returns the SFU address the human will send from", async () => {
    const { status, json } = await draft();

    expect(status).toBe(200);
    expect(json.from).toBe("enactus@sfu.ca");
    expect(json.fromConfigured).toBe(true);
  });

  test("signs off with the sender, the club and that address", async () => {
    const { json } = await draft();

    expect(json.body).toBe("Hi there, could we borrow 15 minutes?\n\nNikita\nExternal Relations, Enactus SFU\nenactus@sfu.ca");
  });

  // The model is told not to write a sign-off, because an address is a fact and
  // a model asked for one invents one.
  test("tells the model to leave the sign-off alone", async () => {
    await draft();

    const system = stub.chatJSON.mock.calls[0][0][0].content as string;
    expect(system).toMatch(/do NOT write a sign-off/i);
    expect(system).toContain("Simon Fraser University email address");
  });

  test("says so, and still drafts, when no SFU address is configured", async () => {
    vi.stubEnv("OUTREACH_FROM_EMAIL", "");

    const { status, json } = await draft();

    expect(status).toBe(200);
    expect(json.body).toContain("Hi there, could we borrow 15 minutes?");
    expect(json.fromConfigured).toBe(false);
    expect((json.notes as string[]).some((n) => n.includes("OUTREACH_FROM_EMAIL"))).toBe(true);
  });

  test("refuses a configured address that is not an SFU one", async () => {
    vi.stubEnv("OUTREACH_FROM_EMAIL", "enactussfu@gmail.com");

    const { json } = await draft();

    expect(json.from).not.toContain("gmail.com");
    expect(json.body).not.toContain("gmail.com");
    expect((json.notes as string[]).some((n) => n.includes("sfu.ca"))).toBe(true);
  });
});

describe("the monthly cap reaches drafting too", () => {
  test("drafts normally while there is budget, which is the common case", async () => {
    const { status } = await draft();

    expect(status).toBe(200);
    expect(stub.chatJSON).toHaveBeenCalled();
  });

  test("stops with the cap and the spend once the month is gone", async () => {
    db.spentUsd = budget.capUsd();
    budget.resetSpendCacheForTests();

    const { status, json } = await draft();

    expect(status).toBe(402);
    expect(json.error).toContain("$20.00 CAD");
    expect(json.subject).toBeUndefined();
    expect(stub.chatJSON).not.toHaveBeenCalled();
  });
});

describe("the draft is attributed to whoever is signed in", () => {
  test("records the name, the action and the lead, and nothing from the email", async () => {
    await draft();

    expect(db.logged).toHaveLength(1);
    expect(db.logged[0]).toMatchObject({
      actor_name: "Nikita",
      action: "draft_generated",
      subject_type: "draft",
    });
    const written = JSON.stringify(db.logged[0]);
    expect(written).not.toContain("could we borrow 15 minutes");
    expect(written).not.toContain("Coffee for Enactus SFU");
  });
});

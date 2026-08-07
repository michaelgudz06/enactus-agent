import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { resetLedger } from "./helpers/ledger";

const stub = vi.hoisted(() => ({ chatJSON: vi.fn() }));

const LEAD = {
  id: "lead-1",
  company: "Renaissance Coffee",
  contact_email: "hello@renaissancecoffeesfu.com",
  mode: "sponsor",
  connection_type: "ecosystem",
  sponsorship_type: ["in_kind"],
};

vi.mock("@/lib/auth", () => ({ getSession: async () => ({ name: "Tester" }) }));
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  chatJSON: stub.chatJSON,
}));
vi.mock("@/lib/supabase", async () => {
  // Enough of the query builder for the reads and inserts the route makes: the
  // lead, the draft row and the attribution line. The spend ledger the budget
  // gate reads is the shared double, so this file does not restate how a month
  // is read. Nothing here reaches a real project.
  const { ledger, spendTable } = await import("./helpers/ledger");
  const single = async () => ({ data: LEAD, error: null });
  const builder = {
    select: () => builder,
    eq: () => builder,
    insert: () => builder,
    single,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  const SPEND = "enactus_api_spend";
  return {
    hasServiceKey: () => ledger.hasServiceKey,
    LEADS: "enactus_leads",
    DRAFTS: "enactus_email_drafts",
    SPEND,
    ACTIVITY: "enactus_activity_log",
    supabaseAdmin: { from: (name: string) => (name === SPEND ? spendTable(name) : builder) },
  };
});

const { POST } = await import("@/app/api/email/draft/route");

beforeEach(() => {
  vi.resetAllMocks();
  resetLedger();
  // A configured SFU inbox, so these tests see only the model's own defects.
  // The unconfigured and non-SFU cases are covered in outreach-sender.test.ts.
  vi.stubEnv("OUTREACH_FROM_EMAIL", "enactus@sfu.ca");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// The sign-off is written by code, so every usable body ends with it.
const SIGNATURE = "Tester\nExternal Relations, Enactus SFU\nenactus@sfu.ca";

async function draftFrom(response: unknown) {
  stub.chatJSON.mockResolvedValueOnce(response);
  const res = await POST(new Request("http://test/api/email/draft", { method: "POST", body: JSON.stringify({ leadId: LEAD.id }) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// The same rule one level down from the plan: a field the model sent in the
// wrong type costs that field, not the draft a human was waiting for.
describe("a defective draft field costs that field only", () => {
  test("keeps a usable body when the subject came back the wrong type", async () => {
    const { status, json } = await draftFrom({ subject: 42, body: "Hi there, we would love 15 minutes." });

    expect(status).toBe(200);
    expect(json.body).toBe(`Hi there, we would love 15 minutes.\n\n${SIGNATURE}`);
    // The subject falls back rather than taking the request down with it.
    expect(json.subject).toBe("Enactus SFU x Renaissance Coffee");
  });

  test("keeps a usable subject when the body came back the wrong type", async () => {
    const { status, json } = await draftFrom({ subject: "Enactus SFU x Renaissance Coffee", body: ["a", "b"] });

    expect(status).toBe(200);
    expect(json.subject).toBe("Enactus SFU x Renaissance Coffee");
    expect(json.body).toBe("");
  });

  test("announces what the draft lost", async () => {
    const { json } = await draftFrom({ subject: 42, body: "Hi there." });

    const notes = json.notes as string[];
    expect(notes.some((n) => n.includes("subject") && n.includes("42"))).toBe(true);
  });

  test("says nothing about a draft that is clean", async () => {
    const { json } = await draftFrom({ subject: "Enactus SFU x you", body: "Hi there." });

    expect(json.notes).toEqual([]);
    expect(json.subject).toBe("Enactus SFU x you");
  });

  // Nothing object-shaped came back, so there is no field to keep. That is a
  // real stop, and it says what arrived instead.
  test("stops when the response is not a draft object at all", async () => {
    const { status, json } = await draftFrom("Subject: hello");

    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });
});

function notesAbout(json: Record<string, unknown>, field: string): string[] {
  return (json.notes as string[]).filter((n) => n.includes(field));
}

// A field that is a string and still says nothing is the same loss as a
// wrong-typed one: the human gets a subject line the code wrote. The whole
// class, whichever way the field came back empty.
describe("a draft field with nothing in it is announced too", () => {
  const EMPTY_SUBJECTS: Record<string, Record<string, unknown>> = {
    "the model sent an empty string": { subject: "", body: "Hi there." },
    "the model sent only whitespace": { subject: "   ", body: "Hi there." },
    "the model omitted the field": { body: "Hi there." },
  };

  for (const [shape, response] of Object.entries(EMPTY_SUBJECTS)) {
    test(`notes the substituted subject when ${shape}`, async () => {
      const { status, json } = await draftFrom(response);

      expect(status).toBe(200);
      expect(json.subject).toBe("Enactus SFU x Renaissance Coffee");
      expect(json.body).toBe(`Hi there.\n\n${SIGNATURE}`);
      expect(notesAbout(json, "subject")).toHaveLength(1);
    });
  }

  test("notes an empty body, which the sender would otherwise send blank", async () => {
    const { status, json } = await draftFrom({ subject: "Enactus SFU x you", body: "" });

    expect(status).toBe(200);
    expect(json.body).toBe("");
    expect(notesAbout(json, "body")).toHaveLength(1);
    expect(notesAbout(json, "subject")).toEqual([]);
  });

  // The wrong-typed field is already reported by the field review, so the
  // fallback must not report it a second time.
  test("reports a wrong-typed field once, not once per check", async () => {
    const { json } = await draftFrom({ subject: 42, body: "Hi there." });

    expect(notesAbout(json, "subject")).toHaveLength(1);
  });
});

// The mirror of the reading the leads envelope already applies: a list of one
// where a single record was asked for is that record. This model wraps its
// output in a bare array often enough to have been measured on the leads call.
describe("a draft wrapped in a list of one", () => {
  const WRAPPED = [{ subject: "Coffee for Enactus SFU", body: "Hi there, could we borrow 15 minutes?" }];

  test("returns the subject and body the wrapper carried", async () => {
    const { status, json } = await draftFrom(WRAPPED);

    expect(status).toBe(200);
    expect(json.subject).toBe(WRAPPED[0].subject);
    expect(json.body).toBe(`${WRAPPED[0].body}\n\n${SIGNATURE}`);
  });

  test("announces the unwrap, which the same draft unwrapped does not", async () => {
    const wrapped = await draftFrom(WRAPPED);
    const plain = await draftFrom(WRAPPED[0]);

    expect(wrapped.json.subject).toBe(plain.json.subject);
    expect(wrapped.json.body).toBe(plain.json.body);
    expect((wrapped.json.notes as string[]).length).toBe((plain.json.notes as string[]).length + 1);
  });

  // Every other shape carries no single draft to act on, so the stop stands.
  const NOT_A_DRAFT: Record<string, unknown> = {
    "a number": 42,
    "nothing at all": null,
    "an empty list": [],
    "a list of several drafts": [WRAPPED[0], { subject: "Second", body: "Also hi." }],
    "a list of one non-draft": ["Subject: hello"],
  };

  for (const [shape, response] of Object.entries(NOT_A_DRAFT)) {
    test(`stops on ${shape}`, async () => {
      const { status, json } = await draftFrom(response);

      expect(status).toBe(502);
      expect(json.error).toBeTruthy();
      expect(json.subject).toBeUndefined();
    });
  }
});

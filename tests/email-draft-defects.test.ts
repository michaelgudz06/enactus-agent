import { describe, test, expect, beforeEach, vi } from "vitest";

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
vi.mock("@/lib/supabase", () => {
  // Enough of the query builder for the one read and the one insert the route
  // makes. Nothing here reaches a real project.
  const single = async () => ({ data: LEAD, error: null });
  const builder = {
    select: () => builder,
    eq: () => builder,
    insert: () => builder,
    single,
  };
  return {
    hasServiceKey: () => true,
    LEADS: "enactus_leads",
    DRAFTS: "enactus_email_drafts",
    supabaseAdmin: { from: () => builder },
  };
});

const { POST } = await import("@/app/api/email/draft/route");

beforeEach(() => {
  vi.resetAllMocks();
});

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
    expect(json.body).toBe("Hi there, we would love 15 minutes.");
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
      expect(json.body).toBe("Hi there.");
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

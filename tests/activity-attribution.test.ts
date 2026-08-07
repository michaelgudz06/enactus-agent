import { describe, test, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  failWith: null as string | null,
  hasKey: true,
}));

vi.mock("@/lib/supabase", async (orig) => {
  const actual = await orig<typeof import("@/lib/supabase")>();
  const table = (name: string) => ({
    insert: async (row: Record<string, unknown>) => {
      if (db.failWith) return { data: null, error: { message: db.failWith } };
      db.rows.push({ table: name, ...row });
      return { data: null, error: null };
    },
  });
  return { ...actual, hasServiceKey: () => db.hasKey, supabaseAdmin: { from: table } };
});

const { logActivity, scrubDetail, REDACTED } = await import("@/lib/activity");
const { ACTIVITY } = await import("@/lib/supabase");

beforeEach(() => {
  db.rows = [];
  db.failWith = null;
  db.hasKey = true;
});

describe("who did it", () => {
  test("records the signed-in name against the action and the record", async () => {
    const result = await logActivity({
      actor: "Nikita",
      action: "lead_created",
      subject: "lead",
      subjectId: "lead-1",
      detail: { company: "Renaissance Coffee", mode: "sponsor" },
    });

    expect(result).toEqual({ logged: true, error: null });
    expect(db.rows[0]).toMatchObject({
      table: ACTIVITY,
      actor_name: "Nikita",
      action: "lead_created",
      subject_type: "lead",
      subject_id: "lead-1",
      detail: { company: "Renaissance Coffee", mode: "sponsor" },
    });
  });

  // Attribution failing must not undo the work the human already did, and must
  // not pretend either: same rule persistLead follows.
  test("never throws, and says when the row was not written", async () => {
    db.failWith = 'relation "enactus_activity_log" does not exist';

    const result = await logActivity({ actor: "Nikita", action: "signed_in", subject: "session" });

    expect(result.logged).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  test("reports nothing written when there is no database to write to", async () => {
    db.hasKey = false;

    expect(await logActivity({ actor: "Nikita", action: "signed_in", subject: "session" })).toEqual({
      logged: false,
      error: null,
    });
  });
});

// NO CREDENTIAL EVER ENTERS THIS TABLE. The scrub is the enforcement, not the
// call sites: a future one that has never read src/lib/activity.ts still cannot
// write a key into it.
describe("nothing secret reaches the log", () => {
  const BY_KEY: Record<string, string> = {
    api_key: "sk-or-v1-abcdefabcdefabcdefabcdef",
    access_token: "ya29.a0AfB_xyz",
    session_cookie: "enactus_session=abc.def",
    password: "hunter2",
    authorization: "Bearer abcdef123456",
    secret: "anything",
    body: "Hi Jessica, we would love 15 minutes to talk about Nourish.",
    subject_line: "Enactus SFU x BAK'D Cookies",
    prompt: "find me catering companies in burnaby",
    // Not credentials, but not attribution either: a business contact's own
    // details belong on the lead, not in an audit line about who clicked.
    contact_name: "Jessica Nguyen",
    recipient_email: "hello@bakdcookies.com",
  };

  for (const [key, value] of Object.entries(BY_KEY)) {
    test(`redacts anything called ${key}`, async () => {
      await logActivity({ actor: "Nikita", action: "draft_generated", subject: "draft", detail: { [key]: value } });

      expect((db.rows[0].detail as Record<string, unknown>)[key]).toBe(REDACTED);
    });
  }

  const BY_VALUE: Record<string, string> = {
    "an OpenRouter key": "sk-or-v1-0123456789abcdef0123456789abcdef",
    "a bearer header": "Bearer eyJhbGciOiJIUzI1NiJ9",
    "a JWT": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    "an AWS key id": "AKIAIOSFODNN7EXAMPLE",
    "a long opaque blob": "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9Q",
  };

  for (const [shape, value] of Object.entries(BY_VALUE)) {
    test(`redacts ${shape} even under an innocent name`, async () => {
      await logActivity({ actor: "Nikita", action: "lead_updated", subject: "lead", detail: { note: value } });

      expect((db.rows[0].detail as Record<string, unknown>).note).toBe(REDACTED);
    });
  }

  // The type says primitives; a call site handing this a parsed request body is
  // not bound by it, and a nested value is where a token or an email body would
  // ride in unread. The scrub is the enforcement, so it has to hold at runtime.
  test("redacts a nested object rather than writing it through", async () => {
    const patch = { note: "looks fine", authorization: "Bearer sk-or-v1-abcdefabcdef" };

    await logActivity({
      actor: "Nikita",
      action: "lead_updated",
      subject: "lead",
      detail: { patch } as unknown as Parameters<typeof logActivity>[0]["detail"],
    });

    const written = db.rows[0].detail as Record<string, unknown>;
    expect(written.patch).toBe(REDACTED);
    expect(JSON.stringify(written)).not.toContain("sk-or-v1");
  });

  test("redacts an array, a function and an undefined value the same way", () => {
    const scrubbed = scrubDetail({
      tags: ["one", "two"],
      later: () => "hi",
      missing: undefined,
    } as unknown as Parameters<typeof scrubDetail>[0]);

    expect(scrubbed).toEqual({ tags: REDACTED, later: REDACTED, missing: REDACTED });
  });

  // An email body under a harmless key is still an email body.
  test("redacts anything long enough to be prose", async () => {
    const paragraph = "Hi Jessica, ".repeat(20);

    expect(scrubDetail({ note: paragraph }).note).toBe(REDACTED);
  });

  test("leaves the things attribution is actually for alone", () => {
    expect(
      scrubDetail({ company: "BAK'D Cookies", lead: "8f14e45f", fields: "status,board_order", leads_saved: 3, from_configured: true })
    ).toEqual({
      company: "BAK'D Cookies",
      lead: "8f14e45f",
      fields: "status,board_order",
      leads_saved: 3,
      from_configured: true,
    });
  });

  test("a lead id survives, because it is what the line points at", () => {
    expect(scrubDetail({ lead: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }).lead).toBe(
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    );
  });
});

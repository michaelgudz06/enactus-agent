import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Outreach sends from an SFU inbox. When it cannot, the Gmail draft is still
// created -- a guard that stops a student drafting is worse than no guard -- but
// the draft carries no From address, so Gmail will send it from whichever Google
// account that student connected. That is the moment the ruling is quietly
// defeated, so it is the moment the warning has to arrive: one screen earlier,
// on the draft itself, is a note that may never have been read.

const gmail = vi.hoisted(() => ({ createDraft: vi.fn(async () => "gmail-draft-1") }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed-cookie" }), set: () => {} }),
}));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ name: "Nikita" }) }));
vi.mock("@/lib/gmail", async (orig) => ({
  ...(await orig<typeof import("@/lib/gmail")>()),
  hasGoogleConfig: () => true,
  readCookie: () => ({ access_token: "token", expiry: Date.now() + 3_600_000 }),
  ensureAccessToken: async (t: unknown) => t,
  createDraft: gmail.createDraft,
}));

const { POST } = await import("@/app/api/gmail/create/route");
const { requestGmailDraft } = await import("@/components/EmailModal");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function create() {
  const res = await POST(
    new Request("http://test/api/gmail/create", {
      method: "POST",
      body: JSON.stringify({ to: "hello@example.ca", subject: "S", body: "B", leadId: "lead-1" }),
    })
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** What the route asked Gmail to put in the From header, if anything. */
function fromHeader(): string | undefined {
  return (gmail.createDraft.mock.calls[0] as unknown as [string, { from?: string }])[1].from;
}

describe("the Gmail draft says which mailbox it will go out from", () => {
  test("warns, and creates the draft anyway, when no SFU address is configured", async () => {
    vi.stubEnv("OUTREACH_FROM_EMAIL", "");

    const { status, json } = await create();

    expect(status).toBe(200);
    expect(json.draftId).toBe("gmail-draft-1");
    expect(fromHeader()).toBeUndefined();
    const warning = json.senderWarning as string;
    expect(warning).toContain("OUTREACH_FROM_EMAIL is not set");
    expect(warning).toContain("whichever Google account you connected");
    expect(warning).toContain("sfu.ca");
  });

  test("says the address was refused when one is set but is not an SFU one", async () => {
    vi.stubEnv("OUTREACH_FROM_EMAIL", "enactussfu@gmail.com");

    const { json } = await create();

    expect(fromHeader()).toBeUndefined();
    const warning = json.senderWarning as string;
    expect(warning).toContain("not an @sfu.ca address");
    expect(warning).toContain("refused");
    expect(warning).toContain("whichever Google account you connected");
    // Never the refused value itself: repeating it reads like it was used.
    expect(warning).not.toContain("gmail.com");
  });

  // No nag on the healthy path.
  test("says nothing at all when the club's SFU inbox is configured", async () => {
    vi.stubEnv("OUTREACH_FROM_EMAIL", "enactus@sfu.ca");

    const { json } = await create();

    expect(fromHeader()).toBe("enactus@sfu.ca");
    expect(json.senderWarning).toBeNull();
  });
});

describe("the modal surfaces what the route returned", () => {
  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body } as Response;
  }

  const INPUT = { to: "hello@example.ca", subject: "S", body: "B", leadId: "lead-1" };

  test("carries the warning through to the student, next to the success line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, draftId: "gmail-draft-1", senderWarning: "Gmail will send it from your own account." })
      )
    );

    const result = await requestGmailDraft(INPUT);

    expect(result).toEqual({
      kind: "created",
      message: "Draft created in your Gmail. Open Gmail to review and send.",
      senderWarning: "Gmail will send it from your own account.",
    });
  });

  test("carries nothing when the route had nothing to say", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, draftId: "d", senderWarning: null })));

    const result = await requestGmailDraft(INPUT);

    expect(result).toEqual({
      kind: "created",
      message: "Draft created in your Gmail. Open Gmail to review and send.",
      senderWarning: "",
    });
  });

  // An unlinked Gmail account is not a failure to report, it is an OAuth trip.
  test("asks for a connection rather than reporting an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "connect", canConnect: true }, false, 428)));

    expect(await requestGmailDraft(INPUT)).toEqual({ kind: "connect" });
  });

  test("reports a failure in the route's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Gmail session expired." }, false, 500)));

    expect(await requestGmailDraft(INPUT)).toEqual({ kind: "failed", message: "Gmail session expired." });
  });
});

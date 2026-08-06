import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDraft, GMAIL_SCOPE } from "@/lib/gmail";

const originalFetch = globalThis.fetch;

function sentMime(): string {
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  const body = JSON.parse((call[1] as RequestInit).body as string);
  return Buffer.from(body.message.raw, "base64url").toString();
}

beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ id: "gmail-draft-1" }), { status: 200 })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the Gmail draft carries the SFU sender", () => {
  test("sets From to the configured SFU inbox", async () => {
    await createDraft("token", {
      to: "hello@example.ca",
      subject: "Enactus SFU x you",
      body: "Hi there.",
      from: "enactus@sfu.ca",
    });

    expect(sentMime()).toContain("From: enactus@sfu.ca");
  });

  // A placeholder in a MIME header is a malformed message, not a hint, so the
  // route only ever passes a real address and this omits the header otherwise.
  test("omits From entirely when there is no configured address", async () => {
    await createDraft("token", { to: "hello@example.ca", subject: "S", body: "B" });

    expect(sentMime()).not.toContain("From:");
    expect(sentMime()).toContain("To: hello@example.ca");
  });
});

// The one rule this file exists under. A human presses send, which is where
// CASL liability belongs.
describe("still drafts, never sends", () => {
  test("asks Gmail for a draft, on the compose scope", async () => {
    await createDraft("token", { to: "hello@example.ca", subject: "S", body: "B" });

    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain("/drafts");
    expect(url).not.toContain("/send");
    expect(GMAIL_SCOPE).toBe("https://www.googleapis.com/auth/gmail.compose");
  });
});

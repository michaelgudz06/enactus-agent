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

// A MIME header ends at the first CRLF, so a newline in a value the request
// body supplied is a header of its own -- and the human presses send on
// whatever ends up in the draft.
describe("a header value cannot become a header", () => {
  function headerLines(): string[] {
    const [headers] = sentMime().split("\r\n\r\n");
    return headers.split("\r\n");
  }

  test("a recipient carrying a CRLF cannot add a Bcc", async () => {
    await createDraft("token", {
      to: "hello@example.ca\r\nBcc: someone@example.com",
      subject: "Enactus SFU x you",
      body: "Hi there.",
      from: "enactus@sfu.ca",
    });

    // The injected text survives as part of the To value, which is inert. What
    // must not exist is a header line of its own.
    expect(headerLines().some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(headerLines()).toEqual([
      "From: enactus@sfu.ca",
      "To: hello@example.ca Bcc: someone@example.com",
      "Subject: Enactus SFU x you",
      'Content-Type: text/plain; charset="UTF-8"',
      "MIME-Version: 1.0",
    ]);
  });

  test("a subject carrying a CRLF cannot add a header either", async () => {
    await createDraft("token", {
      to: "hello@example.ca",
      subject: "Hello\r\nBcc: someone@example.com",
      body: "Hi there.",
    });

    expect(headerLines().some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(headerLines()).toHaveLength(4);
  });

  // The body is not a header and keeps its newlines: folding them would rewrite
  // the email a student is about to send.
  test("leaves the body's own line breaks alone", async () => {
    await createDraft("token", { to: "hello@example.ca", subject: "S", body: "Hi there,\n\nNikita" });

    expect(sentMime()).toContain("Hi there,\n\nNikita");
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

import { describe, test, expect, afterEach, vi } from "vitest";
import { requestDraft, draftIsLoading } from "@/components/EmailModal";

// The modal used to fetch the draft in an effect that first set `loading`,
// `error` and `notes` synchronously. Both halves of that are now plain values:
// `requestDraft` turns one response into a result, and `draftIsLoading` says
// whether the draft on screen belongs to the lead being shown.

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestDraft", () => {
  test("returns the draft for the lead it was asked about", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      subject: "Coffee for the Enactus showcase",
      body: "Hi there,",
      notes: ["fit_score arrived as a string; read as 88"],
      to: "hello@example.ca",
    })));

    const result = await requestDraft("lead-1");

    expect(result).toEqual({
      leadId: "lead-1",
      ok: true,
      subject: "Coffee for the Enactus showcase",
      body: "Hi there,",
      notes: ["fit_score arrived as a string; read as 88"],
      to: "hello@example.ca",
    });
  });

  test("a malformed notes field costs notes and nothing else", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      subject: "Subject",
      body: "Body",
      notes: "one note, not a list",
    })));

    const result = await requestDraft("lead-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toEqual([]);
    expect(result.subject).toBe("Subject");
    expect(result.body).toBe("Body");
    // No address in the response leaves the one the lead already carries alone.
    expect(result.to).toBeNull();
  });

  test("a failed draft carries the route's own message, tagged with the lead", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Lead not found" }, false, 404)));

    const result = await requestDraft("lead-9");

    expect(result).toEqual({ leadId: "lead-9", ok: false, error: "Lead not found" });
  });

  test("a thrown request is reported, not swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    const result = await requestDraft("lead-1");

    expect(result).toEqual({ leadId: "lead-1", ok: false, error: "offline" });
  });
});

describe("draftIsLoading", () => {
  test("is loading before the first draft lands", () => {
    expect(draftIsLoading("lead-1", null, false)).toBe(true);
  });

  test("stops loading once the draft belongs to this lead", () => {
    expect(draftIsLoading("lead-1", "lead-1", false)).toBe(false);
  });

  test("a different lead reads as loading without waiting for an effect", () => {
    expect(draftIsLoading("lead-2", "lead-1", false)).toBe(true);
  });

  test("regenerating this lead's draft reads as loading", () => {
    expect(draftIsLoading("lead-1", "lead-1", true)).toBe(true);
  });
});

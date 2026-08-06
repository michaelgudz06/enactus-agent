import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { REASONER, STRUCTURED, chatJSON, streamReasoner } from "@/lib/llm";

const originalFetch = globalThis.fetch;

function jsonResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function sentBody(): Record<string, unknown> {
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  globalThis.fetch = vi.fn(async () => jsonResponse('{"ok":true}')) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("model pinning", () => {
  test("pins exact model ids rather than floating aliases", () => {
    for (const id of [REASONER, STRUCTURED]) {
      expect(id).not.toMatch(/latest/);
      expect(id).not.toMatch(/^~/);
    }
  });

  test("has left the legacy generation behind", () => {
    expect([REASONER, STRUCTURED]).not.toContain("deepseek/deepseek-r1");
    expect([REASONER, STRUCTURED]).not.toContain("deepseek/deepseek-chat");
  });

  test("keeps the reasoning and structuring models separate", () => {
    expect(REASONER).not.toBe(STRUCTURED);
  });

  test("chatJSON asks the structured-output model by default", async () => {
    await chatJSON([{ role: "user", content: "hi" }]);

    expect(sentBody().model).toBe(STRUCTURED);
  });

  test("streamReasoner asks the reasoning model by default", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("data: [DONE]\n", { status: 200 })
    ) as unknown as typeof fetch;

    await streamReasoner([{ role: "user", content: "hi" }], {});

    expect(sentBody().model).toBe(REASONER);
  });

  // A reasoning model streams its answer into the reasoning channel and leaves
  // content empty, which is exactly how the structuring step used to come back
  // unparseable.
  test("chatJSON refuses to ask the reasoning model for JSON", async () => {
    await expect(chatJSON([{ role: "user", content: "hi" }], { model: REASONER })).rejects.toThrow(
      /reasoning model/i
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

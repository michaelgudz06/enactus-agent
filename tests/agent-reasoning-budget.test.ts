import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());
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

const STREAMED = "Renaissance Coffee has operated on the SFU Burnaby campus for thirty years, which makes ";

beforeEach(() => {
  vi.clearAllMocks();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.chatJSON.mockResolvedValueOnce(PLAN).mockResolvedValueOnce({ leads: [rawLead()] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function run() {
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
}

// What the structuring step was actually handed.
function structurerPrompt(): string {
  const messages = stub.chatJSON.mock.calls[1][0] as { role: string; content: string }[];
  return messages.map((m) => m.content).join("\n");
}

describe("reasoning time budget", () => {
  test("keeps the reasoning that streamed before an abort that throws", async () => {
    vi.useFakeTimers();
    stub.streamReasoner.mockImplementation(
      async (
        _m: unknown,
        handlers: { onReasoning?: (d: string) => void },
        opts: { signal?: AbortSignal }
      ) => {
        handlers.onReasoning?.(STREAMED);
        await vi.advanceTimersByTimeAsync(30000);
        if (opts.signal?.aborted) {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          throw e;
        }
        return { reasoning: "unreachable", content: "" };
      }
    );

    const out = await run();

    expect(out.leads).toHaveLength(1);
    expect(structurerPrompt()).toContain(STREAMED.trim());
  });

  test("tells the user when the budget cut the analysis short", async () => {
    vi.useFakeTimers();
    stub.streamReasoner.mockImplementation(
      async (
        _m: unknown,
        handlers: { onReasoning?: (d: string) => void },
        opts: { signal?: AbortSignal }
      ) => {
        handlers.onReasoning?.(STREAMED);
        await vi.advanceTimersByTimeAsync(30000);
        // llm.ts swallows the abort and returns what streamed so far.
        return { reasoning: opts.signal?.aborted ? STREAMED : "full analysis", content: "" };
      }
    );

    const out = await run();

    expect(out.statuses.some((s) => /time budget/i.test(s))).toBe(true);
  });

  test("keeps the streamed text when reasoning fails for a non-abort reason", async () => {
    stub.streamReasoner.mockImplementation(
      async (_m: unknown, handlers: { onReasoning?: (d: string) => void }) => {
        handlers.onReasoning?.(STREAMED);
        throw new Error("OpenRouter 502: bad gateway");
      }
    );

    const out = await run();

    expect(out.statuses.some((s) => /snag/i.test(s))).toBe(true);
    expect(structurerPrompt()).toContain(STREAMED.trim());
  });

  // D3c: a 3,000-character prefix used to be all the structurer ever saw, which
  // dropped the tail where the analyst's conclusions live.
  test("hands the structurer the whole analysis, not a short prefix", async () => {
    const long = `${"Detailed candidate analysis. ".repeat(300)}CONCLUSION: back Renaissance Coffee.`;
    stub.streamReasoner.mockResolvedValue({ reasoning: long, content: "" });

    await run();

    expect(long.length).toBeGreaterThan(8000);
    expect(structurerPrompt()).toContain("CONCLUSION: back Renaissance Coffee.");
  });

  test("stays silent about the budget when reasoning completes in time", async () => {
    stub.streamReasoner.mockResolvedValue({ reasoning: "A complete analysis.", content: "" });

    const out = await run();

    expect(out.statuses.some((s) => /time budget/i.test(s))).toBe(false);
  });
});

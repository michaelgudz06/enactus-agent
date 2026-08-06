import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { chatJSON } from "@/lib/llm";

const originalFetch = globalThis.fetch;

const LEAD_SCHEMA = {
  name: "leads",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["leads"],
    properties: {
      leads: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["company", "fit_score"],
          properties: {
            company: { type: "string" },
            fit_score: { type: "number" },
            connection_type: { enum: ["alum", "past_sponsor", "ecosystem", "none"] },
            website: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

function reply(content: unknown, status = 200) {
  const body =
    status === 200
      ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] })
      : String(content);
  return new Response(body, { status });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function bodyOf(fn: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((fn.mock.calls[call][1] as RequestInit).body as string);
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("schema-enforced structured output", () => {
  test("asks the provider for a strict json_schema", async () => {
    const fn = mockFetch(reply({ leads: [{ company: "Renaissance Coffee", fit_score: 95 }] }));

    await chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA });

    expect(bodyOf(fn).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "leads", strict: true, schema: LEAD_SCHEMA.schema },
    });
  });

  test("returns a response that matches the schema", async () => {
    mockFetch(reply({ leads: [{ company: "Renaissance Coffee", fit_score: 95, website: null }] }));

    const out = await chatJSON<{ leads: unknown[] }>([{ role: "user", content: "go" }], {
      schema: LEAD_SCHEMA,
    });

    expect(out.leads).toHaveLength(1);
  });

  test("rejects a response missing a required field", async () => {
    mockFetch(reply({ leads: [{ company: "Renaissance Coffee" }] }));

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/fit_score/);
  });

  test("rejects a response with a wrongly typed field", async () => {
    mockFetch(reply({ leads: [{ company: "Renaissance Coffee", fit_score: "ninety-five" }] }));

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/fit_score/);
  });

  test("rejects a null where the schema does not allow one", async () => {
    mockFetch(reply({ leads: [{ company: null, fit_score: 95 }] }));

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/company/);
  });

  test("allows a null where the schema does allow one", async () => {
    mockFetch(reply({ leads: [{ company: "BAK'D Cookies", fit_score: 85, website: null }] }));

    const out = await chatJSON<{ leads: { website: null }[] }>([{ role: "user", content: "go" }], {
      schema: LEAD_SCHEMA,
    });

    expect(out.leads[0].website).toBeNull();
  });

  test("rejects a value outside an enum", async () => {
    mockFetch(
      reply({ leads: [{ company: "X", fit_score: 10, connection_type: "friend-of-a-friend" }] })
    );

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/connection_type/);
  });

  test("rejects a top-level array when the schema says object", async () => {
    mockFetch(reply([{ company: "X", fit_score: 10 }]));

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/object/);
  });

  // If a provider behind OpenRouter cannot honour json_schema, fall back to
  // plain JSON mode rather than failing the run. Local validation still applies.
  test("falls back to plain json mode when the provider rejects json_schema", async () => {
    const fn = mockFetch(
      reply("response_format.type: json_schema is not supported by this provider", 400),
      reply({ leads: [{ company: "Renaissance Coffee", fit_score: 95 }] })
    );

    const out = await chatJSON<{ leads: unknown[] }>([{ role: "user", content: "go" }], {
      schema: LEAD_SCHEMA,
    });

    expect(out.leads).toHaveLength(1);
    expect(bodyOf(fn, 1).response_format).toEqual({ type: "json_object" });
  });

  test("still validates the fallback response against the schema", async () => {
    mockFetch(
      reply("json_schema not supported", 400),
      reply({ leads: [{ company: "Renaissance Coffee" }] })
    );

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/fit_score/);
  });

  // The provider is asked for the envelope shape, but a bare array is normalised
  // before the schema check rather than being rejected by it.
  test("applies the caller's coercion before validating", async () => {
    mockFetch(reply([{ company: "Renaissance Coffee", fit_score: 95 }]));

    const out = await chatJSON<{ leads: unknown[] }>([{ role: "user", content: "go" }], {
      schema: LEAD_SCHEMA,
      coerce: (raw) => (Array.isArray(raw) ? { leads: raw } : raw),
    });

    expect(out.leads).toHaveLength(1);
  });

  test("still rejects a coerced payload that breaks the schema", async () => {
    mockFetch(reply([{ company: "Renaissance Coffee" }]));

    await expect(
      chatJSON([{ role: "user", content: "go" }], {
        schema: LEAD_SCHEMA,
        coerce: (raw) => (Array.isArray(raw) ? { leads: raw } : raw),
      })
    ).rejects.toThrow(/fit_score/);
  });

  test("does not retry a genuine provider error", async () => {
    const fn = mockFetch(reply("rate limited", 429));

    await expect(
      chatJSON([{ role: "user", content: "go" }], { schema: LEAD_SCHEMA })
    ).rejects.toThrow(/429/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

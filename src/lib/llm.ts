// DeepSeek via OpenRouter, current generation, exact IDs only.
//
// The split is load-bearing and must survive: REASONER writes prose that a human
// reads, STRUCTURED produces JSON that code parses. Never ask a reasoning model
// for JSON -- it streams its answer into the reasoning channel and leaves
// `content` empty, which is how the structuring step used to come back
// unparseable. `chatJSON` enforces that below.
//
// Prices verified live against GET https://openrouter.ai/api/v1/models on
// 2026-08-06. The previous pins (deepseek-r1 / deepseek-chat) were the two
// worst-value entries in that table: r1 cost 7.8x the input and 13.9x the output
// of v4-flash on a 164k context instead of 1M.
//
// Pin exact published IDs, never a floating alias: OpenRouter also publishes
// `~deepseek/deepseek-v4-flash-latest`, which would silently change model
// underneath us and make a quality regression unattributable. OpenRouter
// publishes no dated variant of v4-pro; if one appears, pin it here.
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Prose only. Streams a visible analysis for a human to read. $0.435/$0.87 per 1M. */
export const REASONER = "deepseek/deepseek-v4-pro";
/** Anything that must parse. Declares structured-output support. $0.09/$0.18 per 1M. */
export const STRUCTURED = "deepseek/deepseek-v4-flash-0731";

export function hasLLMKey() {
  const k = process.env.OPENROUTER_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

function headers() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://enactus-agent.local",
    "X-Title": "Enactus SFU Lead Agent",
  };
}

// Non-streaming plain-text completion (used for email drafting).
export async function chatText(
  messages: Msg[],
  opts: { model?: string; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const res = await fetch(OR_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model ?? STRUCTURED,
      messages,
      max_tokens: opts.maxTokens ?? 900,
      temperature: opts.temperature ?? 0.6,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

export interface JsonSchemaSpec {
  name: string;
  /** The complete strict schema the provider is asked to honour. */
  schema: Record<string, unknown>;
  /**
   * The schema the response is checked against locally, when it must be more
   * lenient than the one sent. Strict structured output requires every property
   * to be listed in `required`; enforcing that locally would let one omitted
   * optional field discard an entire batch, so the two are allowed to differ.
   * Defaults to `schema`.
   */
  validate?: Record<string, unknown>;
}

// Non-streaming JSON completion (used for planning + scoring synthesis when we
// don't need to show reasoning live). Pass a schema to have the provider enforce
// the shape and to have the response rejected locally when it does not match.
export async function chatJSON<T = unknown>(
  messages: Msg[],
  opts: {
    model?: string;
    maxTokens?: number;
    schema?: JsonSchemaSpec;
    /** Normalise known-benign shape variance before the schema check. */
    coerce?: (raw: unknown) => unknown;
  } = {}
): Promise<T> {
  const model = opts.model ?? STRUCTURED;
  if (model === REASONER) {
    throw new Error(
      `Refusing to ask the reasoning model (${REASONER}) for JSON: it answers in the reasoning channel and leaves content empty. Use ${STRUCTURED}.`
    );
  }

  const send = async (format: Record<string, unknown>) =>
    fetch(OR_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1500,
        temperature: 0.3,
        response_format: format,
      }),
    });

  const strict = opts.schema
    ? { type: "json_schema", json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema } }
    : { type: "json_object" };

  let res = await send(strict);
  // Not every provider behind OpenRouter honours json_schema. Degrade to plain
  // JSON mode rather than failing the run; the local check below still applies.
  if (!res.ok && opts.schema && res.status === 400) {
    const detail = await res.text().catch(() => "");
    if (/json_schema|response_format|structured/i.test(detail)) {
      res = await send({ type: "json_object" });
    } else {
      throw new Error(`OpenRouter 400: ${detail.slice(0, 200)}`);
    }
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJSON<unknown>(content);
  const shaped = opts.coerce ? opts.coerce(parsed) : parsed;
  if (opts.schema) validateAgainstSchema(shaped, opts.schema.validate ?? opts.schema.schema, opts.schema.name);
  return shaped as T;
}

// Minimal JSON Schema check: enough to reject the shapes that used to reach the
// database as nulls and wrong types. Supports type (including unions and null),
// properties, required, items, and enum.
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, path = "response"): void {
  const fail = (msg: string): never => {
    throw new Error(`Model response failed schema check at ${path}: ${msg}`);
  };

  const enumValues = schema.enum as unknown[] | undefined;
  if (Array.isArray(enumValues)) {
    if (!enumValues.includes(value as never)) fail(`expected one of ${JSON.stringify(enumValues)}, got ${JSON.stringify(value)}`);
    return;
  }

  const declared = schema.type;
  if (declared === undefined) return;
  const allowed = Array.isArray(declared) ? (declared as string[]) : [declared as string];
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
  const matches = allowed.some((t) => (t === "integer" ? Number.isInteger(value) : t === actual));
  if (!matches) fail(`expected ${allowed.join(" | ")}, got ${actual}`);
  if (value === null) return;

  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (obj[key] === undefined) fail(`missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (obj[key] !== undefined) validateAgainstSchema(obj[key], sub, `${path}.${key}`);
    }
  }

  if (actual === "array" && schema.items) {
    const items = schema.items as Record<string, unknown>;
    (value as unknown[]).forEach((entry, i) => validateAgainstSchema(entry, items, `${path}[${i}]`));
  }
}

// Streaming call that surfaces both the reasoning trace and the final content.
export async function streamReasoner(
  messages: Msg[],
  handlers: { onReasoning?: (delta: string) => void; onContent?: (delta: string) => void },
  opts: { model?: string; maxTokens?: number; signal?: AbortSignal; fastProvider?: boolean } = {}
): Promise<{ reasoning: string; content: string }> {
  const body: Record<string, unknown> = {
    model: opts.model ?? REASONER,
    messages,
    max_tokens: opts.maxTokens ?? 2400,
    temperature: 0.4,
    stream: true,
  };
  // Route to the highest-throughput provider so reasoning finishes within budget.
  if (opts.fastProvider) body.provider = { sort: "throughput" };

  const res = await fetch(OR_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoning = "";
  let content = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta ?? {};
          const r: string | undefined = delta.reasoning ?? delta.reasoning_content;
          const c: string | undefined = delta.content;
          if (r) {
            reasoning += r;
            handlers.onReasoning?.(r);
          }
          if (c) {
            content += c;
            handlers.onContent?.(c);
          }
        } catch {
          // ignore partial/non-JSON keepalive lines
        }
      }
    }
  } catch (e) {
    // On a time-budget abort, keep whatever reasoning we streamed so far and
    // let the caller proceed to structuring. Re-throw genuine errors.
    if (!(opts.signal?.aborted || (e as Error)?.name === "AbortError")) throw e;
  }
  return { reasoning, content };
}

// Robustly pull a JSON object/array out of a model response that may be fenced.
export function extractJSON<T = unknown>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      // fall through
    }
  }
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }
  throw new Error("Could not parse JSON from model output");
}

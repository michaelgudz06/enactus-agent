// DeepSeek via OpenRouter. R1 for visible reasoning, V3 (chat) for fast structured work.
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

export const REASONER = "deepseek/deepseek-r1";
export const CHAT = "deepseek/deepseek-chat";

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
      model: opts.model ?? CHAT,
      messages,
      max_tokens: opts.maxTokens ?? 900,
      temperature: opts.temperature ?? 0.6,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// Non-streaming JSON completion (used for planning + scoring synthesis when we
// don't need to show reasoning live).
export async function chatJSON<T = unknown>(
  messages: Msg[],
  opts: { model?: string; maxTokens?: number } = {}
): Promise<T> {
  const res = await fetch(OR_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model ?? CHAT,
      messages,
      max_tokens: opts.maxTokens ?? 1500,
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  return extractJSON<T>(content);
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
  // Route to the highest-throughput provider so R1 finishes within our time budget.
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

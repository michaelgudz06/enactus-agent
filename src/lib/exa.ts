// Minimal Exa client for lead discovery + research.
// Docs: https://docs.exa.ai — POST /search with inline contents.
//
// Exa is the expensive half of the monthly API budget: the three searches in a
// run cost about three times every model call in it put together, so the number
// of searches is what $20 a month actually buys. The budget check below sits
// inside this client rather than at its call sites, so there is no way to reach
// the endpoint without passing it.

import { assertHeadroom, exaSearchCostUsd, recordSpend } from "./budget";

const EXA_URL = "https://api.exa.ai/search";

export interface ExaResult {
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  text: string | null;
  highlights: string[];
}

export function hasExaKey() {
  const k = process.env.EXA_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

export async function exaSearch(
  query: string,
  opts: { numResults?: number; category?: string } = {}
): Promise<ExaResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY not set");

  const numResults = opts.numResults ?? 8;
  await assertHeadroom(exaSearchCostUsd(numResults), "an Exa search");

  const body: Record<string, unknown> = {
    query,
    numResults,
    type: "auto",
    contents: {
      text: { maxCharacters: 1200 },
      highlights: { numSentences: 3, highlightsPerUrl: 2, query },
    },
  };
  if (opts.category) body.category = opts.category;

  const res = await fetch(EXA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Exa ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as { results?: unknown[] };
  const results = Array.isArray(data.results) ? data.results : [];

  // Billed on what came back, since the price is a flat base plus anything past
  // the tenth result. Only a request Exa actually served is charged; a rejected
  // one costs the club nothing and must not be booked as if it did.
  await recordSpend({
    provider: "exa",
    model: "search",
    operation: "search",
    requests: 1,
    costUsd: exaSearchCostUsd(results.length),
  });

  return results.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      url: String(x.url ?? ""),
      title: (x.title as string) ?? null,
      publishedDate: (x.publishedDate as string) ?? null,
      author: (x.author as string) ?? null,
      text: (x.text as string) ?? null,
      highlights: Array.isArray(x.highlights) ? (x.highlights as string[]) : [],
    };
  });
}

// De-dupe by hostname so we don't research the same company twice.
export function dedupeByDomain(results: ExaResult[]): ExaResult[] {
  const seen = new Set<string>();
  const out: ExaResult[] = [];
  for (const r of results) {
    let host = "";
    try {
      host = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      host = r.url;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(r);
  }
  return out;
}

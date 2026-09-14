// Minimal Exa client for lead discovery + research.
// Docs: https://docs.exa.ai — POST /search with inline contents.

const EXA_URL = "https://api.exa.ai/search";

export interface ExaResult {
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  text: string | null;
  highlights: string[];
  /**
   * Which channel found this candidate. Optional so the shape is unchanged for
   * everything that only reads a result, but the funnel needs it: Places and
   * Exa find genuinely different things -- Places returns the business, Exa
   * returns pages about it -- and the mix between them is a decision, not an
   * accident of how many each happened to return.
   */
  source?: "exa" | "places";
}

export function hasExaKey() {
  const k = process.env.EXA_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

export async function exaSearch(
  query: string,
  opts: {
    numResults?: number;
    category?: string;
    excludeDomains?: string[];
    includeDomains?: string[];
    textChars?: number;
  } = {}
): Promise<ExaResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY not set");

  const body: Record<string, unknown> = {
    query,
    numResults: opts.numResults ?? 8,
    type: "auto",
    contents: {
      // 1200 is plenty to judge a company from a search snippet, but a team
      // page lists people far below the fold and gets truncated mid-roster.
      // Callers reading people ask for more.
      text: { maxCharacters: opts.textChars ?? 1200 },
      highlights: { numSentences: 3, highlightsPerUrl: 2, query },
    },
  };
  if (opts.category) body.category = opts.category;
  // Pins the search to one company's own domain. The people extractor treats
  // "published on their site" as the evidence standard, so a search that can
  // wander off-domain would hand it pages it is not entitled to trust.
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  // Ask for pages we have never seen instead of paying for pages the
  // already-on-board filter is about to delete. That filter is correct -- it
  // stops two volunteers emailing the same cafe -- but it runs AFTER discovery,
  // so as the board grows the search keeps returning the same top-ranked
  // domains and the filter keeps deleting them, and the run starves. Exa caps
  // this list at 1000.
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains.slice(0, 1000);

  const res = await fetch(EXA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Exa ${res.status}: ${t.slice(0, 200)}`);
  }

  return toResults(await res.json());
}

function toResults(data: unknown): ExaResult[] {
  const results = (data as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      url: String(x.url ?? ""),
      title: (x.title as string) ?? null,
      publishedDate: (x.publishedDate as string) ?? null,
      author: (x.author as string) ?? null,
      text: (x.text as string) ?? null,
      highlights: Array.isArray(x.highlights) ? (x.highlights as string[]) : [],
      source: "exa" as const,
    };
  });
}

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

/**
 * Fetch page text for URLs we already have, without running a search.
 *
 * This is what makes a Google Places result a real candidate. Places returns
 * the business itself -- which is the whole reason it is the better discovery
 * channel for local sponsors -- but all it carries is a name, a type and an
 * address. A candidate whose entire evidence is "Aster Cafe - cafe - 123 Main
 * St" cannot be reasoned about, cannot be grounded against, and loses to any
 * Exa result that came with two paragraphs of prose. So the model was
 * systematically preferring pages ABOUT businesses over the businesses.
 *
 * One request for every URL, so the cost is per page and the wall clock is one
 * round trip. Never throws: a candidate that could not be enriched keeps the
 * thin text it already had.
 */
export async function exaContents(
  urls: string[],
  opts: { textChars?: number; signal?: AbortSignal } = {}
): Promise<Map<string, ExaResult>> {
  const out = new Map<string, ExaResult>();
  const key = process.env.EXA_API_KEY;
  const wanted = [...new Set(urls.filter(Boolean))];
  if (!key || !wanted.length) return out;
  try {
    const res = await fetch(EXA_CONTENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        urls: wanted,
        text: { maxCharacters: opts.textChars ?? 1200 },
      }),
      signal: opts.signal,
      cache: "no-store",
    });
    if (!res.ok) return out;
    for (const r of toResults(await res.json())) if (r.url) out.set(r.url, r);
  } catch {
    // Enrichment is additive. A failure here costs evidence, never the run.
  }
  return out;
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

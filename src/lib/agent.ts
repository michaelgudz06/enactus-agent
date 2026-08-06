import crypto from "crypto";
import { AgentEvent, ConnectionType, Lead, Mode } from "./types";
import { chatJSON, streamReasoner, REASONER } from "./llm";
import { exaSearch, dedupeByDomain, ExaResult } from "./exa";
import { supabaseAdmin, LEADS, SEARCHES, hasServiceKey } from "./supabase";
import { createContactEmailVerifier, EmailCheck } from "./contact";
import { ENACTUS_ORG, ENACTUS_PROJECTS, ENACTUS_VENTURES } from "./enactus";

type Emit = (e: AgentEvent) => void;

interface Plan {
  needClarification: boolean;
  questions: string[];
  searchQueries: string[];
  criteria: string;
  altAngle: string;
  location: string;
}

// Schemas the provider is asked to honour and the response is checked against.
// `required` lists only what the run genuinely cannot proceed without; every
// other field is type-checked when present, so a wrong type is rejected instead
// of being coerced into the database.
const NULLABLE_STRING = { type: ["string", "null"] };

const PLAN_SCHEMA = {
  name: "search_plan",
  schema: {
    type: "object",
    required: ["searchQueries", "criteria"],
    properties: {
      needClarification: { type: ["boolean", "null"] },
      questions: { type: ["array", "null"], items: { type: "string" } },
      searchQueries: { type: "array", items: { type: "string" } },
      criteria: { type: "string" },
      altAngle: NULLABLE_STRING,
      location: NULLABLE_STRING,
    },
  },
};

const LEADS_SCHEMA = {
  name: "leads",
  schema: {
    type: "object",
    required: ["leads"],
    properties: {
      leads: {
        type: "array",
        items: {
          type: "object",
          required: ["company"],
          properties: {
            company: { type: "string" },
            website: NULLABLE_STRING,
            industry: NULLABLE_STRING,
            location: NULLABLE_STRING,
            description: NULLABLE_STRING,
            contact_name: NULLABLE_STRING,
            contact_role: NULLABLE_STRING,
            contact_email: NULLABLE_STRING,
            connection_type: { enum: ["alum", "past_sponsor", "ecosystem", "none"] },
            connection_note: NULLABLE_STRING,
            sponsorship_type: { type: ["array", "null"], items: { type: "string" } },
            fit_score: { type: ["number", "null"] },
            why_fit: NULLABLE_STRING,
            reasoning: NULLABLE_STRING,
            source_index: { type: ["number", "null"] },
          },
        },
      },
    },
  },
};

// How much of the analysis the structuring step is shown. The old 3,000-char cap
// silently dropped the tail, which is exactly where the analyst's conclusions
// live; the structuring model has a 1M-token context, so this only needs to be
// generous enough to bound a runaway stream.
const REASONING_FORWARD_CHARS = 60000;

const STOP = new Set(
  "the a an and or of for to in on at with from find me some list companies company business businesses that are who is looking want need new leads potential more".split(
    " "
  )
);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort()
    .join(" ");
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function planPrompt(mode: Mode): string {
  if (mode === "sales") {
    return `You help a project manager find B2B sales leads (potential customers to sell their product/service to). Turn their request into effective web-search queries and a crisp ideal-customer description.`;
  }
  return `You help Enactus SFU, a student social-entrepreneurship club at Simon Fraser University (Burnaby / Vancouver, BC), find corporate sponsors offering monetary or in-kind support. Favour Lower Mainland businesses with a track record of backing students or community, and especially any with Simon Fraser University (SFU) or Enactus alumni ties. Turn the user's request into effective web-search queries and a crisp ideal-sponsor description.

Only look for real companies, businesses, or grant-making foundations that could give money or in-kind support. NEVER target other student clubs, university clubs or associations (at SFU or elsewhere), or organizations whose "sponsorship" is actually a paid membership, paid directory listing, or a fee the club would have to pay. Word the search queries to find businesses/sponsors, not clubs or memberships.`;
}

export async function runAgent(
  input: { prompt: string; mode: Mode; answers?: string; userName: string; skipClarify?: boolean },
  emit: Emit
): Promise<void> {
  const { prompt, mode, answers, userName } = input;
  const fullPrompt = answers ? `${prompt}\n\nAdditional context from user: ${answers}` : prompt;

  // ── 1. Understand + plan ────────────────────────────────────────────────
  emit({ type: "status", step: "understand", message: "Understanding your request and planning searches" });
  let plan: Plan;
  try {
    plan = await chatJSON<Plan>(
      [
        { role: "system", content: `${planPrompt(mode)}\n\nRespond ONLY with JSON of shape: {"needClarification": boolean, "questions": string[], "searchQueries": string[], "criteria": string, "altAngle": string, "location": string}. Provide 3 focused searchQueries. Only set needClarification true (with up to 2 short questions) if the request is too vague to search well. altAngle is a different angle to try if this search was already done before.` },
        { role: "user", content: fullPrompt },
      ],
      { maxTokens: 800, schema: PLAN_SCHEMA }
    );
  } catch (e) {
    emit({ type: "error", message: `Planning failed: ${(e as Error).message}` });
    return;
  }

  if (plan.needClarification && !answers && !input.skipClarify && plan.questions?.length) {
    emit({ type: "clarify", questions: plan.questions.slice(0, 2) });
    return;
  }

  // ── 2. History check (lightweight, in DB) ───────────────────────────────
  const norm = normalize(fullPrompt);
  if (hasServiceKey()) {
    try {
      const { data } = await supabaseAdmin
        .from(SEARCHES)
        .select("prompt, normalized, created_at")
        .eq("mode", mode)
        .order("created_at", { ascending: false })
        .limit(40);
      let best = { score: 0, prompt: "" };
      for (const row of data ?? []) {
        const score = jaccard(norm, row.normalized || normalize(row.prompt));
        if (score > best.score) best = { score, prompt: row.prompt };
      }
      if (best.score >= 0.45) {
        emit({
          type: "similar",
          message: `Heads up: we ran a very similar search before ("${best.prompt}").`,
          suggestion: plan.altAngle || "Try a different city or industry angle to avoid re-surfacing the same leads.",
          pastPrompt: best.prompt,
        });
      }
    } catch {
      // non-fatal
    }
  }

  // ── 3. Discover via Exa ─────────────────────────────────────────────────
  emit({ type: "status", step: "discover", message: `Searching the web with Exa: ${plan.searchQueries.slice(0, 3).join("  ·  ")}` });
  let candidates: ExaResult[] = [];
  try {
    const batches = await Promise.all(
      plan.searchQueries.slice(0, 3).map((q) => exaSearch(q, { numResults: 6 }).catch(() => []))
    );
    candidates = dedupeByDomain(batches.flat().filter((r) => r.url));
  } catch (e) {
    emit({ type: "error", message: `Discovery failed: ${(e as Error).message}` });
    return;
  }
  // Drop obvious non-company noise + cap.
  candidates = candidates
    .filter((r) => !/wikipedia\.org|reddit\.com|indeed\.com|glassdoor\./.test(r.url))
    .slice(0, 6);

  if (!candidates.length) {
    emit({ type: "status", step: "discover", message: "No candidates found. Try rephrasing or broadening the request." });
    emit({ type: "done", count: 0, searchId: null });
    return;
  }
  emit({ type: "status", step: "research", message: `Found ${candidates.length} candidates. Analyzing fit and connections` });

  // ── 4. Reason + score with the reasoning model (visible reasoning) ──────
  const context = candidates
    .map((c, i) => `[${i + 1}] ${c.title || domainOf(c.url)}\nURL: ${c.url}\n${(c.text || c.highlights.join(" ")).slice(0, 700)}`)
    .join("\n\n");

  const scoreSystem =
    mode === "sales"
      ? `You are a sales-lead analyst. Assess each candidate organization as a potential CUSTOMER for the user's product.\n\n${ENACTUS_VENTURES}`
      : `You are a sponsorship-lead analyst for Enactus SFU. Assess each candidate organization as a potential SPONSOR. Detect any Simon Fraser University (SFU) or Enactus alumni connection, or past-sponsor / SFU-ecosystem tie, strictly from the provided text.\n\n${ENACTUS_ORG}\n\n${ENACTUS_PROJECTS}\n\nFor each strong sponsor, identify which specific Enactus SFU project best matches their industry or values, so outreach can pitch that project.\n\nHARD EXCLUSIONS — drop these candidates entirely (do not output them at all): other student clubs, university clubs, or student associations (at SFU or any school); anything that would require Enactus to PAY (paid memberships, paid directory or association listings, ticketed programs, fee-based accelerators). Enactus is asking companies to give, not to join or pay. Only keep real companies, businesses, or grant-making foundations.`;

  // Stage A — the reasoning model thinks out loud (visible), no JSON. Capped so
  // it stays snappy.
  const reasoningUser = `User request: ${fullPrompt}
Ideal lead: ${plan.criteria}

Candidates:
${context}

Reason candidate by candidate: which are the strongest ${mode === "sales" ? "customers" : "sponsors"} and why? Weigh SFU/Enactus ties, local fit, how winnable the ask is${mode === "sales" ? "" : ", and which specific Enactus SFU project each best aligns with"}. Be concise and specific. Do NOT output JSON, just think it through.`;

  emit({ type: "status", step: "reason", message: "Reasoning about each candidate" });
  // Hard time budget: reasoning is the slow step. Cap it so the serverless function
  // always has room to structure + persist within the 60s limit. If the budget
  // is hit, we proceed with whatever reasoning streamed so far.
  const REASONING_BUDGET_MS = 28000;
  const controller = new AbortController();
  let budgetHit = false;
  const budget = setTimeout(() => {
    budgetHit = true;
    controller.abort();
  }, REASONING_BUDGET_MS);
  // Accumulate every delta as it arrives. Whatever the stream does afterwards --
  // return normally, abort, or throw -- the reasoning the user already watched
  // stream past is still ours to structure from.
  let streamed = "";
  const capture = (d: string) => {
    streamed += d;
    emit({ type: "reasoning", text: d });
  };
  let reasoningText = "";
  try {
    const r = await streamReasoner(
      [
        { role: "system", content: scoreSystem },
        { role: "user", content: reasoningUser },
      ],
      { onReasoning: capture, onContent: capture },
      { model: REASONER, maxTokens: 1200, signal: controller.signal, fastProvider: true }
    );
    reasoningText = (r.reasoning || r.content || "").trim();
  } catch {
    // Genuine failure (not the budget abort): fall back to structuring from the
    // raw candidates rather than dropping the whole run.
    if (!controller.signal.aborted) {
      emit({ type: "status", step: "reason", message: "Reasoning hit a snag; ranking from the candidate research instead" });
    }
  } finally {
    clearTimeout(budget);
  }
  // An abort can surface either as a partial return or as a throw. Either way,
  // degrade to what actually streamed rather than to nothing.
  if (!reasoningText) reasoningText = streamed.trim();
  if (budgetHit) {
    emit({
      type: "status",
      step: "reason",
      message: reasoningText
        ? `Analysis hit its ${Math.round(REASONING_BUDGET_MS / 1000)}s time budget. Ranking from the ${reasoningText.length} characters of reasoning that streamed before the cut.`
        : `Analysis hit its ${Math.round(REASONING_BUDGET_MS / 1000)}s time budget before producing anything. Ranking from the candidate research instead.`,
    });
  }

  // Stage B — the structured-output model turns the analysis into JSON (fast).
  emit({ type: "status", step: "structure", message: "Structuring the shortlisted leads" });
  const structureUser = `User request: ${fullPrompt}
Ideal lead: ${plan.criteria}
Mode: ${mode}

Candidates:
${context}

Analyst reasoning to base your selection on:
${reasoningText.slice(0, REASONING_FORWARD_CHARS)}

Output ONLY JSON of the leads worth pursuing:
{"leads":[{"company","website","industry","location","description","contact_name","contact_role","contact_email","connection_type","connection_note","sponsorship_type","fit_score","why_fit","reasoning","source_index"}]}
Rules:
- connection_type is one of: "alum" (SFU/Enactus alum tie), "past_sponsor", "ecosystem" (SFU entrepreneurship ecosystem), or "none". Only claim a connection if the text supports it.
- sponsorship_type: for sponsor mode an array subset of ["monetary","in_kind"]; for sales mode 1-3 short angle tags.
- fit_score is 0-100. description is one tight sentence. why_fit is one or two sentences, concrete${mode === "sales" ? "" : ", and should name the specific Enactus SFU project this sponsor best aligns with (e.g. Nourish, Alara, Unify, SKYES, NextSpark, Renovo, SensMS, Second Savour)"}.
- reasoning: 3 to 5 sentences about THIS company ONLY. Never mention, compare, or rank other candidates in it. Explain the concrete evidence from the research for the fit, the SFU/alumni/past-sponsor angle if any${mode === "sales" ? "" : ", which specific Enactus SFU project they should fund and why it matches them"}, how winnable the ask looks, and a suggested first ask.
- contact_email only if visible in the text; otherwise null. source_index is the [n] you used.
${mode === "sales" ? "" : "- EXCLUDE entirely (do not output) any other student club, university club/association, or anything requiring Enactus to pay a membership/fee. Only real companies, businesses, or grant-making foundations."}`;

  let parsed: { leads: RawLead[] } | null = null;
  try {
    const p = await chatJSON<{ leads: RawLead[] }>(
      [
        { role: "system", content: `${scoreSystem} Output only the JSON described, nothing else.` },
        { role: "user", content: structureUser },
      ],
      { maxTokens: 2800, schema: LEADS_SCHEMA, coerce: coerceLeadsPayload }
    );
    parsed = coerceLeadsPayload(p);
  } catch {
    // fall through
  }
  if (!parsed) {
    emit({ type: "error", message: "The model did not return usable results. Try again or rephrase." });
    return;
  }

  // One verifier for the whole run: each domain costs at most one DNS query.
  const verifyEmail = createContactEmailVerifier();
  const finalized: Lead[] = [];
  for (const raw of parsed.leads ?? []) {
    const src = resolveSource(candidates, raw.source_index);
    const website = websiteFor(raw.website, src);
    const contact = raw.contact_email ? await verifyEmail(raw.contact_email) : null;
    const lead = await persistLead(raw, { website, src, mode, userName, contact });
    finalized.push(lead);
    emit({ type: "lead", lead });
  }

  // ── 5. Save the search to history ───────────────────────────────────────
  let searchId: string | null = null;
  if (hasServiceKey()) {
    try {
      const { data } = await supabaseAdmin
        .from(SEARCHES)
        .insert({ prompt: fullPrompt, normalized: norm, mode, result_count: finalized.length, created_by_name: userName })
        .select("id")
        .single();
      searchId = data?.id ?? null;
    } catch {
      // non-fatal
    }
  }

  emit({ type: "done", count: finalized.length, searchId });
}

// Platforms that host pages *about* a company rather than the company's own
// site. A source on one of these is legitimate evidence, but its hostname is
// never the company's website.
const AGGREGATOR_HOST =
  /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|threads\.net|tiktok\.com|youtube\.com|medium\.com|substack\.com|crunchbase\.com|yelp\.[a-z.]+|tripadvisor\.[a-z.]+|bbb\.org|eventbrite\.[a-z.]+)$/i;

// `source_index` is the model's claim about which candidate it used. Trust it
// only when it actually indexes a candidate we researched: an out-of-range or
// absent index used to silently attribute a lead to another company's page.
export function resolveSource(candidates: ExaResult[], sourceIndex: unknown): ExaResult | undefined {
  if (typeof sourceIndex !== "number" || !Number.isInteger(sourceIndex)) return undefined;
  if (sourceIndex < 1 || sourceIndex > candidates.length) return undefined;
  return candidates[sourceIndex - 1];
}

// A company website is either the model's own claim or the source's hostname --
// never an aggregator's hostname, which belongs to the platform, not the lead.
export function websiteFor(claimed: string | null | undefined, src?: ExaResult): string | null {
  if (claimed) return claimed;
  if (!src) return null;
  const host = domainOf(src.url);
  if (!host || AGGREGATOR_HOST.test(host)) return null;
  return `https://${host}`;
}

// The structuring model returns `{"leads":[...]}` most of the time and a bare
// top-level array the rest of the time. Live testing measured the bare array at
// 53% of completed runs, and every lead in those runs used to be thrown away.
// Accept both shapes.
export function coerceLeadsPayload(p: unknown): { leads: RawLead[] } | null {
  if (Array.isArray(p)) return { leads: p as RawLead[] };
  if (p && typeof p === "object") {
    const leads = (p as { leads?: unknown }).leads;
    if (Array.isArray(leads)) return { leads: leads as RawLead[] };
  }
  return null;
}

interface RawLead {
  company: string;
  website?: string | null;
  industry?: string | null;
  location?: string | null;
  description?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  contact_email?: string | null;
  connection_type?: string;
  connection_note?: string | null;
  sponsorship_type?: string[];
  fit_score?: number;
  why_fit?: string | null;
  reasoning?: string | null;
  source_index?: number;
}

// An address the model produced that code could not verify. Kept on the record
// so a human can chase it down, never handed to the drafting or Gmail path.
function unverifiedNote(check: Exclude<EmailCheck, { ok: true }>): string {
  const why = check.reason === "format" ? "not a valid email address" : "domain has no mail record";
  return `unverified (${why}): ${check.email}`;
}

async function persistLead(
  raw: RawLead,
  ctx: {
    website: string | null;
    src?: ExaResult;
    mode: Mode;
    userName: string;
    contact: EmailCheck | null;
  }
): Promise<Lead> {
  const conn = (["alum", "past_sponsor", "ecosystem", "none"].includes(raw.connection_type ?? "")
    ? raw.connection_type
    : "none") as ConnectionType;

  const row = {
    company: raw.company || "Unknown",
    website: ctx.website,
    industry: raw.industry ?? null,
    description: raw.description ?? null,
    contact_name: raw.contact_name ?? null,
    contact_role: raw.contact_role ?? null,
    contact_email: ctx.contact?.ok ? ctx.contact.email : null,
    contact_email_status: ctx.contact && !ctx.contact.ok ? unverifiedNote(ctx.contact) : null,
    location: raw.location ?? null,
    connection_type: conn,
    connection_note: raw.connection_note ?? null,
    sponsorship_type: Array.isArray(raw.sponsorship_type) ? raw.sponsorship_type : [],
    fit_score: typeof raw.fit_score === "number" ? Math.max(0, Math.min(100, Math.round(raw.fit_score))) : null,
    why_fit: raw.why_fit ?? null,
    // Per-company reasoning only. The shared analyst trace discusses every
    // candidate together, which the structuring prompt explicitly forbids a
    // lead's reasoning from doing, so it is never borrowed here. If the model
    // gave nothing company-specific, fall back to this company's own why_fit,
    // then leave the field empty.
    reasoning: (raw.reasoning && raw.reasoning.trim()) || (raw.why_fit && raw.why_fit.trim()) || null,
    sources: ctx.src ? [{ url: ctx.src.url, title: ctx.src.title ?? undefined }] : [],
    status: "prospects" as const,
    mode: ctx.mode,
    created_by_name: ctx.userName,
  };

  if (hasServiceKey()) {
    try {
      const { data, error } = await supabaseAdmin.from(LEADS).insert(row).select("*").single();
      if (!error && data) return data as Lead;
    } catch {
      // fall through to in-memory lead
    }
  }
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), board_order: 0, created_at: now, updated_at: now, ...row } as Lead;
}

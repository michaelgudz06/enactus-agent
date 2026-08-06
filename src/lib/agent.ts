import crypto from "crypto";
import { AgentEvent, ConnectionType, Lead, Mode } from "./types";
import { chatJSON, streamReasoner, REASONER } from "./llm";
import { exaSearch, dedupeByDomain, ExaResult } from "./exa";
import { supabaseAdmin, LEADS, SEARCHES, hasServiceKey } from "./supabase";
import { createVerifiers, isAggregatorHost, EmailCheck, WebsiteCheck } from "./contact";
import { ENACTUS_ORG, ENACTUS_PROJECTS, ENACTUS_VENTURES } from "./enactus";
import { ValueDefect, defectMessage, describeValue, recoverValue, reviewFields } from "./review";

type Emit = (e: AgentEvent) => void;

interface Plan {
  needClarification: boolean;
  questions: string[];
  searchQueries: string[];
  criteria: string;
  altAngle: string;
  location: string;
}

// Two views of one shape.
//
// The provider is sent a *complete* schema, because that is what strict
// structured output means: every property listed in `required`, no extras, and
// optionality expressed as a nullable union so "present" is satisfiable by null.
//
// The local check covers the envelope only, for the plan exactly as for the
// leads. Type-checking the properties here would make one wrong-typed field
// fatal to everything beside it -- a cosmetic `altAngle` used to end the run
// before a single search -- which is the failure class this whole change exists
// to remove. Both payloads are instead checked field by field, by reviewPlan and
// reviewLeads, where a defect costs the field it is in and is reported rather
// than swallowed.
const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_STRING_ARRAY = { type: ["array", "null"], items: { type: "string" } };

const CONNECTION_TYPES: ConnectionType[] = ["alum", "past_sponsor", "ecosystem", "none"];

function strictObject(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

const PLAN_PROPERTIES: Record<string, Record<string, unknown>> = {
  needClarification: { type: ["boolean", "null"] },
  questions: NULLABLE_STRING_ARRAY,
  searchQueries: { type: "array", items: { type: "string" } },
  criteria: { type: "string" },
  altAngle: NULLABLE_STRING,
  location: NULLABLE_STRING,
};

const PLAN_SCHEMA = {
  name: "search_plan",
  schema: strictObject(PLAN_PROPERTIES),
  // Envelope only. `searchQueries` is the one thing the run cannot continue
  // without, and reviewPlan decides that after every field has had its own
  // chance to be recovered -- listing it as required here would reject a plan
  // whose queries arrived in a recoverable form.
  validate: { type: "object" },
};

// The per-field contract for one lead. reviewLeads checks each field against
// this independently, so a field that does not match is the only thing lost.
const LEAD_PROPERTIES: Record<string, Record<string, unknown>> = {
  company: { type: "string" },
  website: NULLABLE_STRING,
  industry: NULLABLE_STRING,
  location: NULLABLE_STRING,
  description: NULLABLE_STRING,
  contact_name: NULLABLE_STRING,
  contact_role: NULLABLE_STRING,
  contact_email: NULLABLE_STRING,
  // Not an enum in the local check on purpose: an unrecognised value costs this
  // one field -- persistLead normalises it to "none" -- never the whole lead.
  connection_type: NULLABLE_STRING,
  connection_note: NULLABLE_STRING,
  sponsorship_type: NULLABLE_STRING_ARRAY,
  fit_score: { type: ["number", "null"] },
  why_fit: NULLABLE_STRING,
  reasoning: NULLABLE_STRING,
  source_index: { type: ["number", "null"] },
};

// The provider is still asked for the four literals. A strict validator wants a
// type on every node, so the nullable enum carries the same union NULLABLE_STRING
// uses rather than an enum list on its own.
const REQUEST_LEAD_PROPERTIES = {
  ...LEAD_PROPERTIES,
  connection_type: { type: ["string", "null"], enum: [...CONNECTION_TYPES, null] },
};

const LEADS_SCHEMA = {
  name: "leads",
  schema: strictObject({ leads: { type: "array", items: strictObject(REQUEST_LEAD_PROPERTIES) } }),
  validate: {
    type: "object",
    required: ["leads"],
    properties: { leads: { type: "array" } },
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
  let planned: unknown;
  try {
    planned = await chatJSON<unknown>(
      [
        { role: "system", content: `${planPrompt(mode)}\n\nRespond ONLY with JSON of shape: {"needClarification": boolean, "questions": string[], "searchQueries": string[], "criteria": string, "altAngle": string, "location": string}. Provide 3 focused searchQueries. Only set needClarification true (with up to 2 short questions) if the request is too vague to search well. altAngle is a different angle to try if this search was already done before.` },
        { role: "user", content: fullPrompt },
      ],
      { maxTokens: 800, schema: PLAN_SCHEMA }
    );
  } catch (e) {
    // No plan came back at all, so there is nothing to degrade to.
    emit({ type: "error", message: `Planning failed: ${(e as Error).message}` });
    return;
  }

  const review = reviewPlan(planned);
  for (const defect of review.defects) {
    emit({ type: "status", step: "understand", message: defectMessage(defect, "plan") });
  }
  if (!review.plan) {
    emit({ type: "error", message: `Nothing to search: ${review.blocker}.` });
    return;
  }
  const plan = review.plan;

  if (plan.needClarification && !answers && !input.skipClarify && plan.questions.length) {
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
    emit({ type: "done", count: 0, saved: 0, searchId: null });
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

  // criteria is degradable, so it can legitimately be empty here. An empty
  // labelled field tells the model less than no field at all.
  const idealLead = plan.criteria ? `\nIdeal lead: ${plan.criteria}` : "";

  // Stage A — the reasoning model thinks out loud (visible), no JSON. Capped so
  // it stays snappy.
  const reasoningUser = `User request: ${fullPrompt}${idealLead}

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
  const structureUser = `User request: ${fullPrompt}${idealLead}
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
- website is the company's own domain, exactly as it appears in the research. Never a LinkedIn/Facebook/directory page, never a guess or an example, and never annotated — null if the research does not show one.
${mode === "sales" ? "" : "- EXCLUDE entirely (do not output) any other student club, university club/association, or anything requiring Enactus to pay a membership/fee. Only real companies, businesses, or grant-making foundations."}`;

  // chatJSON already normalises the known shape variance through `coerce`, so
  // whatever comes back is the envelope or nothing. The coercion runs inside
  // chatJSON and cannot emit, so it records what it read into this list and the
  // run announces it below, through the same mechanism every other level uses.
  const envelopeDefects: ValueDefect[] = [];
  let parsed: { leads: unknown[] } | null = null;
  let structuringError = "";
  try {
    parsed =
      (await chatJSON<{ leads: unknown[] } | null>(
        [
          { role: "system", content: `${scoreSystem} Output only the JSON described, nothing else.` },
          { role: "user", content: structureUser },
        ],
        { maxTokens: 2800, schema: LEADS_SCHEMA, coerce: (raw) => coerceLeadsPayload(raw, envelopeDefects) }
      )) ?? null;
  } catch (e) {
    // Say what actually went wrong. A schema rejection, a rate limit and an
    // unparseable body used to be indistinguishable to the person waiting.
    structuringError = (e as Error).message;
  }
  for (const defect of envelopeDefects) {
    emit({ type: "status", step: "structure", message: defectMessage(defect, "response") });
  }
  if (!parsed) {
    emit({
      type: "error",
      message: structuringError
        ? `The model did not return usable results: ${structuringError}`
        : "The model did not return usable results. Try again or rephrase.",
    });
    return;
  }

  const { leads: reviewed, defects } = reviewLeads(parsed.leads ?? [], candidates.length);
  for (const defect of defects) {
    emit({ type: "status", step: "structure", message: defectMessage(defect, "lead") });
  }

  // One verifier for the whole run: each domain costs at most one DNS query.
  // Every model-supplied detail is checked up front and concurrently, so a batch
  // of leads on dead domains costs one timeout window rather than one each --
  // this runs inside the same 60s serverless budget as the reasoning step.
  const verify = createVerifiers();
  const checked = await Promise.all(
    reviewed.map(async (raw) => {
      const [contact, site] = await Promise.all([
        raw.contact_email ? verify.email(raw.contact_email) : null,
        raw.website ? verify.website(raw.website) : null,
      ]);
      return { raw, src: resolveSource(candidates, raw.source_index), contact, site };
    })
  );

  const finalized: Lead[] = [];
  const unsaved: string[] = [];
  let savedCount = 0;
  for (const { raw, src, contact, site } of checked) {
    const { website, websiteStatus } = websiteFor(site, src);
    const { lead, saved, error } = await persistLead(raw, { website, websiteStatus, src, mode, userName, contact });
    finalized.push(lead);
    if (saved) savedCount += 1;
    if (!saved && error) {
      unsaved.push(lead.company);
      emit({
        type: "status",
        step: "persist",
        message: `${lead.company} was NOT saved to the board: ${error}`,
      });
    }
    emit({ type: "lead", lead });
  }

  if (unsaved.length) {
    emit({
      type: "error",
      message:
        `${unsaved.length} of ${finalized.length} lead${finalized.length === 1 ? "" : "s"} could not be written to the database and ` +
        `${unsaved.length === 1 ? "is" : "are"} shown here only — reload and ${unsaved.length === 1 ? "it" : "they"} will be gone. ` +
        `If the error mentions a missing column, run the "alter table ... add column if not exists" statements in supabase-setup.sql.`,
    });
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

  emit({ type: "done", count: finalized.length, saved: savedCount, searchId });
}

// `source_index` is the model's claim about which candidate it used. Trust it
// only when it actually indexes a candidate we researched: an out-of-range or
// absent index used to silently attribute a lead to another company's page.
function resolveSource(candidates: ExaResult[], sourceIndex: unknown): ExaResult | undefined {
  if (typeof sourceIndex !== "number" || !Number.isInteger(sourceIndex)) return undefined;
  if (sourceIndex < 1 || sourceIndex > candidates.length) return undefined;
  return candidates[sourceIndex - 1];
}

// A company website is either the model's own claim or the source's hostname,
// and both routes into the field carry the same guard: never an aggregator's
// hostname, which belongs to the platform rather than the lead, and never a
// domain code could not resolve. A claim that fails is recorded as unverified
// instead of being trusted or thrown away -- the lead is always kept, because
// the company may still be worth pursuing.
function websiteFor(
  claimed: WebsiteCheck | null,
  src?: ExaResult
): { website: string | null; websiteStatus: string | null } {
  const fromSource = sourceWebsite(src);
  if (!claimed) return { website: fromSource, websiteStatus: null };
  if (claimed.ok) return { website: claimed.url, websiteStatus: null };
  return { website: fromSource, websiteStatus: unverifiedWebsiteNote(claimed) };
}

// The search engine actually returned this URL, so its hostname is evidence
// rather than a model claim -- but it is still only the company's own site when
// it is not a platform that hosts pages about companies.
function sourceWebsite(src?: ExaResult): string | null {
  if (!src) return null;
  const host = domainOf(src.url);
  if (!host || isAggregatorHost(host)) return null;
  return `https://${host}`;
}

// This note explains a REJECTED CLAIM, and any website shown alongside it came
// from somewhere else, so it has to name the model as the source of the string
// rather than read as a warning about the site on the card.
function unverifiedWebsiteNote(check: Exclude<WebsiteCheck, { ok: true }>): string {
  switch (check.reason) {
    case "format":
      return `rejected: the model claimed ${check.url}, which is not a usable web address`;
    case "aggregator":
      return `rejected: the model claimed ${check.url}, which is a social or directory page rather than a company site`;
    case "domain":
      return `rejected: the model claimed ${check.url}, which does not resolve`;
    default:
      return `not verified: the model claimed ${check.url}, and the domain lookup did not complete`;
  }
}

const LEADS_SUBJECT = "The leads response";

// What the envelope has to carry for there to be anything to act on: one lead
// object with a name to put on a card. Everything else about a lead is checked
// per field, per lead, by reviewLeads.
const LEADS_LIST_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: { type: "object", required: ["company"], properties: { company: { type: "string" } } },
};

// The structuring model returns `{"leads":[...]}` most of the time and a bare
// top-level array the rest of the time. Live testing measured the bare array at
// 53% of completed runs, and every lead in those runs used to be thrown away.
// Accept both shapes.
//
// A lone lead where a list was asked for -- `{"leads":{...}}`, or the bare lead
// object on its own -- is the same single reading recoverValue applies to every
// other field, and it is applied here, at the earliest boundary both shapes pass
// through, rather than being re-derived downstream. It is recorded on `defects`
// so the caller announces it: this arrives after the searches and the reasoning
// stage, and used to discard a usable lead outright. A payload with nothing
// lead-shaped in it still has nothing to act on, and still stops the run.
function coerceLeadsPayload(p: unknown, defects: ValueDefect[]): { leads: unknown[] } | null {
  if (Array.isArray(p)) return { leads: p };
  if (!p || typeof p !== "object") return null;

  const envelope = p as Record<string, unknown>;
  if (Array.isArray(envelope.leads)) return { leads: envelope.leads };

  const lone = envelope.leads === undefined ? envelope : envelope.leads;
  const recovered = recoverValue(LEADS_LIST_SCHEMA, lone);
  if (!recovered) return null;

  defects.push({
    subject: LEADS_SUBJECT,
    field: "leads",
    detail: `read ${describeValue(lone)} as a list of one lead`,
    action: "coerced",
  });
  return { leads: recovered.value as unknown[] };
}

const PLAN_SUBJECT = "The search plan";

interface PlanReview {
  /** Null only when the next step has nothing to act on. */
  plan: Plan | null;
  defects: ValueDefect[];
  /** Why the run cannot continue, when it cannot. */
  blocker: string | null;
}

/**
 * Checks the plan field by field, on the same contract reviewLeads uses.
 *
 * A malformed optional field -- `altAngle` is a cosmetic hint about a different
 * search angle -- costs that field and nothing else. A wrong type with one
 * possible reading is recovered. Only `searchQueries` can stop the run, and only
 * when it yields no query at all: at that point there is genuinely nothing to
 * search, which is a real stop rather than a degradation.
 */
function reviewPlan(entry: unknown): PlanReview {
  const defects: ValueDefect[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { plan: null, defects, blocker: `the model returned ${describeValue(entry)} instead of a plan` };
  }

  const raw = { ...(entry as Record<string, unknown>) };
  const claimedQueries = raw.searchQueries;
  reviewFields(PLAN_SUBJECT, raw, PLAN_PROPERTIES, defects);

  // When no query survives, the blocker names what the model sent and is the one
  // report of that loss, however the list arrived -- recovered entry by entry
  // here or by reviewFields above. Reporting the same loss twice is its own kind
  // of noise.
  const searchQueries = stringList(raw.searchQueries, "searchQueries", defects);
  if (!searchQueries.length) {
    return {
      plan: null,
      defects: defects.filter((d) => d.field !== "searchQueries"),
      blocker: missingQueriesReason(claimedQueries),
    };
  }

  // criteria only sharpens the ranking prompt, which also carries the user's own
  // request, so losing it degrades the run rather than ending it. Announce it,
  // unless reviewFields already reported the value it arrived as.
  const criteria = typeof raw.criteria === "string" ? raw.criteria.trim() : "";
  if (!criteria && !defects.some((d) => d.field === "criteria")) {
    defects.push({
      subject: PLAN_SUBJECT,
      field: "criteria",
      detail: "the model described no ideal lead, so ranking runs on the request alone",
      action: "ignored",
    });
  }

  return {
    plan: {
      needClarification: raw.needClarification === true,
      questions: stringList(raw.questions, "questions", defects),
      searchQueries,
      criteria,
      altAngle: typeof raw.altAngle === "string" ? raw.altAngle : "",
      location: typeof raw.location === "string" ? raw.location : "",
    },
    defects,
    blocker: null,
  };
}

// Say what was actually missing. "Planning failed" told the user nothing about
// which part of the plan was unusable, or that the rest of it was fine.
function missingQueriesReason(claimed: unknown): string {
  if (claimed === undefined) return "the plan came back with no searchQueries at all";
  if (Array.isArray(claimed) && !claimed.length) return "the plan came back with an empty searchQueries list";
  return `no usable query survived in searchQueries (the model sent ${describeValue(claimed)})`;
}

// An entry with nothing in it costs that entry and nothing else -- but it is
// still a loss, and a silent repair teaches nobody that the model is misbehaving,
// so what was dropped is reported like every other degradation.
function stringList(value: unknown, field: string, defects: ValueDefect[]): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  const dropped: unknown[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) kept.push(entry);
    else dropped.push(entry);
  }
  if (dropped.length) {
    defects.push({
      subject: PLAN_SUBJECT,
      field,
      detail: `${dropped.length} of ${value.length} ${field} entries were empty (${describeValue(dropped)}), leaving ${kept.length}`,
      action: "ignored",
    });
  }
  return kept;
}

/**
 * Checks each lead on its own, field by field.
 *
 * One bad field costs that field and nothing else. A wrong type with a single
 * possible reading is recovered; anything else is removed so persistLead's
 * existing normalisation supplies the default. Either way the model's slip is
 * reported rather than swallowed. A record is dropped only when it is genuinely
 * unusable -- no company name to put on a card. A defect in one lead never
 * touches another lead in the same response.
 */
function reviewLeads(entries: unknown[], candidateCount: number): { leads: RawLead[]; defects: ValueDefect[] } {
  const leads: RawLead[] = [];
  const defects: ValueDefect[] = [];

  entries.forEach((entry, i) => {
    const position = `lead ${i + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      defects.push({
        subject: position,
        field: "lead",
        detail: `expected an object, got ${describeValue(entry)}`,
        action: "dropped",
      });
      return;
    }

    const raw = { ...(entry as Record<string, unknown>) };
    const company = typeof raw.company === "string" ? raw.company.trim() : "";
    if (!company) {
      defects.push({
        subject: position,
        field: "company",
        detail: `no usable company name (got ${describeValue(raw.company)})`,
        action: "dropped",
      });
      return;
    }

    reviewFields(company, raw, LEAD_PROPERTIES, defects);

    // The schema this run sends permits null, so null is the model saying it
    // found no tie, not a defect. Any other unrecognised value is a claim about
    // a real relationship, and is reported rather than quietly becoming "none".
    if (raw.connection_type != null && !(CONNECTION_TYPES as string[]).includes(raw.connection_type as string)) {
      defects.push({
        subject: company,
        field: "connection_type",
        detail: `expected one of ${CONNECTION_TYPES.join(", ")}, got ${describeValue(raw.connection_type)}`,
        action: "ignored",
      });
      delete raw.connection_type;
    }

    // An index that points at no candidate is a fabricated attribution, which is
    // a louder slip than a mistyped field, so it cannot be the one that passes
    // unannounced. The lead is still kept, with no source rather than a wrong one.
    const claimedSource = raw.source_index;
    if (claimedSource == null) {
      defects.push({
        subject: company,
        field: "source_index",
        detail: "the model named no source, so this lead is kept without one",
        action: "ignored",
      });
    } else if (
      typeof claimedSource !== "number" ||
      !Number.isInteger(claimedSource) ||
      claimedSource < 1 ||
      claimedSource > candidateCount
    ) {
      defects.push({
        subject: company,
        field: "source_index",
        detail: `the model cited candidate ${describeValue(claimedSource)}, but only ${candidateCount} were researched`,
        action: "ignored",
      });
      delete raw.source_index;
    }

    leads.push(raw as unknown as RawLead);
  });

  return { leads, defects };
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
  const why =
    check.reason === "format"
      ? "not a valid email address"
      : check.reason === "domain"
        ? "domain has no mail record"
        : "the domain lookup did not complete, so this was never checked";
  return `unverified (${why}): ${check.email}`;
}

// A lead the database accepted, or the same lead in memory plus the reason it
// was not written. `saved` is never true unless a row actually came back.
interface PersistResult {
  lead: Lead;
  saved: boolean;
  error: string | null;
}

async function persistLead(
  raw: RawLead,
  ctx: {
    website: string | null;
    websiteStatus: string | null;
    src?: ExaResult;
    mode: Mode;
    userName: string;
    contact: EmailCheck | null;
  }
): Promise<PersistResult> {
  // An unrecognised connection_type costs this field and nothing else.
  const conn = (CONNECTION_TYPES as string[]).includes(raw.connection_type ?? "")
    ? (raw.connection_type as ConnectionType)
    : "none";

  const row = {
    company: raw.company || "Unknown",
    website: ctx.website,
    website_status: ctx.websiteStatus,
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

  const now = new Date().toISOString();
  const inMemory = { id: crypto.randomUUID(), board_order: 0, created_at: now, updated_at: now, ...row } as Lead;

  if (!hasServiceKey()) return { lead: inMemory, saved: false, error: null };

  // The insert can fail for reasons the model has nothing to do with -- the
  // commonest being a project that has not run the additive column migrations in
  // supabase-setup.sql. Returning a plausible in-memory lead and calling it saved
  // is the worst shape this codebase has: the board looks full and is empty on
  // reload. Keep the object for display, but say what happened.
  try {
    const { data, error } = await supabaseAdmin.from(LEADS).insert(row).select("*").single();
    if (!error && data) return { lead: data as Lead, saved: true, error: null };
    return { lead: inMemory, saved: false, error: error?.message || "the database accepted the insert but returned no row" };
  } catch (e) {
    return { lead: inMemory, saved: false, error: (e as Error).message };
  }
}

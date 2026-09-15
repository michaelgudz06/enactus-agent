import crypto from "crypto";
import { AgentEvent, ConnectionType, Lead, Mode, STATUS_COLUMNS } from "./types";
import {
  chatJSON,
  streamReasoner,
  pluck,
  extractJSON,
  salvageObjects,
  REASONER,
  STRUCTURER,
  STRUCTURER_PROVIDER,
  type Usage,
} from "./llm";
import { exaSearch, exaContents, dedupeByDomain, ExaResult } from "./exa";
import { placesSearch, hasPlacesKey } from "./places";
import {
  enrichDomains,
  disqualify,
  orgFacts,
  grounded,
  provinceFromRequest,
  hasApolloKey,
  ApolloOrg,
  DISQUALIFIER_LABEL,
  isMembershipName,
  nameMatchesDomain,
  companyKey,
} from "./apollo";
import { db, hasDatabaseUrl } from "./db";
import { MAX_COUNT, parsedCount, requestedCount } from "./count";
import { ENACTUS_ORG, ENACTUS_PROJECTS, ENACTUS_VENTURES } from "./enactus";
import { looksConversational } from "./intent";
import { reasoningFor } from "./reasoning";
import { interleave, partition } from "./funnel";
// Every rule about who the club targets -- in prose for the prompts and as
// patterns for the code -- lives in one file. See its header for why.
import {
  QUERY_GUARDRAILS,
  STRUCTURE_EXCLUSION_RULE,
  analystSystemPrompt,
  isOwnOrganisation,
  planPrompt,
} from "./targeting";
import { scoreLead, boardOrderFor } from "./score";
import { boardLines } from "./table";
import {
  budgetStopMessage,
  exaContentsCostUsd,
  exaSearchCostUsd,
  openRouterCostUsd,
  overBudget,
  tokensFromChars,
} from "./budget";
import { budgetState, flushSpend, ledgerWriteProblem, recordSpend } from "./spend";

type Emit = (e: AgentEvent) => void;

// Planner retry. See the loop in runPipeline().
const PLAN_ATTEMPTS = 2;
const PLAN_RETRY_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Plan {
  // Which of the two things this run is. Optional and defaulted to a search by
  // the branch that reads it: a planner that forgets the field must fall back
  // to the pipeline that was here before it, never to answering silently.
  intent?: "leads" | "answer";
  needClarification: boolean;
  questions: string[];
  searchQueries: string[];
  criteria: string;
  altAngle: string;
  location: string;
  placesQueries?: string[];
}

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


// Drop reasons, rendered for a human. Any reason without a label is skipped
// rather than printed: a new drop reason added without a sentence rendered as
// "3 undefined" in the shortfall message a volunteer reads.
function dropReasons(dropped: Record<string, number>): string[] {
  return Object.entries(dropped)
    .filter(([k]) => k in DISQUALIFIER_LABEL)
    .map(([k, n]) => `${n} ${DISQUALIFIER_LABEL[k as keyof typeof DISQUALIFIER_LABEL]}`);
}

// A candidate plus whatever Apollo could verify about it.
interface Candidate {
  result: ExaResult;
  domain: string;
  org: ApolloOrg | null;
}


/**
 * What the board looks like right now, in one query, as a few lines of prose.
 *
 * Grouped in SQL rather than pulled row by row: a real board is a couple of
 * hundred leads and the answer only ever needs the shape of it. Each company
 * list is truncated because the point is "here is what is in this stage", not a
 * complete inventory -- an untruncated one would be most of the prompt.
 */
async function boardSummary(mode: Mode): Promise<string> {
  if (!hasDatabaseUrl()) return "";
  try {
    const rows = (await db()`
      select status,
             count(*)::int as n,
             coalesce(sum(amount), 0)::int as total,
             string_agg(company, ', ' order by updated_at desc) as companies
        from enactus_leads where mode = ${mode}
       group by status`) as { status: string; n: number; total: number; companies: string }[];
    if (!rows.length) return `The ${mode} board is empty -- no leads have been found yet.`;
    return `The club's current ${mode} board:\n${boardLines(STATUS_COLUMNS, rows).join("\n")}`;
  } catch {
    // A board that cannot be read is worth answering the Enactus half of the
    // question anyway -- the alternative is failing a "what is our mission"
    // on a database error.
    return "";
  }
}

/**
 * Answer, instead of searching.
 *
 * Everything here is already in memory or one query away, so this path spends a
 * single cheap model call and none of the search budget. STRUCTURER rather than
 * the reasoner on purpose: there is nothing to rank, and R1's visible-reasoning
 * stream would put a scratchpad in front of a two-sentence answer.
 */
async function answerRequest(
  prompt: string,
  mode: Mode,
  userName: string,
  emit: Emit,
  charge: (u: Usage) => void
): Promise<void> {
  emit({ type: "status", step: "answer", message: "Answering from Enactus context and your board" });
  const board = await boardSummary(mode);
  const system = `You are the Enactus SFU sponsorship agent, talking to ${userName} on the club's External Relations team.

Answer the question directly and briefly, in plain prose. No markdown headings, no list longer than four items, two short paragraphs at most.

Answer ONLY from what follows. When it covers part of the question and not the rest, answer the part it covers and say in one sentence what you do not have -- refusing a whole question over one missing half is worse than a partial answer. When it covers none of it, say so and name where the answer would come from: a lead search, the board's lead detail panel, or a person on the team. A stage listed with 0 leads IS the answer for that stage, not missing data. Never invent a sponsor, a number, or a project.

${ENACTUS_ORG}

${ENACTUS_PROJECTS}

${ENACTUS_VENTURES}

${board}`;

  try {
    const { content } = await streamReasoner(
      [{ role: "system", content: system }, { role: "user", content: prompt }],
      { onContent: (d) => emit({ type: "answer", text: d }) },
      { model: STRUCTURER, provider: STRUCTURER_PROVIDER, maxTokens: 700, onUsage: charge }
    );
    // A stream that produced nothing looks identical to a finished answer once
    // `done` lands, and this pipeline has been repaired four times for exactly
    // that shape of silence.
    if (!content.trim()) emit({ type: "error", message: "The model returned an empty answer. Try rephrasing." });
  } catch (e) {
    emit({ type: "error", message: `Could not answer that: ${(e as Error).message}` });
  }
  emit({ type: "done", count: 0, searchId: null });
}

/**
 * One agent run, start to finish.
 *
 * A thin wrapper around the pipeline so that every exit -- and there are a
 * dozen of them, most of them early returns on a degraded funnel -- settles the
 * spend ledger on the way out. See flushSpend() in src/lib/spend.ts: the
 * inserts are deliberately not awaited on the hot path, and on a serverless
 * runtime an unawaited insert dies when the response stream closes.
 */
export async function runAgent(
  input: { prompt: string; mode: Mode; answers?: string; userName: string; skipClarify?: boolean },
  emit: Emit
): Promise<void> {
  try {
    await runPipeline(input, emit);
  } finally {
    await flushSpend();
  }
}

async function runPipeline(
  input: { prompt: string; mode: Mode; answers?: string; userName: string; skipClarify?: boolean },
  emit: Emit
): Promise<void> {
  const { prompt, mode, answers, userName } = input;
  const fullPrompt = answers ? `${prompt}\n\nAdditional context from user: ${answers}` : prompt;

  // How many leads to deliver. Decided here, in code, before anything else.
  const targetCount = requestedCount(fullPrompt);
  // What they actually typed. A run is one 60s function (see RUN_DEADLINE
  // below), so 25 is a real limit and not a preference -- but it has to be said
  // out loud, or asking for 50 and being handed 21 with no explanation reads as
  // the agent ignoring the request.
  const askedFor = parsedCount(fullPrompt);
  const overCap = askedFor !== null && askedFor > MAX_COUNT;
  const capNote = overCap
    ? ` (you asked for ${askedFor}; ${MAX_COUNT} is the most one run can do -- run it again to keep going)`
    : "";
  const capTail = overCap ? ` ${MAX_COUNT} is the most one run can do, so run it again to keep going.` : "";

  // Vercel Hobby kills the function at 60s (see maxDuration in the route).
  // Stop our own work at 52s so there is room to persist the leads and flush
  // the stream. Overrunning it loses the whole run.
  const RUN_DEADLINE = Date.now() + 52_000;

  // The $20 CAD monthly cap. Checked before any paid call and again before the
  // structuring stage, so a run that crosses the line mid-flight stops instead
  // of finishing on money it does not have. It is announced when it stops:
  // this pipeline has been repaired four times for degrading silently, and a
  // run that just ends looks exactly like the bug.
  const budgetBlocked = async (): Promise<boolean> => {
    const state = await budgetState();
    if (!overBudget(state)) return false;
    emit({ type: "error", message: budgetStopMessage(state) });
    return true;
  };
  if (await budgetBlocked()) return;

  // Charges one OpenRouter call. The provider reports real usage on a completed
  // call; a stream the deadline aborted has none, so the char counts stand in.
  const charge = (u: Usage) => {
    const input = u.inputTokens ?? tokensFromChars(u.inputChars);
    const output = u.outputTokens ?? tokensFromChars(u.outputChars);
    void recordSpend({
      provider: "openrouter",
      detail: u.model,
      costUsd: openRouterCostUsd(u.model, input, output),
    });
  };
  // Do NOT tune this from a one-off measurement. The same structuring call has
  // been measured at 1.0s and at over 20s within the same hour, on the same
  // model and provider -- two separate sessions have now sized this budget from
  // a lucky reading and starved the stage that actually produces the leads.
  // The reserve is deliberately generous, and structuring streams so that
  // overrunning it costs a few leads rather than all of them.
  const STRUCTURE_RESERVE_MS = 20_000;
  // R1 is verbose and never returns early, so this cap trades reasoning depth
  // for headroom rather than risking the run.
  const R1_CAP_MS = 16_000;
  const t0 = Date.now();
  const mark = (label: string) => console.log(`[agent] ${label} @${Date.now() - t0}ms`);

  // ── 1. Understand + plan ────────────────────────────────────────────────
  // The status announcing a lead target is emitted AFTER the intent branch
  // below, never here: measured live, asking "how many of our 40 leads are
  // still in prospects?" put "Target: 25 leads (you asked for 40; 25 is the
  // most one run can do -- run it again to keep going)" above a prose answer
  // that searched nothing and capped nothing, telling the user to re-run a
  // request that had not been truncated. The page renders "Starting..." while
  // `steps` is empty, so the planning wait is still covered.
  // Wider ask needs more angles, or every query returns the same few pages.
  const queryCount = targetCount <= 6 ? 3 : targetCount <= 12 ? 4 : 5;
  let plan!: Plan;
  // Every branch below this point depends on the planner, and it was a single
  // unretried call: one 429, one 502, one malformed body and the whole run
  // ended on "Planning failed" with nothing delivered. Transient OpenRouter
  // failures are the common case by far, so retry first; only a planner that
  // cannot be reached at all falls through to the degraded plan.
  const planOnce = () =>
    chatJSON<Plan>(
      [
        { role: "system", content: `${planPrompt(mode)}\n\nRespond ONLY with JSON of shape: {"intent": "leads" | "answer", "needClarification": boolean, "questions": string[], "searchQueries": string[], "criteria": string, "altAngle": string, "location": string, "placesQueries": string[]}. Provide ${queryCount} DISTINCT searchQueries that attack the request from different angles (neighbourhood plus business category, local-news coverage of independent businesses, business-improvement-association and neighbourhood directory listings, "supported a local school or team" phrasing) so they do not all return the same pages.${
              mode === "sales"
                ? ""
                : QUERY_GUARDRAILS
            } placesQueries: ${
              mode === "sales"
                ? 'up to 3 short local-business queries suited to a maps search (e.g. "gift shops Vancouver", "yarn shops Burnaby"), or [] if the request is not about local storefront businesses'
                : 'AT LEAST 2 and up to 4 short local-business queries suited to a maps search (e.g. "coffee shops Burnaby", "climbing gyms near SFU"). A maps search returns the businesses themselves rather than pages written about them, which is the only channel that reliably finds the independent storefronts this club actually wins, so never leave it empty'
            }. ALWAYS populate searchQueries, criteria and location, even when needClarification is true -- the user can skip the questions and those fields are still used. Only set needClarification true (with up to 2 short questions) if the request is too vague to search well. altAngle is a different angle to try if this search was already done before.

intent is "answer" for exactly three things: greetings, thanks and small talk ("hi", "thanks!"); questions about Enactus SFU, its mission, projects or ventures; and questions about what is already on their board. Running a search on a greeting costs real money and puts junk on the board, so those three never search.

intent is "leads" for EVERYTHING else, including a bare noun phrase naming a kind of business to go after -- "credit unions and banks in the Lower Mainland with community grant programs" and "catering companies in Burnaby" are search requests with the verb left off, not questions, and so is "20 more" or "same thing for Richmond". When you cannot tell which it is, choose "leads": a needless search costs money, but answering a search request hands the user nothing they asked for. When intent is "answer" the other fields are ignored, so leave them empty.` },
        { role: "user", content: fullPrompt },
      ],
      { model: STRUCTURER, provider: STRUCTURER_PROVIDER, maxTokens: 800 }
    );

  // Two attempts, ~400ms apart. Kept tight on purpose: this runs inside the
  // run deadline, so a long backoff would buy a plan at the cost of the
  // structuring stage that actually produces the leads.
  let planError: Error | null = null;
  for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
    try {
      planError = null;
      plan = await planOnce();
      break;
    } catch (e) {
      planError = e as Error;
      if (attempt < PLAN_ATTEMPTS - 1) await sleep(PLAN_RETRY_MS);
    }
  }

  if (planError) {
    // Degrade instead of dying. The query synthesis further down already knows
    // how to build searches from a bare prompt -- it was written for the
    // planner returning an EMPTY query list -- so an absent planner lands in
    // the same place. Intent is the one thing that genuinely cannot be
    // recovered, so looksConversational() makes the cheap, conservative call.
    console.error("planner failed after retries:", planError.message);
    emit({
      type: "status",
      step: "understand",
      message: `Planning is degraded (${planError.message}) -- working from your request as written.`,
    });
    plan = {
      intent: looksConversational(fullPrompt) ? "answer" : "leads",
      needClarification: false,
      questions: [],
      searchQueries: [],
      criteria: fullPrompt,
      altAngle: "",
      location: "",
      placesQueries: [],
    };
  }

  if (plan.intent === "answer") {
    await answerRequest(fullPrompt, mode, userName, emit, charge);
    return;
  }

  emit({
    type: "status",
    step: "understand",
    message: `Understanding your request. Target: ${targetCount} lead${targetCount === 1 ? "" : "s"}${capNote}`,
  });

  if (plan.needClarification && !answers && !input.skipClarify && plan.questions?.length) {
    emit({ type: "clarify", questions: plan.questions.slice(0, 2) });
    return;
  }

  // ── 2. History check (lightweight, in DB) ───────────────────────────────
  const norm = normalize(fullPrompt);
  if (hasDatabaseUrl()) {
    try {
      const data = (await db()`
        select prompt, normalized, created_at from enactus_searches
        where mode = ${mode} order by created_at desc limit 40`) as {
        prompt: string;
        normalized: string | null;
      }[];
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

  // ── 3. Discover ─────────────────────────────────────────────────────────
  // The funnel is sized from targetCount rather than fixed. Previously this was
  // 3 queries x 6 results capped at 6 candidates, so "give me 10 leads" could
  // not have succeeded no matter how the model was prompted. Roughly 3
  // candidates per requested lead survives dedupe, the noise filter and the
  // already-on-the-board filter with enough left to choose from.
  // The planner returns needClarification with an EMPTY searchQueries array for
  // requests it considers vague ("give me 10 leads from Burnaby" hits this every
  // time). When the user has skipped the questions there is nothing to fall back
  // on, and the run used to die with a misleading "No candidates found". Asking
  // the planner nicely is not enough on its own, so synthesise queries here too.
  let queries = (plan.searchQueries ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, queryCount);
  if (!queries.length) {
    const subject = fullPrompt.replace(/\b\d{1,3}\b/g, " ").replace(/\s+/g, " ").trim();
    queries =
      mode === "sales"
        ? [subject, `${subject} companies`, `${subject} buyers`]
        : [
            `${subject} companies community sponsorship`,
            `${subject} businesses supporting local students`,
            `${subject} corporate giving community investment`,
          ];
    queries = queries.slice(0, queryCount);
  }
  const candidateTarget = Math.min(60, Math.max(12, targetCount * 3));
  // Dividing the target across queries assumed the queries return disjoint
  // results. They do not -- they are deliberately overlapping phrasings of one
  // subject, so dedupeByDomain collapses most of the union (18 raw -> 6 in one
  // observed failing run). At targetCount=5 the old arithmetic asked for 15 raw
  // URLs, fewer than the 18 the build before it used, so the count rebuild made
  // small asks WORSE at discovery while fixing them at structuring. Overshoot
  // instead: the searches already run in one Promise.all, so a wider net costs
  // one search's wall clock and the pool is sliced back before any LLM sees it.
  const perQuery = Math.min(25, Math.max(10, Math.ceil((candidateTarget * 2) / Math.max(1, queries.length))));

  // Places is the PRIMARY discovery channel for sponsor mode, not a side
  // channel. The planner's own prompt has said so for months -- "a maps search
  // returns the businesses themselves rather than pages written about them,
  // which is the only channel that reliably finds the independent storefronts
  // this club actually wins" -- while the code capped it at 3 queries asking
  // for half as many results as Exa, and gave the results a one-line text blob
  // no model could reason from. The channel the club wins through was the one
  // wired in as optional.
  //
  // Sales mode keeps the old shape: the planner is told to return placesQueries
  // only when the request is about local storefronts, so there is frequently
  // nothing to run.
  const placesQueries = (plan.placesQueries ?? []).filter((q) => typeof q === "string" && q.trim());
  const placesPrimary = mode === "sponsor";
  const placesQueryCap = placesPrimary ? 4 : 3;
  const usingPlaces = hasPlacesKey() && placesQueries.length > 0;
  emit({
    type: "status",
    step: "discover",
    message: usingPlaces
      ? `Searching Google Places for the businesses themselves (${placesQueries
          .slice(0, placesQueryCap)
          .join("  ·  ")}), and the web with Exa: ${queries.join("  ·  ")}`
      : `Searching the web with Exa: ${queries.join("  ·  ")}`,
  });

  // ── 2b. What is already on the board ────────────────────────────────────
  // Read BEFORE discovery, not after. This used to run only as a post-filter,
  // which meant every search spent its whole result budget re-finding companies
  // the club already had and then threw them away: measured at a 206-lead
  // board, 9 of 14 usable candidates were deleted here, leaving 4 to fill an
  // ask for 10. The filter below still runs -- it is the net for leads whose
  // website is null and so cannot be excluded by domain -- but the domains now
  // go to Exa first so it returns ground we have not covered.
  const boardDomains = new Set<string>();
  const boardNames = new Set<string>();
  if (hasDatabaseUrl()) {
    try {
      const rows = (await db()`
        select website, company from enactus_leads where mode = ${mode}`) as {
        website: string | null;
        company: string | null;
      }[];
      for (const r of rows ?? []) {
        if (r.website)
          boardDomains.add(domainOf(r.website.startsWith("http") ? r.website : `https://${r.website}`));
        if (r.company) boardNames.add(companyKey(r.company));
      }
      boardDomains.delete("");
    } catch {
      // Non-fatal: a dedupe we could not run must not stop the search.
    }
  }
  const excludeDomains = [...boardDomains];

  let found: ExaResult[] = [];
  try {
    const exaBatches = Promise.all(
      queries.map((q) => {
        // Charged per request, not per result, and billed whether or not the
        // search returns anything -- so it is recorded before the .catch().
        void recordSpend({ provider: "exa", detail: "search", costUsd: exaSearchCostUsd(perQuery) });
        return exaSearch(q, { numResults: perQuery, excludeDomains }).catch(() => []);
      })
    );
    // Places returns actual businesses rather than pages about businesses, so
    // it is the better source for local storefront sponsors. Shaped into the
    // same ExaResult so everything downstream stays source-agnostic.
    // Places is free at this tier and capped at 20 results per call, so ask for
    // the whole candidate target from each query rather than half of it: the
    // pool is cut back before any model sees it, and the rows that survive
    // dedupe are the ones worth having.
    const placeBatches = usingPlaces
      ? Promise.all(
          placesQueries.slice(0, placesQueryCap).map((q) =>
            placesSearch(q, { maxResults: placesPrimary ? 20 : Math.ceil(candidateTarget / 2) }).then((ps) =>
              ps
                .filter((p) => p.website)
                .map<ExaResult>((p) => ({
                  url: p.website!,
                  title: p.name,
                  publishedDate: null,
                  author: null,
                  // A placeholder until enrichPlaces() below fetches the real
                  // page. Kept as the fallback for anything that could not be
                  // fetched -- a name and a street address still beat nothing.
                  text: [p.name, p.primaryType?.replace(/_/g, " "), p.address]
                    .filter(Boolean)
                    .join(" · "),
                  highlights: [],
                  source: "places" as const,
                }))
            )
          )
        )
      : Promise.resolve([] as ExaResult[][]);

    const [exa, places] = await Promise.all([exaBatches, placeBatches]);
    found = dedupeByDomain([...exa.flat(), ...places.flat()].filter((r) => r.url));
  } catch (e) {
    emit({ type: "error", message: `Discovery failed: ${(e as Error).message}` });
    return;
  }

  // Obvious non-company noise: encyclopedias, forums and job boards are never
  // the sponsor themselves.
  found = found.filter(
    (r) => !/wikipedia\.org|reddit\.com|indeed\.com|glassdoor\.|linkedin\.com|facebook\.com|yelp\./.test(r.url)
  );
  const foundCount = found.length;
  mark(`discovery done (${foundCount} raw)`);

  // ── 3a. Drop anything already on the board ──────────────────────────────
  // A rotating volunteer team runs this every few weeks. Without this filter
  // the same café resurfaces every search and two people email it a month
  // apart, which is the one failure that actually costs the club a sponsor.
  // Uses the sets read at 2b -- one query per run, not two. Exa has already
  // been told to avoid these domains, so this is now a backstop for the leads
  // it could not be told about (64 of 206 board rows have no website) and for
  // Google Places results, which never saw the exclusion list.
  let alreadyKnown = 0;
  {
    const before = found.length;
    found = found.filter((r) => {
      const d = domainOf(r.url);
      const n = (r.title ?? "").trim().toLowerCase();
      return !(boardDomains.has(d) || (n && boardNames.has(n)));
    });
    alreadyKnown = before - found.length;
  }

  // ── 3b. Verify against Apollo ───────────────────────────────────────────
  // Deterministic reality check: Apollo confirms a candidate is a real,
  // currently-staffed company in the right province in ~0.4s per 10 domains.
  // This is what removes defunct companies, national chains with no local
  // decision maker, and trade associations -- classes the prompt rules alone
  // never reliably caught.
  const province = provinceFromRequest(fullPrompt, plan.location, plan.criteria);
  let candidates: Candidate[] = found.map((r) => ({ result: r, domain: domainOf(r.url), org: null }));
  const dropped: Record<string, number> = {};
  if (hasApolloKey() && candidates.length) {
    const enriched = await enrichDomains(
      candidates.map((c) => c.domain).filter(Boolean),
      { signal: AbortSignal.timeout(Math.max(2000, Math.min(8000, RUN_DEADLINE - Date.now() - 20_000))) }
    );
    for (const c of candidates) c.org = enriched.get(c.domain) ?? null;
    mark(`apollo done`);
  }
  // Outside the Apollo block on purpose: the membership-name test needs no
  // enrichment, so a missing or rate-limited APOLLO_API_KEY must not silently
  // switch the whole guard off.
  candidates = candidates.filter((c) => {
    const why = disqualify(c.org, { province, name: c.result.title });
    if (why) dropped[why] = (dropped[why] ?? 0) + 1;
    return !why;
  });

  // Mix the pool across BOTH axes that matter, rather than sorting on either.
  //
  // Verified vs unverified: sorting verified first would quietly undo the whole
  // point of disqualify() never dropping on missing data -- Apollo has poor
  // coverage of very small local businesses, so a verified-first sort pushes
  // exactly the corner-shop in-kind sponsors this club relies on below the cut
  // whenever the pool is large.
  //
  // Places vs Exa: Places returns the businesses, Exa returns pages about them,
  // and Exa returns many times more rows. Left proportional, the channel that
  // finds what this club actually wins takes a handful of slots in a pool that
  // is then cut in half. Round-robin gives it an even share of what the model
  // gets to choose from.
  const [fromPlaces, fromExa] = partition(candidates, (c) => c.result.source === "places");
  const byVerification = (list: Candidate[]) =>
    interleave([list.filter((c) => c.org), list.filter((c) => !c.org)]);
  const mixed = interleave([byVerification(fromPlaces), byVerification(fromExa)]);
  // Give the model roughly twice what we need so it has genuine choice, without
  // paying to reason over candidates that can never make the cut.
  candidates = mixed.slice(0, Math.max(targetCount * 2, 12));

  // ── 3c. Give the Places candidates real evidence ────────────────────────
  // A Places row arrives as "Aster Cafe · cafe · 123 Main St" and nothing else.
  // That is not enough to reason about, not enough to ground a contact against,
  // and it loses on sight to any Exa result that came with two paragraphs of
  // prose -- so the model was systematically preferring pages ABOUT businesses
  // over the businesses themselves, which is the exact inversion this channel
  // exists to correct.
  //
  // Run AFTER the cut, so only candidates that will actually be reasoned over
  // are paid for. This is not free and it is not cheaper per page than a
  // search -- a 10-result search bundles its pages for $0.007, ten /contents
  // pages are $0.010 -- so the placement matters: at most a dozen URLs, once,
  // for the candidates a model is about to spend far more than that reading.
  const needText = candidates.filter((c) => c.result.source === "places" && c.domain);
  if (needText.length && !(await budgetBlocked())) {
    void recordSpend({
      provider: "exa",
      detail: "contents",
      costUsd: exaContentsCostUsd(needText.length),
    });
    const pages = await exaContents(
      needText.map((c) => c.result.url),
      { signal: AbortSignal.timeout(Math.max(2000, Math.min(8000, RUN_DEADLINE - Date.now() - 20_000))) }
    );
    let enriched = 0;
    for (const c of needText) {
      const page = pages.get(c.result.url);
      // Keep the address placeholder when the fetch came back empty: a name and
      // a street still beat nothing, and an empty text field reads downstream
      // as "no evidence" rather than "not fetched".
      if (!page?.text?.trim()) continue;
      c.result = { ...c.result, text: page.text, highlights: page.highlights, source: "places" };
      enriched++;
    }
    mark(`places contents done (${enriched}/${needText.length} enriched)`);
  }

  if (!candidates.length) {
    const why = alreadyKnown
      ? `Everything found was already on the board (${alreadyKnown} skipped). Try a different angle or city.`
      : "No candidates found. Try rephrasing or broadening the request.";
    emit({ type: "status", step: "discover", message: why });
    emit({ type: "done", count: 0, searchId: null });
    return;
  }

  // Say what was filtered rather than silently narrowing: a run that quietly
  // drops half its candidates reads as "the agent is weak at finding people".
  const notes = [
    `${foundCount} found`,
    alreadyKnown ? `${alreadyKnown} already on the board` : "",
    ...dropReasons(dropped),
  ].filter(Boolean);
  emit({
    type: "status",
    step: "research",
    message: `${notes.join(", ")} → analyzing ${candidates.length} candidates for ${targetCount} leads`,
  });

  // ── 4. Reason + score with R1 (visible reasoning) ───────────────────────
  // Apollo's facts go in as a labelled line so the model states real employee
  // counts, industries and locations instead of inventing them. Anything it
  // could not verify simply has no VERIFIED line.
  // Numbered with the candidate's GLOBAL index so a chunked structuring pass can
  // render a subset without renumbering: source_index always points straight
  // back into candidates[].
  const renderContext = (list: Candidate[], startIdx: number) =>
    list
      .map((c, i) => {
        const r = c.result;
        const facts = orgFacts(c.org);
        return [
          `[${startIdx + i + 1}] ${c.org?.name || r.title || c.domain}`,
          `URL: ${r.url}`,
          facts,
          (r.text || r.highlights.join(" ") || "").slice(0, 700),
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  const context = renderContext(candidates, 0);
  // The labels the prompt gives each candidate, in the same order, so the
  // reasoning slicer can attribute a block to "[7]" or to the company named in
  // it. Built from the same expression renderContext uses, so the two cannot
  // disagree about what candidate [7] is called.
  const candidateNames = candidates.map((c) => c.org?.name || c.result.title || c.domain);

  const scoreSystem = analystSystemPrompt(mode);

  // Stage A — R1 reasons out loud (visible), no JSON. Capped so it stays snappy.
  const reasoningUser = `User request: ${fullPrompt}
Ideal lead: ${plan.criteria}

Candidates:
${context}

The team needs ${targetCount} ${mode === "sales" ? "customers" : "sponsors"} to contact from this list, so cover at least ${targetCount} of the candidates. Outreach is cheap and breadth beats precision here: a plausible sponsor worth an email is a yes, not just the perfect one. Only rule a candidate out if it is genuinely unsuitable.

Reason candidate by candidate: how would each be approached and why might they say yes? Weigh SFU/Enactus ties, local fit, how winnable the ask is${mode === "sales" ? "" : ", and which specific Enactus SFU project each best aligns with"}. Where a VERIFIED line is present, use those figures rather than estimating. Be concise and specific. Do NOT output JSON, just think it through.`;

  mark("plan+exa done");
  emit({ type: "status", step: "reason", message: "DeepSeek R1 reasoning about each candidate" });
  // A fixed per-stage cap on R1 alone is not enough: planning and Exa have
  // already spent an unknown amount of the 60s function limit, and structuring
  // still has to run after this. Both LLM stages share ONE deadline instead, so
  // whatever planning overran comes out of R1's slice rather than out of
  // structuring, which is the stage that actually produces the leads.
  const msLeft = () => RUN_DEADLINE - Date.now();
  const R1_BUDGET_MS = Math.max(5000, Math.min(R1_CAP_MS, msLeft() - STRUCTURE_RESERVE_MS));
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), R1_BUDGET_MS);
  let reasoningText = "";
  try {
    const r = await streamReasoner(
      [
        { role: "system", content: scoreSystem },
        { role: "user", content: reasoningUser },
      ],
      {
        onReasoning: (d) => emit({ type: "reasoning", text: d }),
        onContent: (d) => emit({ type: "reasoning", text: d }),
      },
      {
        model: REASONER,
        maxTokens: 1200,
        signal: controller.signal,
        fastProvider: true,
        onUsage: charge,
      }
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
    mark(`R1 done (budget was ${R1_BUDGET_MS}ms)`);
  }

  // Stage B — V3 turns the analysis into reliable structured JSON.
  emit({ type: "status", step: "structure", message: "Structuring the shortlisted leads" });

  // Per chunk, not per run. The whole trace used to be cut at 3000 chars from
  // the FRONT and handed to every chunk alike, so the last chunk read an
  // argument about the first chunk's candidates and R1's conclusions -- which
  // land at the end -- were discarded outright. See src/lib/reasoning.ts.
  const REASONING_CHARS_PER_CHUNK = 3000;

  // Measured on a real 10-lead run: v3.2 emits ~400 output tokens per lead and
  // the provider was managing ~90 tok/s, so ten leads is ~45s of generation --
  // more than the entire function budget, and no reshuffling of the time
  // budget can create throughput that isn't there. Splitting the candidates
  // into DISJOINT chunks structured concurrently turns that into roughly one
  // chunk's wall-clock. Disjoint inputs mean two chunks cannot return the same
  // company, so there is no cross-chunk dedupe to get wrong.
  // Chunks are small on purpose. At 5 leads a chunk still ran past the budget
  // and had to be salvaged mid-lead; at 3 it finishes cleanly, and a chunk that
  // FINISHES is worth more than a bigger one that gets cut off.
  const LEADS_PER_CHUNK = 3;
  // Never make more chunks than the candidate pool can feed -- a chunk asked
  // for more leads than it has candidates simply under-delivers.
  const nChunks = Math.max(
    1,
    Math.min(4, Math.floor(candidates.length / LEADS_PER_CHUNK), Math.ceil(targetCount / LEADS_PER_CHUNK))
  );
  const perChunk = Math.ceil(candidates.length / nChunks);
  const wantPerChunk = Math.ceil(targetCount / nChunks);

  const structureUserFor = (slice: Candidate[], startIdx: number, want: number) => `User request: ${fullPrompt}
Ideal lead: ${plan.criteria}
Mode: ${mode}

Candidates:
${renderContext(slice, startIdx)}

Analyst reasoning to base your selection on:
${reasoningFor(reasoningText, {
    names: candidateNames,
    first: startIdx,
    count: slice.length,
    maxChars: REASONING_CHARS_PER_CHUNK,
  })}

Output ONLY JSON. Return EXACTLY ${want} leads if the candidates allow it, best first. There are ${slice.length} candidates above, so returning fewer than ${want} means leaving usable prospects unsent. Include every candidate that is a plausible ${mode === "sales" ? "customer" : "sponsor"} worth one email, not only the ideal ones. Only return fewer than ${want} if the remaining candidates are genuinely unsuitable.
{"leads":[{"company","website","industry","location","description","contact_name","contact_role","contact_email","connection_type","connection_note","sponsorship_type","why_fit","reasoning","source_index"}]}
Rules:
- connection_type is one of: "alum" (SFU/Enactus alum tie), "past_sponsor", "ecosystem" (SFU entrepreneurship ecosystem), or "none". Only claim a connection if the text supports it.
- sponsorship_type: for sponsor mode an array subset of ["monetary","in_kind"]; for sales mode 1-3 short angle tags.
- description is one tight sentence. why_fit is ONE sentence under 100 characters${mode === "sales" ? "" : ", naming the specific Enactus SFU project this sponsor best aligns with (e.g. Nourish, Alara, Unify, SKYES, NextSpark, Renovo, SensMS, Second Savour)"}. Open with the reason, not the company name, and never restate the description.
- Where a candidate has a VERIFIED line, take industry and location from it verbatim. Never invent an employee count, revenue figure or founding year.
- reasoning: ONE sentence under 200 characters about THIS company ONLY -- the single strongest piece of concrete evidence from the research, then the first ask it justifies${mode === "sales" ? "" : " and the Enactus SFU project it funds"}. Never mention, compare, or rank other candidates in it. If the evidence is thin, say so instead of padding.
- contact_email only if visible in the text; otherwise null. source_index is the [n] you used.
${mode === "sales" ? "" : STRUCTURE_EXCLUSION_RULE}`;

  let parsedLeads: RawLead[] | null = null;
  let structureError: string | null = null;
  let truncated = false;
  // Give structuring everything that is left, minus a slice for persisting.
  // All chunks share one deadline because they run concurrently: the budget is
  // wall-clock, not work, so it is not divided between them.
  const structureCtl = new AbortController();
  const structureAllowance = Math.max(5000, msLeft() - 6000);
  // Measured ~400 output tokens per lead at the full field set, and a run at
  // 1800 truncated mid-JSON even for 5 leads, losing everything. Size the
  // ceiling to what this chunk is actually asked for.
  const structureTokens = Math.min(12_000, Math.max(2500, wantPerChunk * 420 + 600));
  mark(`structure start (allowance ${structureAllowance}ms, ${nChunks} chunks x ${wantPerChunk} leads, ${structureTokens} tok)`);
  const structureTimer = setTimeout(() => structureCtl.abort(), structureAllowance);

  // Second gate. The reasoning stage above has now been charged, so a run that
  // started just under the cap can be over it by here.
  if (await budgetBlocked()) {
    clearTimeout(structureTimer);
    return;
  }

  const runChunk = async (idx: number): Promise<RawLead[]> => {
    const startIdx = idx * perChunk;
    const slice = candidates.slice(startIdx, startIdx + perChunk);
    if (!slice.length) return [];
    let body = "";
    try {
      const s = await streamReasoner(
        [
          { role: "system", content: `${scoreSystem} Output only the JSON described, nothing else.` },
          // Never ask a chunk for more leads than it was given candidates. At
          // targetCount=10 with a pool of 6, each chunk saw 3 candidates and was
          // told "there are 3 candidates above, so returning fewer than 5 means
          // leaving usable prospects unsent" -- a false statement, and direct
          // pressure to invent a company.
          { role: "user", content: structureUserFor(slice, startIdx, Math.min(wantPerChunk, slice.length)) },
        ],
        {},
        {
          model: STRUCTURER,
          provider: STRUCTURER_PROVIDER,
          maxTokens: structureTokens,
          signal: structureCtl.signal,
          temperature: 0.3,
          json: true,
          onUsage: charge,
        }
      );
      body = s.content;
    } catch (e) {
      // One slow chunk must not lose the chunks that did finish.
      if (!structureError) structureError = (e as Error).message;
    }
    if (!body) return [];

    // Whole-body parse first; fall back to scanning out the leads that did
    // finish. This covers both an abort mid-stream and the model closing
    // cleanly with slightly malformed JSON, which was observed on 3 of 12
    // otherwise healthy calls -- in both cases the finished leads are still
    // in the buffer.
    // Candidates are numbered GLOBALLY in the prompt so chunks need no
    // renumbering, but a model handed a list starting at [10] still often
    // numbers its answers 1,2,3. Unfixed, chunk 4's "source_index: 2" resolved
    // to a chunk-1 candidate and the lead was grounded against a page it was
    // never shown. Only this scope knows startIdx and slice.length.
    const remap = (l: RawLead): RawLead => {
      const si = typeof l?.source_index === "number" ? l.source_index : NaN;
      if (si > startIdx && si <= startIdx + slice.length) return l; // already global
      if (si >= 1 && si <= slice.length) return { ...l, source_index: startIdx + si }; // local
      return { ...l, source_index: undefined }; // unattributable: keep the lead, drop the link
    };

    try {
      const whole = pluck<RawLead>(extractJSON(body), "leads");
      // A valid EMPTY array is a parse success, not a failure: falling through
      // to salvage on it returns whatever sibling object follows "leads": [].
      if (whole) return whole.map(remap);
    } catch {
      // fall through to salvage
    }
    const salvaged = salvageObjects(body) as RawLead[];
    if (salvaged.length) {
      truncated = true;
      mark(`chunk ${idx + 1}: salvaged ${salvaged.length} leads from a partial body (${body.length} chars)`);
    }
    return salvaged.map(remap);
  };

  try {
    const chunks = await Promise.all(Array.from({ length: nChunks }, (_, i) => runChunk(i)));
    const all = chunks.flat();
    if (all.length) parsedLeads = all;
  } finally {
    clearTimeout(structureTimer);
    mark(`structure done (${parsedLeads?.length ?? 0} leads)`);
  }
  if (!parsedLeads?.length && !structureError) {
    structureError = structureCtl.signal.aborted
      ? "ran out of time before structuring finished"
      : "model returned no usable leads";
  }
  if (!parsedLeads?.length) {
    // Keep the cause: a swallowed error here is indistinguishable from "the
    // model had an off day", which hides real outages (bad key, dead model id,
    // truncated output) behind a retry suggestion.
    console.error("structure step failed:", structureError);
    emit({
      type: "error",
      message: `The model did not return usable results (${structureError}). Try again or rephrase.`,
    });
    return;
  }

  const finalized: Lead[] = [];
  let persistError: string | null = null;
  // The system prompt already says to exclude membership bodies, and a real run
  // returned one anyway. The prompt is a suggestion; this is the rule.
  // SFU itself joins the list for the same reason: a run returned "Simon Fraser
  // University" as a sponsor prospect for its own student club.
  // Everything the model produced funnels through here on its way to the board,
  // so this is where the shape is checked once rather than trusted N times.
  // salvageObjects and pluck can both hand back a non-lead (a sibling object, a
  // stray string); without the type test those reach the database.
  const seenNames = new Set<string>();
  const usable = parsedLeads.filter((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.company !== "string" || !raw.company.trim()) return false;
    if (isMembershipName(raw.company)) {
      dropped.membership_org = (dropped.membership_org ?? 0) + 1;
      return false;
    }
    if (isOwnOrganisation(raw.company)) return false;
    // Chunks were assumed to be unable to collide because their inputs are
    // disjoint. A real Langley run emitted "Otter Co-Op" three times, each as
    // its own board row: the model names a company mentioned INSIDE a page, and
    // two pages about one firm survive dedupeByDomain. Duplicate cards mean the
    // same sponsor gets emailed twice by two volunteers, which is the failure
    // that costs the relationship.
    //
    // Checked against the board too, not just against this run. The pre-search
    // filter can only compare Exa PAGE TITLES to stored names, and a page title
    // is never a bare company name, so it catches nothing by name -- and the
    // domain half misses every board row whose website is null. This is the
    // first point where a real company name exists to compare.
    const key = companyKey(raw.company);
    if (seenNames.has(key)) {
      dropped.duplicate = (dropped.duplicate ?? 0) + 1;
      return false;
    }
    if (boardNames.has(key)) {
      alreadyKnown++;
      return false;
    }
    seenNames.add(key);
    return true;
  });
  // The prompt asks for exactly targetCount, but a prompt is not a guarantee:
  // enforce the ceiling here so an over-eager run cannot clutter the board or
  // burn credits. Under-delivery is reported honestly below instead.
  // Build every row first, then write them in ONE statement. This used to be a
  // loop of awaited single-row inserts, which is up to 25 sequential round
  // trips at the point in the run where there is least time left: the deadline
  // that cuts structuring short is the same deadline these inserts run against,
  // and a slow database turned "the model finished 10 leads" into "6 of them
  // were saved". One statement is one round trip whatever the lead count.
  const built = usable.slice(0, targetCount).map((raw) => {
    // `?? 1` silently bound every lead with no source_index to candidate #1 --
    // which is how one Langley candidate became three separate board rows. An
    // unattributable lead now resolves to undefined and simply keeps no site.
    const cand = candidates[(raw.source_index ?? 0) - 1];
    // The fetched URL only. Taking `raw.website ||` first meant the model could
    // supply its own domain, and the nameMatchesDomain guard below would then be
    // checking the model's domain against the model's company name -- the guard
    // grading its own homework, which passes.
    const website = cand ? `https://${cand.domain}` : null;
    return buildLeadRow(raw, {
      website,
      src: cand?.result,
      org: cand?.org ?? null,
      mode,
      userName,
    });
  });

  const written = await persistLeadRows(built);
  persistError = written.error;
  // Lost a race with the unique index: the company is already on the board, so
  // it is not a new lead and must not be shown as one.
  alreadyKnown += written.duplicates;
  for (const lead of written.leads) {
    finalized.push(lead);
    emit({ type: "lead", lead });
  }

  // Honour the count out loud. Silently returning 3 when 10 were asked for is
  // exactly the behaviour that made the agent feel like it was not listening;
  // if the funnel genuinely could not fill the order, say so and say why.
  if (finalized.length < targetCount) {
    const reasons = [
      alreadyKnown ? `${alreadyKnown} were already on the board` : "",
      ...dropReasons(dropped),
    ].filter(Boolean);
    emit({
      type: "status",
      step: "shortfall",
      message:
        `You asked for ${askedFor ?? targetCount} and I found ${finalized.length}` +
        (reasons.length ? ` (${reasons.join(", ")})` : "") +
        (truncated
          ? `. The model ran out of time partway through, so these are the ones it finished -- run it again to fill the rest.`
          : `. Try a broader area or a different industry angle for more.`) +
        capTail,
    });
  }

  // A dead database used to fail silently here: cards rendered from in-memory
  // objects and vanished on refresh, which reads as "the agent is flaky"
  // rather than "the database is down". Say it out loud instead. One event,
  // not one per lead.
  if (persistError) {
    emit({
      type: "error",
      message: `These leads were NOT saved and will disappear on refresh. Database error: ${persistError}`,
    });
  }

  // ── 5. Save the search to history ───────────────────────────────────────
  let searchId: string | null = null;
  if (hasDatabaseUrl()) {
    try {
      const [row] = (await db()`
        insert into enactus_searches (prompt, normalized, mode, result_count, created_by_name)
        values (${fullPrompt}, ${norm}, ${mode}, ${finalized.length}, ${userName})
        returning id`) as { id: string }[];
      searchId = row?.id ?? null;
    } catch {
      // non-fatal: history is a nicety, the leads themselves already persisted
    }
  }

  // A cap that is not being recorded is not a cap. If the ledger could not be
  // written this run, say so rather than let the next run believe the total.
  const ledgerProblem = ledgerWriteProblem();
  if (ledgerProblem) {
    emit({ type: "status", step: "budget", message: `Budget tracking degraded -- ${ledgerProblem}` });
  }
  emit({ type: "done", count: finalized.length, searchId });
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
  why_fit?: string | null;
  reasoning?: string | null;
  source_index?: number;
}

/** One row of enactus_leads, exactly as it is inserted. */
type LeadRow = Omit<Lead, "id" | "created_at" | "updated_at">;

function buildLeadRow(
  raw: RawLead,
  ctx: {
    website: string | null;
    src?: ExaResult;
    org: ApolloOrg | null;
    mode: Mode;
    userName: string;
  }
): LeadRow {
  // Every claim about a PERSON or a shared history has to survive the evidence
  // we actually fetched. This runs first so there is no path into the database
  // that skips it. Uses the full ExaResult, not the 700-char slice the model
  // saw, so a real contact further down the page is not thrown away.
  const evidence = [
    ctx.src?.title,
    ctx.src?.text,
    ctx.src?.highlights?.join(" "),
    orgFacts(ctx.org),
    ctx.org?.name,
  ]
    .filter(Boolean)
    .join("\n");
  const safe = grounded(raw, evidence, ctx.website ? domainOf(ctx.website) : null);

  const conn = (["alum", "past_sponsor", "ecosystem", "none"].includes(safe.connection_type ?? "")
    ? safe.connection_type
    : "none") as ConnectionType;

  // Apollo's values win over the model's wherever it has them: these are the
  // fields most likely to be confabulated, and Apollo's are looked up.
  const apolloLocation = [ctx.org?.city, ctx.org?.state].filter(Boolean).join(", ") || null;

  // Everything below is inherited from the candidate PAGE. If the company the
  // model named is not that page's owner, the page's domain and the publisher's
  // Apollo facts belong to someone else -- an empty website is a smaller error
  // than a confident link to the wrong company.
  const company = raw.company || ctx.org?.name || "Unknown";
  const siteIsTheirs = nameMatchesDomain(company, ctx.website ? domainOf(ctx.website) : null);
  // Resolved once so the score and the stored row cannot disagree about what
  // industry or location this lead has.
  const row_industry = (siteIsTheirs ? ctx.org?.industry : null) ?? raw.industry ?? null;
  const row_location = (siteIsTheirs ? apolloLocation : null) ?? raw.location ?? null;

  // Pass 1 of two. Contact fields are almost always null at this point -- Exa
  // returns pages about companies, not staff directories -- so the contact
  // weights simply do not fire yet. findContactFor() re-scores the row the
  // moment a real person is found, which is also the moment those weights
  // become knowable. See the header of score.ts.
  const fit = scoreLead({
    company,
    industry: row_industry,
    description: raw.description ?? null,
    location: row_location,
    employees: ctx.org?.employees ?? null,
    connectionType: conn,
    contactName: safe.contact_name,
    contactRole: safe.contact_role,
    contactEmail: safe.contact_email,
  });

  return {
    company,
    website: siteIsTheirs ? ctx.website : null,
    industry: row_industry,
    description: raw.description ?? null,
    contact_name: safe.contact_name ?? null,
    contact_role: safe.contact_role ?? null,
    contact_email: safe.contact_email ?? null,
    location: row_location,
    connection_type: conn,
    connection_note: safe.connection_note ?? null,
    sponsorship_type: Array.isArray(raw.sponsorship_type) ? raw.sponsorship_type : [],
    // Computed in src/lib/score.ts from the club's own outreach history, never
    // emitted by a model. The previous occupant of this column WAS model-emitted
    // -- a 0-100 number invented from nothing, which made volunteers skip lead
    // #7 for no reason -- so the rule that replaced it is that every point here
    // traces back to a field on this row. Rows written before 2026-08-20 hold
    // the old invented values and are not comparable with these.
    fit_score: fit.score,
    // The board sorts board_order ASC, so a better lead needs a smaller number
    // (score.ts negates it). Without this write the ranking is invisible: every
    // row defaults to 0, the sort collapses to created_at desc, and because
    // leads insert best-first the top pick lands at the BOTTOM of the board.
    board_order: boardOrderFor(fit.score),
    why_fit: raw.why_fit ?? null,
    // Per-company only. ctx.reasoningTrace was up to 4000 chars of the SHARED
    // analyst trace about EVERY candidate in the run, so whenever V3 omitted a
    // company-specific reasoning, every card in that run got the same dump
    // comparison-shopping other companies under a panel titled "Why we chose
    // {company}" -- the exact thing the prompt above forbids. why_fit was the
    // next fallback and it is already on the card, so it only made the
    // disclosure a duplicate. Nothing to say is honest.
    reasoning: raw.reasoning?.trim() || null,
    sources: ctx.src ? [{ url: ctx.src.url, title: ctx.src.title ?? undefined }] : [],
    status: "prospects" as const,
    mode: ctx.mode,
    created_by_name: ctx.userName,
  } as LeadRow;
}

// The 19 columns of enactus_leads that a run writes, and the casts the two
// non-scalar ones need. Declared once so the column list, the placeholder
// builder and the value builder below cannot drift apart.
const LEAD_COLUMNS = [
  "company", "website", "industry", "description", "contact_name", "contact_role",
  "contact_email", "location", "connection_type", "connection_note",
  "sponsorship_type", "fit_score", "board_order", "why_fit", "reasoning", "sources",
  "status", "mode", "created_by_name",
] as const;
const LEAD_CASTS: Record<string, string> = { sponsorship_type: "::text[]", sources: "::jsonb" };

function leadValues(row: LeadRow): unknown[] {
  return LEAD_COLUMNS.map((c) => (c === "sources" ? JSON.stringify(row.sources) : row[c]));
}

/**
 * The key the unique index actually uses.
 *
 * NOT companyKey(): that one is deliberately fuzzy (it drops legal suffixes,
 * bracketed qualifiers and punctuation) and is the right tool for comparing a
 * model's name against the board. The index is
 * `lower(btrim(company))` and nothing else, so matching an insert result or a
 * conflict against the database has to use the same plain normalisation or it
 * silently matches nothing -- "Purdys Chocolatier Inc." conflicts as
 * "purdys chocolatier inc.", never as "purdys chocolatier".
 */
const dbKey = (name: string) => name.trim().toLowerCase();

/**
 * Insert leads one at a time, keeping whatever succeeds.
 *
 * The recovery path for a rejected batch. Deliberately sequential and
 * deliberately silent per row: it only ever runs after the fast path has
 * already failed, and the point is to salvage the leads that are fine rather
 * than to diagnose the one that is not.
 */
async function insertRowsIndividually(rows: LeadRow[]): Promise<{ leads: Lead[] }> {
  const cols = LEAD_COLUMNS.join(", ");
  const leads: Lead[] = [];
  for (const row of rows) {
    const values = leadValues(row);
    const placeholders = values.map((_, i) => `$${i + 1}${LEAD_CASTS[LEAD_COLUMNS[i]] ?? ""}`);
    try {
      const res = await db().query(
        `insert into enactus_leads (${cols}) values (${placeholders.join(", ")})
         on conflict do nothing
         returning *`,
        values
      );
      const [saved] = res as unknown as Lead[];
      if (saved) leads.push(saved);
    } catch {
      // This row is the problem, or every row is. Either way the next one is
      // still worth trying.
    }
  }
  return { leads };
}

/**
 * Write a whole run's leads in one statement.
 *
 * Returns only the rows that are genuinely NEW. A company already on the board
 * is reported as a duplicate count, not as a lead and not as an error: that is
 * the case the unique index exists to handle, and surfacing it as a failure
 * showed volunteers a red database message for the system working correctly.
 *
 * Order is restored from the input afterwards. RETURNING gives no ordering
 * guarantee, and the input is sorted best-first, so trusting the returned order
 * would shuffle the board's top pick to an arbitrary position.
 */
async function persistLeadRows(
  rows: LeadRow[]
): Promise<{ leads: Lead[]; duplicates: number; error: string | null }> {
  if (!rows.length) return { leads: [], duplicates: 0, error: null };

  // Still hand back usable cards so the run's work isn't lost, but the caller
  // now knows they are unsaved and tells the user.
  const unsaved = (error: string) => {
    const now = new Date().toISOString();
    return {
      leads: rows.map((r) => ({ id: crypto.randomUUID(), created_at: now, updated_at: now, ...r }) as Lead),
      duplicates: 0,
      error,
    };
  };
  if (!hasDatabaseUrl()) return unsaved("DATABASE_URL missing");

  const cols = LEAD_COLUMNS.join(", ");
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = leadValues(row).map((v, i) => {
      params.push(v);
      return `$${params.length}${LEAD_CASTS[LEAD_COLUMNS[i]] ?? ""}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  let inserted: Lead[] = [];
  let error: string | null = null;
  try {
    const res = await db().query(
      `insert into enactus_leads (${cols}) values ${tuples.join(", ")}
       on conflict do nothing
       returning *`,
      params
    );
    inserted = res as unknown as Lead[];
  } catch (e) {
    // One statement means one failure mode: anything that rejects the batch
    // rejects EVERY lead in it. Before this was batched, a per-row loop lost
    // one lead to a bad row and saved the rest, so making the fast path
    // all-or-nothing quietly converted "lost one card" into "saved nothing" --
    // and a schema migration applied after a deploy turns that into every run,
    // silently, for as long as the column is missing.
    //
    // So the batch is the fast path, not the only path. Falling back row by row
    // costs a round trip per lead exactly when the run has already gone wrong,
    // and recovers the 24 leads that a single unlucky one would have taken with
    // it. If the fallback fails too the cause is not this row, and the original
    // batch error is the more useful one to report.
    const batchError = (e as Error).message;
    console.error("batch lead insert failed, falling back to row-by-row:", batchError);
    const recovered = await insertRowsIndividually(rows);
    inserted = recovered.leads;
    error = recovered.leads.length ? null : batchError;
    if (!inserted.length) return { ...unsaved(batchError), duplicates: 0 };
  }

  // Anything the insert did not return hit the unique index. One follow-up
  // query confirms it really is on the board rather than lost, so a genuine
  // "insert returned no row" is still distinguishable from a duplicate.
  const insertedKeys = new Set(inserted.map((l) => dbKey(l.company)));
  const missing = rows.filter((r) => !insertedKeys.has(dbKey(r.company)));
  let duplicates = 0;
  if (missing.length) {
    try {
      const res = await db().query(
        `select lower(btrim(company)) as key from enactus_leads
          where mode = $1 and lower(btrim(company)) = any($2::text[])`,
        [rows[0].mode, missing.map((r) => dbKey(r.company))]
      );
      const onBoard = new Set((res as unknown as { key: string }[]).map((r) => r.key));
      duplicates = missing.filter((r) => onBoard.has(dbKey(r.company))).length;
      if (duplicates < missing.length) error = "insert returned no row";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  // Best-first, as the model ranked them.
  const order = new Map(rows.map((r, i) => [dbKey(r.company), i]));
  const leads = inserted.sort(
    (a, b) => (order.get(dbKey(a.company)) ?? 0) - (order.get(dbKey(b.company)) ?? 0)
  );
  return { leads, duplicates, error };
}

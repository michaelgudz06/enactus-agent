// The hard monthly API budget.
//
// The club has $20 CAD a month to spend on paid APIs. That is a cap, not a
// target: the pipeline stops rather than overspend, and says so when it stops.
// A run that silently degrades because it ran out of money is the same failure
// this codebase was repaired for four times -- work that looks finished and is
// not -- so a budget stop is always an explicit, named refusal and never a
// thinner set of leads.
//
// THE CAP IS CONFIG, NOT AN ARGUMENT. Nothing in this module takes a "skip",
// "force" or "dryRun" flag, and no caller can pass one, because a cap a caller
// can wave away is not a cap. The only way to change it is `API_BUDGET_CAD` in
// the environment, which is the VP External's decision to make and not a
// programmer's. A malformed value falls back to the default rather than opening
// the gate.
//
// ── The two providers this agent actually pays for ────────────────────────
//
// Read from the code, not assumed: `src/lib/llm.ts` calls OpenRouter and
// `src/lib/exa.ts` calls Exa. Nothing else costs money. Google's Gmail API
// (`src/lib/gmail.ts`) is free at this volume, Supabase is a flat free-tier
// project rather than a per-call charge, and the DNS lookups in
// `src/lib/contact.ts` go to the local resolver.
//
// Prices below were verified live on 2026-08-06:
//   OpenRouter  GET https://openrouter.ai/api/v1/models
//   Exa         https://docs.exa.ai/reference/pricing
// Re-verify them when a model pin in `src/lib/llm.ts` changes. A price that has
// drifted does not break the cap, it just makes the stop land in the wrong
// place, which is exactly the kind of quiet wrongness this file exists to
// prevent.

import { supabaseAdmin, SPEND, hasServiceKey } from "./supabase";

// ── The cap ──────────────────────────────────────────────────────────────

/** The captain's number. Overridable only through the environment. */
export const DEFAULT_CAP_CAD = 20;

/**
 * USD per CAD. The providers bill in USD and the cap is written in CAD, so one
 * of the two has to be converted. Pinned rather than fetched: a live FX call
 * would be a third network dependency on the hot path, and a rate that moves a
 * few percent moves the stop by a few cents on a $20 cap.
 *
 * Source: open.er-api.com, 2026-08-06 (1 USD = 1.402359 CAD). Set
 * `API_BUDGET_USD_TO_CAD` when it has drifted enough to matter.
 */
export const DEFAULT_USD_TO_CAD = 1.4024;

/**
 * Spend is attributed to the calendar month in the club's own timezone, so a
 * run at 11pm on the 31st counts against the month the student thinks it does.
 */
export const BILLING_TIMEZONE = "America/Vancouver";

const MONTH_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: BILLING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
});

const MONTH_LABEL = new Intl.DateTimeFormat("en-CA", {
  timeZone: BILLING_TIMEZONE,
  year: "numeric",
  month: "long",
});

/** `2026-08`, in the club's timezone. */
export function billingMonth(now: Date = new Date()): string {
  return MONTH_KEY.format(now);
}

/** `August 2026`, for a message a student reads. */
export function billingMonthLabel(now: Date = new Date()): string {
  return MONTH_LABEL.format(now);
}

// A number from the environment is only allowed to *be* the cap, never to
// remove it: anything unparseable, negative, zero or infinite falls back to the
// default. A typo in `.env.local` must not turn the budget off.
function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function capCad(): number {
  return positiveEnvNumber("API_BUDGET_CAD", DEFAULT_CAP_CAD);
}

export function usdToCad(): number {
  return positiveEnvNumber("API_BUDGET_USD_TO_CAD", DEFAULT_USD_TO_CAD);
}

/** The cap the providers are actually measured against. */
export function capUsd(): number {
  return capCad() / usdToCad();
}

export function toCad(usd: number): number {
  return usd * usdToCad();
}

export function formatCad(usd: number): string {
  return `$${toCad(usd).toFixed(2)} CAD`;
}

// ── Prices ───────────────────────────────────────────────────────────────

export interface TokenPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/** Verified against OpenRouter's own model list on 2026-08-06. */
export const OPENROUTER_PRICES: Record<string, TokenPrice> = {
  "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "deepseek/deepseek-v4-flash-0731": { input: 0.09, output: 0.18 },
};

/**
 * A model nobody priced is charged at the most expensive rate we know, never at
 * zero. Free-by-default would let a new pin in `src/lib/llm.ts` spend the whole
 * month invisibly, which is the one failure a budget module must not have.
 */
export function priceFor(model: string): TokenPrice {
  const known = OPENROUTER_PRICES[model];
  if (known) return known;
  const all = Object.values(OPENROUTER_PRICES);
  return {
    input: Math.max(...all.map((p) => p.input)),
    output: Math.max(...all.map((p) => p.output)),
  };
}

export function openRouterCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  return (Math.max(0, inputTokens) * price.input + Math.max(0, outputTokens) * price.output) / 1_000_000;
}

/**
 * Exa charges per request, not per token: $7 per 1,000 `/search` calls covers
 * up to 10 results *including* their text and highlights, and results past the
 * tenth are $1 per 1,000. This agent asks for six, so a search is a flat
 * $0.007 and is by far the most expensive thing a run does.
 */
export const EXA_SEARCH_USD = 0.007;
export const EXA_RESULT_OVER_TEN_USD = 0.001;
export const EXA_RESULTS_INCLUDED = 10;

export function exaSearchCostUsd(numResults: number): number {
  const extra = Math.max(0, numResults - EXA_RESULTS_INCLUDED);
  return EXA_SEARCH_USD + extra * EXA_RESULT_OVER_TEN_USD;
}

// OpenRouter reports real usage on every response, so an estimate is only ever
// a fallback for a stream that ended before its usage chunk arrived. Four
// characters per token is the usual rule of thumb for this tokenizer family.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: { content: string }[]): number {
  return estimateTokens(messages.map((m) => m.content).join(""));
}

// ── What one run costs ───────────────────────────────────────────────────

/**
 * The shape of a run, in one place, because the pre-flight estimate and the
 * pipeline have to agree: if `src/lib/agent.ts` searched four queries while
 * this said three, the gate would let through a run it cannot pay for.
 *
 * This is also the depth/breadth dial. Exa dominates the bill, so the number of
 * *searches* is what $20 buys; `resultsPerSearch` up to ten is free, and the
 * models are cheap enough that reasoning harder over fewer companies costs
 * almost nothing next to one more search.
 */
export const RUN_SHAPE = {
  searchQueries: 3,
  resultsPerSearch: 6,
  candidates: 6,
} as const;

/**
 * Worst case for one agent run, from the same constants the pipeline uses: the
 * `max_tokens` ceilings in `src/lib/agent.ts` for output, and a deliberately
 * generous input allowance for the system prompts, the candidate research and
 * the reasoning forwarded into the structuring step.
 *
 * It is an over-estimate on purpose. The gate is "can we afford the worst
 * version of this run", so a run either happens in full or does not start.
 */
const PLAN_INPUT_TOKENS = 2_000;
const PLAN_OUTPUT_TOKENS = 800;
const REASON_INPUT_TOKENS = 8_000;
const REASON_OUTPUT_TOKENS = 1_200;
const STRUCTURE_INPUT_TOKENS = 24_000;
const STRUCTURE_OUTPUT_TOKENS = 2_800;
const DRAFT_INPUT_TOKENS = 2_000;
const DRAFT_OUTPUT_TOKENS = 700;

export function estimateAgentRunUsd(models: { reasoner: string; structured: string }): number {
  const search = RUN_SHAPE.searchQueries * exaSearchCostUsd(RUN_SHAPE.resultsPerSearch);
  const plan = openRouterCostUsd(models.structured, PLAN_INPUT_TOKENS, PLAN_OUTPUT_TOKENS);
  const reason = openRouterCostUsd(models.reasoner, REASON_INPUT_TOKENS, REASON_OUTPUT_TOKENS);
  const structure = openRouterCostUsd(models.structured, STRUCTURE_INPUT_TOKENS, STRUCTURE_OUTPUT_TOKENS);
  return search + plan + reason + structure;
}

export function estimateDraftUsd(model: string): number {
  return openRouterCostUsd(model, DRAFT_INPUT_TOKENS, DRAFT_OUTPUT_TOKENS);
}

// ── The ledger ───────────────────────────────────────────────────────────

export interface SpendEntry {
  provider: "openrouter" | "exa";
  /** Model id for OpenRouter, endpoint for Exa. */
  model: string;
  /** Which step of the pipeline spent this: `plan`, `reason`, `structure`, `draft`, `search`. */
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  requests?: number;
  costUsd: number;
}

// Month-to-date, cached for the life of the process. Serverless invocations are
// short and each reads once; a long-lived process picks up other people's spend
// on the next month rollover or the next cold start. `pending` is what this
// process has spent since that read, so a run cannot outspend its own gate.
//
// The two are tracked against the month separately and deliberately. Tying
// `pending` to the read would mean a charge booked before the first read was
// wiped by that read -- money spent and then forgotten, which is the one
// direction a budget must never round.
let cachedMonth: string | null = null;
let cachedUsd = 0;
let pendingMonth: string | null = null;
let pendingUsd = 0;

/** Test seam. Resets the cache so one test's spend never reaches another. */
export function resetSpendCacheForTests(): void {
  cachedMonth = null;
  cachedUsd = 0;
  pendingMonth = null;
  pendingUsd = 0;
}

// Charges belong to the month they happened in. A process alive across midnight
// on the 1st starts the new month at nothing rather than carrying the old one's
// spend into it.
function pendingForMonth(month: string): number {
  if (pendingMonth !== month) {
    pendingMonth = month;
    pendingUsd = 0;
  }
  return pendingUsd;
}

async function loadMonthToDateUsd(month: string): Promise<number> {
  if (!hasServiceKey()) return 0;
  const { data, error } = await supabaseAdmin.from(SPEND).select("cost_usd").eq("billing_month", month);
  if (error) throw new Error(error.message);
  let total = 0;
  for (const row of (data ?? []) as { cost_usd: number | string | null }[]) {
    const value = Number(row.cost_usd ?? 0);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * Everything spent this month, in USD.
 *
 * Without a service key there is nowhere durable to keep a ledger, so this
 * counts only what the current process spent. That is a real gap and it is
 * reported as one -- `budgetStatus().persisted` is false and the UI says so --
 * rather than being presented as a cap that is being enforced.
 */
export async function monthToDateUsd(): Promise<number> {
  const month = billingMonth();
  const pending = pendingForMonth(month);
  if (cachedMonth !== month) {
    // A ledger we cannot read is not a licence to spend, so the failure is
    // thrown for the caller to report. Nothing is cached until the read
    // succeeds: caching a failed read as zero would fail open on the very next
    // call, which is the quiet version of having no cap at all.
    const loaded = await loadMonthToDateUsd(month);
    cachedMonth = month;
    cachedUsd = loaded;
  }
  return cachedUsd + pending;
}

/** Writes one charge to the ledger and counts it against this month. */
export async function recordSpend(entry: SpendEntry): Promise<void> {
  const month = billingMonth();
  pendingForMonth(month);
  pendingUsd += Math.max(0, entry.costUsd);
  if (!hasServiceKey()) return;
  try {
    await supabaseAdmin.from(SPEND).insert({
      billing_month: month,
      provider: entry.provider,
      model: entry.model,
      operation: entry.operation,
      input_tokens: entry.inputTokens ?? 0,
      output_tokens: entry.outputTokens ?? 0,
      requests: entry.requests ?? 1,
      cost_usd: Number(entry.costUsd.toFixed(6)),
    });
  } catch {
    // The charge is already counted in `pendingUsd`, so this process still
    // stops in the right place. A lost row understates next month's starting
    // point rather than overstating it, and losing the run over a bookkeeping
    // write would be the worse trade.
  }
}

/**
 * Raised instead of spending money the budget cannot account for: either the
 * cap is reached, or the ledger could not be read and the spend is unknown.
 * Unknown is treated as spent, because the alternative is treating it as zero.
 */
export class BudgetExceededError extends Error {
  readonly capCad: number;
  readonly spentCad: number;
  readonly neededCad: number;

  constructor(message: string, parts: { capCad: number; spentCad: number; neededCad: number }) {
    super(message);
    this.name = "BudgetExceededError";
    this.capCad = parts.capCad;
    this.spentCad = parts.spentCad;
    this.neededCad = parts.neededCad;
  }
}

function exceeded(what: string, spentUsd: number, needUsd: number): BudgetExceededError {
  const cap = capCad();
  return new BudgetExceededError(
    `Monthly API budget reached. The cap is $${cap.toFixed(2)} CAD; ${formatCad(spentUsd)} has already been ` +
      `spent in ${billingMonthLabel()}, and ${what} needs about ${formatCad(needUsd)} more. ` +
      `Nothing was charged and nothing ran. The budget resets at the start of next month, or the VP External ` +
      `can raise API_BUDGET_CAD.`,
    { capCad: cap, spentCad: toCad(spentUsd), neededCad: toCad(needUsd) }
  );
}

/**
 * The last line of defence, called from inside the provider clients themselves.
 * Every paid request in this codebase passes through here before its fetch, so
 * the cap holds even for a caller that forgot the pre-flight check below.
 */
export async function assertHeadroom(estimateUsd: number, what: string): Promise<void> {
  let spent: number;
  try {
    spent = await monthToDateUsd();
  } catch (e) {
    throw new BudgetExceededError(unreadableLedger((e as Error).message), {
      capCad: capCad(),
      spentCad: NaN,
      neededCad: toCad(estimateUsd),
    });
  }
  if (spent + estimateUsd > capUsd()) throw exceeded(what, spent, estimateUsd);
}

// Said the same way wherever the ledger is unreadable, because the stop is the
// same one: the spend is unknown, and unknown is not zero.
function unreadableLedger(detail: string): string {
  return (
    `Could not read this month's API spend, so there is no way to know what is left of the ` +
    `$${capCad().toFixed(2)} CAD cap: ${detail}. Nothing ran.`
  );
}

export interface BudgetStatus {
  /** `2026-08`. */
  month: string;
  monthLabel: string;
  capCad: number;
  spentCad: number;
  remainingCad: number;
  /** Whole runs the remaining budget can still pay for, at worst case. */
  runsRemaining: number;
  /** False when there is no service key, so the ledger is per-process only. */
  persisted: boolean;
  /** Set when the ledger could not be read; spend is unknown, not zero. */
  error: string | null;
}

export async function budgetStatus(runCostUsd: number): Promise<BudgetStatus> {
  const cap = capCad();
  const base = {
    month: billingMonth(),
    monthLabel: billingMonthLabel(),
    capCad: cap,
    persisted: hasServiceKey(),
  };
  try {
    const spent = await monthToDateUsd();
    const remainingUsd = Math.max(0, capUsd() - spent);
    return {
      ...base,
      spentCad: Number(toCad(spent).toFixed(2)),
      remainingCad: Number(toCad(remainingUsd).toFixed(2)),
      runsRemaining: runCostUsd > 0 ? Math.floor(remainingUsd / runCostUsd) : 0,
      error: null,
    };
  } catch (e) {
    return { ...base, spentCad: 0, remainingCad: 0, runsRemaining: 0, error: (e as Error).message };
  }
}

/**
 * The pre-flight gate. A run either has room for its whole worst case or does
 * not start: half a run is the shape the captain explicitly ruled out, because
 * partial leads that look complete are worse than no leads at all.
 *
 * Returns the reason to stop, or null to proceed.
 */
export async function budgetBlocker(estimateUsd: number, what: string): Promise<string | null> {
  let spent: number;
  try {
    spent = await monthToDateUsd();
  } catch (e) {
    // Unknown spend is not zero spend. Refusing here costs a run; assuming zero
    // could cost the month.
    return unreadableLedger((e as Error).message);
  }
  if (spent + estimateUsd > capUsd()) return exceeded(what, spent, estimateUsd).message;
  return null;
}

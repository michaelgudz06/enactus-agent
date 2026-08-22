// A hard monthly cap on what the agent may spend at the API providers.
//
// THE CAP IS CONFIG, NOT AN ARGUMENT. Nothing here takes a "skip" or "force"
// flag: a caller that could opt out of the budget is not a budget. The only
// way to move it is the environment, and even that can only ever *set* the
// number -- see positiveEnvNumber.
//
// Zero static imports, deliberately: scripts/selfcheck.ts runs this file under
// `node --experimental-strip-types`, which cannot resolve the `@/lib` alias.
// The Neon ledger that records and totals spend lives in ./spend.ts instead.

/** The captain's number. Overridable only through the environment. */
export const DEFAULT_CAP_CAD = 20;

/**
 * USD per CAD. The providers bill in USD and the cap is written in CAD, so one
 * of the two has to be converted. Pinned rather than fetched: a live FX call
 * would be another network dependency on the hot path, and a rate that moves a
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

/**
 * Read from OpenRouter's own /api/v1/models on 2026-08-21 and converted from
 * their per-token figures. These are the two models src/lib/llm.ts actually
 * pins; re-read that endpoint if either pin changes.
 */
export const OPENROUTER_PRICES: Record<string, TokenPrice> = {
  "deepseek/deepseek-r1": { input: 0.7, output: 2.5 },
  "deepseek/deepseek-v3.2": { input: 0.26, output: 0.38 },
};

/**
 * A model nobody priced is charged at the most expensive rate we know, never at
 * zero. Free-by-default would let a new pin in src/lib/llm.ts spend the whole
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
 * tenth are $1 per 1,000.
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

export function tokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return tokensFromChars(text.length);
}

export function estimateMessageTokens(messages: { content: string }[]): number {
  return estimateTokens(messages.map((m) => m.content).join(""));
}

// ── The stop ─────────────────────────────────────────────────────────────

export interface BudgetState {
  spentUsd: number;
  capUsd: number;
  month: string;
}

export function overBudget(state: BudgetState): boolean {
  return state.spentUsd >= state.capUsd;
}

/**
 * What a student sees when the pipeline stops. It names the number, the month
 * and the knob, because a run that just stops looks like a bug -- and this
 * codebase has already been repaired four times for degrading silently.
 */
export function budgetStopMessage(state: BudgetState, now: Date = new Date()): string {
  return (
    `Stopped: the $${capCad().toFixed(2)} CAD monthly API budget for ` +
    `${billingMonthLabel(now)} is used up (${formatCad(state.spentUsd)} spent). ` +
    `Runs resume next month, or raise API_BUDGET_CAD.`
  );
}

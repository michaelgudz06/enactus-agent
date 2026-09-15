// What one run actually did, accumulated as it happens.
//
// The club already has an outcome table: leads move to Outreach Sent, replies
// get stamped, wins get closed with a dollar value and a type. None of it ever
// flowed backwards. So the two questions that should drive every tuning
// decision were unanswerable:
//
//   Which search query found the lead that replied?
//   What does a qualified lead cost?
//
// Both need the run, its leads and its spend to share an id, and they need the
// run to have written down what it did. enactus_searches stored the prompt and
// a result count, which answers neither.
//
// This is the accumulator. It is deliberately a plain object with no database
// access and no timers of its own -- the pipeline is already timing itself for
// its console marks, so the trace piggybacks on those rather than adding a
// second clock that can disagree with the first.
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

export interface RunTrace {
  /** The searches that were actually run, per channel. */
  queries: string[];
  placesQueries: string[];
  /** Counts through the funnel, in funnel order. */
  askedFor: number | null;
  targetCount: number;
  found: number;
  alreadyKnown: number;
  dropped: Record<string, number>;
  candidates: string[];
  placesEnriched: number;
  structured: number;
  delivered: number;
  /** How many delivered leads got a contact lookup, and how many yielded a person. */
  contactsAttempted: number;
  contactsFound: number;
  /** Wall-clock milliseconds from the start of the run, per stage. */
  timings: Record<string, number>;
  /** Which models did the work, so a trace stays readable after a model swap. */
  models: Record<string, string>;
  /** Set when structuring was cut short and leads were salvaged from a partial body. */
  truncated: boolean;
  /** What the user was told, when the run could not fill the order. */
  shortfall: string | null;
  /** Degradations that did not stop the run. */
  notes: string[];
}

export function newTrace(input: { targetCount: number; askedFor: number | null }): RunTrace {
  return {
    queries: [],
    placesQueries: [],
    askedFor: input.askedFor,
    targetCount: input.targetCount,
    found: 0,
    alreadyKnown: 0,
    dropped: {},
    candidates: [],
    placesEnriched: 0,
    structured: 0,
    delivered: 0,
    contactsAttempted: 0,
    contactsFound: 0,
    timings: {},
    models: {},
    truncated: false,
    shortfall: null,
    notes: [],
  };
}

/**
 * Record a non-fatal degradation.
 *
 * Deduplicated, because the things worth noting here -- Apollo unreachable, the
 * ledger unwritable, the planner degraded -- tend to happen once per candidate
 * chunk rather than once per run, and a trace listing the same sentence four
 * times is harder to read than one listing it once.
 */
export function note(trace: RunTrace, message: string): void {
  if (!trace.notes.includes(message)) trace.notes.push(message);
}

/**
 * Cost per delivered lead, or null when the run delivered nothing.
 *
 * Null rather than the run's total cost: a run that spent $0.40 and produced
 * nothing has no cost per lead, and reporting $0.40 would make it look like the
 * cheapest run of the month in any average taken over this field.
 */
export function costPerLead(costUsd: number, delivered: number): number | null {
  if (delivered <= 0) return null;
  return costUsd / delivered;
}

/**
 * One line summarising a run, for a log or a future runs page.
 *
 * Written here rather than at the call site so the trace and its rendering stay
 * in one file: a field added above and never surfaced is a field nobody reads.
 */
export function traceSummary(trace: RunTrace, costUsd: number): string {
  const perLead = costPerLead(costUsd, trace.delivered);
  const parts = [
    `${trace.delivered}/${trace.targetCount} leads`,
    `${trace.found} found`,
    `${trace.candidates.length} candidates`,
    trace.alreadyKnown ? `${trace.alreadyKnown} already known` : "",
    trace.contactsAttempted ? `${trace.contactsFound}/${trace.contactsAttempted} contacts` : "",
    `$${costUsd.toFixed(4)}`,
    perLead === null ? "" : `$${perLead.toFixed(4)}/lead`,
    trace.truncated ? "truncated" : "",
    ...trace.notes,
  ];
  return parts.filter(Boolean).join(" · ");
}

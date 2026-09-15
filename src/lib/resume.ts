// Carrying a run across more than one serverless invocation.
//
// THE PROBLEM
//
// A run is one 60s function, and the whole pipeline is bent around that. R1 is
// aborted at 16s whether or not it finished thinking, structuring gets whatever
// wall clock is left, and salvageObjects() exists purely to rescue leads from
// output the deadline cut in half. Discovery, reasoning and structuring share
// ONE budget, so a slow Exa day is paid for by the stage that actually produces
// the leads -- and the slow days are exactly the days that need the reasoning.
//
// The three time budgets in agent.ts are not tuning knobs. They are the shape
// of a quality problem: lead quality is whatever survives an arbitrary clock.
//
// WHAT THIS DOES INSTEAD
//
// The run is split at the one natural seam -- everything up to a settled
// candidate pool, then everything that reasons over it -- and the pool is
// durable between them. When discovery leaves enough time, analysis runs inline
// exactly as it does today and nothing changes. When it does not, the run hands
// off: the pool is written to the run row, the response closes with a
// `continue` event, and the client immediately POSTs back with the run id to
// get a FRESH 60s for the analysis alone.
//
// So the pathological case -- discovery ate 40 of the 52 seconds, R1 gets 5 --
// becomes discovery ate 40 seconds and R1 gets a full budget of its own.
//
// WHAT THIS IS NOT
//
// Not a job queue. The client is still the thing driving the run, so a closed
// tab still ends it, exactly as before. The difference is that a handed-off run
// leaves its state on the row, so what is lost is the analysis rather than the
// discovery that was paid for. A real queue is the next step and needs
// infrastructure this project does not have on the Hobby plan.
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

/** Bump when the stored shape changes; a mismatched state is discarded, not guessed at. */
export const RESUME_VERSION = 2;

/**
 * What is written to the run row at a handoff.
 *
 * Generic over the two halves it carries so this module stays free of the
 * pipeline's types -- and so the compiler still checks, at the call site, that
 * what is stored is what is read back. Everything in here has to survive a
 * round trip through jsonb, which is the reason phase two's input is plain data
 * in the first place.
 */
export interface ResumeState<TInput = unknown, TTrace = unknown> {
  v: number;
  input: TInput;
  trace: TTrace;
  /** Spend already charged to this run, so the resumed half does not restart the total. */
  costUsd: number;
}

/**
 * Is the stored state one this build can resume?
 *
 * Version mismatches are thrown away rather than migrated. A resume is an
 * optimisation over re-running discovery, so the cost of refusing one is a
 * repeated search; the cost of half-reading a state written by a different
 * build is a run that reasons over the wrong candidates.
 */
export function isResumable<TInput, TTrace>(
  state: unknown
): state is ResumeState<TInput, TTrace> {
  if (!state || typeof state !== "object") return false;
  const s = state as ResumeState;
  return s.v === RESUME_VERSION && Boolean(s.input) && typeof s.input === "object";
}

/**
 * Should this run hand the analysis to a fresh invocation?
 *
 * `msLeft` is what remains of THIS invocation's budget; `needed` is what the
 * analysis wants to do its job properly rather than merely finish.
 *
 * Biased towards continuing inline. A handoff costs a round trip and a possible
 * cold start, so it has to buy something real -- and when discovery was fast,
 * running on is both quicker and exactly what this pipeline already does. The
 * handoff is for the case where continuing would mean giving the reasoning
 * stage a budget too small to be worth spending.
 */
export function shouldHandOff(msLeft: number, needed: number): boolean {
  return msLeft < needed;
}

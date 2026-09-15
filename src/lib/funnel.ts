// Shaping the candidate pool before it reaches a model.
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

/**
 * Round-robin several ranked lists into one, best-of-each-first.
 *
 * The candidate pool is cut to roughly twice the requested lead count before
 * any model sees it, so whatever sits below that cut is not merely ranked
 * lower -- it is never considered at all. That makes the ORDER of this list a
 * policy decision rather than a presentation one, and concatenating groups
 * would quietly hand the entire pool to whichever group is listed first.
 *
 * Two properties the pipeline depends on:
 *
 *   Apollo has poor coverage of very small local businesses, so sorting
 *   verified candidates first would push exactly the corner-shop in-kind
 *   sponsors this club relies on below the cut whenever the pool is large.
 *
 *   Google Places returns the businesses themselves and Exa returns pages
 *   about them. Places is the channel that actually finds the independent
 *   storefronts this club wins, and it returns far fewer rows than Exa, so
 *   proportional representation is the same thing as no representation.
 *
 * Empty groups are skipped rather than wasting their turn, so a run with no
 * Places key produces exactly the order it produced before Places existed.
 */
export function interleave<T>(groups: T[][]): T[] {
  const live = groups.filter((g) => g.length);
  const out: T[] = [];
  const longest = Math.max(0, ...live.map((g) => g.length));
  for (let i = 0; i < longest; i++) {
    for (const g of live) if (i < g.length) out.push(g[i]);
  }
  return out;
}

/**
 * Partition by a predicate, keeping the input order inside each half.
 * `[matching, rest]`, so it reads the same way at the call site as the
 * question being asked.
 */
export function partition<T>(items: T[], pred: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (pred(item) ? yes : no).push(item);
  return [yes, no];
}

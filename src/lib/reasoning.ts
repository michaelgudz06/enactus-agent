// Give each structuring chunk the part of the analyst trace that is about ITS
// candidates.
//
// The reasoning stage reasons over every candidate at once and produces one
// prose trace. Structuring is then sharded into disjoint chunks of three
// candidates, run concurrently, and every chunk was handed the same
// `reasoningText.slice(0, 3000)`.
//
// Two things are wrong with that. The slice is taken from the FRONT, so it is
// reasoning about the first few candidates -- chunk 4 was being told to pick
// the best of candidates 10-12 while reading an argument about candidates 1-3,
// which is at best irrelevant and at worst actively points it at a company it
// was not given. And the cut discards the end of the trace, which is where R1
// puts its conclusions.
//
// So the trace is split into blocks and each chunk gets the blocks that mention
// its own candidates, by [n] marker or by company name, plus whatever general
// preamble still fits. A chunk whose candidates are never mentioned -- which
// happens when the reasoning budget aborted before R1 reached them -- falls
// back to the head of the trace, which is exactly the old behaviour.
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

/** A block long enough to be worth splitting further if it covers several candidates. */
const LONG_BLOCK = 600;

/** Paragraphs first; a wall of single-newline text is split by line instead. */
function blocksOf(trace: string): string[] {
  const paras = trace.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of paras) {
    // R1 often writes one candidate per line with no blank line between, which
    // would make the whole trace a single block owned by every chunk.
    if (p.length > LONG_BLOCK && (p.match(/\[\d+\]/g) ?? []).length > 1) {
      for (const line of p.split("\n").map((l) => l.trim()).filter(Boolean)) out.push(line);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Which candidates does this block talk about?
 *
 * Both signals are needed. The [n] markers are what the prompt numbers the
 * candidates with and are the reliable one, but R1 frequently drops the marker
 * after the first mention and refers to the company by name from then on.
 */
function mentions(block: string, names: string[]): Set<number> {
  const hit = new Set<number>();
  for (const m of block.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= names.length) hit.add(n);
  }
  const lower = block.toLowerCase();
  names.forEach((name, i) => {
    // Short names ("Nourish", "Co-op") collide with ordinary prose, so only
    // names with enough substance to be unambiguous are matched.
    const n = name.trim().toLowerCase();
    if (n.length > 4 && lower.includes(n)) hit.add(i + 1);
  });
  return hit;
}

/**
 * The reasoning one structuring chunk should see.
 *
 * `names` is every candidate in the run, in prompt order, so names[0] is the
 * candidate the prompt labels [1]. `first` and `count` describe this chunk's
 * slice of that list as 0-based offsets, matching candidates.slice().
 *
 * Owned blocks are laid down first and never crowded out by general prose:
 * running out of room must cost this chunk somebody else's preamble, not its
 * own candidate's argument.
 */
export function reasoningFor(
  trace: string,
  opts: { names: string[]; first: number; count: number; maxChars: number }
): string {
  const { names, first, count, maxChars } = opts;
  const text = (trace ?? "").trim();
  if (!text || count <= 0) return "";
  if (names.length <= count) return text.slice(0, maxChars);

  const mine = new Set<number>();
  for (let i = first + 1; i <= first + count; i++) mine.add(i);

  const blocks = blocksOf(text);
  const owned: string[] = [];
  const general: string[] = [];
  for (const b of blocks) {
    const hit = mentions(b, names);
    if (hit.size === 0) general.push(b);
    // A block naming several candidates is kept whenever ONE of them is ours:
    // that is usually a comparison, and the half about our candidate is the
    // part worth having.
    else if ([...hit].some((n) => mine.has(n))) owned.push(b);
  }

  // R1 never got as far as these candidates -- the reasoning budget aborts
  // mid-trace routinely. Fall back to the head of the trace, which is what
  // every chunk used to get.
  if (!owned.length) return text.slice(0, maxChars);

  let out = "";
  for (const b of [...owned, ...general]) {
    if (!out) {
      out = b;
      continue;
    }
    if (out.length + 2 + b.length > maxChars) break;
    out += `\n\n${b}`;
  }
  return out.slice(0, maxChars);
}

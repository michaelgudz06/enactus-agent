// Deterministic fallback for the intent branch.
//
// Intent is normally decided by the planner call in src/lib/agent.ts, which
// reads the whole request and is much better at this than any regex. This is
// what stands in when that call cannot be made at all -- OpenRouter down, a bad
// key, a rate limit that survives the retries. Without it a planner outage
// either kills the run outright or, worse, spends Exa credit and puts junk on
// the board in reply to "thanks!".
//
// Deliberately narrow. It recognises greetings, thanks and closing pleasantries
// and answers "not conversational" for everything else, including questions it
// cannot classify. That asymmetry is the planner's own documented rule: a
// needless search costs money, but answering a search request hands the user
// nothing they asked for. So the failure this leans into is an occasional
// wasted search on a question during an outage, never a silent refusal to
// search.
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

// Words that cannot begin a request for work. "thanks, that is all" opens with
// one; no search does.
const GREETING =
  /^(hi|hey+|hello|yo|sup|hiya|howdy|good (morning|afternoon|evening)|thanks?|thank you|ty|thx|cheers|nvm|never ?mind|bye|goodbye|see ya|ping)\b/i;

// Words that ARE small talk on their own and ORDINARY ADJECTIVES in front of a
// request. These must be the whole message to count.
//
// They were in GREETING, which silently declined real searches: "great gyms
// near SFU", "nice coffee shops in Burnaby" and "perfect bakeries Langley" all
// open with one, sit inside the word limit, and were answered as pleasantries
// instead of searched. That is the exact failure this module exists to prevent
// -- a needless search costs money, but refusing to search costs the user the
// thing they asked for -- and it was introduced by the guard against it.
const ACKNOWLEDGEMENT =
  /^(ok|okay|kk|cool|nice|great|awesome|perfect|got it|sounds good|will do|later|test)$/i;

// Anything longer than this is a request that happens to open politely --
// "hey can you find me 10 bakeries in Burnaby" is a search, not a greeting.
const SMALL_TALK_MAX_WORDS = 6;

/** Trailing punctuation only; leading punctuation would hide the opener. */
const strip = (s: string) => s.replace(/[\s!.?,]+$/, "");

/**
 * Is this message small talk rather than work?
 *
 * True for a short message that OPENS with a word no request can open with, and
 * for a bare acknowledgement. An empty message counts, because there is nothing
 * to search for.
 */
export function looksConversational(prompt: string): boolean {
  const trimmed = strip(prompt.trim());
  if (!trimmed) return true;
  if (ACKNOWLEDGEMENT.test(trimmed)) return true;
  if (trimmed.split(/\s+/).length > SMALL_TALK_MAX_WORDS) return false;
  return GREETING.test(trimmed);
}

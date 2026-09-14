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

const GREETING =
  /^(hi|hey+|hello|yo|sup|hiya|howdy|good (morning|afternoon|evening)|thanks?|thank you|ty|thx|cheers|ok|okay|kk|cool|nice|great|awesome|perfect|got it|sounds good|will do|nvm|never ?mind|bye|goodbye|see ya|later|test|ping)\b/i;

// Anything longer than this is a request that happens to open politely --
// "hey can you find me 10 bakeries in Burnaby" is a search, not a greeting.
const SMALL_TALK_MAX_WORDS = 6;

/**
 * Is this message small talk rather than work?
 *
 * True only for short messages that OPEN with a recognised pleasantry. An empty
 * message counts, because there is nothing to search for.
 */
export function looksConversational(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return true;
  if (trimmed.split(/\s+/).length > SMALL_TALK_MAX_WORDS) return false;
  // Strip trailing punctuation only; leading punctuation would hide the
  // greeting the pattern is anchored on.
  return GREETING.test(trimmed.replace(/[\s!.?,]+$/, ""));
}

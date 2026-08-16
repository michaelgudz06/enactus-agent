// How many leads did the user actually ask for?
//
// Parsed in code, never delegated to the model. "Give me 10 leads" coming back
// with 3 was the loudest complaint about this agent, and a model that is merely
// *asked* to honour a count will under-deliver the moment its own judgement
// says fewer are worth it. The count is the user's call, so it is extracted
// here and handed to the model as a fixed instruction, with the discovery
// funnel widened to match.
//
// Kept dependency-free so it can be unit-checked on its own: see
// scripts/selfcheck.ts.

export const DEFAULT_COUNT = 6;
export const MAX_COUNT = 25;

const NUMBER_WORDS: Record<string, number> = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

// A bare number is not a count -- "companies in the top 5% by revenue" and
// "open until 10 pm" both contain digits. Require one of the nouns we actually
// deliver, so only a real request for N things counts.
const COUNT_NOUN =
  "(?:leads?|sponsors?|prospects?|companies|company|businesses|business|names?|contacts?|orgs?|organi[sz]ations?" +
  "|firms?|shops?|stores?|brands?|vendors?|suppliers?|partners?|manufacturers?|retailers?|agenc(?:y|ies)" +
  "|startups?|employers?)";

// Any words at all between the number and the noun, not a list of approved ones.
//
// This was a closed list of ten adjectives (more|new|good|solid|...), which
// meant "10 construction companies", "10 engineering firms" and "3 food and
// beverage companies" all failed to parse and silently fell back to 6. Measured
// against production: four of six real prompts lost their count this way, which
// is the whole of "I asked for 10 and got 6". An allowlist of English adjectives
// can never be complete, so the gap is positional instead.
//
// Five words, not three: "10 local print and coffee shops" is four, and it
// silently ran as 6 in production. The width is what stops a digit from the far
// side of a sentence binding to a noun, so it is not free -- widening it alone
// starts matching "open 7 days a week local businesses".
const GAP = "(?:[a-z]+\\s+){0,5}";

// ...which is why the width is paired with this. A number followed immediately
// by a unit is measuring something, not counting what we deliver: days, km,
// dollars, employees. Only the FIRST word after the digit is checked -- that is
// where a unit always sits, and testing the whole gap would reject the perfectly
// ordinary "10 companies with 50 employees".
const NOT_A_UNIT =
  "(?!(?:days?|weeks?|months?|years?|hours?|mins?|minutes?|am|pm|km|kms|kilomet(?:er|re)s?" +
  "|miles?|percent|dollars?|cad|usd|employees?|staff|people|million|billion|thousand|k|m)\\b)";

export function requestedCount(prompt: string, fallback: number = DEFAULT_COUNT): number {
  const clamp = (n: number) => Math.max(1, Math.min(MAX_COUNT, n));

  const digits = prompt.match(new RegExp(`\\b(\\d{1,3})\\s+${NOT_A_UNIT}${GAP}${COUNT_NOUN}\\b`, "i"));
  if (digits) return clamp(parseInt(digits[1], 10));

  const words = prompt.match(
    new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\s+${NOT_A_UNIT}${GAP}${COUNT_NOUN}\\b`, "i")
  );
  if (words) return clamp(NUMBER_WORDS[words[1].toLowerCase()]);

  return fallback;
}

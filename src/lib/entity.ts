// What counts as "the same company".
//
// Identity in this codebase is a string, and five separate mechanisms try to
// reconstruct it from whatever the model happened to type:
//
//   1. excludeDomains shipped to Exa            (domain, before the search)
//   2. boardDomains / boardNames pre-filter     (domain and companyKey)
//   3. seenNames within a run                   (companyKey)
//   4. the unique index on lower(btrim(company))(exact, in Postgres)
//   5. a follow-up select when the insert conflicts
//
// Each was added after a specific incident -- "Otter Co-Op three times",
// "Xenon Pharmaceuticals Inc. and Xenon Pharmaceuticals", "Grosvenor and
// Grosvenor (Burnaby FC)" -- and they overlap because none of them is an
// identity. They are five guesses at one.
//
// Worse, they contradict the club's own strategy. score.ts pays a bonus for a
// name that carries a neighbourhood, because "every sponsorship this club has
// ever landed was approved by one owner, franchisee or store manager acting
// alone" and four confirmed sponsors are outlets of national brands. So
// Popeyes Burnaby and Popeyes Coquitlam are two prospects, with two managers,
// either of whom can say yes. Whether the board can hold both currently depends
// on whether a model happened to name them differently on two runs weeks apart.
//
// An entity key is one answer to both. It is the company's canonical name plus
// the locality that distinguishes one outlet from another, so:
//
//   "Xenon Pharmaceuticals Inc."  ->  xenon pharmaceuticals
//   "Xenon Pharmaceuticals"       ->  xenon pharmaceuticals       same
//   "Grosvenor (Burnaby FC)"      ->  grosvenor|burnaby
//   "Popeyes Burnaby"             ->  popeyes|burnaby
//   "Popeyes Coquitlam"           ->  popeyes|coquitlam           different
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

/**
 * Metro Vancouver neighbourhoods and municipalities, as they appear inside a
 * company name.
 *
 * Bare "delta" is deliberately absent, matching the same list in score.ts: it
 * is a common word and a company name is not a mailbox, so the false positives
 * outweigh the one municipality.
 */
const LOCALITY =
  /(vancouver|east ?van|north ?van|west ?van|burnaby|surrey|richmond|coquitlam|port moody|langley|new ?west(minster)?|kitsilano|gastown|yaletown|brentwood|metrotown|cloverdale|kerrisdale|brewery district|kensington|fleetwood|queensborough|edmonds|white rock|maple ridge|pitt meadows|tsawwassen|ladner|lonsdale|steveston|guildford|willowbrook|lougheed|oakridge)/i;

const LEGAL_SUFFIX =
  /\b(inc|incorporated|ltd|limited|llc|llp|lp|corp|corporation|co|company|holdings|group|plc|gmbh|sa|nv|pty)\b\.?/g;

/**
 * The neighbourhood a piece of text names, normalised, or "" for none.
 *
 * Whitespace is squeezed rather than stripped so "new west" and "newwest" agree
 * without "portmoody" having to be spelled two ways in the pattern above.
 */
export function localityOf(text: string | null | undefined): string {
  const m = (text ?? "").match(LOCALITY);
  return m ? m[0].toLowerCase().replace(/\s+/g, "") : "";
}

/**
 * The canonical name half of the key: the company with its legal suffix,
 * bracketed qualifiers and punctuation removed.
 *
 * Deliberately the same normalisation as companyKey() in apollo.ts, which is
 * what the in-run dedupe already uses. Once the entity table is the single
 * source of identity, that function becomes this one's caller rather than its
 * rival.
 */
export function baseNameOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/['’]/g, "")
    .replace(/[.,&/-]/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One company's identity, stable across the ways a model might name it.
 *
 * `location` is consulted only when the NAME carries no locality of its own. A
 * name that names its outlet is the stronger signal -- it is what the club
 * actually writes to -- and a location column filled in by Apollo frequently
 * holds the head office of a chain whose branch this row is.
 *
 * The locality is stripped from the base name before it is appended, so
 * "Popeyes Burnaby" and "Popeyes" plus location "Burnaby, BC" agree.
 */
export function entityKey(name: string, location?: string | null): string {
  const fromName = localityOf(name);
  const locality = fromName || localityOf(location);
  const base = baseNameOf(fromName ? name.replace(LOCALITY, " ") : name);
  // A name that is ONLY a locality ("Vancouver") keeps it rather than reducing
  // to an empty key that would collide with every other such name.
  if (!base) return locality || baseNameOf(name);
  return locality ? `${base}|${locality}` : base;
}

/**
 * Are these two rows the same company?
 *
 * A domain match settles it outright: two names for one website are one
 * company, whatever the model called them. Otherwise the entity keys decide.
 */
export function sameCompany(
  a: { company: string; location?: string | null; domain?: string | null },
  b: { company: string; location?: string | null; domain?: string | null }
): boolean {
  if (a.domain && b.domain && a.domain === b.domain) return true;
  return entityKey(a.company, a.location) === entityKey(b.company, b.location);
}

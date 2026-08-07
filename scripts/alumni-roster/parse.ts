/**
 * Parsers for the Enactus SFU past-executive roster reconstruction.
 *
 * Every function here is pure: HTML in, name/role pairs out. Nothing fetches,
 * nothing writes. `build.ts` supplies the source URL, the capture date and the
 * year, and `tests/alumni-roster.test.ts` exercises these against fixtures.
 *
 * PRIVACY IS ENFORCED HERE, NOT BY CARE.
 * The pages these parsers read carry more than name/role/years — role email
 * addresses, phone numbers, employers, photos. `sanitiseFragment` removes the
 * nodes that hold contact detail before any text is read, and `carriesContactDetail`
 * drops any candidate that still looks like one. A field that fails a check is
 * discarded; it is never cleaned up and kept. See `config/alumni/README.md`.
 */

export type Confidence = "high" | "medium" | "low";

/** One person, on one page, in one academic year. `build.ts` merges these. */
export type Sighting = {
  name: string;
  role: string;
  /** Academic year label, e.g. "2016-17". */
  year: string;
  sourceUrl: string;
  capturedAt: string;
  confidence: Confidence;
};

/** What a page parser returns; the caller adds provenance. */
export type Entry = { name: string; role: string };

// --- privacy guards -------------------------------------------------------

/**
 * Anything that reads as a contact detail rather than a name or a role.
 * Deliberately broad: a false positive costs one recoverable name, a false
 * negative puts a personal contact detail in a committed file.
 */
const CONTACT_MARKERS = /[@]|mailto|https?:\/\/|\bwww\.|\+?\d[\d\s().-]{6,}|protected email/i;

export function carriesContactDetail(value: string): boolean {
  return CONTACT_MARKERS.test(value);
}

/**
 * Strip the elements that carry contact detail, scripts (these pages hide
 * addresses in obfuscated JS) and markup, leaving plain text.
 */
export function sanitiseFragment(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    // the 2012 theme hides the role address in a collapsible sibling div
    .replace(/<div[^>]*class="[^"]*collapseomatic_content[^"]*"[\s\S]*?<\/div>/gi, " ")
    .replace(/<ul[^>]*class="[^"]*mk-employeee?-networks[^"]*"[\s\S]*?<\/ul>/gi, " ");
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function textOf(html: string): string {
  return decodeEntities(sanitiseFragment(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// --- field validation -----------------------------------------------------

/** Words that appear where a name would but are not people. */
const NOT_A_NAME = new Set([
  "our team", "the team", "leadership team", "executive team", "core operations",
  "project operations", "enactus sfu", "about us", "to top", "follow enactus",
  "read more", "learn more", "coming soon", "team", "executives", "alumni",
]);

/**
 * A published personal name: two to four tokens of letters, each token able to
 * carry a hyphen, apostrophe or trailing period. Rejects role placeholders
 * ("Program Officer"), section headings, and anything carrying contact detail.
 */
export function isPlausiblePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || carriesContactDetail(trimmed)) return false;
  if (NOT_A_NAME.has(trimmed.toLowerCase())) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  return tokens.every((token) => /^\p{L}[\p{L}'’.-]*$/u.test(token));
}

/** A published role label. Free-form, but never a contact detail or an essay. */
export function isPlausibleRole(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (carriesContactDetail(trimmed)) return false;
  // A role can carry one comma ("VP Finance, External"). Two means this is a
  // list of people, not a role — the 2023 site pairs a project name with a
  // comma-run of its members, and that block must not become roster rows.
  if ((trimmed.match(/,/g)?.length ?? 0) > 1) return false;
  return /^[\p{L}][\p{L}\s&'’,.()/-]*$/u.test(trimmed);
}

/**
 * The club's pages render names in three cases: "Andrew Ma", "ANDREW MA",
 * "andrew ma". Normalise ALL CAPS to title case and leave the rest alone —
 * changing the case of a name is not inventing one.
 */
export function normaliseNameCase(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Dedup key. Case- and accent-insensitive; punctuation-insensitive. */
export function nameKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Accept a candidate pair, or return null. The single gate every parser uses. */
export function acceptEntry(rawName: string, rawRole: string): Entry | null {
  const name = normaliseNameCase(decodeEntities(rawName).replace(/\s+/g, " ").trim());
  const role = decodeEntities(rawRole).replace(/\s+/g, " ").trim();
  if (!isPlausiblePersonName(name)) return null;
  if (!isPlausibleRole(role)) return null;
  return { name, role };
}

// --- academic year --------------------------------------------------------

/**
 * The academic year a Wayback capture falls in. The club's exec term runs with
 * the SFU academic year, so a page captured in September belongs to the year
 * that starts then, and one captured in February to the year that started the
 * previous August.
 *
 * This is the capture date, not a claim about when the person held office —
 * a stale page extends a span. `config/alumni/README.md` says so plainly.
 */
export function academicYearOfCapture(timestamp14: string): string {
  const match = /^(\d{4})(\d{2})/.exec(timestamp14);
  if (!match) throw new Error(`not a 14-digit Wayback timestamp: ${timestamp14}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = month >= 8 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "2004/2005", "2004-2005", "2004-05" -> "2004-05". Null if unreadable. */
export function academicYearOfLabel(label: string): string | null {
  const match = /(\d{4})\s*[/–—-]\s*(\d{2,4})/.exec(label);
  if (!match) {
    const single = /\b(19|20)(\d{2})\b/.exec(label);
    return single ? `${single[1]}${single[2]}` : null;
  }
  const start = Number(match[1]);
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// --- page parsers ---------------------------------------------------------

/**
 * enactussfu.com/executives/ and /program-managers/, 2012-2013 theme.
 * <span class="collapseomatic" title="Benjamin Che, President">Benjamin Che, President</span>
 * The sibling div holds the role address; `sanitiseFragment` has already removed it.
 */
export function parseCollapseomatic(html: string): Entry[] {
  const entries: Entry[] = [];
  const pattern = /<span[^>]*class="[^"]*collapseomatic[^"]*"[^>]*title="([^"]+)"/gi;
  for (const match of html.matchAll(pattern)) {
    const parts = decodeEntities(match[1]).split(",");
    if (parts.length < 2) continue;
    const entry = acceptEntry(parts[0], parts.slice(1).join(","));
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * enactussfu.com/executives/, 2013-2014 theme.
 * <strong>Lara Ahmad</strong><br />President<br /><script>…address…</script>
 */
export function parseStrongThenRole(html: string): Entry[] {
  const entries: Entry[] = [];
  const pattern = /<strong>([^<]{2,60})<\/strong>\s*<br\s*\/?>\s*([^<]{2,80})<br\s*\/?>/gi;
  for (const match of sanitiseFragment(html).matchAll(pattern)) {
    const entry = acceptEntry(match[1], match[2]);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * enactussfu.com/executives/ and /program-managers/, 2015-2019 theme.
 * <span class="team-member-name">Rajin Shokar</span><span class="team-member-position">President</span>
 */
export function parseEmployeeCards(html: string): Entry[] {
  const entries: Entry[] = [];
  const pattern =
    /<span[^>]*class="[^"]*team-member-name[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*class="[^"]*team-member-position[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  for (const match of html.matchAll(pattern)) {
    const entry = acceptEntry(textOf(match[1]), textOf(match[2]));
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Dispatch across the three WordPress-era themes. */
export function parseWordpressRoster(html: string): Entry[] {
  const cards = parseEmployeeCards(html);
  if (cards.length) return cards;
  const collapsed = parseCollapseomatic(html);
  if (collapsed.length) return collapsed;
  return parseStrongThenRole(html);
}

/**
 * enactussfu.com/alumni/, 2012 theme — the only page on the old site that names
 * pre-2012 executives.
 *
 *   <h2>Enactus SFU Alumni Business Owners</h2>
 *   <ul><li><strong>Minna Van</strong> – President 2004/2005. Co-Founder of …</li>
 *
 * Only the first sentence after the dash is read: it carries the role and the
 * year. Everything after it is the alum's present-day employer, which this file
 * does not record, so it is never returned.
 */
export function parseAlumniBusinessOwners(html: string): Array<Entry & { year: string | null }> {
  const section = /<h2[^>]*>\s*[^<]*Alumni Business Owners[^<]*<\/h2>\s*<ul>([\s\S]*?)<\/ul>/i.exec(html);
  if (!section) return [];

  const found: Array<Entry & { year: string | null }> = [];
  for (const item of section[1].matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const strong = /<strong>([\s\S]*?)<\/strong>/i.exec(item[1]);
    if (!strong) continue;
    const rest = decodeEntities(textOf(item[1].replace(strong[0], "")));
    // first sentence only — the rest is employer detail we must not read
    const firstSentence = rest.replace(/^\s*[–—-]\s*/, "").split(/\.\s|\.$/)[0] ?? "";
    const year = academicYearOfLabel(firstSentence);
    const roleText = firstSentence
      .replace(/\b(19|20)\d{2}\s*[/–—-]?\s*(\d{2,4})?/g, "")
      // "Founded organization in 1991" leaves a dangling preposition once the
      // year goes; the role is what is left of the club's own words.
      .replace(/\s+(in|on|from|since|during)\s*$/i, "")
      .trim();
    const entry = acceptEntry(textOf(strong[1]), roleText || "Executive");
    if (entry) found.push({ ...entry, year });
  }
  return found;
}

/**
 * enactussfu.ca/our-team, Wix era (2023). Wix emits obfuscated class names, so
 * pair on the rendered order instead: a rich-text run in ALL CAPS is a name and
 * the run after it is that person's role.
 */
export function parseWixTeam(html: string): Entry[] {
  const runs: string[] = [];
  for (const match of html.matchAll(/<p class="font_\d+"[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = textOf(match[1]);
    if (text) runs.push(text);
  }

  const entries: Entry[] = [];
  for (let i = 0; i < runs.length - 1; i += 1) {
    const candidate = runs[i];
    if (candidate !== candidate.toUpperCase()) continue;
    const entry = acceptEntry(candidate, runs[i + 1]);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The year the Wix page declares: "MEET OUR 2022/2023 TEAM". */
export function parseWixTeamYear(html: string): string | null {
  const match = /MEET OUR\s*([\d\s/–—-]{4,12})\s*TEAM/i.exec(textOf(html));
  return match ? academicYearOfLabel(match[1]) : null;
}

/**
 * enactussfu.ca/the-team, the Squarespace era (2023-2024).
 *
 * Squarespace renders these cards client-side, so the names exist in the served
 * HTML only inside an entity-encoded JSON blob on `data-current-context`. That
 * blob also carries image filenames, author IDs and timestamps: this reads
 * `title` and `description` and nothing else.
 *
 * The same page carries a second list pairing a project name with a comma-run of
 * its members. Those are general members rather than role-holders, and the
 * source runs several of their names together with no separator
 * ("Ashani PereraWimelia Wong"), so splitting them would mean guessing.
 * `isPlausibleRole` rejects that list on its comma count and it yields nothing.
 */
export function parseSquarespaceTeam(html: string): Entry[] {
  const entries: Entry[] = [];
  for (const match of html.matchAll(/data-current-context="([\s\S]*?)"\s/g)) {
    let items: unknown;
    try {
      items = (JSON.parse(decodeEntities(match[1])) as { userItems?: unknown }).userItems;
    } catch {
      continue; // not the list payload; other attributes on the page share the name
    }
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const card = item as { title?: unknown; description?: unknown };
      if (typeof card.title !== "string" || typeof card.description !== "string") continue;
      const entry = acceptEntry(card.title, textOf(card.description));
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/**
 * enactussfu.ca/team, the current Next.js site.
 * <h3> <!-- -->Naia Wong<!-- --> </h3><p class="…">President</p>
 *
 * The card also wraps a LinkedIn href. It is deliberately not read: the roster
 * records that the club publishes such a link, never what is behind it.
 */
export function parseNextTeam(html: string): Entry[] {
  const entries: Entry[] = [];
  const pattern = /<h3>([\s\S]{1,120}?)<\/h3>\s*<p[^>]*>([\s\S]{1,120}?)<\/p>/gi;
  for (const match of html.matchAll(pattern)) {
    const entry = acceptEntry(textOf(match[1]), textOf(match[2]));
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * enactussfu.ca/competition. Coaches are named under a year heading:
 *   <h5 …> 2026 </h5><h1> Regionals </h1> … <h3>Coaches: Brandon Xu, David Guo</h3>
 *
 * The page's own "Previous Years" section maps a calendar-year event to an
 * academic year (its "2026 Regionals" block is listed as "2025–2026"), so the
 * season is that page's claim rather than this parser's inference.
 *
 * Presenters and designers are named on the same page and are deliberately not
 * returned: they are competing members, not executives or alumni.
 */
export function parseCompetitionCoaches(html: string): Array<Entry & { year: string }> {
  const found: Array<Entry & { year: string }> = [];
  const pattern = /<h5[^>]*>\s*(?:<!--[^>]*-->)?\s*(\d{4})\s*(?:<!--[^>]*-->)?\s*<\/h5>|<h3>\s*Coaches:\s*([^<]+)<\/h3>/gi;

  let season: string | null = null;
  for (const match of html.matchAll(pattern)) {
    if (match[1]) {
      const end = Number(match[1]);
      season = `${end - 1}-${String(end % 100).padStart(2, "0")}`;
      continue;
    }
    if (!season || !match[2]) continue;
    for (const raw of decodeEntities(match[2]).split(/,|\s+&\s+/)) {
      const entry = acceptEntry(raw, "Competition coach");
      if (entry) found.push({ ...entry, year: season });
    }
  }
  return found;
}

/**
 * A "Community Spotlight" blog post. Only the post title is read — the body is
 * an interview about the person's career and is exactly what this file must not
 * collect. The title states no role and no year of service, which is why these
 * names are recorded at low confidence.
 */
export function parseSpotlightName(html: string): string | null {
  // The title tag carries attributes on some themes and the heading is the only
  // copy of the post title on others, so try both.
  const candidates = [
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
    /<h1[^>]*>([\s\S]{0,160}?)<\/h1>/i.exec(html)?.[1],
    /<h2[^>]*>([\s\S]{0,160}?)<\/h2>/i.exec(html)?.[1],
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = decodeEntities(candidate.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const marker = text.search(/Community Spotlight:/i);
    if (marker < 0) continue;

    // "Community Spotlight: Ivy So - SIFE Alumni | Enactus SFU": the name ends
    // at the first spaced dash or pipe. The dash must be spaced — an unspaced
    // one is part of a hyphenated name.
    const after = text.slice(marker + "Community Spotlight:".length);
    const end = after.search(/\s[-–—]\s|\|/);
    const name = normaliseNameCase((end < 0 ? after : after.slice(0, end)).trim());
    if (isPlausiblePersonName(name)) return name;
  }
  return null;
}

// --- removal --------------------------------------------------------------

/**
 * The names on the removal list as they were written, before they become keys.
 * A message to the student has to quote what they typed rather than the
 * lower-cased, de-punctuated key it was matched on.
 */
export function parseRemovalNames(contents: string): string[] {
  const names: string[] = [];
  for (const line of contents.split("\n")) {
    const name = line.split("#")[0].trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Names a person has asked be kept out of the roster, one per line, `#` for a
 * comment. Matched on `nameKey`, so a request written in a different case or
 * with different punctuation still lands.
 */
export function parseRemovalList(contents: string): Set<string> {
  return new Set(parseRemovalNames(contents).map(nameKey));
}

/**
 * A name on the removal list that is one character away from a name still in
 * the file — the shape of a removal that only half landed.
 *
 * The club's own pages spell some names two ways, so a person can hold two
 * rows. Register one spelling, delete both rows, and every exact check passes
 * while the unregistered spelling comes back at the next rebuild, because
 * `applyRemovals` matches on `nameKey` exactly. This names the other spelling
 * to the student. It does not merge anything and does not choose a spelling:
 * one character apart is evidence, not proof, and two people really can be
 * `Ann Lee` and `Anna Lee`. So it reports and the student decides — which is
 * also why it can never refuse a removal it has misread.
 */
export function nearMissesOnRemovalList(
  listed: string[],
  surviving: string[],
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const name of listed) {
    const a = nameKey(name);
    for (const other of surviving) {
      const b = nameKey(other);
      if (a !== b && editDistanceAtMostOne(a, b)) pairs.push([name, other]);
    }
  }
  return pairs;
}

// --- spellings a human has confirmed ---------------------------------------

/**
 * One correction: the spelling the club published, the spelling a human
 * confirmed is right, and who said so.
 */
export type ConfirmedSpelling = {
  /** The spelling on the club's own page. Sightings carrying it are renamed. */
  published: string;
  /** The spelling that reaches the roster. */
  confirmed: string;
  /** The snapshot the published spelling was read from — the evidence it exists. */
  sourceUrl: string;
  /** Who confirmed it: a role, never a person's contact detail. */
  confirmedBy: string;
  /** The day they confirmed it, `YYYY-MM-DD`. */
  confirmedOn: string;
};

const CONFIRMED_ON = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `config/alumni/confirmed-spellings.tsv`: the club's pages spell some names two
 * ways, and the roster records both rather than guessing, because choosing one
 * would be inventing a name. A human who knows the person can settle it, and
 * this is where that settlement lives — so it survives the next rebuild, which
 * a hand-merged row would not.
 *
 * Every row carries its own provenance, because the spelling is not derived from
 * anything: the club page is the thing that was wrong, so attributing the
 * correction to it would be a lie about where the fact came from.
 *
 * A malformed row throws rather than being skipped: a correction silently
 * dropped splits one person back into two rows, which is the trap this file
 * exists to close.
 */
export function parseConfirmedSpellings(contents: string): ConfirmedSpelling[] {
  const spellings: ConfirmedSpelling[] = [];
  const published = new Set<string>();
  const confirmed = new Set<string>();

  let line = 0;
  for (const raw of contents.split("\n")) {
    line += 1;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    const fields = raw.split("\t").map((field) => field.trim());
    if (fields.length !== 5) {
      throw new Error(`line ${line}: expected 5 tab-separated fields, found ${fields.length}`);
    }

    const [publishedName, confirmedName, sourceUrl, confirmedBy, confirmedOn] = fields;
    // Both spellings go through the same gate every parsed name goes through:
    // a human confirming a name is still not licence to write anything into the
    // roster that a club page could not have said.
    if (!isPlausiblePersonName(publishedName)) {
      throw new Error(`line ${line}: "${publishedName}" is not a published personal name`);
    }
    if (!isPlausiblePersonName(confirmedName)) {
      throw new Error(`line ${line}: "${confirmedName}" is not a personal name`);
    }
    if (publishedName === confirmedName) {
      throw new Error(`line ${line}: "${publishedName}" is corrected to itself, so it corrects nothing`);
    }
    if (!/^https?:\/\//.test(sourceUrl)) {
      throw new Error(`line ${line}: "${sourceUrl}" is not the URL the published spelling was read from`);
    }
    if (!confirmedBy || carriesContactDetail(confirmedBy)) {
      throw new Error(`line ${line}: name the role that confirmed it, and no contact detail`);
    }
    if (!CONFIRMED_ON.test(confirmedOn)) {
      throw new Error(`line ${line}: "${confirmedOn}" is not a date, which every confirmation needs`);
    }

    const publishedKey = nameKey(publishedName);
    if (published.has(publishedKey)) {
      throw new Error(`line ${line}: "${publishedName}" is corrected twice, so the two rows disagree`);
    }
    // One hop, never a chain: A→B and B→C would make the result depend on the
    // order the rows happen to be applied in.
    if (confirmed.has(publishedKey)) {
      throw new Error(`line ${line}: "${publishedName}" is corrected to and from, which is a chain`);
    }
    if (published.has(nameKey(confirmedName))) {
      throw new Error(`line ${line}: "${confirmedName}" is corrected elsewhere, which is a chain`);
    }

    published.add(publishedKey);
    confirmed.add(nameKey(confirmedName));
    spellings.push({
      published: publishedName,
      confirmed: confirmedName,
      sourceUrl,
      confirmedBy,
      confirmedOn,
    });
  }

  return spellings;
}

/** Published spelling (as a key) to the spelling a human confirmed. */
export function confirmedSpellingMap(spellings: ConfirmedSpelling[]): Map<string, string> {
  return new Map(spellings.map((spelling) => [nameKey(spelling.published), spelling.confirmed]));
}

/** The confirmed spelling of a name, or the name itself where none was confirmed. */
export function canonicalName(name: string, spellings: Map<string, string>): string {
  return spellings.get(nameKey(name)) ?? name;
}

/**
 * Applied to sightings, before removals and before the merge, so the two
 * spellings become one person everywhere downstream rather than in the written
 * file alone.
 */
export function applyConfirmedSpellings(
  sightings: Sighting[],
  spellings: Map<string, string>,
): Sighting[] {
  if (!spellings.size) return sightings;
  return sightings.map((sighting) => {
    const confirmed = canonicalName(sighting.name, spellings);
    return confirmed === sighting.name ? sighting : { ...sighting, name: confirmed };
  });
}

/**
 * A removal written under either spelling has to land. Someone asking to be
 * taken off a list does not know which of the club's spellings the file settled
 * on, and being asked to guess is not a burden to put on them.
 */
export function canonicaliseRemovals(
  removed: Set<string>,
  spellings: Map<string, string>,
): Set<string> {
  if (!spellings.size) return removed;
  const keys = new Set<string>();
  for (const key of removed) {
    const confirmed = spellings.get(key);
    keys.add(confirmed ? nameKey(confirmed) : key);
  }
  return keys;
}

// --- the source registry --------------------------------------------------

export type SourceKind = "archived" | "spotlight" | "live";

export type Source = {
  key: string;
  kind: SourceKind;
  prefix: string;
  cdxPattern: string;
  url: string;
  postFilter: string;
};

/** The registry's "not applicable to this kind" marker. */
const NOT_APPLICABLE = "-";

const SOURCE_KINDS: SourceKind[] = ["archived", "spotlight", "live"];

/**
 * scripts/alumni-roster/sources.tsv: the one declaration of what the roster is
 * built from, read by the fetcher and by the build so neither can hold a source
 * the other has never heard of. A malformed row throws rather than being
 * skipped — a source silently dropped from this file is a cohort silently
 * dropped from the roster.
 */
export function parseSourceRegistry(contents: string): Source[] {
  const sources: Source[] = [];
  const keys = new Set<string>();
  const prefixes = new Set<string>();

  let line = 0;
  for (const raw of contents.split("\n")) {
    line += 1;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    const fields = raw.split("\t").map((field) => field.trim());
    if (fields.length !== 6) {
      throw new Error(`line ${line}: expected 6 tab-separated fields, found ${fields.length}`);
    }

    const [key, kind, prefix, cdxPattern, url, postFilter] = fields;
    if (!key || !prefix) throw new Error(`line ${line}: a source needs a key and a cache prefix`);
    if (!cdxPattern || !url || !postFilter) {
      throw new Error(`line ${line}: every column needs a value; write "${NOT_APPLICABLE}" where a kind does not use one`);
    }
    if (!SOURCE_KINDS.includes(kind as SourceKind)) {
      throw new Error(`line ${line}: unknown kind "${kind}", expected one of ${SOURCE_KINDS.join(", ")}`);
    }
    // The sweep matches its posts by this substring and reads the slug that
    // follows it, so it goes in the registry rather than in the fetcher: a
    // second sweep for a different series is otherwise a row that fetches
    // nothing while looking perfectly well formed.
    if (kind === "spotlight" && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(postFilter)) {
      throw new Error(
        `line ${line}: a spotlight source needs a post filter of letters, digits and dashes, not "${postFilter}"`,
      );
    }
    // The prefix names files on disk and `sourceOfCacheFile` claims them with a
    // startsWith, so it is checked like a filename component rather than only
    // for emptiness.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(prefix)) {
      throw new Error(`line ${line}: a cache prefix is letters, digits and dashes, not "${prefix}"`);
    }
    if (keys.has(key)) throw new Error(`line ${line}: duplicate source key "${key}"`);
    if (prefixes.has(prefix)) throw new Error(`line ${line}: duplicate cache prefix "${prefix}"`);
    // A prefix that is another prefix plus a dash claims that source's archived
    // pages as well as its own, and the first row wins: a row prefixed `live`
    // would take `live-team.html` and `live-competition.html` from the sources
    // that fetched them. Two sources cannot own one page.
    for (const seen of prefixes) {
      if (prefix.startsWith(`${seen}-`) || seen.startsWith(`${prefix}-`)) {
        throw new Error(
          `line ${line}: cache prefix "${prefix}" and "${seen}" would claim each other's pages`,
        );
      }
    }

    keys.add(key);
    prefixes.add(prefix);
    sources.push({ key, kind: kind as SourceKind, prefix, cdxPattern, url, postFilter });
  }

  if (!sources.length) throw new Error("no sources declared");
  return sources;
}

/**
 * Which declared source a cached page belongs to. A live page is fetched once
 * and keeps its bare name; everything else carries the Wayback stamp after its
 * prefix. A file no source claims is not silently ignored by the caller — it is
 * the one way a source could otherwise reach the roster undeclared.
 */
export function sourceOfCacheFile(file: string, sources: Source[]): Source | null {
  for (const source of sources) {
    const claimed =
      source.kind === "live" ? file === `${source.prefix}.html` : file.startsWith(`${source.prefix}-`);
    if (claimed) return source;
  }
  return null;
}

/**
 * Sources the club has retired for good, one per line, `#` for a comment. These
 * are the source keys the build reports rather than anything a person wrote, so
 * unlike a removal request they are matched exactly.
 */
export function parseSourceList(contents: string): Set<string> {
  const sources = new Set<string>();
  for (const line of contents.split("\n")) {
    const source = line.split("#")[0].trim();
    if (source) sources.add(source);
  }
  return sources;
}

/**
 * A removal has to survive the next rebuild, or it is not a removal — deleting
 * the row alone would put the person back the moment anyone regenerates the
 * file. This is applied to sightings, before anything is merged or written.
 */
export function applyRemovals(sightings: Sighting[], removed: Set<string>): Sighting[] {
  return sightings.filter((sighting) => !removed.has(nameKey(sighting.name)));
}

// --- merge ----------------------------------------------------------------

export type RosterRow = {
  name: string;
  role: string;
  yearsActive: string;
  sourceUrl: string;
  capturedAt: string;
  confidence: Confidence;
};

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** "2015-16", "2016-17", "2018-19" -> "2015-16..2016-17;2018-19" */
export function compressYears(years: string[]): string {
  const sorted = [...new Set(years.filter(Boolean))].sort();
  const runs: string[][] = [];
  for (const year of sorted) {
    const last = runs.at(-1);
    const previous = last?.at(-1);
    if (previous && Number(year.slice(0, 4)) === Number(previous.slice(0, 4)) + 1) last!.push(year);
    else runs.push([year]);
  }
  return runs.map((run) => (run.length > 1 ? `${run[0]}..${run.at(-1)}` : run[0])).join(";");
}

/** "2015-16..2016-17;2018-19" -> ["2015-16", "2016-17", "2018-19"] */
export function expandYears(span: string): string[] {
  const years: string[] = [];
  for (const part of span.split(";")) {
    if (!part) continue;
    const [from, to] = part.split("..");
    if (!to) {
      years.push(from);
      continue;
    }
    // A run states a sighting in every year it spans, which is what makes it a
    // run: compressYears only collapses years that are actually consecutive.
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
      years.push(`${year}-${String(year + 1).slice(2)}`);
    }
  }
  return years;
}

/**
 * How many people the roster covers in each academic year, and how many it
 * names with no year at all. The coverage report in config/alumni/README.md is
 * this, printed: a hand-maintained one drifts from the file it describes.
 */
export function coverageByYear(rows: RosterRow[]): {
  years: Array<[string, number]>;
  undated: number;
} {
  const counts = new Map<string, number>();
  let undated = 0;
  for (const row of rows) {
    const years = expandYears(row.yearsActive);
    if (!years.length) {
      undated += 1;
      continue;
    }
    for (const year of new Set(years)) counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return { years: [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), undated };
}

/**
 * One row per person, not one per snapshot.
 *
 * Roles are kept, not collapsed: someone who was a director and later president
 * carries both, each annotated with the years it was observed, and one source
 * URL per role in the same order. Confidence is the best any sighting achieved —
 * one direct read off a roster page establishes the name, and a later weaker
 * sighting does not unestablish it.
 */
export function mergeSightings(sightings: Sighting[]): RosterRow[] {
  const people = new Map<string, Sighting[]>();
  for (const sighting of sightings) {
    const key = nameKey(sighting.name);
    const bucket = people.get(key);
    if (bucket) bucket.push(sighting);
    else people.set(key, [sighting]);
  }

  const rows: RosterRow[] = [];
  for (const raw of people.values()) {
    // A source that names someone but states no role adds nothing once another
    // source states one. It still counts towards the years and the confidence.
    const stated = raw.filter((sighting) => sighting.role !== "");
    const bucket = stated.length ? stated : raw;

    const byRole = new Map<string, Sighting[]>();
    for (const sighting of bucket) {
      const bucketForRole = byRole.get(sighting.role);
      if (bucketForRole) bucketForRole.push(sighting);
      else byRole.set(sighting.role, [sighting]);
    }

    // Both orderings below are total: ties fall through to the order the
    // sightings were read in, which is the sorted cache listing. Leaving a tie
    // to the engine's sort would make the file's bytes a Node version detail.
    const roles = [...byRole.entries()]
      .map(([role, seen], order) => ({
        role,
        order,
        years: compressYears(seen.map((s) => s.year)),
        earliest: seen.reduce((best, next) => (next.year < best.year ? next : best)),
      }))
      .sort((a, b) => (a.years < b.years ? -1 : a.years > b.years ? 1 : a.order - b.order));

    // One provenance entry per role, in role order, even where two roles were
    // read off the same page: role, source_url and captured_at are read by
    // index, so a value written once for two roles would mis-pair them.
    const single = roles.length === 1;
    rows.push({
      name: bucket[0].name,
      role: single ? roles[0].role : roles.map((r) => `${r.role} (${r.years})`).join("; "),
      yearsActive: compressYears(raw.map((s) => s.year)),
      sourceUrl: roles.map((r) => r.earliest.sourceUrl).join(" | "),
      capturedAt: roles.map((r) => r.earliest.capturedAt).join(" | "),
      confidence: raw
        .map((s) => s.confidence)
        .reduce((best, next) => (CONFIDENCE_RANK[next] > CONFIDENCE_RANK[best] ? next : best)),
    });
  }

  // Code-unit order, not localeCompare: collation follows the machine's ICU and
  // locale, and the order of every line is part of what makes this file
  // reproducible.
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// --- CSV ------------------------------------------------------------------

/**
 * The file has to state its own handling rules, because a CSV travels: it gets
 * opened in a spreadsheet, pasted into a chat, mailed to next year's exec. The
 * README beside it is the long form; this is what survives the trip.
 *
 * It lives here rather than in build.ts so the committed roster can be checked
 * against the bytes the generator writes: the preamble is generated output, and
 * a rebuild has to reproduce it exactly.
 */
export const CSV_PREAMBLE = `# Enactus SFU past-executive and alumni roster.
#
# PRIVATE. Do not publish, share outside the External Relations team, or commit
# to a public repository. These are real people, most of them former students,
# and the club published their names to introduce a team - not to build a list.
# An alum's connection to this club is personal information about them: it sits
# outside PIPEDA's business-contact exemption and outside BC PIPA's
# contact-information carve-out, so this file carries obligations that the
# company data elsewhere in this repository does not.
#
# THIS IS A RESEARCH SEED, NOT A CONTACT LIST. Its one job is to let the pipeline
# recognise an alumni connection to a company it has already found on its own.
# Do not contact anyone because they appear here.
#
# Only what the club itself published: name, role, years. No email addresses, no
# phone numbers, no LinkedIn profile data, no employers, no personal detail.
#
# Anyone named here may ask to be removed. See config/alumni/README.md; honour it
# the same day and never ask why.
#
# Where the club published a name two ways, the spelling a human confirmed and
# the snapshot the superseded spelling came from are recorded in
# confirmed-spellings.tsv beside this file.
#
# Generated by scripts/alumni-roster/build.ts - edit that, not this.
`;

export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: RosterRow[]): string {
  const lines = ["name,role,years_active,source_url,captured_at,confidence"];
  for (const row of rows) {
    lines.push(
      [row.name, row.role, row.yearsActive, row.sourceUrl, row.capturedAt, row.confidence]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

const CSV_COLUMNS = ["name", "role", "years_active", "source_url", "captured_at", "confidence"];

function splitCsv(body: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }

  return records;
}

/**
 * Read back what toCsv wrote, preamble and all. The committed roster is the
 * only input the file's own coverage report needs, which is what lets that
 * report be refreshed with no snapshot cache and no network.
 */
export function parseRosterCsv(contents: string): RosterRow[] {
  const lines = contents.split("\n");
  const headerAt = lines.findIndex((line) => !line.startsWith("#"));
  if (headerAt < 0) throw new Error("no header row: every line is a comment");

  const records = splitCsv(lines.slice(headerAt).join("\n"));
  const header = records.shift();
  if (!header || header.join(",") !== CSV_COLUMNS.join(",")) {
    throw new Error(`unexpected header row: ${header?.join(",")}`);
  }

  const rows: RosterRow[] = [];
  for (const [index, record] of records.entries()) {
    if (record.length !== CSV_COLUMNS.length) {
      throw new Error(`row ${index + 1}: expected ${CSV_COLUMNS.length} fields, found ${record.length}`);
    }
    const [name, role, yearsActive, sourceUrl, capturedAt, confidence] = record;
    if (!(confidence in CONFIDENCE_RANK)) {
      throw new Error(`row ${index + 1}: "${confidence}" is not a confidence level`);
    }
    rows.push({ name, role, yearsActive, sourceUrl, capturedAt, confidence: confidence as Confidence });
  }
  return rows;
}

// --- the README's coverage report ------------------------------------------

const COVERAGE_BLOCK = /(## Gaps in the record[\s\S]*?```\n)([\s\S]*?)(```)/;

/**
 * The year the chapter was founded, as the club itself published it: its
 * archived site footers carry "Founded in 1991", and the 2012 /alumni/ page
 * dates its founder's entry to that year — the same page the roster's own 1991
 * row was read from.
 *
 * It is pinned rather than read off the roster because it is the denominator of
 * the coverage report: taken from the earliest row instead, removing the person
 * who holds that row would shrink the span and the report would claim a larger
 * share of the club's history than it covers, in the section whose whole job is
 * saying what is missing.
 */
export const FOUNDING_YEAR = 1991;

/** "2024-25  12  ← coaches only" -> the note beside the count, if there is one. */
function notesInTable(block: string): Map<string, string> {
  const notes = new Map<string, string>();
  for (const line of block.split("\n")) {
    if (line.trim() === "") break;
    const cells = [...line.matchAll(/(\d{4}(?:-\d{2})?)\s+\d+/g)];
    for (const [index, cell] of cells.entries()) {
      const from = cell.index + cell[0].length;
      const to = index + 1 < cells.length ? cells[index + 1].index : line.length;
      const note = line.slice(from, to).trim();
      if (note) notes.set(cell[1], note);
    }
  }
  return notes;
}

/**
 * The whole coverage report, table and totals together, as config/alumni/README.md
 * carries it. Every count the file states about the roster is in here and nowhere
 * else: a number that appears in one place cannot disagree with itself, so there
 * is nothing to keep in sync and nothing to go quietly stale.
 */
export function renderCoverageReport(
  people: number,
  coverage: { years: Array<[string, number]>; undated: number },
  asOfYear: number,
  notes: Map<string, string> = new Map(),
): string {
  const columns = 4;
  const rows = Math.ceil(coverage.years.length / columns);
  const lines: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      const entry = coverage.years[column * rows + row];
      if (!entry) continue;
      const [year, count] = entry;
      const note = notes.get(year);
      cells.push(year.padEnd(7) + String(count).padStart(4) + (note ? `  ${note}` : ""));
    }
    lines.push(cells.join("    ").trimEnd());
  }

  const first = coverage.years[0]?.[0];
  const last = coverage.years.at(-1)?.[0];
  // Founding year to the year this roster was captured. Neither end is a row,
  // so the share of the club's history this file covers does not rise when
  // somebody is taken out of it.
  const span = asOfYear - FOUNDING_YEAR + 1;

  // A window that ends before the last year it counts is not a smaller share,
  // it is a contradiction — and one that reads as a plausible number. Report it
  // rather than writing it.
  const lastCovered = last ? Number(last.slice(0, 4)) : FOUNDING_YEAR;
  if (asOfYear < lastCovered) {
    throw new Error(
      `a roster dated ${asOfYear} cannot cover ${last ?? FOUNDING_YEAR}: ` +
        `the coverage span would end before the years it counts`,
    );
  }

  if (lines.length) lines.push("");
  lines.push(
    [
      `people ${people}`,
      `with no year ${coverage.undated}`,
      `earliest ${first ?? "-"}`,
      `latest ${last ?? "-"}`,
    ].join("    "),
  );
  lines.push(
    `years covered ${coverage.years.length} of the ${span} academic years since the chapter was founded in ${FOUNDING_YEAR}`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Rewrite that report in place from the roster. A note beside a year is carried
 * over; nothing else in the file is touched, because nothing else in the file
 * states a count. A report that has moved throws rather than being left stale.
 */
export function refreshCoverageClaims(
  readme: string,
  people: number,
  coverage: { years: Array<[string, number]>; undated: number },
  asOfYear: number,
): string {
  const block = COVERAGE_BLOCK.exec(readme);
  if (!block) throw new Error('no fenced coverage report under "## Gaps in the record"');

  return readme.replace(
    COVERAGE_BLOCK,
    (_match, open: string, body: string, close: string) =>
      open + renderCoverageReport(people, coverage, asOfYear, notesInTable(body)) + close,
  );
}

/**
 * The academic year the roster was captured in, read off the capture date the
 * file records for every row and nothing else — not the clock, and not the
 * environment. `ROSTER_CAPTURED_AT` pins that date when the roster is built;
 * once it is in the file, letting it be overridden again could only date the
 * roster differently from the rows it describes. A file whose rows disagree
 * about when they were captured is not a file to guess at.
 */
export function capturedAcademicYear(rows: RosterRow[]): number {
  const dates = new Set(rows.flatMap((row) => row.capturedAt.split(" | ")).filter(Boolean));

  if (dates.size !== 1) {
    throw new Error(
      dates.size === 0
        ? "no capture date to date the roster by"
        : `rows disagree about when they were captured: ${[...dates].sort().join(", ")}`,
    );
  }

  const [date] = dates;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a capture date: ${date}`);
  return Number(academicYearOfCapture(`${date.replace(/-/g, "")}000000`).slice(0, 4));
}

/**
 * Names that differ by a single character are almost always one person spelled
 * two ways by the club's own pages. This reports them; it does not merge them.
 * Guessing which spelling is right would be inventing a name.
 */
export function findNearDuplicates(rows: RosterRow[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = nameKey(rows[i].name);
      const b = nameKey(rows[j].name);
      if (a !== b && editDistanceAtMostOne(a, b)) pairs.push([rows[i].name, rows[j].name]);
    }
  }
  return pairs;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (shorter.length === longer.length) i += 1;
    j += 1;
  }
  return edits + (longer.length - j) <= 1;
}

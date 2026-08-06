// Loads the maintained exclusion lists in config/exclusions/.
//
// These lists are POLICY, not code: a human curates them, they are reviewed in a pull request,
// and they are loaded once at process start. Spec: enactus-disqualifiers/report.md §7.
//
// Nothing in this file calls a model, and nothing in it reaches the network.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Minimal RFC 4180 reader. Handles quoted fields, embedded commas, embedded newlines and
 * doubled quotes. Returns row objects keyed by the header row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const stripped = text.replace(/^﻿/, "");

  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];

    if (inQuotes) {
      if (c === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && stripped[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (nonEmpty.length === 0) return [];

  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim();
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Normalisation — the `normalized_name` / `registrable_domain` contract of report §2.1
// ---------------------------------------------------------------------------

/**
 * Legal-suffix set from report §2.1. Stripped only from the END of the name, repeatedly, so
 * "MNP LLP" -> "mnp" and "Always Beyond Corp." -> "always beyond", while "Co-operators" and
 * "Canadian Tire Corporation" survive intact ("corporation" is deliberately not in the set).
 */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "ltd",
  "llp",
  "llc",
  "corp",
  "co",
  "company",
  "limited",
  "ulc",
  "lp",
  "societe",
  "ltee",
]);

/**
 * Casefold; strip accents; drop apostrophes; turn every other punctuation mark into a space;
 * expand "&" to "and"; collapse whitespace; strip trailing legal suffixes.
 *
 * This is the exact key that every `kind=name` row in config/exclusions/ is written against.
 */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[‘’'`]/g, "");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, " ");
  s = s.trim().replace(/\s+/g, " ");

  let tokens = s.split(" ").filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(" ");
}

/**
 * Defensive normalisation of an already-registrable domain.
 *
 * The account record carries `registrable_domain` as a field (report §2.1: "Public Suffix List;
 * www. and sub. collapsed"), so deriving the registrable form from an arbitrary hostname is the
 * caller's job, not this function's. This only lowercases, drops a scheme, a `www.` label, a
 * port, a path and a trailing dot — it does NOT consult a public suffix list.
 */
export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^\/\//, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  s = s.split("@").pop() ?? s;
  s = s.split(":")[0];
  s = s.replace(/\.+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

/** True when `domain` is `parent` or any subdomain of it. */
export function isDomainOrSubdomainOf(domain: string, parent: string): boolean {
  if (!domain || !parent) return false;
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** Municipality key used against config/exclusions/metro-vancouver.csv aliases. */
export function normalizeMunicipality(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// List shapes
// ---------------------------------------------------------------------------

export interface ListEntry {
  kind: "domain" | "name";
  value: string;
  entity: string;
  reason: string;
  addedBy: string;
  addedAt: string;
  sourceUrl: string;
}

/** A list that can be probed by registrable domain or by normalised name. */
export interface KeyedList {
  readonly name: string;
  readonly domains: ReadonlyMap<string, ListEntry>;
  readonly names: ReadonlyMap<string, ListEntry>;
  readonly entries: readonly ListEntry[];
}

export interface MetroJurisdiction {
  canonical: string;
  aliases: string[];
  reason: string;
}

export interface SectorPolicyRow {
  sector: string;
  naics: string;
  pattern: string;
  /**
   * `pattern` compiled once, at load. `null` when the row has no pattern — a blank pattern is a
   * deliberate "detection not enumerated" marker (adult_entertainment) and must never become the
   * empty regex, which matches every string.
   */
  regex: RegExp | null;
  policy: "allowed" | "discouraged" | "prohibited" | "needs_decision";
  decidedBy: string;
  decidedAt: string;
  note: string;
}

export interface QualificationLists {
  nationalPartner: KeyedList;
  nationalFlag: KeyedList;
  studentOrg: KeyedList;
  eduDomains: KeyedList;
  paidMembership: KeyedList;
  govDomains: KeyedList;
  self: KeyedList;
  neverKillDomains: KeyedList;
  disposableDomains: KeyedList;
  freeMailProviders: KeyedList;
  parkingNameservers: KeyedList;
  currentAndPastSponsors: KeyedList;
  metroVancouver: MetroJurisdiction[];
  /** alias -> canonical jurisdiction. An alias may be shared by two in-scope jurisdictions. */
  metroVancouverAliases: ReadonlyMap<string, string[]>;
  sectorPolicy: SectorPolicyRow[];
}

function buildKeyedList(name: string, rows: Record<string, string>[]): KeyedList {
  const domains = new Map<string, ListEntry>();
  const names = new Map<string, ListEntry>();
  const entries: ListEntry[] = [];

  for (const row of rows) {
    const rawKind = (row.kind ?? "").toLowerCase();
    if (rawKind !== "domain" && rawKind !== "name") continue;

    const rawValue = row.value ?? "";
    // A blank `value` is a deliberate "we could not verify a domain for this" marker.
    // It must never become a wildcard match.
    if (rawValue.trim() === "") continue;

    const value = rawKind === "domain" ? normalizeDomain(rawValue) : normalizeName(rawValue);
    if (!value) continue;

    const entry: ListEntry = {
      kind: rawKind,
      value,
      entity: row.entity ?? "",
      reason: row.reason ?? "",
      addedBy: row.added_by ?? "",
      addedAt: row.added_at ?? "",
      sourceUrl: row.source_url ?? "",
    };
    entries.push(entry);
    if (rawKind === "domain") {
      if (!domains.has(value)) domains.set(value, entry);
    } else if (!names.has(value)) {
      names.set(value, entry);
    }
  }

  return { name, domains, names, entries };
}

/**
 * The canonical Metro Vancouver jurisdictions a municipality string resolves to.
 *
 * Lives here, next to `normalizeMunicipality` and the alias map it reads, because both the
 * filter (`isInMetroVancouver`) and the scorer (`geographyBand`) need it and scoring.ts
 * deliberately keeps no runtime dependency on filter.ts. An alias may be shared by two
 * in-scope jurisdictions ("north vancouver" is both the City and the District).
 */
export function metroVancouverCanonicals(
  municipality: string | null | undefined,
  lists: Pick<QualificationLists, "metroVancouverAliases">,
): string[] {
  const key = normalizeMunicipality(municipality);
  if (!key) return [];
  return lists.metroVancouverAliases.get(key) ?? [];
}

/**
 * THE THREE-VALUED PRIMITIVE, applied to every geography field alike.
 *
 * Report §2.3 says a predicate may only fire on a positive observation. That is a statement
 * about THREE states, not two, and writing it as a boolean per field is what produced four
 * consecutive geography defects: each hand-written classifier collapsed the third state in a
 * different direction — one read "unrecognised" as CONTRARY and killed a Burnaby bakery whose
 * province read "B.C.", another read it as PERMISSIVE and scored Vancouver, Washington as a
 * local prospect.
 *
 *   known     the field is positive evidence FOR the thing being asked about
 *   contrary  the field was RECOGNISED and says the opposite
 *   unknown   absent, blank, or recorded but not recognised — the same evidential state
 *
 * Every consumer switches on all three with a `never` default, so a future field cannot quietly
 * inherit either collapse.
 */
export type Evidence = "known" | "contrary" | "unknown";

/** The spellings of British Columbia that appear in real records. */
export const BC_REGION_SPELLINGS: ReadonlySet<string> = new Set([
  "bc",
  "b c",
  "british columbia",
  "colombie-britannique",
  "colombie britannique",
  "cb",
  "c-b",
]);

/**
 * The twelve Canadian provinces and territories that are NOT British Columbia.
 *
 * DELIBERATELY NOT A WORLD GAZETTEER. Province is derived only WITHIN Canada, so the token "CA"
 * — the ISO code this codebase itself uses for CANADA — can never be read as California.
 */
const CANADA_OTHER_PROVINCES: ReadonlySet<string> = new Set([
  "ab", "alberta",
  "sk", "saskatchewan",
  "mb", "manitoba",
  "on", "ontario",
  "qc", "pq", "que", "quebec",
  "nb", "new brunswick", "nouveau-brunswick",
  "ns", "nova scotia", "nouvelle-ecosse",
  "pe", "pei", "prince edward island", "ile-du-prince-edouard",
  "nl", "nf", "newfoundland", "newfoundland and labrador", "terre-neuve-et-labrador",
  "yt", "yukon",
  "nt", "northwest territories", "territoires du nord-ouest",
  "nu", "nunavut",
]);

const CANADA_SPELLINGS: ReadonlySet<string> = new Set(["ca", "can", "canada"]);

/**
 * Countries RECOGNISED as not being Canada.
 *
 * A CLOSED VOCABULARY, deliberately, and deliberately incomplete. K-GEO-01 is the one geographic
 * terminal left, so "outside Canada" has to be something the module RECOGNISED, never merely
 * something it failed to recognise: `address_country` of "British Columbia" is a plausible
 * data-entry slip and must not drop a Burnaby bakery. The cost of the omission is under-killing
 * — a French company records "France" and reaches the queue unresolved — which is the safe
 * direction, because a wrongly killed account is invisible forever. Extend the list when a real
 * row needs it.
 */
const NOT_CANADA_COUNTRIES: ReadonlySet<string> = new Set([
  "us", "usa", "u s a", "united states", "united states of america", "america",
  "gb", "uk", "united kingdom", "england", "scotland", "wales", "northern ireland",
  "ie", "ireland", "au", "australia", "nz", "new zealand",
  "fr", "france", "de", "germany", "deutschland", "es", "spain", "it", "italy",
  "nl", "netherlands", "se", "sweden", "no", "norway", "dk", "denmark", "fi", "finland",
  "ch", "switzerland", "at", "austria", "be", "belgium", "pt", "portugal", "pl", "poland",
  "mx", "mexico", "br", "brazil", "ar", "argentina", "cl", "chile",
  "cn", "china", "jp", "japan", "kr", "south korea", "in", "india", "sg", "singapore",
  "hk", "hong kong", "tw", "taiwan", "il", "israel", "ae", "united arab emirates",
  "za", "south africa", "ng", "nigeria", "ke", "kenya",
]);

/**
 * The shapes a value is tried in. Beyond `normalizeMunicipality`, this drops the separators
 * inside an abbreviation ("B.C." → "bc") and a trailing country ("British Columbia, Canada" →
 * "british columbia"), because both are ordinary in scraped addresses.
 */
function candidates(value: string | null | undefined): string[] {
  const key = normalizeMunicipality(value);
  if (!key) return [];
  const out = new Set<string>([key, key.replace(/[\s-]+/g, "")]);
  const trailingCountry = /\s+(canada|ca|usa|us|united states|united states of america)$/;
  const trimmed = key.replace(trailingCountry, "").trim();
  if (trimmed && trimmed !== key) {
    out.add(trimmed);
    out.add(trimmed.replace(/[\s-]+/g, ""));
  }
  return [...out].filter(Boolean);
}

/** A Canadian postal code, by FORMAT — `A1A 1A1`. The first letter is the postal district. */
const CANADIAN_POSTAL_RE = /^([a-z])\d[a-z]\s*\d[a-z]\d$/i;

function canadianPostalDistrict(postal: string | null | undefined): string | null {
  const key = (postal ?? "").trim();
  const m = CANADIAN_POSTAL_RE.exec(key.replace(/\s+/g, " "));
  return m ? m[1].toLowerCase() : null;
}

/** IS THIS ROW IN CANADA? Country first, then a Canadian postal FORMAT, then a province name. */
export function countryEvidence(facts: GeographyFacts): Evidence {
  const keys = candidates(facts.country);
  if (keys.some((k) => CANADA_SPELLINGS.has(k))) return "known";
  if (keys.some((k) => NOT_CANADA_COUNTRIES.has(k))) return "contrary";
  // A well-formed Canadian postal code is positive evidence of Canada. This is a FORMAT rule,
  // not the FSA-prefix membership list report §8 rejected: it says which COUNTRY the row is in,
  // never which municipality.
  if (canadianPostalDistrict(facts.postal_code)) return "known";
  const region = candidates(facts.region);
  if (region.some((k) => BC_REGION_SPELLINGS.has(k) || CANADA_OTHER_PROVINCES.has(k))) return "known";
  return "unknown";
}

/** IS THIS ROW IN BRITISH COLUMBIA? `V` is BC's postal district, which is a province fact. */
export function regionEvidence(facts: GeographyFacts): Evidence {
  const keys = candidates(facts.region);
  if (keys.some((k) => BC_REGION_SPELLINGS.has(k))) return "known";
  if (keys.some((k) => CANADA_OTHER_PROVINCES.has(k))) return "contrary";
  if (canadianPostalDistrict(facts.postal_code) === "v") return "known";
  return "unknown";
}

/**
 * IS THIS MUNICIPALITY ONE OF THE 23 METRO VANCOUVER MEMBER JURISDICTIONS?
 *
 * `contrary` is unreachable today and that is honest: config/exclusions/metro-vancouver.csv
 * enumerates the members, and nothing enumerates every BC municipality that is NOT one, so a
 * name it does not carry is UNKNOWN rather than "known to be elsewhere". The combination rule
 * below is what keeps that from being permissive.
 */
export function municipalityEvidence(
  facts: GeographyFacts,
  lists: Pick<QualificationLists, "metroVancouverAliases">,
): Evidence {
  return metroVancouverCanonicals(facts.municipality, lists).length > 0 ? "known" : "unknown";
}

/**
 * WHERE A ROW SITS — one band, and only one of them kills.
 *
 * CAPTAIN'S RULING, 2026-08-06, which SUPERSEDES the disqualifier report: "ideally we want
 * businesses in BC, but anything across canada is fine". In scope is ANYWHERE IN CANADA;
 * preferred is BC, and Greater Vancouver most of all; out of scope is outside Canada.
 *
 *   metro_vancouver  one of the 23 member jurisdictions of config/exclusions/metro-vancouver.csv
 *   bc_other         in BC, outside those 23
 *   canada_other     elsewhere in Canada — ACCEPTABLE at a lower weight, NEVER a kill
 *   outside_canada   RECOGNISED outside Canada — the ONLY band that terminals (K-GEO-01)
 *   unresolved       nothing recorded decides it; `missing_fields` says what would
 */
export type GeographyBandId =
  | "metro_vancouver"
  | "bc_other"
  | "canada_other"
  | "outside_canada"
  | "unresolved";

export interface GeographyFacts {
  municipality?: string | null;
  region?: string | null;
  country?: string | null;
  /**
   * Read ONLY for its country and province FORMAT (a Canadian postal code; `V` is BC). It never
   * decides Metro Vancouver membership — report §8 rejected FSA-prefix geography in writing, and
   * a coarse V3–V7 set proved it: V3G and V4X are Abbotsford, V4S is Mission.
   */
  postal_code?: string | null;
}

export interface GeographyVerdict {
  band: GeographyBandId;
  /** The three-valued reading of each field. The band is a pure function of these. */
  evidence: {
    country: Evidence;
    region: Evidence;
    municipality: Evidence;
  };
  /** The member jurisdictions the municipality resolved to. Empty unless `metro_vancouver`. */
  metro_canonicals: string[];
  /** Which fields read `unknown`. Absent and unrecognised are the same state, so both appear. */
  missing_fields: string[];
}

/**
 * THE ONE COMBINATION RULE. Both src/lib/filter.ts and src/lib/scoring.ts consume this verdict
 * with the same inputs, and neither keeps its own copy.
 *
 *  1. A RECOGNISED non-Canada country is the only thing that can reach `outside_canada`. An
 *     unrecognised one is `unknown` and can never kill.
 *
 *  2. A MUNICIPALITY ALIAS IS TRUSTED ONLY ON POSITIVE EVIDENCE OF CANADA. metro-vancouver.csv
 *     ships BARE MUNICIPALITY NAMES, and richmond, vancouver, surrey, langley, delta and white
 *     rock all name real places elsewhere. Vancouver BC and Vancouver WA are indistinguishable
 *     on a bare municipality, so the honest answer is `unresolved` — which is not a kill, so a
 *     thin row loses a weighting, never its place on the board.
 *
 *  3. `canada_other` NEEDS POSITIVE EVIDENCE TOO — a RECOGNISED non-BC province. Country-is-
 *     Canada with everything else unknown is `unresolved`, because P-04 reads this band as "the
 *     head office is elsewhere" and the captain's absence rule forbids inferring that from a
 *     field nobody filled in.
 *
 *  4. UNKNOWN IS ABSENT, IN EVERY BRANCH AND AT EVERY FIELD — identically, not merely
 *     non-fatally. Nothing derived from the raw string reaches the verdict, so resolving a row
 *     with a field present-but-unrecognised returns an object EQUAL to resolving it omitted.
 */
export function resolveGeography(
  facts: GeographyFacts,
  lists: Pick<QualificationLists, "metroVancouverAliases">,
): GeographyVerdict {
  const evidence = {
    country: countryEvidence(facts),
    region: regionEvidence(facts),
    municipality: municipalityEvidence(facts, lists),
  };

  const missing_fields = (["municipality", "region", "country"] as const).filter(
    (f) => evidence[f] === "unknown",
  );
  const metro = metroVancouverCanonicals(facts.municipality, lists);

  const band = ((): GeographyBandId => {
    switch (evidence.country) {
      case "contrary":
        return "outside_canada";
      case "known":
      case "unknown":
        break;
      default: {
        const unhandled: never = evidence.country;
        return unhandled;
      }
    }

    switch (evidence.region) {
      case "known":
        return evidence.municipality === "known" ? "metro_vancouver" : "bc_other";
      case "contrary":
        return "canada_other";
      case "unknown":
        return evidence.country === "known" && evidence.municipality === "known"
          ? "metro_vancouver"
          : "unresolved";
      default: {
        const unhandled: never = evidence.region;
        return unhandled;
      }
    }
  })();

  return {
    band,
    evidence,
    metro_canonicals: band === "metro_vancouver" ? metro : [],
    missing_fields: [...missing_fields],
  };
}

/** Look a record up by domain first, then by normalised name. */
export function lookupList(
  list: KeyedList,
  domain: string | null | undefined,
  name: string | null | undefined,
): ListEntry | null {
  const d = normalizeDomain(domain);
  if (d) {
    const hit = list.domains.get(d);
    if (hit) return hit;
  }
  const n = normalizeName(name);
  if (n) {
    const hit = list.names.get(n);
    if (hit) return hit;
  }
  return null;
}

/** Look a record up by domain only, allowing subdomains (used for the .edu / SFU rule). */
export function lookupDomainOrSubdomain(
  list: KeyedList,
  domain: string | null | undefined,
): ListEntry | null {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const exact = list.domains.get(d);
  if (exact) return exact;
  for (const [key, entry] of list.domains) {
    if (isDomainOrSubdomainOf(d, key)) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building from raw file contents (pure — the unit under test)
// ---------------------------------------------------------------------------

const LIST_FILES = {
  nationalPartner: "national-partners.csv",
  nationalFlag: "national-flag.csv",
  studentOrg: "student-orgs.csv",
  eduDomains: "edu-domains.csv",
  paidMembership: "paid-membership.csv",
  govDomains: "gov-domains.csv",
  self: "self.csv",
  neverKillDomains: "never-kill-domains.csv",
  disposableDomains: "disposable-domains.csv",
  freeMailProviders: "free-mail-providers.csv",
  parkingNameservers: "parking-nameservers.csv",
  currentAndPastSponsors: "current-and-past-sponsors.csv",
} as const;

export const EXCLUSION_LIST_FILES: readonly string[] = [
  ...Object.values(LIST_FILES),
  "metro-vancouver.csv",
  "sector-policy.csv",
];

/**
 * Compile one sector-policy pattern, naming the offending row if it will not compile.
 *
 * sector-policy.csv is edited by the VP External Relations, not by a programmer. An unbalanced
 * pattern such as `payday(` used to raise a bare `SyntaxError` from deep inside the penalty pass,
 * once per account, with nothing to say which row was at fault. Fail once, at load, loudly —
 * the way `loadIcpConfig()` already fails on a weight that stops summing to 100.
 */
function compileSectorPattern(sector: string, pattern: string): RegExp | null {
  if (pattern.trim() === "") return null;
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(
      `sector-policy.csv row "${sector}" has an invalid pattern ${JSON.stringify(pattern)}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Fix the pattern in config/exclusions/sector-policy.csv — see its README for who owns this file.`,
    );
  }
}

/**
 * Build the in-memory lists from raw file text. Pure: no filesystem, no network.
 * `files` is keyed by bare filename, e.g. `{"self.csv": "kind,value,..."}`.
 */
export function buildQualificationLists(files: Record<string, string>): QualificationLists {
  const keyed = {} as Record<keyof typeof LIST_FILES, KeyedList>;
  for (const [key, filename] of Object.entries(LIST_FILES) as [
    keyof typeof LIST_FILES,
    string,
  ][]) {
    keyed[key] = buildKeyedList(filename, parseCsv(files[filename] ?? ""));
  }

  const metroVancouver: MetroJurisdiction[] = parseCsv(files["metro-vancouver.csv"] ?? "")
    .filter((r) => (r.canonical ?? "").trim() !== "")
    .map((r) => ({
      canonical: r.canonical.trim(),
      aliases: (r.aliases ?? "")
        .split("|")
        .map((a) => normalizeMunicipality(a))
        .filter(Boolean),
      reason: r.reason ?? "",
    }));

  const metroVancouverAliases = new Map<string, string[]>();
  for (const j of metroVancouver) {
    // The canonical name is always an alias of itself.
    for (const alias of [...j.aliases, normalizeMunicipality(j.canonical)]) {
      const existing = metroVancouverAliases.get(alias);
      if (existing) {
        if (!existing.includes(j.canonical)) existing.push(j.canonical);
      } else {
        metroVancouverAliases.set(alias, [j.canonical]);
      }
    }
  }

  const sectorPolicy: SectorPolicyRow[] = parseCsv(files["sector-policy.csv"] ?? "")
    .filter((r) => (r.sector ?? "").trim() !== "")
    .map((r) => {
      const sector = r.sector.trim();
      const pattern = r.pattern ?? "";
      return {
        sector,
        naics: r.naics ?? "",
        pattern,
        regex: compileSectorPattern(sector, pattern),
        policy: (r.policy ?? "needs_decision") as SectorPolicyRow["policy"],
        decidedBy: r.decided_by ?? "",
        decidedAt: r.decided_at ?? "",
        note: r.note ?? "",
      };
    });

  return { ...keyed, metroVancouver, metroVancouverAliases, sectorPolicy };
}

// ---------------------------------------------------------------------------
// Loading from disk
// ---------------------------------------------------------------------------

export const DEFAULT_EXCLUSIONS_DIR = join(process.cwd(), "config", "exclusions");

let cached: QualificationLists | null = null;
let cachedDir: string | null = null;

/**
 * Read config/exclusions/ and build the lists. Cached per directory, because the lists are
 * loaded once at process start and a club with annual turnover edits them in a pull request,
 * not at runtime. Pass `reload: true` in a test that mutates the files.
 */
export function loadQualificationLists(
  dir: string = DEFAULT_EXCLUSIONS_DIR,
  opts: { reload?: boolean } = {},
): QualificationLists {
  if (!opts.reload && cached && cachedDir === dir) return cached;

  const present = new Set(readdirSync(dir));
  const files: Record<string, string> = {};
  for (const filename of EXCLUSION_LIST_FILES) {
    if (!present.has(filename)) {
      throw new Error(
        `Missing exclusion list ${filename} in ${dir}. ` +
          `Every list in enactus-disqualifiers/report.md §7 must be present; an absent list ` +
          `would silently turn its predicate off.`,
      );
    }
    files[filename] = readFileSync(join(dir, filename), "utf8");
  }

  cached = buildQualificationLists(files);
  cachedDir = dir;
  return cached;
}

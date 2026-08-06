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
 * The spellings of British Columbia that appear in real records.
 *
 * `normalizeMunicipality` preserves hyphens and collapses everything else to spaces, so
 * "colombie-britannique" and "colombie britannique" are DISTINCT KEYS and both must be here.
 * `regionCandidates` below tries a few further shapes ("B.C.", "British Columbia, Canada") on top
 * — but that tolerance is a convenience, never the safety mechanism. The safety mechanism is
 * `RegionVerdict`: there will always be another spelling, and an unrecognised one must not kill.
 */
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
 * Regions that are KNOWN NOT to be British Columbia — the Canadian provinces and territories and
 * the US states, by code and by name.
 *
 * This list exists so the resolver can tell "this row says Virginia" from "this row says
 * something I do not recognise". Only the former is contrary evidence.
 */
const NON_BC_REGIONS: ReadonlySet<string> = new Set([
  "ab", "alberta",
  "sk", "saskatchewan",
  "mb", "manitoba",
  "on", "ontario",
  "qc", "pq", "quebec", "que",
  "nb", "new brunswick", "nouveau-brunswick",
  "ns", "nova scotia", "nouvelle-ecosse",
  "pe", "pei", "prince edward island",
  "nl", "nf", "newfoundland and labrador", "newfoundland",
  "yt", "yukon",
  "nt", "northwest territories",
  "nu", "nunavut",
  "al", "alabama", "ak", "alaska", "az", "arizona", "ar", "arkansas",
  "ca", "california", "co", "colorado", "ct", "connecticut", "de", "delaware",
  "fl", "florida", "ga", "georgia", "hi", "hawaii", "id", "idaho",
  "il", "illinois", "in", "indiana", "ia", "iowa", "ks", "kansas",
  "ky", "kentucky", "la", "louisiana", "me", "maine", "md", "maryland",
  "ma", "massachusetts", "mi", "michigan", "mn", "minnesota", "ms", "mississippi",
  "mo", "missouri", "mt", "montana", "ne", "nebraska", "nv", "nevada",
  "nh", "new hampshire", "nj", "new jersey", "nm", "new mexico", "ny", "new york",
  "nc", "north carolina", "nd", "north dakota", "oh", "ohio", "ok", "oklahoma",
  "or", "oregon", "pa", "pennsylvania", "ri", "rhode island", "sc", "south carolina",
  "sd", "south dakota", "tn", "tennessee", "tx", "texas", "ut", "utah",
  "vt", "vermont", "va", "virginia", "wa", "washington", "wv", "west virginia",
  "wi", "wisconsin", "wy", "wyoming", "dc", "district of columbia",
]);

/**
 * WHAT A RECORDED REGION TELLS US — report §2.3 expressed as a type rather than as a comment.
 *
 *   bc        the row says British Columbia
 *   contrary  the row names a province or state that is NOT British Columbia. The ONLY value
 *             that may kill, and the only one that may overrule a municipality alias.
 *   unparsed  a region string nobody recognised. TREATED EXACTLY AS ABSENT: `cannot_evaluate`,
 *             never a kill. "B.C." was simply the first spelling to surface; there will be
 *             another, so the safe answer has to be structural rather than a longer list.
 */
export type RegionVerdict = "bc" | "contrary" | "unparsed";

/**
 * The shapes a region string is tried in. Beyond `normalizeMunicipality`, this drops the
 * separators inside an abbreviation ("B.C." → "bc") and a trailing country ("British Columbia,
 * Canada" → "british columbia"), because both are ordinary in scraped addresses.
 */
function regionCandidates(region: string | null | undefined): string[] {
  const key = normalizeMunicipality(region);
  if (!key) return [];
  const out = new Set<string>([key]);
  out.add(key.replace(/[\s-]+/g, ""));
  const trailingCountry = /\s+(canada|ca|usa|us|united states|united states of america)$/;
  const trimmed = key.replace(trailingCountry, "").trim();
  if (trimmed && trimmed !== key) {
    out.add(trimmed);
    out.add(trimmed.replace(/[\s-]+/g, ""));
  }
  return [...out].filter(Boolean);
}

/** Classify a recorded region into the three states above. An absent region is `unparsed`. */
export function classifyRegion(region: string | null | undefined): RegionVerdict {
  const candidates = regionCandidates(region);
  if (candidates.length === 0) return "unparsed";
  if (candidates.some((c) => BC_REGION_SPELLINGS.has(c))) return "bc";
  if (candidates.some((c) => NON_BC_REGIONS.has(c))) return "contrary";
  return "unparsed";
}

/**
 * The postal prefixes that fall inside Metro Vancouver.
 *
 * MEMBERSHIP DATA, so it lives here beside the alias map and the BC spellings rather than in
 * config/icp.yaml. icp.yaml decides band WEIGHTS ONLY; a membership list there is the second
 * source of truth that already killed six member jurisdictions once. Keeping it here is also
 * what lets the filter and the scorer make the SAME call with the SAME inputs — the filter
 * deliberately never reads icp.yaml.
 */
export const METRO_POSTAL_PREFIXES: readonly string[] = ["V3", "V4", "V5", "V6", "V7"];

/**
 * Where a row sits, as one verdict.
 *
 *   metro_vancouver   one of the 23 member jurisdictions of config/exclusions/metro-vancouver.csv
 *   bc_outside_metro  recorded in BC, but not in a member jurisdiction
 *   outside_bc        recorded in a region KNOWN not to be BC — the only CONTRARY verdict
 *   unresolved        nothing recorded resolves; `missing_fields` says what would decide it
 */
export type GeographyScope =
  | "metro_vancouver"
  | "bc_outside_metro"
  | "outside_bc"
  | "unresolved";

export interface GeographyFacts {
  municipality?: string | null;
  region?: string | null;
  postal_code?: string | null;
}

export interface GeographyVerdict {
  scope: GeographyScope;
  /** What the recorded region said, in the three states that matter. */
  region: RegionVerdict;
  /** The member jurisdictions the municipality resolved to. Empty unless `metro_vancouver`. */
  metro_canonicals: string[];
  /**
   * True when a municipality alias or metro postal prefix DID match but the recorded region
   * overruled it. Set for a CONTRARY region (Richmond, Virginia) and for an UNPARSED one, where
   * the alias is suppressed for safety without the row being called out of area.
   */
  alias_suppressed_by_region: boolean;
  /** What would let an `unresolved` verdict decide. Empty for every other scope. */
  missing_fields: string[];
}

/**
 * THE ONE GEOGRAPHY DECISION. Both src/lib/filter.ts and src/lib/scoring.ts consume this, with
 * the SAME full input set, and neither carries its own copy — two resolvers over the same data
 * drift, and so do two callers that feed one resolver different fields.
 *
 * TWO PRECONDITIONS, in this order:
 *
 *  1. A MUNICIPALITY ALIAS MAY ONLY BE TRUSTED WHEN THE REGION IS BC OR ABSENT.
 *     metro-vancouver.csv ships BARE MUNICIPALITY NAMES, and richmond, vancouver, surrey,
 *     langley, delta and white rock all name real places outside BC — Vancouver, Washington is
 *     forty minutes from Portland. So the region is read BEFORE the alias, never after.
 *
 *  2. UNPARSEABLE IS NOT CONTRARY (§2.3). A region nobody recognised suppresses the alias, which
 *     is conservative, but it can never produce `outside_bc` — that would kill an in-scope
 *     account on a spelling, which is the invisible-forever failure this module exists to avoid.
 */
export function resolveGeography(
  facts: GeographyFacts,
  lists: Pick<QualificationLists, "metroVancouverAliases">,
): GeographyVerdict {
  const region = classifyRegion(facts.region);

  const canonicals = metroVancouverCanonicals(facts.municipality, lists);
  const prefix = (facts.postal_code ?? "").trim().slice(0, 2).toUpperCase();
  const postalMetro = prefix !== "" && METRO_POSTAL_PREFIXES.includes(prefix);
  const metroSignal = canonicals.length > 0 || postalMetro;

  if (region === "contrary") {
    return {
      scope: "outside_bc",
      region,
      metro_canonicals: [],
      alias_suppressed_by_region: metroSignal,
      missing_fields: [],
    };
  }

  if (region === "bc") {
    return metroSignal
      ? {
          scope: "metro_vancouver",
          region,
          metro_canonicals: canonicals,
          alias_suppressed_by_region: false,
          missing_fields: [],
        }
      : {
          scope: "bc_outside_metro",
          region,
          metro_canonicals: [],
          alias_suppressed_by_region: false,
          missing_fields: [],
        };
  }

  const regionRecorded = normalizeMunicipality(facts.region) !== "";
  if (metroSignal && !regionRecorded) {
    return {
      scope: "metro_vancouver",
      region,
      metro_canonicals: canonicals,
      alias_suppressed_by_region: false,
      missing_fields: [],
    };
  }

  const missing = ["region"];
  if (!normalizeMunicipality(facts.municipality)) missing.unshift("municipality");
  if (prefix === "") missing.push("postal_code");
  return {
    scope: "unresolved",
    region,
    metro_canonicals: [],
    alias_suppressed_by_region: metroSignal,
    missing_fields: missing,
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

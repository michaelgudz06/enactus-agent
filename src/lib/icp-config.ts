// Loads and validates config/icp.yaml — the ICP scoring weights.
//
// The weights live in a file, not in code, so a future VP External Relations can retune the ICP
// in September without a developer. Re-scoring the whole corpus after a change costs $0 and
// milliseconds because no model is involved. Spec: enactus-icp/report.md §6.4.
//
// Nothing in this file calls a model, and nothing in it reaches the network.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

export const SEGMENT_IDS = [
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "S10",
  "S11",
  "S12",
  "S13",
  "S14",
  "S15",
  "S16",
  "S17",
] as const;

export type SegmentId = (typeof SEGMENT_IDS)[number];

export type SegmentObjective = "cash_and_relationship" | "relationship_only" | "excluded";

export type RelationshipTier =
  | "cold"
  | "prospected"
  | "engaged_non_monetary"
  | "lapsed_partner"
  | "active_partner";

export type AlumniEvidence = "enactus_alum_led" | "sfu_alum_led" | "sfu_ecosystem" | "none";

export type ProjectValuesMatch = "human_confirmed" | "keyword_only" | "none";

export type LawfulBasisStrength =
  | "ebr_2y"
  | "express"
  | "conspicuous_pub_named_person"
  | "role_inbox"
  | "none";

export type AskClass =
  | "in_kind_prize"
  | "in_kind_product"
  | "in_kind_service"
  | "in_kind_venue"
  | "cash_bronze"
  | "cash_silver"
  | "cash_gold"
  | "cash_diamond"
  | "non_monetary_time"
  | "grant_application";

export type AskTier = "in_kind" | "bronze" | "silver" | "gold" | "diamond" | "grant" | "none";

export interface AskLadderRung {
  amount_low: number;
  amount_high: number;
  imputed_low?: number;
  imputed_high?: number;
}

export interface AskRule {
  class: AskClass;
  tier: AskTier;
  imputed_low?: number;
  imputed_high?: number;
}

export interface SegmentConfig {
  key: string;
  objective: SegmentObjective;
  headcount_ceiling: number | null;
  ideal_low: number | null;
  ideal_high: number | null;
}

/**
 * The captain's SMB definition, 2026-08-06: in-scope small-to-medium is 5–250 employees.
 *
 * It is a WEIGHTING AND ROUTING band, never a kill, and it is read only where a headcount is
 * actually recorded — see the absence rule in config/icp.yaml and `smbBandApplies` in
 * src/lib/scoring.ts.
 */
export interface SmbBandConfig {
  min_headcount: number;
  max_headcount: number;
}

/**
 * The captain's advisory ruling, 2026-08-06: a mentor or project advisor is worth THE SAME as
 * money. `equal_to_cash` is the only value the loader accepts, so a future cash preference has to
 * be a visible edit to config/icp.yaml rather than a drifting weight.
 */
export type AdvisoryParity = "equal_to_cash";

export const ADVISORY_PARITIES: readonly AdvisoryParity[] = ["equal_to_cash"];

export interface AdvisoryConfig {
  parity: AdvisoryParity;
  /** The club's own published per-event engagement menu. Code checks reported commitments here. */
  commitments: string[];
  /** The rung an advisory commitment is valued at when the lead's own ask carries no cash amount. */
  parity_tier: AskTier;
}

export interface IcpConfig {
  geography: {
    /**
     * The jurisdictions worth the `core` band — the three SFU campuses. This is a WEIGHT, not a
     * membership test: whether a place is in Metro Vancouver at all is decided by
     * config/exclusions/metro-vancouver.csv, the maintained list, via `geographyBand()`.
     */
    core: string[];
    bands: Record<GeographyBandName, number>;
  };
  fit_score: {
    segment_match: number;
    size_band: number;
    geography: number;
    industry_specificity: number;
    entity_signals: number;
  };
  affinity_score: {
    relationship_tier: number;
    alumni_evidence: number;
    project_values_match: number;
    local_proximity: number;
    giving_posture: number;
  };
  access_score: {
    named_approver: number;
    approver_collapse: number;
    deliverable_contact: number;
    lawful_basis_strength: number;
    channel_available: number;
  };
  scales: {
    relationship_tier: Record<RelationshipTier, number>;
    alumni_evidence: Record<AlumniEvidence, number>;
    project_values_match: Record<ProjectValuesMatch, number>;
    lawful_basis_strength: Record<LawfulBasisStrength, number>;
  };
  trigger_bonus: {
    max_bonus: number;
    max_age_days: Record<string, number>;
    values: Record<string, number>;
  };
  smb_band: SmbBandConfig;
  advisory: AdvisoryConfig;
  p_yes: Record<string, number>;
  ask_ladder: Record<AskTier, AskLadderRung>;
  effort_minutes: Record<SegmentId, number>;
  segments: Record<SegmentId, SegmentConfig>;
  ask_rules: Record<SegmentId, AskRule> & {
    s6_by_affinity: Record<string, AskRule>;
    s1_escalation: Record<string, AskRule>;
  };
  approver_titles: {
    default: string[];
    by_segment: Partial<Record<SegmentId, string[]>>;
  };
  affiliation_evidence: {
    tier1_domains: string[];
    tier2_domains: string[];
    min_tier1_sources: number;
    min_tier2_sources: number;
    require_literal_substring: boolean;
  };
}

export class IcpConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`config/icp.yaml is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "IcpConfigError";
    this.problems = problems;
  }
}

/** The three score blocks whose weights must each sum to exactly 100. */
export const SCORE_BLOCKS = ["fit_score", "affinity_score", "access_score"] as const;

/** Slack allowed on a weight sum, to absorb binary floating-point error on fractional weights. */
export const WEIGHT_SUM_TOLERANCE = 1e-6;

/**
 * The weight bands, in the captain's ORDERING (2026-08-06): metro_vancouver > bc_other >
 * canada_other. `core` splits the top band for the three campuses; `outside_canada` and
 * `unresolved` exist so `geography.bands[band]` is never NaN, not because either is a prospect.
 * The NUMBERS in config/icp.yaml are starting values a human retunes; the ordering is a ruling.
 */
export const GEOGRAPHY_BANDS = [
  "core",
  "metro_vancouver",
  "bc_other",
  "canada_other",
  "outside_canada",
  "unresolved",
] as const;

export type GeographyBandName = (typeof GEOGRAPHY_BANDS)[number];

function sumWeights(block: Record<string, unknown>): number {
  return Object.values(block).reduce<number>(
    (acc, v) => acc + (typeof v === "number" ? v : 0),
    0,
  );
}

/**
 * Validate a parsed config. Returns the list of problems; empty means valid.
 *
 * This exists because the file is meant to be edited by a non-programmer. A typo that makes
 * weights sum to 95 would silently deflate every score in the corpus, and nobody would notice.
 */
export function validateIcpConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return ["top level is not a mapping"];
  }
  const cfg = raw as Record<string, unknown>;

  for (const block of SCORE_BLOCKS) {
    const value = cfg[block];
    if (typeof value !== "object" || value === null) {
      problems.push(`${block} is missing`);
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        problems.push(`${block}.${k} is not a number`);
      } else if (v < 0) {
        problems.push(`${block}.${k} is negative (${v}); weights are non-negative`);
      }
    }
    // Compared with a tolerance, not for exact equality: a legitimate fractional retune such as
    // 33.3 / 33.3 / 33.4 sums to 100.00000000000001 in binary floating point, and rejecting the
    // file over that would teach the VP External Relations that the validator lies.
    const total = sumWeights(value as Record<string, unknown>);
    if (Math.abs(total - 100) > WEIGHT_SUM_TOLERANCE) {
      problems.push(
        `${block} weights sum to ${total}, not 100 ` +
          `(${entries.map(([k, v]) => `${k}=${v}`).join(", ")})`,
      );
    }
  }

  // The geography block. `scoreFit` reads `geography.bands[band]` straight into `clamp()`, so a
  // deleted or renamed band key would produce NaN through the whole fit score with no error
  // anywhere — the silent-deflation failure this validator exists to prevent, and the block is
  // load-bearing now that membership comes from the maintained CSV and this file holds weights
  // alone.
  const geography = cfg.geography as Record<string, unknown> | undefined;
  if (typeof geography !== "object" || geography === null) {
    problems.push("geography is missing");
  } else {
    for (const key of ["core"] as const) {
      const value = geography[key];
      if (!Array.isArray(value)) {
        problems.push(`geography.${key} is missing or not a list`);
      } else if (value.length === 0) {
        problems.push(`geography.${key} is empty`);
      } else if (value.some((v) => typeof v !== "string" || v.trim() === "")) {
        problems.push(`geography.${key} contains a non-string or blank entry`);
      }
    }

    const bands = geography.bands as Record<string, unknown> | undefined;
    if (typeof bands !== "object" || bands === null) {
      problems.push("geography.bands is missing");
    } else {
      for (const band of GEOGRAPHY_BANDS) {
        const v = bands[band];
        if (v === undefined) {
          problems.push(
            `geography.bands.${band} is missing; every band must be present or its score is NaN`,
          );
        } else if (typeof v !== "number" || !Number.isFinite(v)) {
          problems.push(`geography.bands.${band} is not a number`);
        } else if (v < 0) {
          problems.push(`geography.bands.${band} is negative (${v}); weights are non-negative`);
        }
      }
    }
  }

  const segments = cfg.segments as Record<string, unknown> | undefined;
  if (typeof segments !== "object" || segments === null) {
    problems.push("segments is missing");
  } else {
    for (const id of SEGMENT_IDS) {
      const seg = segments[id] as Record<string, unknown> | undefined;
      if (!seg) {
        problems.push(`segments.${id} is missing`);
        continue;
      }
      const objective = seg.objective;
      if (
        objective !== "cash_and_relationship" &&
        objective !== "relationship_only" &&
        objective !== "excluded"
      ) {
        problems.push(
          `segments.${id}.objective is "${String(objective)}"; expected ` +
            `cash_and_relationship, relationship_only or excluded`,
        );
      }
    }
  }

  // smb_band — the captain's 5–250 definition. Validated for the same reason the weight sums are:
  // the file is edited by a non-programmer, and a band with a missing or inverted bound would
  // silently reclassify every sized company in the corpus with no error anywhere.
  const smb = cfg.smb_band as Record<string, unknown> | undefined;
  if (typeof smb !== "object" || smb === null) {
    problems.push(
      "smb_band is missing; it carries the captain's 5-250 small-to-medium definition and the " +
        "scorer has no default to fall back on",
    );
  } else {
    for (const key of ["min_headcount", "max_headcount"] as const) {
      const v = smb[key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        problems.push(`smb_band.${key} is not a number`);
      } else if (!Number.isInteger(v) || v < 1) {
        problems.push(`smb_band.${key} must be a whole number of employees, 1 or more (got ${v})`);
      }
    }
    if (
      typeof smb.min_headcount === "number" &&
      typeof smb.max_headcount === "number" &&
      smb.min_headcount > smb.max_headcount
    ) {
      problems.push(
        `smb_band.min_headcount (${smb.min_headcount}) is above smb_band.max_headcount ` +
          `(${smb.max_headcount}); no headcount could ever be in band`,
      );
    }
  }

  // advisory — the captain's "worth the same as money" ruling.
  const advisory = cfg.advisory as Record<string, unknown> | undefined;
  if (typeof advisory !== "object" || advisory === null) {
    problems.push(
      "advisory is missing; it carries the captain's ruling that a mentor or project advisor is " +
        "worth the same as money, and the scorer has no default to fall back on",
    );
  } else {
    if (!ADVISORY_PARITIES.includes(advisory.parity as AdvisoryParity)) {
      problems.push(
        `advisory.parity is "${String(advisory.parity)}"; the only accepted value is ` +
          `"equal_to_cash" (CAPTAIN'S RULING 2026-08-06 — a mentor or project advisor is worth ` +
          `the same as money). Changing it is a product decision, not a retune`,
      );
    }
    const commitments = advisory.commitments;
    if (!Array.isArray(commitments)) {
      problems.push("advisory.commitments is missing or not a list");
    } else if (commitments.length === 0) {
      problems.push(
        "advisory.commitments is empty; with no menu, code would recognise no commitment and " +
          "every advisory offer would be silently discarded",
      );
    } else if (commitments.some((v) => typeof v !== "string" || v.trim() === "")) {
      problems.push("advisory.commitments contains a non-string or blank entry");
    }
    const tier = advisory.parity_tier;
    const ladderTiers = cfg.ask_ladder as Record<string, unknown> | undefined;
    if (typeof tier !== "string" || tier.trim() === "") {
      problems.push("advisory.parity_tier is missing or not a string");
    } else if (
      typeof ladderTiers === "object" &&
      ladderTiers !== null &&
      ladderTiers[tier] === undefined
    ) {
      problems.push(`advisory.parity_tier is "${tier}", which is not a rung of ask_ladder`);
    }
  }

  const effort = cfg.effort_minutes as Record<string, unknown> | undefined;
  if (typeof effort !== "object" || effort === null) {
    problems.push("effort_minutes is missing");
  } else {
    for (const id of SEGMENT_IDS) {
      const v = effort[id];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        problems.push(`effort_minutes.${id} must be a positive number (got ${String(v)})`);
      }
    }
  }

  const askRules = cfg.ask_rules as Record<string, unknown> | undefined;
  if (typeof askRules !== "object" || askRules === null) {
    problems.push("ask_rules is missing");
  } else {
    for (const id of SEGMENT_IDS) {
      if (!askRules[id]) problems.push(`ask_rules.${id} is missing`);
    }
  }

  const ladder = cfg.ask_ladder as Record<string, unknown> | undefined;
  if (typeof ladder !== "object" || ladder === null) {
    problems.push("ask_ladder is missing");
  } else {
    for (const tier of ["in_kind", "bronze", "silver", "gold", "diamond", "grant", "none"]) {
      const rung = ladder[tier] as Record<string, unknown> | undefined;
      if (!rung) {
        problems.push(`ask_ladder.${tier} is missing`);
        continue;
      }
      if (typeof rung.amount_low !== "number" || typeof rung.amount_high !== "number") {
        problems.push(`ask_ladder.${tier} needs numeric amount_low and amount_high`);
      } else if (rung.amount_high < rung.amount_low) {
        problems.push(`ask_ladder.${tier}: amount_high is below amount_low`);
      }
    }
  }

  const pYes = cfg.p_yes as Record<string, unknown> | undefined;
  if (typeof pYes !== "object" || pYes === null) {
    problems.push("p_yes is missing");
  } else {
    for (const [k, v] of Object.entries(pYes)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        problems.push(`p_yes.${k} must be a probability between 0 and 1 (got ${String(v)})`);
      }
    }
  }

  const trigger = cfg.trigger_bonus as Record<string, unknown> | undefined;
  if (typeof trigger !== "object" || trigger === null) {
    problems.push("trigger_bonus is missing");
  } else if (typeof trigger.max_bonus !== "number" || trigger.max_bonus < 0) {
    problems.push("trigger_bonus.max_bonus must be a non-negative number");
  }

  return problems;
}

/** Parse YAML text into a validated config. Pure: no filesystem, no network. */
export function parseIcpConfig(yamlText: string): IcpConfig {
  const raw = parseYaml(yamlText);
  const problems = validateIcpConfig(raw);
  if (problems.length > 0) throw new IcpConfigError(problems);
  return raw as IcpConfig;
}

export const DEFAULT_ICP_CONFIG_PATH = join(process.cwd(), "config", "icp.yaml");

let cached: IcpConfig | null = null;
let cachedPath: string | null = null;

/** Read and validate config/icp.yaml. Cached per path; pass `reload` in a test that edits it. */
export function loadIcpConfig(
  path: string = DEFAULT_ICP_CONFIG_PATH,
  opts: { reload?: boolean } = {},
): IcpConfig {
  if (!opts.reload && cached && cachedPath === path) return cached;
  cached = parseIcpConfig(readFileSync(path, "utf8"));
  cachedPath = path;
  return cached;
}

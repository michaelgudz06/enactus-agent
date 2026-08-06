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

export interface IcpConfig {
  geography: {
    core: string[];
    metro: string[];
    postal_prefixes: string[];
    bands: { core: number; metro: number; bc_outside_metro: number; elsewhere: number };
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
    const total = sumWeights(value as Record<string, unknown>);
    if (total !== 100) {
      problems.push(
        `${block} weights sum to ${total}, not 100 ` +
          `(${entries.map(([k, v]) => `${k}=${v}`).join(", ")})`,
      );
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

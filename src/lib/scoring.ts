// ICP scoring for Enactus SFU sponsorship prospecting.
//
// Spec: enactus-icp/report.md (prepared 2026-08-06). Section references below are to that
// document.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
//  1. NO MODEL. Scoring is arithmetic over reported features. A model may report what a document
//     says; it may never decide what is true, what is next, or what a lead is worth. §6.5.
//
//  2. THREE SCORES, NEVER ONE. `fit`, `affinity` and `access` are returned separately and are
//     never summed. A single number destroys the only information a volunteer with four hours a
//     week actually needs — WHAT TO DO NEXT. Three different failures produce the same low
//     blended score and require three opposite actions. §6.1. There is deliberately no `total`
//     field on ScoreResult.
//
//  3. SEPARATE OBJECTIVES, NEVER ONE. The highest-converting ask does not pay any bills: 69 logos
//     produced $3,200. A pipeline optimised purely for conversion rate reproduces exactly the
//     outcome the club already has. So every lead carries a `deployable_cash` objective AND a
//     `relationship_volume` objective, and they are never added together. §0.4, §8.
//     For Tier B segments (S15, S16) the cash objective is NOT APPLICABLE, not zero — scoring
//     them on dollars makes a successful relationship look like a failed sale. §11.
//     CAPTAIN'S RULING 2026-08-06 added a THIRD: `advisory_capacity`, because a mentor or project
//     advisor is worth THE SAME as money and the club asked for advisors as an explicit goal
//     alongside funding. It is an objective rather than a weight for the same reason the other two
//     are separate — a term inside the cash score would encode "cash first, advisory if nothing
//     better". Three now, and still never summed.
//
// The weights live in config/icp.yaml, not here. A future VP External Relations must be able to
// retune the ICP in September without a developer.

import type {
  AdvisoryParity,
  AlumniEvidence,
  AskClass,
  AskRule,
  AskTier,
  IcpConfig,
  LawfulBasisStrength,
  ProjectValuesMatch,
  RelationshipTier,
  SegmentId,
} from "./icp-config";
import type { FilterResult, RequiredChannel } from "./filter";
import {
  type GeographyVerdict,
  type QualificationLists,
  metroVancouverCanonicals,
  normalizeDomain,
  normalizeMunicipality,
  resolveGeography,
  resolveLocationGeography,
} from "./qualification-lists";

export type { SegmentId, RelationshipTier, AlumniEvidence, AskClass, AskTier, AdvisoryParity };

// ===========================================================================
// §4 — segment assignment
// ===========================================================================

export type SegmentAssignment = SegmentId | "EXCLUDED" | "EXCLUDED_INSTITUTIONAL" | "UNSEGMENTED";

/**
 * The shape a civic institution's ask takes. §4 ambiguity 1: decide on the ASK THAT FITS, not
 * the institution type. A transferable item a student could win (admission passes, tickets) is
 * S2; space, staff time or co-programming is S16. Vancouver Maritime Museum sits on the Forward
 * Vision PRIZE list, so it is S2; Vancouver Public Library hosted Unify Gather events, so it is
 * S16.
 */
export type CivicAskShape = "transferable_item" | "space_or_programming";

/** §4 ambiguity 2: franchise or head office? ALWAYS the location. Head office belongs to S8. */
export type CompanyUnit = "location" | "head_office";

export interface AffiliationSource {
  url: string;
  /** Whether the claimed literal string was found as a substring of the RETRIEVED text. */
  literal_substring_present: boolean;
}

export interface TriggerObservation {
  /** A key of trigger_bonus.values in config/icp.yaml, e.g. "student_job_posting". */
  kind: string;
  /** ISO date the trigger was observed / dated. */
  observed_at: string;
}

/**
 * The facts the §4 ladder and the §6.4 weights are computed over.
 *
 * Every field is a REPORTED FEATURE: a model may fill one in by reading a page, but code decides
 * what the combination means. Absent optional fields mean "not observed" and never assert the
 * negative.
 */
export interface CompanyFacts {
  legal_name: string;
  registrable_domain?: string | null;

  // --- §4 ladder ------------------------------------------------------------
  /** On the exclusion list the parallel disqualifier task owns (see src/lib/filter.ts). */
  is_excluded?: boolean;
  exclusion_reason?: string | null;
  /** Enactus Canada, SFU, Beedie, the Charles Chang Institute, or one of the club's ventures. */
  is_institutional_home?: boolean;
  relationship_tier: RelationshipTier;
  /** The ask class the prior relationship produced. Drives the S1 escalation ladder. */
  prior_ask_class?: AskClass | null;
  is_individual_person?: boolean;
  is_grantmaking_foundation?: boolean;
  is_credit_union?: boolean;
  is_family_office_principal?: boolean;
  has_public_philanthropic_profile?: boolean;
  is_public_or_civic?: boolean;
  civic_ask_shape?: CivicAskShape | null;
  is_national_enterprise?: boolean;
  /**
   * Employees. Read against the captain's 5–250 SMB band in config/icp.yaml.
   *
   * ABSENT MEANS UNKNOWN, NEVER SMALL AND NEVER LARGE. No free source publishes headcount for BC
   * micro-businesses and 0 of the 25 seeded rows carry one, so every reader of this field tests
   * `!= null` before the band is consulted at all. Absence may only penalise after a documented
   * attempt to resolve it; a merely-missing headcount costs nothing anywhere.
   */
  headcount?: number | null;
  /**
   * Advisory capacity this lead has been OBSERVED to offer — a mentor, a project advisor, a judge
   * — named from the club's own published per-event engagement menu (`advisory.commitments` in
   * config/icp.yaml).
   *
   * CAPTAIN'S RULING 2026-08-06: this is worth THE SAME as money, so it feeds its own objective
   * beside `deployable_cash` and is deliberately absent from fit, affinity, access and the trigger
   * bonus. It is not a bonus, not a modifier and not a tie-break.
   *
   * ABSENT MEANS NOT RESEARCHED, NEVER REFUSED. An unrecorded advisory capacity leaves the
   * advisory objective NOT APPLICABLE and costs the lead nothing anywhere else.
   *
   * The model may REPORT entries here; code checks each against the menu and reports the ones it
   * does not recognise rather than scoring them.
   */
  advisory_commitments?: string[] | null;
  alumni_evidence: AlumniEvidence;
  sells_to_club_or_student_orgs?: boolean;
  runs_campus_recruiting?: boolean;
  has_structured_brand_programme?: boolean;
  raised_institutional_capital_at?: string | null;
  project_match: ProjectValuesMatch;
  matched_project?: string | null;
  is_consumer_packaged_goods?: boolean;
  has_consumer_storefront?: boolean;
  has_trial_offer?: boolean;
  is_b2b_trade?: boolean;
  unit?: CompanyUnit;

  // --- §6.4 scoring inputs --------------------------------------------------
  municipality?: string | null;
  region?: string | null;
  postal_code?: string | null;
  /** Consulted BEFORE the region, so the ISO code "CA" is never read as California. */
  country?: string | null;
  /**
   * §5 proved this row is a location with its own decision-making authority, so geography is
   * judged on the LOCATION'S OWN ADDRESS rather than the chain's recorded country. Carried by
   * `gateInputsFromFilterResult` from the filter's franchise verdict, so the two modules cannot
   * reach opposite conclusions about a franchisee whose row carries its brand's country.
   */
  local_authority?: boolean;
  /** A named sub-vertical beat a generic category match. */
  industry_sub_vertical?: boolean;
  orgbook_status?: "ACT" | "HIS" | null;
  /** SP / GP is direct machine evidence that the motive-feeler and the approver are one person. */
  orgbook_entity_type?: string | null;
  registration_date?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  deliverable_contact?: boolean;
  lawful_basis_strength: LawfulBasisStrength;
  /** In-person walkable, or a published request form. */
  channel_available?: boolean;
  within_2km_of_campus?: boolean;
  has_giving_page?: boolean;
  triggers?: TriggerObservation[];
  /** §6.3 G_AFFILIATION_EVIDENCE. S6 only. */
  affiliation_sources?: AffiliationSource[];

  // --- §6.3 gate inputs that the disqualifier filter produces ---------------
  domain_resolves?: boolean;
  domain_parked?: boolean;
  independent_live_sources?: number;
  no_solicitation_found?: boolean;
  suppressed?: boolean;
  /** S8 / S10 / S14: published eligibility requires charity status the club does not have. */
  eligibility_requires_charity?: boolean;
  /**
   * The route the filter decided this row takes, if any.
   *
   * G_LAWFUL_BASIS asks one question: MAY THIS LEAD BE EMAILED. Only the routes in
   * `NON_CEM_CHANNELS` make that question moot; `renewal_motion` and the internal handoffs are
   * still reached by email and must still prove a basis.
   */
  required_channel?: RequiredChannel | null;
  /**
   * Whether an email may still be sent to this lead at all.
   *
   * `false` makes G_LAWFUL_BASIS NOT APPLICABLE rather than failed — the gate asks whether the
   * lead may be EMAILED, and a closed channel means there is no message to justify. Read fresh
   * on every evaluation so reopening the channel restores a real basis check.
   */
  email_channel_open?: boolean;
}

export interface SegmentResult {
  segment: SegmentAssignment;
  /** Populated whenever `segment === "S1"`: the segment that owns the ask, the tier and the copy. */
  underlying_segment: SegmentId | null;
  /** Which ladder rung fired, in plain words. */
  basis: string;
}

/**
 * The §4 precedence ladder, implemented in order, so a company lands in EXACTLY ONE segment.
 *
 * Three of the seventeen (S1, S6, S9) are really relationship DIMENSIONS rather than business
 * profiles — a cafe can be all three at once. The ladder resolves that, and §6.2's orthogonal
 * decomposition (`underlying_segment`, `affinity_signals`) preserves what the ladder discards,
 * because the copy needs both facts at once.
 *
 * ⚠️ ONE INTERNAL CONTRADICTION IN THE REPORT, resolved in favour of §4.
 * §5 S4 asserts "a funding round also matches S11; §4 precedence sends CPG to S4". §4's ladder
 * does the opposite: `raised_institutional_capital < 36 months` is tested BEFORE
 * `consumer_packaged_goods`. §4 is the normative ladder the brief points at, so a funded CPG
 * brand lands in S11 here. Flagged rather than silently reconciled.
 *
 * ⚠️ ONE CAPTAIN SUPERSESSION OF THE REPORT, 2026-08-06 (ENTERPRISE FLOOR).
 * §4's ladder reads `if headcount > 500 or is_national_enterprise: return S15`, and §5 S15's
 * firmographics say "headcount 500+". The captain ruled that in-scope small-to-medium ends at
 * 250, because above it no single person can approve unilaterally — which is verbatim the
 * reasoning this rung already encodes ("a NON-MONETARY relationship, not a donor segment"). So
 * the NUMBER now comes from `smb_band.max_headcount` in config/icp.yaml and the rung, its
 * position in the ladder and its reasoning are untouched. A ruling supersedes the report exactly
 * as the 2026-08-06 geography ruling does; the report's 500 is recorded here rather than deleted.
 *
 * The rung's position matters and was checked rather than assumed: every institutional segment
 * (S17 individual, S14 grantmaker, S10 credit union, S12 family office, S16 civic) is decided
 * ABOVE it, so a credit union with 2,000 staff is still S10 and a foundation is still S14.
 *
 * EVERY SEGMENT DECIDED BELOW THE RUNG IS NEWLY REACHED BY THE LOWER LINE — S6, S5, S7, S8, S11,
 * S9, S4, S3, S2 and S13, in ladder order. A 300-person company that was S6 (a cash ask, the cash
 * objective applicable) now lands in S15 (`non_monetary_time`, the cash objective NOT APPLICABLE),
 * and the same holds for each of the others between 251 and 500. Most were already outside their
 * own `headcount_ceiling` at that size and so already scored 0 for size_band; S8 is the only one
 * whose null ceiling meant it was not already out of ceiling, because its relevant unit is the
 * local field-marketing territory rather than national headcount. What is new for ALL of them is
 * the SEGMENT, not just the size term. That is the ruling's own logic (above the band no single
 * person can approve unilaterally, so the relationship is non-monetary) rather than an accident,
 * but it is a real behaviour change across ten segments and is stated here rather than discovered
 * later.
 */
export function assignSegment(
  c: CompanyFacts,
  config: IcpConfig,
  opts: { now?: Date } = {},
): SegmentResult {
  const now = opts.now ?? new Date();

  if (c.is_excluded) {
    return {
      segment: "EXCLUDED",
      underlying_segment: null,
      basis: `on the exclusion list${c.exclusion_reason ? `: ${c.exclusion_reason}` : ""}`,
    };
  }
  if (c.is_institutional_home) {
    return {
      segment: "EXCLUDED_INSTITUTIONAL",
      underlying_segment: null,
      basis: "the club's own venture, or Enactus Canada / SFU / Beedie / the Charles Chang Institute",
    };
  }

  // The renewal motion overrides everything — but the UNDERLYING segment still owns the ask,
  // the tier and the copy, so it is computed and kept. §4 ambiguity 3.
  if (c.relationship_tier !== "cold") {
    const underlying = ladder({ ...c, relationship_tier: "cold" }, config, now);
    return {
      segment: "S1",
      underlying_segment: typeof underlying.segment === "string" && underlying.segment.startsWith("S")
        ? (underlying.segment as SegmentId)
        : null,
      basis: `relationship_tier is "${c.relationship_tier}", so the renewal motion owns the outreach; the underlying segment (${underlying.segment}) owns the ask and the copy`,
    };
  }

  return ladder(c, config, now);
}

function ladder(c: CompanyFacts, config: IcpConfig, now: Date): SegmentResult {
  const out = (segment: SegmentId | "UNSEGMENTED", basis: string): SegmentResult => ({
    segment,
    underlying_segment: null,
    basis,
  });

  if (c.is_individual_person) return out("S17", "an individual person, not an entity");
  if (c.is_grantmaking_foundation) return out("S14", "a grant-making foundation or community fund");
  if (c.is_credit_union) return out("S10", "a credit union");
  if (c.is_family_office_principal && c.has_public_philanthropic_profile) {
    return out("S12", "a family office or investment principal with a public philanthropic profile");
  }

  // §4 ambiguity 1 — a civic institution whose ask is a transferable item is S2, not S16.
  if (c.is_public_or_civic) {
    if (c.civic_ask_shape === "transferable_item") {
      return out(
        "S2",
        "a civic institution, but the value requested is a transferable item a student could win (admission passes, tickets), so the ask that fits is S2's",
      );
    }
    return out(
      "S16",
      "public sector / library / museum / school / community centre / settlement agency / ecosystem non-profit, asked for space, staff time or co-programming",
    );
  }

  // ENTERPRISE FLOOR. The number is `smb_band.max_headcount`, never a literal here — see the
  // captain supersession noted on `assignSegment`. A MISSING headcount cannot fire this rung:
  // `is_national_enterprise` is the only other way in, and it is an observation, not an absence.
  const enterpriseFloor = config.smb_band.max_headcount;
  if ((c.headcount != null && c.headcount > enterpriseFloor) || c.is_national_enterprise) {
    return out(
      "S15",
      `headcount above ${enterpriseFloor} or a national enterprise — above the in-scope SMB band ` +
        `no single person can approve unilaterally, so this is a NON-MONETARY relationship, not a ` +
        `donor segment`,
    );
  }

  if (c.alumni_evidence === "enactus_alum_led" || c.alumni_evidence === "sfu_alum_led") {
    return out("S6", `an Enactus SFU or SFU alum in leadership (${c.alumni_evidence})`);
  }
  if (c.sells_to_club_or_student_orgs) {
    return out("S5", "sells to the club, to SFU, or to student organisations generally");
  }
  if (c.runs_campus_recruiting) return out("S7", "runs campus or student recruiting");
  if (c.has_structured_brand_programme) {
    return out(
      "S8",
      "has a structured brand-ambassador or corporate donation-request programme with a published application path",
    );
  }

  if (c.raised_institutional_capital_at) {
    const raised = new Date(c.raised_institutional_capital_at);
    if (!Number.isNaN(raised.getTime())) {
      const months = (now.getTime() - raised.getTime()) / (86_400_000 * 30.4375);
      if (months < 36) {
        return out("S11", `raised institutional capital ${Math.floor(months)} months ago (< 36)`);
      }
    }
  }

  if (c.project_match !== "none" && c.matched_project) {
    return out("S9", `industry maps to the named Enactus SFU project "${c.matched_project}"`);
  }
  if (c.is_consumer_packaged_goods && !c.has_consumer_storefront) {
    return out("S4", "a consumer packaged-goods brand with no storefront");
  }
  if (c.has_trial_offer) {
    return out("S3", "a trial-model service business (intro offer / first class free / pass)");
  }
  if (c.has_consumer_storefront) return out("S2", "a consumer-facing storefront");
  if (c.is_b2b_trade) return out("S13", "B2B / trade / industrial with no consumer storefront");

  return out(
    "UNSEGMENTED",
    "no segment predicate matched. UNSEGMENTED is a legitimate terminal state and must be VISIBLE on the card — do not contact",
  );
}

// ===========================================================================
// §6.3 — hard gates versus weighted contributors
// ===========================================================================
//
// Hard gates are boolean and blocking. A gate failure is NEVER compensated by a high score
// elsewhere. Weighted contributors move a score; they never block.

export type GateId =
  | "G_EXCLUDED"
  | "G_GEO"
  | "G_EXISTS"
  | "G_SIZE"
  | "G_NAMED_PERSON"
  | "G_DELIVERABLE"
  | "G_LAWFUL_BASIS"
  | "G_NO_SOLICIT"
  | "G_SUPPRESSED"
  | "G_AFFILIATION_EVIDENCE"
  | "G_TRIGGER_FRESH"
  | "G_ELIGIBILITY";

export type GateVerdict = "pass" | "fail" | "not_applicable" | "cannot_evaluate";

export interface GateResult {
  gate: GateId;
  verdict: GateVerdict;
  /** What a failure does. `park` and `cap_affinity` are deliberately NOT kills. */
  effect: "block" | "reassign" | "park" | "cap_affinity" | "none";
  message: string;
}

/**
 * SMB BAND ENTRY CONDITION — "does the captain's 5–250 band apply to this row at all?"
 *
 * Stated ONCE, here, and read by both G_SIZE and `scoreFit`'s size_band term, so the band cannot
 * mean one thing to the gate and another to the score. It answers the question the disqualifier
 * module asks of every rule: does this rule cover this entity? An unproven condition on an entity
 * the rule does not cover is a no-op, never a penalty.
 *
 * The band applies to a segment when BOTH hold:
 *
 *  1. The segment serves the cash objective (`cash_and_relationship`). Tier B is measured in
 *     relationships, never in dollars, and S15 is BY DEFINITION the segment above the band —
 *     bounding it by the band would penalise a row for the very fact that put it there.
 *  2. The segment declares a headcount band of its own. A `null` ceiling with `null` ideals is
 *     the config saying size is not the unit for this segment: S1 makes NO SIZE JUDGEMENT BY
 *     DESIGN — a lapsed partner has already sponsored, so size has been answered by evidence and
 *     prior sponsorship supersedes it — S8 scores the local field-marketing territory rather than
 *     national headcount, and S10 / S14 are institutions whose staff count says nothing about
 *     whether they fund students. Vancity has thousands of employees and is one of the club's
 *     best real prospects; a band applied there would delete it.
 *
 *     S1 is stated as a CHOICE, not as inheritance: nothing here reads `underlying_segment`, and
 *     a doc comment describing a mechanism that does not exist is the defect class this module
 *     has closed repeatedly. A lapsed partner with a known headcount of 3 keeps the size weight
 *     where an otherwise identical cold row does not, and that divergence is deliberate.
 *
 * NOTE WHAT THIS FUNCTION DOES NOT LOOK AT: the headcount. Applicability is a property of the
 * SEGMENT. Whether a headcount is present is the caller's separate, explicit test, so that
 * "the band does not apply here" and "we do not know the headcount" can never be confused.
 */
export function smbBandApplies(segment: SegmentAssignment, config: IcpConfig): boolean {
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;
  if (!seg) return false;
  const s = config.segments[seg];
  if (!s || s.objective !== "cash_and_relationship") return false;
  return s.headcount_ceiling != null || s.ideal_low != null || s.ideal_high != null;
}

/**
 * The bounds a row is actually judged against.
 *
 * THE SMB BAND IS THE DEFAULT ENVELOPE. A SEGMENT IS NEVER JUDGED OUT OF BAND FOR A HEADCOUNT ITS
 * OWN DECLARED BAND REACHES. A segment that declares it accepts companies smaller than the global
 * floor keeps that reach; a segment that declares no bound of its own inherits the global one.
 * Both bounds are therefore `Math.min` of the global value and the segment's own — the band only
 * ever NARROWS a segment from above and LOWERS it from below, and it can never make a segment
 * stricter than the segment declared itself to be. Stated once, here, so the next segment with its
 * own floor needs no patch and no exception list can go stale.
 *
 * The floor is `min(smb_band.min_headcount, ideal_low)` and NOT `ideal_low` alone: reading a
 * segment's `ideal_low` as a hard floor would newly zero every S7 row at 5–9 people, which scores
 * half weight today and is correctly ranked. The min form lowers a floor where the segment reaches
 * lower and never raises one.
 *
 * CAPTAIN'S RULING 2026-08-06 (S6). The clearest case the rule covers is S6 ALUMNI_LED_COMPANY,
 * which declares `ideal_low: 1`. An alum-led company's value to the club is a former Enactus SFU
 * executive who answers the phone, not its cheque size, so pricing a solo founder as if they were
 * a cash prospect contradicts the captain's own advisory ruling; and neither premise of the 5–250
 * band ("below 5 cannot carry a sponsorship budget", "above 250 nobody can approve unilaterally")
 * holds for a one-person alumni company. It is a general rule rather than an S6 carve-out because
 * an enumeration that misses a case is exactly the defect this closed.
 *
 * Returns `null` bounds where the band does not apply, which is how a caller distinguishes
 * "no size judgement for this segment" from "in band".
 */
export function effectiveSizeBounds(
  segment: SegmentAssignment,
  config: IcpConfig,
): { floor: number | null; ceiling: number | null } {
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;
  const declared = seg ? (config.segments[seg]?.headcount_ceiling ?? null) : null;
  if (!smbBandApplies(segment, config)) return { floor: null, ceiling: declared };
  const declaredLow = seg ? (config.segments[seg]?.ideal_low ?? null) : null;
  return {
    floor: Math.min(config.smb_band.min_headcount, declaredLow ?? config.smb_band.min_headcount),
    ceiling: Math.min(declared ?? config.smb_band.max_headcount, config.smb_band.max_headcount),
  };
}

const PLACEHOLDER_TITLE_RE =
  /\b(team|department|dept|group|staff|office|owner|gm|manager|director|officer|coordinator|program(me)?s?|relations|partnerships?|committee)\b/i;

/** True when the value is a real given + family name rather than a role placeholder. */
export function isRealPersonName(name: string | null | undefined): boolean {
  if (!name) return false;
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return !PLACEHOLDER_TITLE_RE.test(name);
}

/**
 * §6.3 G_AFFILIATION_EVIDENCE. S6 only.
 *
 * One tier-1 source, OR two independent tier-2/3 sources ON DIFFERENT DOMAINS, AND the literal
 * string present in retrieved text. Semantic search cannot enforce an institutional affiliation:
 * a "Simon Fraser" people query returned Sim / Simon / Simran / Harsimrat — the flagship alumni
 * query's top six results were all token collisions.
 *
 * Failing this gate CAPS AFFINITY at the no-alumni level and keeps the claim out of copy. It
 * does not kill the lead.
 */
export function affiliationEvidenceClears(
  sources: AffiliationSource[] | undefined,
  config: IcpConfig,
): boolean {
  const cfg = config.affiliation_evidence;
  const usable = (sources ?? []).filter(
    (s) => !cfg.require_literal_substring || s.literal_substring_present,
  );
  if (usable.length === 0) return false;

  const tier1 = usable.filter((s) =>
    cfg.tier1_domains.some((d) => domainMatches(s.url, d)),
  );
  if (tier1.length >= cfg.min_tier1_sources) return true;

  const otherDomains = new Set(
    usable
      .filter((s) => !cfg.tier1_domains.some((d) => domainMatches(s.url, d)))
      .map((s) => normalizeDomain(s.url)),
  );
  return otherDomains.size >= cfg.min_tier2_sources;
}

function domainMatches(url: string, domain: string): boolean {
  const d = normalizeDomain(url);
  return d === domain || d.endsWith(`.${domain}`);
}

/**
 * The routes that carry NO commercial electronic message from Enactus SFU, and therefore make
 * G_LAWFUL_BASIS NOT APPLICABLE rather than failed.
 *
 * ENUMERATED, never inferred from "a channel is set". `renewal_motion` IS an email motion —
 * K-REL-03 routes a current sponsor away from a COLD acquisition email precisely so they get the
 * renewal one — and `enactus_canada`, `sfu_advancement` and `grants_pipeline` are handoffs whose
 * own sends still need a basis. Suppressing the CASL gate for any of them would be a compliance
 * hole, so a future addition to `RequiredChannel` has to be added here deliberately.
 */
const NON_CEM_CHANNELS: ReadonlySet<RequiredChannel> = new Set<RequiredChannel>([
  // An in-person ask at a counter is not a CEM at all.
  "in_person",
  // §3.2 K-CHAN-01's own reasoning: a form submission is not a CEM sent by Enactus SFU.
  "web_form",
  // A phone call is not an electronic message.
  "phone",
]);

/**
 * §6.3's twelve gates.
 *
 * THE ASYMMETRY RULE APPLIES TO GATES TOO, and this set has been walked once end to end rather
 * than patched a gate at a time. For each: what inputs does it need, and what does it return when
 * they are absent? ABSENT INPUTS RETURN `cannot_evaluate` WITH EFFECT `none`. ONLY CONTRARY
 * EVIDENCE RETURNS `fail`. The audit, so the next reader does not have to redo it:
 *
 *   G_GEO         reads `resolveGeography`, the SAME verdict the filter's K-GEO rules read, so
 *                 the two modules cannot place a company in different provinces. A RECOGNISED
 *                 country that is not Canada is the one contrary reading and the one that
 *                 fails; everywhere in Canada passes at a lower band per the 2026-08-06
 *                 supersession, and anything the module could not place is `cannot_evaluate`.
 *   G_EXISTS      contrary DNS fails; uncorroborated-but-unrecorded is `cannot_evaluate`.
 *   G_SIZE        no headcount is `cannot_evaluate`; §6 records that as a specification bug. The
 *                 captain's 5–250 SMB band changed the BOUNDS, never this behaviour: the gate
 *                 decides whether the band applies to the SEGMENT before it reads the headcount at
 *                 all, so a missing headcount still returns `cannot_evaluate` with effect `none`
 *                 and a below-floor row is a `reassign`, exactly as an above-ceiling one is.
 *   G_DELIVERABLE unchecked is `cannot_evaluate`.
 *   G_NO_SOLICIT  unscanned is `cannot_evaluate`.
 *   G_ELIGIBILITY unread eligibility page is `cannot_evaluate`.
 *   G_NAMED_PERSON no name is `cannot_evaluate`, and the gate is non-blocking regardless.
 *   G_TRIGGER_FRESH fires on OBSERVED stale triggers, and parks rather than blocks.
 *
 * Three gates deliberately do NOT return `cannot_evaluate` on an absent input, each for a stated
 * reason rather than by omission:
 *
 *   G_EXCLUDED / G_SUPPRESSED  are membership tests against complete in-memory lists. Absent
 *                 means "the filter recorded no hit", which is a determination and not a gap, and
 *                 the direction of failure is permissive: an unset field lets the row through
 *                 rather than blocking it.
 *   G_LAWFUL_BASIS  reads a REQUIRED field whose `"none"` is an explicit recorded value meaning
 *                 "no basis exists", not a missing one. Under CASL the burden of proving consent
 *                 is on the sender, so `"none"` is contrary evidence — but it only BLOCKS on a
 *                 route that actually carries a CEM. A closed email channel or a non-CEM route
 *                 is `not_applicable`, derived fresh on every evaluation. See the send-path
 *                 warning in AGENTS.md: `blocked` alone is not a pre-send check.
 *   G_AFFILIATION_EVIDENCE  asks whether a claim the row is ALREADY MAKING is substantiated. No
 *                 sources IS the observation, and the effect is `cap_affinity`, never a block —
 *                 treating it as `cannot_evaluate` would award full affinity weight to an
 *                 unevidenced alumni claim and let it into copy.
 */
export function evaluateGates(
  c: CompanyFacts,
  segment: SegmentAssignment,
  config: IcpConfig,
  opts: { lists: QualificationLists; now?: Date },
): GateResult[] {
  const now = opts.now ?? new Date();
  const out: GateResult[] = [];
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;

  out.push({
    gate: "G_EXCLUDED",
    verdict: c.is_excluded || c.is_institutional_home ? "fail" : "pass",
    effect: "block",
    message:
      c.is_excluded || c.is_institutional_home
        ? `EXCLUDED (terminal): ${c.exclusion_reason ?? "on the exclusion list or the club's institutional home"}`
        : "not on the exclusion list, not the club's own venture, not Enactus Canada / SFU / Beedie / Chang Institute",
  });

  // G_GEO — soft for S6 ONLY. An alum anywhere is worth more than a stranger next door.
  // The SAME verdict the filter's K-GEO rules read. `outside_canada` is the only failing band,
  // and a bare municipality alias is trusted only on positive evidence of Canada, so
  // "Vancouver, WA" resolves unresolved here rather than scoring as a local prospect.
  const geo = geographyScope(c, opts.lists);
  const geoBand = geographyBand(c, config, opts.lists);
  if (seg === "S6") {
    out.push({
      gate: "G_GEO",
      verdict: "not_applicable",
      effect: "none",
      message: "G_GEO is soft for S6: an alum elsewhere still qualifies. Geography is a weight here, not a gate",
    });
  } else if (geo.band === "unresolved") {
    out.push({
      gate: "G_GEO",
      verdict: "cannot_evaluate",
      effect: "none",
      message:
        `nothing recorded places this account, so its geography band cannot be resolved. ` +
        `Missing: ${geo.missing_fields.join(", ")}. Absence of evidence is never a kill`,
    });
  } else if (geo.band === "outside_canada") {
    out.push({
      gate: "G_GEO",
      verdict: "fail",
      effect: "block",
      message: `killed: outside_canada — the recorded country ${c.country} is outside Canada, the one geographic terminal`,
    });
  } else {
    // Everywhere in Canada is IN SCOPE per the 2026-08-06 supersession. Where in Canada is a
    // weight, carried by the band, never a gate failure.
    out.push({
      gate: "G_GEO",
      verdict: "pass",
      effect: "block",
      message: `in the ${geoBand} band`,
    });
  }

  // G_EXISTS. Contrary evidence kills; ABSENT evidence never does. A domain that demonstrably
  // resolves and is not parked but whose corroboration has simply not been imported yet is
  // `cannot_evaluate`, exactly like G_SIZE with no headcount — never `killed: dead_domain`.
  const corroborated = c.orgbook_status === "ACT" || (c.independent_live_sources ?? 0) >= 2;
  const corroborationRecorded = c.orgbook_status != null || c.independent_live_sources != null;
  const dnsContrary = c.domain_resolves === false || c.domain_parked === true;
  if (dnsContrary) {
    out.push({
      gate: "G_EXISTS",
      verdict: "fail",
      effect: "block",
      message:
        c.domain_parked === true
          ? "killed: dead_domain — the domain is on a parking nameserver"
          : "killed: dead_domain — the domain does not resolve",
    });
  } else if (corroborated) {
    out.push({
      gate: "G_EXISTS",
      verdict: "pass",
      effect: "block",
      message: "domain resolves or is unrecorded, is not parked, and existence is corroborated",
    });
  } else if (corroborationRecorded) {
    out.push({
      gate: "G_EXISTS",
      verdict: "fail",
      effect: "block",
      message:
        "killed: dead_domain — existence is not corroborated by OrgBook ACT or two independent live sources",
    });
  } else {
    out.push({
      gate: "G_EXISTS",
      verdict: "cannot_evaluate",
      effect: "none",
      message:
        c.domain_resolves === true
          ? "the domain resolves and is not parked, but no OrgBook status and no independent-source count are recorded, so existence cannot be corroborated. Absence of evidence is never a kill"
          : "no DNS result, OrgBook status or independent-source count is recorded",
    });
  }

  // G_SIZE. The bounds are the segment's own, BOUNDED by the captain's 5–250 SMB band — and the
  // floor is the band's alone. The verdict order below is deliberate: applicability is decided
  // BEFORE the headcount is read, so an absent headcount can never be mistaken for an out-of-band
  // one. `reassign` is unchanged and still not `block`: this gate has never dropped a row.
  const { floor, ceiling } = effectiveSizeBounds(segment, config);
  const bandNote = smbBandApplies(segment, config)
    ? ` (the segment's own ceiling bounded by the captain's ${config.smb_band.min_headcount}-${config.smb_band.max_headcount} SMB band)`
    : "";
  if (ceiling == null && floor == null) {
    out.push({
      gate: "G_SIZE",
      verdict: "not_applicable",
      effect: "none",
      message: seg
        ? `segment ${seg} has no headcount ceiling, so the SMB band makes no size judgement here either`
        : "no segment assigned",
    });
  } else if (c.headcount == null) {
    out.push({
      gate: "G_SIZE",
      verdict: "cannot_evaluate",
      effect: "none",
      message:
        `no headcount is available, and no free source publishes headcount for BC micro-businesses. ` +
        `The ${ceiling}-person ceiling for ${seg}${bandNote} cannot be tested; absence of evidence ` +
        `is never a kill and never a penalty`,
    });
  } else if (floor != null && c.headcount < floor) {
    out.push({
      gate: "G_SIZE",
      verdict: "fail",
      effect: "reassign",
      message:
        `out_of_band: too_small — headcount ${c.headcount} is below the ${floor}-person floor ` +
        `${seg} is judged against (the in-scope SMB band, lowered wherever the segment declares it ` +
        `reaches lower), which is too small to carry a sponsorship budget (CAPTAIN'S RULING ` +
        `2026-08-06). Reassign rather than drop`,
    });
  } else if (ceiling != null && c.headcount > ceiling) {
    out.push({
      gate: "G_SIZE",
      verdict: "fail",
      effect: "reassign",
      message: `killed: too_big — headcount ${c.headcount} exceeds the ${ceiling}-person ceiling for ${seg}${bandNote}. Reassign rather than drop`,
    });
  } else {
    out.push({
      gate: "G_SIZE",
      verdict: "pass",
      effect: "reassign",
      message: `headcount ${c.headcount} is within the ${ceiling}-person ceiling for ${seg}${bandNote}`,
    });
  }

  // G_NAMED_PERSON
  out.push({
    gate: "G_NAMED_PERSON",
    verdict: c.contact_name ? (isRealPersonName(c.contact_name) ? "pass" : "fail") : "cannot_evaluate",
    effect: "none",
    message: c.contact_name
      ? isRealPersonName(c.contact_name)
        ? `"${c.contact_name}" is a real given + family name`
        : `"${c.contact_name}" is a role placeholder, not a person. Back to PERSON_FOUND, next tactic — the ACCOUNT is untouched`
      : "no contact name is recorded yet",
  });

  // G_DELIVERABLE
  out.push({
    gate: "G_DELIVERABLE",
    verdict:
      c.deliverable_contact === undefined ? "cannot_evaluate" : c.deliverable_contact ? "pass" : "fail",
    effect: c.deliverable_contact === undefined ? "none" : "block",
    message:
      c.deliverable_contact === undefined
        ? "deliverability has not been checked"
        : c.deliverable_contact
          ? "the address passed DNS, syntax, role classification and SMTP"
          : "killed: undeliverable",
  });

  // G_LAWFUL_BASIS — the email gate, and ONLY the email gate.
  //
  // Its question is "MAY THIS LEAD BE EMAILED", so it may never BLOCK a lead for being
  // unreachable by email: that is a routing fact, not a disqualification, and blocking on it is
  // how a corpus of role accounts empties the board. The verdict is DERIVED FROM THE CURRENT
  // CHANNEL STATE on every evaluation and never stamped once — so the moment the email channel
  // opens again (a human finds a named contact, a route changes) the basis question is asked
  // for real, and a lead that reaches an outbox has passed this gate on the path it took.
  if (c.email_channel_open === false) {
    out.push({
      gate: "G_LAWFUL_BASIS",
      verdict: "not_applicable",
      effect: "none",
      message:
        "the email channel is closed for this lead, so there is no commercial electronic " +
        "message to justify. This is re-evaluated whenever the channel state changes: reopen " +
        "the channel and the CASL basis must be proved before anything can be sent",
    });
  } else if (c.required_channel && NON_CEM_CHANNELS.has(c.required_channel)) {
    out.push({
      gate: "G_LAWFUL_BASIS",
      verdict: "not_applicable",
      effect: "none",
      message: `this lead is routed to ${c.required_channel}, which carries no commercial electronic message from Enactus SFU, so no CASL sending basis is required`,
    });
  } else {
    out.push({
      gate: "G_LAWFUL_BASIS",
      verdict: c.lawful_basis_strength === "none" ? "fail" : "pass",
      effect: "block",
      message:
        c.lawful_basis_strength === "none"
          ? "no CASL basis is recorded, so this lead cannot enter CONTACTABLE"
          : `CASL basis: ${c.lawful_basis_strength}`,
    });
  }

  // G_NO_SOLICIT
  out.push({
    gate: "G_NO_SOLICIT",
    verdict:
      c.no_solicitation_found === undefined ? "cannot_evaluate" : c.no_solicitation_found ? "fail" : "pass",
    effect: c.no_solicitation_found === undefined ? "none" : "block",
    message:
      c.no_solicitation_found === undefined
        ? "no source page has been scanned for a no-solicitation notice"
        : c.no_solicitation_found
          ? "SUPPRESSED (terminal) — the source page carries a no-solicitation notice"
          : "no no-solicitation notice on the source page",
  });

  // G_SUPPRESSED
  out.push({
    gate: "G_SUPPRESSED",
    verdict: c.suppressed ? "fail" : "pass",
    effect: "block",
    message: c.suppressed
      ? "blocked — on the suppression list. Checked before EVERY send, forever"
      : "not on the suppression list",
  });

  // G_AFFILIATION_EVIDENCE — S6 only, and it caps affinity rather than killing.
  if (seg === "S6") {
    const clears = affiliationEvidenceClears(c.affiliation_sources, config);
    out.push({
      gate: "G_AFFILIATION_EVIDENCE",
      verdict: clears ? "pass" : "fail",
      effect: "cap_affinity",
      message: clears
        ? "affiliation evidence clears the bar: one tier-1 source, or two independent tier-2/3 sources on different domains, with the literal string present in retrieved text"
        : "affiliation evidence does NOT clear the bar. Affinity is capped at the no-alumni level and the claim must never appear in copy",
    });
  } else {
    out.push({
      gate: "G_AFFILIATION_EVIDENCE",
      verdict: "not_applicable",
      effect: "none",
      message: "S6 only",
    });
  }

  // G_TRIGGER_FRESH — PARK, DO NOT KILL. Recency is a gate on the BONUS.
  const stale = staleTriggers(c.triggers ?? [], config, now);
  out.push({
    gate: "G_TRIGGER_FRESH",
    verdict: stale.length > 0 ? "fail" : "pass",
    effect: "park",
    message:
      stale.length > 0
        ? `stale triggers ignored (park, do not kill): ${stale.map((t) => `${t.kind} observed ${t.observed_at}`).join("; ")}`
        : "all observed triggers are inside their max age",
  });

  // G_ELIGIBILITY — S8, S10, S14 only, and the check is free.
  if (seg === "S8" || seg === "S10" || seg === "S14") {
    out.push({
      gate: "G_ELIGIBILITY",
      verdict:
        c.eligibility_requires_charity === undefined
          ? "cannot_evaluate"
          : c.eligibility_requires_charity
            ? "fail"
            : "pass",
      effect: c.eligibility_requires_charity === undefined ? "none" : "block",
      message:
        c.eligibility_requires_charity === undefined
          ? "the published eligibility page has not been read. This check is free and prevents a guaranteed rejection"
          : c.eligibility_requires_charity
            ? "killed: ineligible — published eligibility requires registered-charity status, which Enactus SFU does not have and cannot obtain"
            : "published eligibility does not require charity status",
    });
  } else {
    out.push({
      gate: "G_ELIGIBILITY",
      verdict: "not_applicable",
      effect: "none",
      message: "S8, S10 and S14 only",
    });
  }

  return out;
}

function staleTriggers(
  triggers: TriggerObservation[],
  config: IcpConfig,
  now: Date,
): TriggerObservation[] {
  return triggers.filter((t) => !isTriggerFresh(t, config, now));
}

export function isTriggerFresh(t: TriggerObservation, config: IcpConfig, now: Date): boolean {
  const maxAge = config.trigger_bonus.max_age_days[triggerAgeKey(t.kind)];
  if (maxAge == null) return true;
  const observed = new Date(t.observed_at);
  if (Number.isNaN(observed.getTime())) return false;
  const days = (now.getTime() - observed.getTime()) / 86_400_000;
  return days >= 0 && days <= maxAge;
}

/** trigger_bonus.values and trigger_bonus.max_age_days use slightly different key names. */
function triggerAgeKey(kind: string): string {
  switch (kind) {
    case "grant_window_open":
      return "grant_window";
    case "student_job_posting":
      return "job_posting";
    case "donation_page_found":
      return "new_location"; // a published giving page is durable; use the 365-day window
    default:
      return kind;
  }
}

// ===========================================================================
// §6.4 — the three scores
// ===========================================================================

/**
 * The WEIGHT bands. `core` is a split INSIDE `metro_vancouver` — the three places events actually
 * happen (SFU Burnaby, SFU Harbour Centre, SFU Surrey) — and config/icp.yaml owns which names
 * count as core. Everything below it comes straight from the shared geography verdict.
 */
export type GeographyBand =
  | "core"
  | "metro_vancouver"
  | "bc_other"
  | "canada_other"
  | "outside_canada"
  | "unresolved";

/**
 * ONE SOURCE OF TRUTH PER CONCERN.
 *
 * `config/exclusions/metro-vancouver.csv` decides MEMBERSHIP — whether a place is in scope at
 * all. It is the maintained list §7.8 of the disqualifier report specified and verified, it
 * carries all 23 member jurisdictions and their aliases, and it is the file a human edits.
 *
 * `config/icp.yaml` decides WEIGHT — how much a band contributes to fit_score, and which
 * jurisdictions count as `core` (the three SFU campuses). It never decides whether a place
 * qualifies.
 *
 * MEMBERSHIP IS NOT DECIDED HERE EITHER. `resolveGeography` in qualification-lists.ts answers it
 * for both this module and the filter, so a place cannot be in scope for one and out for the
 * other. This function only maps that one verdict onto a WEIGHT band.
 */
export function geographyScope(c: CompanyFacts, lists: QualificationLists): GeographyVerdict {
  const facts = {
    municipality: c.municipality,
    region: c.region,
    country: c.country,
    postal_code: c.postal_code,
  };
  return c.local_authority ? resolveLocationGeography(facts, lists) : resolveGeography(facts, lists);
}

export function geographyBand(
  c: CompanyFacts,
  config: IcpConfig,
  lists: QualificationLists,
): GeographyBand {
  const geo = geographyScope(c, lists);

  if (geo.band === "metro_vancouver") {
    const muni = normalizeMunicipality(c.municipality);
    const coreNames = config.geography.core.map((m) => normalizeMunicipality(m));
    if (coreNames.includes(muni)) return "core";
    // A core name resolved through the same alias map, so "Kitsilano" lands on core rather
    // than on plain metro_vancouver.
    const coreCanonicals = new Set(
      config.geography.core.flatMap((m) => metroVancouverCanonicals(m, lists)),
    );
    if (geo.metro_canonicals.some((canonical) => coreCanonicals.has(canonical))) return "core";
    return "metro_vancouver";
  }

  return geo.band;
}

export interface ScoreTerm {
  term: string;
  points: number;
  max: number;
  /** Why this term scored what it scored. Any card can answer "why is this a 74?". */
  basis: string;
}

export interface ScoreBlock {
  score: number;
  terms: ScoreTerm[];
}

function clamp(points: number, max: number): number {
  return Math.max(0, Math.min(points, max));
}

function block(terms: ScoreTerm[]): ScoreBlock {
  return { score: Math.round(terms.reduce((acc, t) => acc + t.points, 0)), terms };
}

export function scoreFit(
  c: CompanyFacts,
  segment: SegmentAssignment,
  config: IcpConfig,
  opts: { lists: QualificationLists; now?: Date; missing?: string[] },
): ScoreBlock {
  const now = opts.now ?? new Date();
  const w = config.fit_score;
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;
  const terms: ScoreTerm[] = [];

  terms.push({
    term: "segment_match",
    points: seg ? w.segment_match : 0,
    max: w.segment_match,
    basis: seg ? `matched ${seg} cleanly` : `no segment predicate matched (${segment})`,
  });

  // size_band: full weight INSIDE the ideal band, half inside the ceiling but outside it.
  //
  // The captain's 5–250 SMB band is the OUTER ENVELOPE of both: a headcount outside it is outside
  // the club's in-scope small-to-medium definition altogether, so it earns neither the full nor
  // the half weight, whichever segment band it happens to sit in. Below the floor is treated
  // exactly as above the ceiling — "too small to carry a sponsorship budget" is a fit statement,
  // and it is a PENALTY on a known value, never a kill and never reachable from a missing one.
  const cfgSeg = seg ? config.segments[seg] : null;
  if (c.headcount != null && cfgSeg) {
    const bounds = effectiveSizeBounds(segment, config);
    const belowFloor = bounds.floor != null && c.headcount < bounds.floor;
    const aboveBandCeiling = bounds.ceiling != null && c.headcount > bounds.ceiling;
    const inSmbBand = !belowFloor && !aboveBandCeiling;
    const inIdeal =
      inSmbBand &&
      (cfgSeg.ideal_low == null || c.headcount >= cfgSeg.ideal_low) &&
      (cfgSeg.ideal_high == null || c.headcount <= cfgSeg.ideal_high);
    const inCeiling =
      inSmbBand && (cfgSeg.headcount_ceiling == null || c.headcount <= cfgSeg.headcount_ceiling);
    terms.push({
      term: "size_band",
      points: inIdeal ? w.size_band : inCeiling ? w.size_band / 2 : 0,
      max: w.size_band,
      basis: belowFloor
        ? `headcount ${c.headcount} is below the ${bounds.floor}-person floor ${seg} is judged against — too small to carry a sponsorship budget`
        : aboveBandCeiling
          ? `headcount ${c.headcount} is above the ${bounds.ceiling}-person ceiling ${seg} is judged against`
          : inIdeal
            ? `headcount ${c.headcount} is inside ${seg}'s ideal band`
            : inCeiling
              ? `headcount ${c.headcount} is under ${seg}'s ceiling but outside its ideal band`
              : `headcount ${c.headcount} is above ${seg}'s ceiling`,
    });
  } else if (c.orgbook_entity_type === "SP" || c.orgbook_entity_type === "GP") {
    // §6.6: entity_type SP/GP is direct machine evidence of an owner-operated micro-business,
    // which is the only headcount proxy the club can actually obtain for free.
    //
    // ⚠ A KNOWN TENSION WITH THE CAPTAIN'S 5-PERSON FLOOR, LEFT STANDING DELIBERATELY. A sole
    // proprietorship is by definition at or below that floor, yet this branch awards the FULL
    // size weight. It stands because of what it is: a positive signal read ONLY when the headcount
    // is absent, and the absence rule forbids turning a missing value into a penalty. Deleting it
    // would not enforce the floor — it would penalise every micro-business the club could not
    // measure, which is the exact failure the ruling's absence clause exists to prevent. A row
    // that actually RECORDS 3 employees is penalised above; a row that records nothing is not.
    terms.push({
      term: "size_band",
      points: w.size_band,
      max: w.size_band,
      basis: `no headcount available, but OrgBook entity_type ${c.orgbook_entity_type} is direct evidence of an owner-operated micro-business`,
    });
  } else {
    opts.missing?.push("headcount");
    terms.push({
      term: "size_band",
      points: 0,
      max: w.size_band,
      basis:
        "NO HEADCOUNT AVAILABLE. This score is depressed by missing data, not by a bad fit — no free source publishes headcount for BC micro-businesses",
    });
  }

  const band = geographyBand(c, config, opts.lists);
  terms.push({
    term: "geography",
    points: clamp(config.geography.bands[band], w.geography),
    max: w.geography,
    basis: `${c.municipality ?? c.region ?? c.postal_code ?? "unknown location"} → ${band}`,
  });

  terms.push({
    term: "industry_specificity",
    points: c.industry_sub_vertical ? w.industry_specificity : 0,
    max: w.industry_specificity,
    basis: c.industry_sub_vertical
      ? "matched a named sub-vertical, not a generic category"
      : "only a generic category match",
  });

  const entitySignals: string[] = [];
  if (c.orgbook_status === "ACT") entitySignals.push("OrgBook ACT");
  if (c.orgbook_entity_type === "SP" || c.orgbook_entity_type === "GP") {
    entitySignals.push(`entity_type ${c.orgbook_entity_type}`);
  }
  if (c.registration_date) {
    const reg = new Date(c.registration_date);
    if (!Number.isNaN(reg.getTime())) {
      const years = (now.getTime() - reg.getTime()) / (86_400_000 * 365.25);
      if (years > 2) entitySignals.push(`trading ${Math.floor(years)} years`);
    }
  }
  terms.push({
    term: "entity_signals",
    points: (w.entity_signals * entitySignals.length) / 3,
    max: w.entity_signals,
    basis: entitySignals.length > 0 ? entitySignals.join(", ") : "no OrgBook record loaded",
  });

  return block(terms);
}

export function scoreAffinity(
  c: CompanyFacts,
  segment: SegmentAssignment,
  config: IcpConfig,
  opts: { affiliation_capped?: boolean } = {},
): ScoreBlock {
  const w = config.affinity_score;
  const s = config.scales;
  const terms: ScoreTerm[] = [];

  terms.push({
    term: "relationship_tier",
    points: clamp(s.relationship_tier[c.relationship_tier] ?? 0, w.relationship_tier),
    max: w.relationship_tier,
    basis: `relationship_tier = ${c.relationship_tier}`,
  });

  const capped = opts.affiliation_capped === true;
  const evidence: AlumniEvidence = capped ? "none" : c.alumni_evidence;
  terms.push({
    term: "alumni_evidence",
    points: clamp(s.alumni_evidence[evidence] ?? 0, w.alumni_evidence),
    max: w.alumni_evidence,
    basis: capped
      ? `alumni_evidence claimed "${c.alumni_evidence}" but G_AFFILIATION_EVIDENCE did not clear, so it is capped at the no-alumni level and must not appear in copy`
      : `alumni_evidence = ${c.alumni_evidence}`,
  });

  terms.push({
    term: "project_values_match",
    points: clamp(s.project_values_match[c.project_match] ?? 0, w.project_values_match),
    max: w.project_values_match,
    basis:
      c.project_match === "human_confirmed"
        ? `a human confirmed the match to ${c.matched_project ?? "a project"}`
        : c.project_match === "keyword_only"
          ? "keyword-only match — a keyword tie between \"sustainability\" and \"bioplastics\" is not a reason for a specific company to care"
          : "no project match",
  });

  terms.push({
    term: "local_proximity",
    points: c.within_2km_of_campus ? w.local_proximity : 0,
    max: w.local_proximity,
    basis: c.within_2km_of_campus ? "within 2 km of a campus or a booked venue" : "not nearby, or not geocoded",
  });

  terms.push({
    term: "giving_posture",
    points: c.has_giving_page ? w.giving_posture : 0,
    max: w.giving_posture,
    basis: c.has_giving_page
      ? "publishes a donation-request / community / sponsorship page — the highest-precision cheap signal in the spec: they have PRE-DECIDED to say yes and published how to ask"
      : "no published giving page found",
  });

  return block(terms);
}

export function scoreAccess(c: CompanyFacts, segment: SegmentAssignment, config: IcpConfig): ScoreBlock {
  const w = config.access_score;
  const s = config.scales;
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;
  const terms: ScoreTerm[] = [];

  const allowlist = (seg && config.approver_titles.by_segment[seg]) || config.approver_titles.default;
  const title = (c.contact_title ?? "").toLowerCase();
  const namedApprover = isRealPersonName(c.contact_name) && allowlist.some((t) => title.includes(t));
  terms.push({
    term: "named_approver",
    points: namedApprover ? w.named_approver : 0,
    max: w.named_approver,
    basis: namedApprover
      ? `${c.contact_name}, ${c.contact_title} — on the ${seg ?? "default"} seniority allowlist`
      : c.contact_name
        ? `"${c.contact_title ?? "no title"}" is not on the ${seg ?? "default"} seniority allowlist, or the name is a role placeholder`
        : "no named person yet",
  });

  // approver_collapse: the motive-feeler and the approver are the same person. OrgBook entity
  // types SP and GP are direct machine evidence of it.
  const collapse =
    c.orgbook_entity_type === "SP" ||
    c.orgbook_entity_type === "GP" ||
    (seg != null && ["S2", "S3", "S5", "S12", "S13", "S16"].includes(seg) && isRealPersonName(c.contact_name));
  terms.push({
    term: "approver_collapse",
    points: collapse ? w.approver_collapse : 0,
    max: w.approver_collapse,
    basis: collapse
      ? `the motive-feeler and the approver are the same person${c.orgbook_entity_type ? ` (OrgBook entity_type ${c.orgbook_entity_type})` : ""} — no procurement, no marketing committee, no legal review`
      : "the roles diverge, or the collapse is unproven",
  });

  terms.push({
    term: "deliverable_contact",
    points: c.deliverable_contact ? w.deliverable_contact : 0,
    max: w.deliverable_contact,
    basis: c.deliverable_contact ? "passed all deliverability gates" : "deliverability unproven or failed",
  });

  terms.push({
    term: "lawful_basis_strength",
    points: clamp(s.lawful_basis_strength[c.lawful_basis_strength] ?? 0, w.lawful_basis_strength),
    max: w.lawful_basis_strength,
    basis: `lawful basis: ${c.lawful_basis_strength}`,
  });

  terms.push({
    term: "channel_available",
    points: c.channel_available ? w.channel_available : 0,
    max: w.channel_available,
    basis: c.channel_available
      ? "in-person walkable, or a published request form"
      : "no cheap channel identified",
  });

  return block(terms);
}

// ===========================================================================
// §6.4 — trigger bonus. Additive, applied AFTER the three scores, and capped.
// ===========================================================================

export interface TriggerBonusResult {
  bonus: number;
  applied: { kind: string; value: number; observed_at: string }[];
  /** Stale triggers are PARKED, never a kill. */
  parked: { kind: string; observed_at: string; max_age_days: number }[];
}

export function triggerBonus(
  c: CompanyFacts,
  config: IcpConfig,
  opts: { now?: Date } = {},
): TriggerBonusResult {
  const now = opts.now ?? new Date();
  const applied: TriggerBonusResult["applied"] = [];
  const parked: TriggerBonusResult["parked"] = [];

  for (const t of c.triggers ?? []) {
    const value = config.trigger_bonus.values[t.kind];
    if (value == null) continue;
    if (isTriggerFresh(t, config, now)) {
      applied.push({ kind: t.kind, value, observed_at: t.observed_at });
    } else {
      parked.push({
        kind: t.kind,
        observed_at: t.observed_at,
        max_age_days: config.trigger_bonus.max_age_days[triggerAgeKey(t.kind)] ?? 0,
      });
    }
  }

  const raw = applied.reduce((acc, t) => acc + t.value, 0);
  return { bonus: Math.min(raw, config.trigger_bonus.max_bonus), applied, parked };
}

// ===========================================================================
// The derived ask. §11 point 1: `ask` is DERIVED, never scored, never invented by a student.
// ===========================================================================

export interface DerivedAsk {
  class: AskClass;
  tier: AskTier;
  amount_low: number;
  amount_high: number;
  /** In-kind asks carry an IMPUTED value, never a cash amount. */
  imputed_low: number;
  imputed_high: number;
  basis: string;
}

export function deriveAsk(
  c: CompanyFacts,
  segment: SegmentAssignment,
  underlying: SegmentId | null,
  config: IcpConfig,
): DerivedAsk | null {
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;
  if (!seg) return null;

  let rule: AskRule;
  let basis: string;

  if (seg === "S1") {
    // ESCALATION, not repetition: "You gave us X last year; here is what the next tier adds."
    const prior = c.prior_ask_class;
    if (prior && config.ask_rules.s1_escalation[prior]) {
      rule = config.ask_rules.s1_escalation[prior];
      basis = `S1 escalation from last year's ${prior}${underlying ? ` (underlying segment ${underlying})` : ""}`;
    } else {
      rule = underlying ? config.ask_rules[underlying] : config.ask_rules.S1;
      basis = prior
        ? `S1 with no escalation rule for prior ask "${prior}"; falling back to the underlying segment's ask`
        : `S1 with no prior ask recorded — the cash/in-kind attribution for the 69 logos does not exist anywhere and must be reconstructed internally. Falling back to ${underlying ?? "S1"}'s ask`;
    }
  } else if (seg === "S6") {
    const byAffinity = config.ask_rules.s6_by_affinity[c.alumni_evidence];
    rule = byAffinity ?? config.ask_rules.S6;
    basis = byAffinity
      ? `S6 tiered by AFFINITY (${c.alumni_evidence}), not by company size — the decision is personal, not budgetary`
      : "S6 default";
  } else {
    rule = config.ask_rules[seg];
    basis = `${seg} default ask`;
  }

  const rung = config.ask_ladder[rule.tier];
  return {
    class: rule.class,
    tier: rule.tier,
    amount_low: rung?.amount_low ?? 0,
    amount_high: rung?.amount_high ?? 0,
    imputed_low: rule.imputed_low ?? rung?.imputed_low ?? 0,
    imputed_high: rule.imputed_high ?? rung?.imputed_high ?? 0,
    basis,
  };
}

// ===========================================================================
// The objectives. NEVER SUMMED — and there are three of them since the captain's 2026-08-06
// ruling that a mentor or project advisor is worth the same as money.
// ===========================================================================

export interface CashObjective {
  applicable: boolean;
  /** Present only when applicable. */
  p_yes?: number;
  expected_cash?: number;
  cash_per_hour?: number;
  note: string;
}

export interface RelationshipObjective {
  applicable: boolean;
  p_yes?: number;
  expected_relationships?: number;
  relationships_per_hour?: number;
  expected_imputed_in_kind?: number;
  note: string;
}

/**
 * What a mentor, a project advisor or a judge from this lead is worth.
 *
 * CAPTAIN'S RULING 2026-08-06: THE SAME AS MONEY. The club asked for advisors as an explicit goal
 * alongside funding, so this is an objective in its own right — never a term inside
 * `deployable_cash`, never a bonus, never a tie-break, and never consulted only when funding
 * evidence is absent.
 *
 * `expected_value` is denominated in dollars because that is what parity MEANS: an advisory yes is
 * valued at the same ask-ladder rung a cheque from this lead would be. It is still never added to
 * `expected_cash` — the sum is not a quantity the club has, because a mentor does not pay a
 * printer. Parity says a $375 advisory yes RANKS WITH a $375 cash yes.
 */
export interface AdvisoryObjective {
  applicable: boolean;
  /** The ruling this objective was computed under. Read from config; never inferred. */
  parity: AdvisoryParity;
  p_yes?: number;
  /** The commitments code recognised on the club's published menu. */
  commitments?: string[];
  /** Reported commitments that are NOT on the menu. Reported, never scored. */
  unrecognised?: string[];
  expected_advisors?: number;
  advisors_per_hour?: number;
  /** The parity valuation, on the SAME ladder as a cheque. */
  expected_value?: number;
  value_per_hour?: number;
  /** The ask-ladder rung the valuation used. */
  valued_at_tier?: AskTier;
  note: string;
}

export interface Objectives {
  deployable_cash: CashObjective;
  relationship_volume: RelationshipObjective;
  advisory_capacity: AdvisoryObjective;
}

/**
 * Resolve `p_yes` for a segment. Config keys carry a descriptive suffix (`S2_local_consumer`),
 * so the lookup is by `S<n>_` prefix. S1 deliberately has two: the in-kind renewal converts far
 * better than the cash escalation, and conflating them is how a renewal programme gets scored as
 * a failure.
 */
export function resolvePYes(
  config: IcpConfig,
  segment: SegmentId,
  askClass: AskClass | null,
): { value: number; key: string } | null {
  if (segment === "S1") {
    const isCash = askClass != null && askClass.startsWith("cash_");
    const key = isCash ? "S1_renewal_cash" : "S1_renewal_in_kind";
    const value = config.p_yes[key];
    return value == null ? null : { value, key };
  }
  const prefix = `${segment}_`;
  for (const [key, value] of Object.entries(config.p_yes)) {
    if (key.startsWith(prefix)) return { value, key };
  }
  return null;
}

const CASH_TIERS = new Set<AskTier>(["bronze", "silver", "gold", "diamond", "grant"]);

/** Menu matching is case- and separator-insensitive; the menu itself still governs membership. */
function normalizeCommitment(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * The advisory objective. CAPTAIN'S RULING 2026-08-06 — a mentor or project advisor is worth the
 * same as money.
 *
 * FOUR PROPERTIES THIS FUNCTION EXISTS TO HOLD, each one a way the ruling could be quietly
 * reversed:
 *
 *  1. NEVER GATED ON CASH. Applicability is decided by whether advisory capacity was observed,
 *     full stop. It does not ask whether the cash objective applies, whether an ask carries a
 *     dollar amount, or whether funding evidence is absent. Tier B, where cash is NOT APPLICABLE,
 *     is exactly where advisory lives most.
 *  2. NEVER A MODIFIER. Nothing in `fit`, `affinity`, `access` or `trigger_bonus` reads advisory
 *     capacity. It moves its own objective and nothing else, so it cannot become a bonus.
 *  3. VALUED ON THE SAME LADDER. `equal_to_cash` values the commitment at the rung this lead's
 *     own cash ask uses, so parity is arithmetic. Where the lead's ask carries no cash amount at
 *     all (an in-kind or non-monetary ask) it falls to `advisory.parity_tier` rather than to zero
 *     — zero there would silently restore the cash preference in exactly the segments where the
 *     report says the non-monetary yield IS the product.
 *  4. CODE DECIDES WHAT COUNTS. A reported commitment is checked against the club's published
 *     menu, and the valuation is the rung ONCE, not once per commitment: a model that lists all
 *     eight menu items cannot inflate a lead eightfold. Unrecognised entries are reported — and
 *     so is a non-string entry, stringified into the same `unrecognised` list rather than dropped,
 *     because a silent repair teaches nobody that the model is misbehaving.
 *
 * ⚠ ONE HONEST UNDERSTATEMENT, RECORDED RATHER THAN PAPERED OVER. `p_yes` is the segment's own
 * rate — the same one the cash objective uses. The report models the non-monetary ask converting
 * FAR better (§5 S11: "4–8% for cash and 15–25% for a non-monetary ask"; §5 S15: 30–50% for time
 * against ~5% for cash), so this valuation is conservative. No measured advisory rate exists for
 * this club, and inventing seventeen of them would be worse than being conservative with the one
 * rate on file. Replace with measured rates alongside the other `p_yes` values.
 */
function advisoryObjective(
  seg: SegmentId | null,
  segmentLabel: SegmentAssignment,
  ask: DerivedAsk | null,
  config: IcpConfig,
  reported: readonly string[] | null | undefined,
): AdvisoryObjective {
  const parity = config.advisory.parity;
  const menu = new Set(config.advisory.commitments.map(normalizeCommitment));
  const listed = (reported ?? []).map((v) => (typeof v === "string" ? v : String(v)));
  const commitments = listed.filter((v) => menu.has(normalizeCommitment(v)));
  const unrecognised = listed.filter((v) => !menu.has(normalizeCommitment(v)));
  const unrecognisedNote =
    unrecognised.length > 0
      ? ` Reported but not on the club's published engagement menu, so not scored: ${unrecognised.join(", ")}.`
      : "";

  if (!seg || config.segments[seg].objective === "excluded") {
    return {
      applicable: false,
      parity,
      ...(unrecognised.length > 0 ? { unrecognised } : {}),
      note:
        `segment is ${segmentLabel}: no objective applies, advisory included.` + unrecognisedNote,
    };
  }

  if (commitments.length === 0) {
    return {
      applicable: false,
      parity,
      ...(unrecognised.length > 0 ? { unrecognised } : {}),
      note:
        `no advisory capacity has been researched for this lead. ABSENT IS NOT A REFUSAL: this ` +
        `costs the lead nothing in any score or objective, and the moment a mentor, project ` +
        `advisor or judge is observed it is valued at parity with a cheque.` + unrecognisedNote,
    };
  }

  const pYes = resolvePYes(config, seg, ask?.class ?? null);
  if (!pYes) {
    return {
      applicable: false,
      parity,
      commitments,
      ...(unrecognised.length > 0 ? { unrecognised } : {}),
      note: `advisory capacity is recorded (${commitments.join(", ")}) but no p_yes is configured for ${seg}, so it cannot be valued.` + unrecognisedNote,
    };
  }

  const effort = config.effort_minutes[seg];
  const leadRung = ask ? config.ask_ladder[ask.tier] : undefined;
  const leadCarriesCash =
    ask != null && CASH_TIERS.has(ask.tier) && (leadRung?.amount_high ?? 0) > 0;
  const tier: AskTier = leadCarriesCash ? ask.tier : config.advisory.parity_tier;
  const rung = config.ask_ladder[tier];
  const value = pYes.value * midpoint(rung?.amount_low ?? 0, rung?.amount_high ?? 0);

  return {
    applicable: true,
    parity,
    p_yes: pYes.value,
    commitments,
    ...(unrecognised.length > 0 ? { unrecognised } : {}),
    // One yes is one advisory relationship however many menu items were listed.
    expected_advisors: pYes.value,
    advisors_per_hour: effort > 0 ? (pYes.value / effort) * 60 : 0,
    expected_value: value,
    value_per_hour: effort > 0 ? (value / effort) * 60 : 0,
    valued_at_tier: tier,
    note:
      `${commitments.join(", ")} valued at parity with money (${parity}) on the ${tier} rung ` +
      `($${rung?.amount_low ?? 0}-${rung?.amount_high ?? 0})` +
      (leadCarriesCash
        ? `, the same rung this lead's own cash ask uses`
        : `, because this lead's ask (${ask?.class ?? "none"} at tier ${ask?.tier ?? "none"}) ` +
          `carries no cash amount — advisory.parity_tier, not zero`) +
      `; p_yes from config key ${pYes.key}. NEVER ADDED TO expected_cash.` +
      unrecognisedNote,
  };
}

export function computeObjectives(
  segment: SegmentAssignment,
  ask: DerivedAsk | null,
  config: IcpConfig,
  opts: { advisory_commitments?: readonly string[] | null } = {},
): Objectives {
  const seg = typeof segment === "string" && segment.startsWith("S") ? (segment as SegmentId) : null;
  const advisory = advisoryObjective(seg, segment, ask, config, opts.advisory_commitments);

  if (!seg) {
    const note = `segment is ${segment}: no objective applies`;
    return {
      deployable_cash: { applicable: false, note },
      relationship_volume: { applicable: false, note },
      advisory_capacity: advisory,
    };
  }

  const objective = config.segments[seg].objective;
  const effort = config.effort_minutes[seg];
  const pYes = resolvePYes(config, seg, ask?.class ?? null);

  if (objective === "excluded") {
    const note = `${seg} is excluded from the automated pipeline entirely — legally and ethically the wrong shape for automation`;
    return {
      deployable_cash: { applicable: false, note },
      relationship_volume: { applicable: false, note },
      advisory_capacity: advisory,
    };
  }

  const relationship: RelationshipObjective = pYes
    ? {
        applicable: true,
        p_yes: pYes.value,
        expected_relationships: pYes.value,
        relationships_per_hour: effort > 0 ? (pYes.value / effort) * 60 : 0,
        expected_imputed_in_kind: ask
          ? pYes.value * midpoint(ask.imputed_low, ask.imputed_high)
          : 0,
        note: `p_yes from config key ${pYes.key} (an ESTIMATE midpoint — replace with measured rates)`,
      }
    : {
        applicable: false,
        note: `no p_yes is configured for ${seg}`,
      };

  if (objective === "relationship_only") {
    return {
      deployable_cash: {
        applicable: false,
        note:
          `${seg} is a Tier B relationship, NOT a donor segment. The cash objective is NOT APPLICABLE, ` +
          `not zero: scoring it on dollars makes a successful relationship look like a failed sale. ` +
          `Roughly one in four entities on the club's own partner wall is one of these.`,
      },
      relationship_volume: relationship,
      // Tier B is where advisory lives most — these ARE the mentor employers and judges. The
      // advisory objective is applicable here on exactly the same terms as anywhere else, which
      // is the point of it not being gated on the cash objective.
      advisory_capacity: advisory,
    };
  }

  const cashCapable = ask != null && CASH_TIERS.has(ask.tier);
  const cash: CashObjective =
    pYes && cashCapable
      ? {
          applicable: true,
          p_yes: pYes.value,
          expected_cash: pYes.value * midpoint(ask.amount_low, ask.amount_high),
          cash_per_hour:
            effort > 0 ? ((pYes.value * midpoint(ask.amount_low, ask.amount_high)) / effort) * 60 : 0,
          note: `p_yes from config key ${pYes.key}; ask tier ${ask.tier} ($${ask.amount_low}-${ask.amount_high})`,
        }
      : {
          applicable: true,
          p_yes: pYes?.value,
          expected_cash: 0,
          cash_per_hour: 0,
          note:
            `the derived ask is ${ask?.class ?? "none"} at tier ${ask?.tier ?? "none"}, which is worth ` +
            `$0 in deployable cash. This is the structural finding: in-kind is where the yes lives and it ` +
            `pays nothing. Every in-kind yes must create a dated, owned cash-escalation candidate for next year`,
        };

  return { deployable_cash: cash, relationship_volume: relationship, advisory_capacity: advisory };
}

function midpoint(low: number, high: number): number {
  return (low + high) / 2;
}

// ===========================================================================
// The public entry point
// ===========================================================================

export interface ScoreResult {
  segment: SegmentAssignment;
  underlying_segment: SegmentId | null;
  segment_basis: string;

  // THREE SCORES, DELIBERATELY NOT SUMMED. There is no `total` field, and adding one would
  // destroy the only information a volunteer with four hours a week needs: what to do next.
  fit: ScoreBlock;
  affinity: ScoreBlock;
  access: ScoreBlock;

  trigger_bonus: TriggerBonusResult;
  gates: GateResult[];
  /** True when any blocking gate failed. A gate failure is never compensated by a high score. */
  blocked: boolean;
  blocking_gates: GateId[];

  ask: DerivedAsk | null;
  objectives: Objectives;

  /** Inputs that were absent, so a card can say "this score is depressed by missing data". */
  missing_inputs: string[];
}

/**
 * Score one company. Pure arithmetic over reported features and config/icp.yaml.
 *
 * NO MODEL IS INVOKED. Which segment, which size, which geography, which title is senior enough,
 * whether the affiliation evidence clears, and what the ask is worth are all CODE decisions.
 */
export function scoreCompany(
  c: CompanyFacts,
  config: IcpConfig,
  opts: { lists: QualificationLists; now?: Date },
): ScoreResult {
  const now = opts.now ?? new Date();
  const assignment = assignSegment(c, config, { now });
  const gates = evaluateGates(c, assignment.segment, config, { lists: opts.lists, now });

  const affiliationGate = gates.find((g) => g.gate === "G_AFFILIATION_EVIDENCE");
  const affiliationCapped = affiliationGate?.effect === "cap_affinity" && affiliationGate.verdict === "fail";

  const missing: string[] = [];
  const fit = scoreFit(c, assignment.segment, config, { lists: opts.lists, now, missing });
  const affinity = scoreAffinity(c, assignment.segment, config, {
    affiliation_capped: affiliationCapped,
  });
  const access = scoreAccess(c, assignment.segment, config);

  const blocking = gates.filter((g) => g.effect === "block" && g.verdict === "fail").map((g) => g.gate);
  for (const g of gates) {
    if (g.verdict === "cannot_evaluate") missing.push(g.gate);
  }

  const ask = deriveAsk(c, assignment.segment, assignment.underlying_segment, config);

  return {
    segment: assignment.segment,
    underlying_segment: assignment.underlying_segment,
    segment_basis: assignment.basis,
    fit,
    affinity,
    access,
    trigger_bonus: triggerBonus(c, config, { now }),
    gates,
    blocked: blocking.length > 0,
    blocking_gates: blocking,
    ask,
    objectives: computeObjectives(assignment.segment, ask, config, {
      advisory_commitments: c.advisory_commitments,
    }),
    missing_inputs: [...new Set(missing)],
  };
}

// ===========================================================================
// Adapter — wire the disqualifier filter's output into the §6.3 gate inputs.
// ===========================================================================

/**
 * Map a `runFilter()` result onto the gate-input fields of `CompanyFacts`.
 *
 * This is a type-only dependency on src/lib/filter.ts: scoring stays pure arithmetic and does
 * not import any filter code at runtime. Integration into the agent run is a separate follow-up;
 * this exists so that wiring is a one-liner rather than a re-derivation.
 */
export function gateInputsFromFilterResult(
  result: FilterResult,
): Pick<
  CompanyFacts,
  | "is_excluded"
  | "exclusion_reason"
  | "suppressed"
  | "no_solicitation_found"
  | "deliverable_contact"
  | "required_channel"
  | "email_channel_open"
  | "local_authority"
> &
  Partial<Pick<CompanyFacts, "lawful_basis_strength">> {
  const suppressed = result.kills.some(
    (k) => k.reason === "suppressed_do_not_contact" || k.reason === "declined_permanently",
  );
  // L-02 is email-scoped, so it lands in `field_terminals`, not `kills`. G_NO_SOLICIT is the
  // gate that exists to carry it; reading only `kills` would drop the finding entirely.
  const noSolicit = [...result.kills, ...result.field_terminals].some(
    (k) => k.reason === "no_solicitation_statement_at_source",
  );
  const deliverabilityRules = new Set(["D-01", "D-02", "D-03", "D-05", "D-06", "D-07", "K-REL-08"]);
  // An address-scoped terminal (D-05, D-07, K-REL-08) does NOT exclude the account, but it does
  // mean the recorded contact is undeliverable — so it feeds G_DELIVERABLE, not G_EXCLUDED.
  //
  // `overridden_kills` counts too. The never-kill allowlist keeps a past sponsor in the corpus
  // when its domain goes dead; it does not make the dead domain deliverable. Reading only
  // `kills` turned a suppressed D-01 into a POSITIVE assertion that the address works, and
  // `scoreAccess` then awarded the full deliverable_contact weight to a domain with no
  // nameservers.
  const deliverabilityKilled = [
    ...result.kills,
    ...result.field_terminals,
    ...result.overridden_kills,
  ].some((k) => deliverabilityRules.has(k.rule_id));
  const deliverabilityUnknown = result.cannot_evaluate.some((c) => deliverabilityRules.has(c.rule_id));

  return {
    // ONLY an account-scoped kill excludes. A cleared address or a cleared contact name leaves
    // the account in the corpus — §3.5 "Never drop the account".
    is_excluded: result.kills.some((k) => k.scope === "account"),
    local_authority: result.franchise.status === "LOCAL_AUTHORITY",
    exclusion_reason: result.reject_reason,
    suppressed,
    no_solicitation_found: noSolicit,
    deliverable_contact: deliverabilityKilled ? false : deliverabilityUnknown ? undefined : true,
    // A non-email route makes G_LAWFUL_BASIS NOT APPLICABLE rather than failed. P-08's forbid
    // closes the EMAIL channel and sends the row to the walk list; treating that as "no basis"
    // would block every cold role-account lead in the corpus, which is precisely the
    // pipeline-emptying outcome §9.4's measurement exists to prevent.
    required_channel: result.required_channel,
    email_channel_open: result.email_channel_open,
    // Every email-scoped terminal is a CASL finding that destroys the basis for sending: L-02
    // because s.10(9)(b) withdraws implied consent where the publication carries a
    // no-solicitation notice, L-04 because a third-party directory is not conspicuous
    // publication. G_LAWFUL_BASIS is the gate that answers exactly that question, so the closed
    // channel is carried there. The account still survives — this blocks the SEND, not the row.
    //
    // Reported only when the filter actually closed the channel, so a caller's own recorded
    // basis stands when it did not.
    ...(result.email_channel_open ? {} : { lawful_basis_strength: "none" as const }),
  };
}

/** Convenience re-export so a caller can resolve list-backed facts without a second import. */
export type { QualificationLists };

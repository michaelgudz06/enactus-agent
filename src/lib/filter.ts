// The disqualifier filter for Enactus SFU sponsorship prospecting.
//
// Spec: enactus-disqualifiers/report.md (research date 2026-08-06). Section references below
// are to that document. Every predicate here is a pure, deterministic function of the account
// record and the maintained lists in config/exclusions/.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
//  1. NO MODEL. Not now, not as a fallback. This module must never import a model client.
//     Steps 1-7 of the evaluation order cost nothing and touch no network; step 8 consumes DNS
//     facts the caller already resolved. §2.4.
//
//  2. HARD KILLS AND SOFT PENALTIES ARE SEPARATE. A wrongly killed account is invisible
//     forever; a wrongly penalised one still surfaces. They live in different arrays, are
//     produced by different functions, and are never summed together. §4.
//
//  3. KILL ON CONTRARY EVIDENCE, NEVER ON ABSENT EVIDENCE. Every predicate is written as
//     `field IS NOT NULL AND <test>`. Where the data needed to decide is missing, the
//     predicate returns an explicit `cannot_evaluate` outcome carrying the missing field
//     names — never a silent pass and never a silent fail. §2.3.
//
//  4. EVERY RULE CARRIES AN EXPLICIT ENTRY CONDITION. Before a rule's severity is considered it
//     must answer "does this rule apply to this row at all?". An unproven condition on an entity
//     the rule does not cover is not a penalty — it is a NO-OP. Each rule's population is taken
//     from its own definition row, never from a later procedure section (see below).
//
// ===========================================================================
// REPORT CONTRADICTIONS — where the specifications disagree with themselves
// ===========================================================================
//
// The reports are the requirements documents, and in four places they contradict themselves. The
// governing rule applied throughout: A RULE'S DEFINITION GOVERNS; LATER PROCEDURE SECTIONS
// IMPLEMENT THAT DEFINITION AND MAY NOT WIDEN IT. Each is pinned by a test.
//
//  C1. P-03, "publicly traded". §4 defines it as "Publicly traded (has a ticker /
//      investor-relations section)". §6 option 2 widens it with "One [proxy] -> P-03 (-20)",
//      where the proxy set includes a /suppliers path, 20+ job postings and a 25+ location store
//      locator. TAKEN: §4. A suppliers page is not evidence of being publicly traded. The
//      report's own honest caveat proves it — Cactus Club Cafe publishes Suppliers and Supply
//      Chain Accountability, has no ticker, and is a PAST ENACTUS SFU PARTNER. Penalising an
//      account that already said yes, for a reason factually untrue of it, means the
//      implementation is wrong rather than the account. K-SIZE-01's separate two-or-more-proxy
//      arm is §6's own rule and is unchanged.
//
//  C2. P-04, "branch autonomy unproven". §4 defines it as "Head office outside BC, local branch
//      exists but branch autonomy unproven" — three clauses. §5 step 3 says only "neither fires
//      -> UNPROVEN -> apply P-04". TAKEN: §4. §5 step 3 is an incomplete implementation of the
//      §4 definition, not a broader rule. Applying the bare fall-through charged -30 to every
//      independent single-location business in the corpus — the population §5 exists to protect,
//      which the org report calls "where the yes lives".
//
//  C3. §5's own scope. §5 is "Franchise and branch handling" and its one-line rule is "test the
//      LOCATION, not the brand", but its procedure has no entry condition, so an independent
//      business fell through to UNPROVEN. TAKEN: §5's title and stated rule govern its
//      procedure. A row with no observed chain or branch signal gets NOT_APPLICABLE.
//
//  C4. K-REL-08's cross-record penalty. §3.4 specifies "-40 on every other lead sharing
//      email_domain" verbatim, with no free-mail carve-out, while D-07 one section later exempts
//      LIST_free_mail_providers because "a Vancouver bakery legitimately uses @gmail.com".
//      TAKEN: the D-07 exemption applies here too, reusing the same list. Read literally, one
//      bounced info@gmail.com would levy the largest penalty in §4 on every free-mail lead in
//      the corpus — a corpus-wide outage from one bad address. This is the one place a rule is
//      NARROWED against its own text rather than widened; recorded here because the brief
//      requires noting a disagreement rather than shipping it silently.
//
// A fifth contradiction lives in the ICP report and is documented at `assignSegment` in
// src/lib/scoring.ts: §5 S4 asserts §4 precedence sends a funded CPG brand to S4, while §4's
// normative ladder tests raised_institutional_capital first and sends it to S11. TAKEN: §4.
//
// ===========================================================================
// RESOLVED AMBIGUITIES — where the specification is silent rather than contradictory
// ===========================================================================
//
//  A1. MAY A PENALTY FIRE ON A MERELY ABSENT VALUE? Ruled 2026-08-06.
//
//      §2.3 states the asymmetry rule for KILLS only — "missing data is never a kill" — and is
//      silent on penalties. It does not follow that absence may never penalise: §4 P-09 is
//      "`unresolved_geography` AFTER ONE RETRY, -15", and §2.3's own worked example sends a null
//      region for one more resolution attempt and THEN takes a penalty. What the report never
//      does is state the gate as a general rule.
//
//      THE RULE TAKEN: a penalty may fire on an OBSERVED POSITIVE FACT, or on a MISSING VALUE
//      WHERE A RESOLUTION ATTEMPT HAS RUN AND ITS FAILURE IS RECORDED ON THE ROW. It never fires
//      on a value that is merely absent.
//
//      Applied in one pass over all fifteen penalties. P-01/02/03/05/07/08/11/12/13/15 fire on an
//      observed positive; P-04 requires all three of its §4 clauses; P-06 gates on
//      `discovery_tactics_attempted >= 2` and P-09 on `geography_resolution_attempts >= 1`, which
//      were already the correct shape and are the model for the rest. P-10's bare
//      `!website_url && !registrable_domain` arm was the one exception and now gates on
//      `website_resolution_attempts >= 1`: a freshly discovered row carrying a name, a
//      municipality and a phone must not be marked down before anything has looked it up, and
//      thin-web-presence local operators are precisely the population the ICP research ranks
//      highest-converting.
//
//  A2. P-08's PAIRED CONSTRAINT CLOSES THE EMAIL CHANNEL AND ROUTES TO THE WALK LIST. It never
//      blocks the lead. §4 specifies P-08 as "-15 AND forbid `lawful_basis = conspicuous_pub`",
//      and a constraint described only in a rendered sentence is a comment — so
//      `p08RoleAccountCannotClaimConspicuousPub` enforces it.
//
//      HOW it enforces it is the part the report had to settle, because the obvious reading
//      empties the board. Conspicuous publication is the ONLY basis a COLD prospect can carry
//      (the other three all require a prior relationship), and §9.4 measured 25 OF 25 seeded
//      addresses as role accounts. So a forbid implemented as "no lawful basis" would fail
//      G_LAWFUL_BASIS on essentially every cold lead in the corpus — the pipeline-emptying
//      outcome §9.4 exists to prevent, and flatly against §3.5's "a penalty plus a constraint on
//      the lawful basis, NEVER A KILL".
//
//      The ICP report answers it directly for exactly these segments (S2/S3/S4/S13): a generic
//      `info@` is weak ground, and "this is an argument for the WALK LIST rather than the email
//      list — an in-person ask is not a CEM at all". So the rule emits TWO outcomes: an
//      email-scoped terminal that closes the email channel, and a CHANNEL routing the row to
//      `in_person`. The account stays on the board, keeps its -15, and is never killed or
//      blocked. `gateInputsFromFilterResult` carries both the route and the channel state to
//      G_LAWFUL_BASIS, which reports NOT_APPLICABLE when the email channel is shut and for any
//      non-CEM route — otherwise the corpus-wide block simply moves one layer down into the
//      scorer. A non-walkable role account has no route at all, so the closed channel is the
//      branch that spares it.
//
//  A3. §7.2 `LIST_national_flag` IS NOT §7.1 `LIST_national_partner`. §7.2 is headed "review, do
//      not kill" with "Kill mode: none — `human_review` only". It therefore emits a FLAG and
//      never a terminal and never a `enactus_canada` channel: PwC is on it because it is BOTH a
//      named donor AND a warm SFU relationship, and Scotiabank and CWB because the report could
//      not tell "ended" from "mid-renewal" and left it as an open question for a human.
//
//  A6. THE CAPTAIN SUPERSEDED THE REPORT'S GEOGRAPHY, 2026-08-06.
//
//      The captain, who owns the ICP: "ideally we want businesses in BC, but anything across
//      canada is fine". IN SCOPE: ANYWHERE IN CANADA. PREFERRED: BC, and Greater Vancouver most
//      of all. OUT OF SCOPE: outside Canada. The report was written to a narrower assumption;
//      where the two disagree the captain's decision wins, and the report stays unedited.
//
//      WHAT THAT DELETED, rather than corrected:
//        · K-GEO-02 `outside_bc` was a TERMINAL. It is GONE. An Ontario or Alberta company is a
//          prospect at a lower weight, not an invisible row.
//        · K-GEO-03 / P-01's -25 `outside_metro_vancouver` penalty is GONE. Geography is
//          expressed EXACTLY ONCE, as the band weight in config/icp.yaml; charging a penalty as
//          well would count the same fact twice.
//        · The non-BC region enumeration is GONE. It read the token "CA" — the ISO code this
//          module itself uses for Canada — as California and terminalled a Vancouver bakery.
//          Province is now derived only WITHIN Canada, so that collision cannot recur.
//        · The metro postal-prefix set is GONE. Report §8 rejected FSA-prefix geography in
//          writing, and V3G/V4X being Abbotsford, V4S Mission and V4T/V4V Central Okanagan is
//          exactly the defect it predicted.
//
//      K-GEO-01 `outside_canada` is the ONLY geographic terminal that survives.
//
//  A7. §3.3 K-GEO-05'S MULTI-BASIS LOCALITY CARVE-OUT IS SUPERSEDED TOO, 2026-08-06.
//
//      K-GEO-05 let three bases put an account in scope — registered address, operating
//      location, decision-maker location — so that a remote-first company with a Vancouver
//      founder was not KILLED as `outside_bc`. A6 deleted that kill. A Canadian company is in
//      scope at `canada_other` with no rescue needed, so the carve-out was written against a
//      regime that no longer exists, and geography is now ONE dimension expressed ONCE: the
//      band. `localityBasis`, `GeoBasis`, `LocalityReport`, `bases_in_scope` and the
//      `operating_municipality` / `decision_maker_municipality` observations are GONE.
//
//      WHAT THE SECOND DIMENSION COST WHILE IT LIVED: the two observations carried no province
//      of their own, so they were read through a bare alias hit. That was defended as
//      rescue-only, but P-04 clause 2 also read it, and an Ontario chain whose operating
//      municipality read `Richmond` took -30 as a branch of a namesake. Clause 2 now requires
//      `bc_branch_confirmed`.
//
//      WHAT IT COSTS TO REMOVE IT: a company registered OUTSIDE CANADA with a Vancouver founder
//      no longer escapes K-GEO-01. That is the intended shape of a single geographic terminal,
//      not an oversight — record the founder as an alumni/proximity signal if the row is worth
//      keeping.
//
//      IF THE FOUNDER-LOCATION NUANCE IS EVER WANTED BACK, IT IS AN AFFINITY SIGNAL — a
//      person-level fact belonging beside `local_proximity` and the alumni evidence tiers in
//      src/lib/scoring.ts — and NEVER a second geography dimension in this module.
//
//  A4. A MUNICIPALITY ALIAS IS ONLY TRUSTWORTHY ON POSITIVE EVIDENCE OF CANADA. §7.8's list
//      ships BARE MUNICIPALITY NAMES, and richmond, vancouver, surrey, langley, delta and white
//      rock all name real places outside BC. The report never says which wins when a row records
//      both, so: a recorded CONTRARY region is consulted FIRST, and the alias never overturns
//      it. `resolveGeography` in qualification-lists.ts is the single implementation — this
//      module and src/lib/scoring.ts both consume it, with the SAME full input set, because two
//      resolvers over the same data drifted in OPPOSITE directions within one review round, and
//      then two CALLERS of one resolver drifted again by passing it different fields.
//
//      AND UNRECOGNISED IS ABSENT, IN EVERY BRANCH, AT EVERY FIELD. Four consecutive geography
//      defects came from writing a three-state question as a boolean per field: one classifier
//      read "unrecognised" as CONTRARY and terminalled a Burnaby bakery whose province read
//      "B.C.", another read it as PERMISSIVE and scored Vancouver, Washington as a local
//      prospect. `Evidence` is now ONE primitive — `known | contrary | unknown` — applied to
//      country, region and municipality alike, with ONE combination rule, and every consumer
//      switches on all three states with a `never` default. Resolving a row with a field
//      present-but-unrecognised returns an object EQUAL to resolving it omitted.
//
//      THREE CONSEQUENCES WORTH NAMING:
//        · A bare municipality alias is trusted only on POSITIVE evidence of Canada. Vancouver
//          BC and Vancouver WA are indistinguishable on a bare municipality, so the honest
//          answer is `unresolved` — a thin row loses a weighting, never its place on the board.
//        · `canada_other` needs a RECOGNISED non-BC province. Country-is-Canada with everything
//          else unknown is `unresolved`, because P-04 reads that band as "the head office is
//          elsewhere" and the absence rule forbids inferring it from an empty field. (The
//          instruction said country AND province; a recognised Canadian province is itself
//          positive evidence of Canada, so the province alone carries it — the clause that
//          bites is the absence case, and that is closed.)
//        · "Outside Canada" must be RECOGNISED, never merely unrecognised, so a country field
//          reading "British Columbia" is a slip rather than a kill. The recognised-not-Canada
//          list is deliberately incomplete; the cost is under-killing, which is the safe
//          direction.
//
//  A5. AN EFFECT A RULE DESCRIBES IS PART OF ITS RETURN TYPE. Four rules in a row were found
//      narrating an outcome nothing emitted (K-REL-08's sibling −40, L-04's email channel,
//      P-08's forbid, §5's head-office reroute). Sweeping for it caught the ones that existed;
//      the type catches the next one. So: `FranchiseReport`'s HEAD_OFFICE variant CARRIES its
//      reroute and cannot be constructed without one; `SCOPE_EFFECTS` is a total record over
//      `TerminalScope`; K-REL-08's sentence is RENDERED FROM its `SiblingOutcome` rather than
//      written beside it. Each has a `never` arm, so adding a case without an effect stops
//      compiling. Do not describe an effect in a message or doc comment that the return value
//      does not carry.
//

import {
  type GeographyVerdict,
  type KeyedList,
  type QualificationLists,
  resolveGeography,
  isDomainOrSubdomainOf,
  lookupDomainOrSubdomain,
  lookupList,
  metroVancouverCanonicals,
  normalizeDomain,
  normalizeMunicipality,
  normalizeName,
} from "./qualification-lists";

// ===========================================================================
// §2.1 — the input record
// ===========================================================================

export type LawfulBasis =
  | "express"
  | "ebr_2y"
  | "inquiry_6m"
  | "conspicuous_pub"
  | "direct_disclosure"
  | "b2b_relationship"
  | "solicited";

export type CollectionMethod =
  | "own_site_fetch"
  | "business_card"
  | "inbound_enquiry"
  | "human_paste"
  | "email_finder"
  | "bulk_crawler"
  | "enrichment_api";

/**
 * §3.4: a closed set, because K-REL-05/06/07 branch on it. An open string here would make the
 * decline-suppression rules silently unreachable.
 */
export type DeclinedReason =
  | "no_budget"
  | "not_a_fit"
  | "policy_no_student_groups"
  | "never_contact_us"
  | "timing"
  | "budget_cycle"
  | "no_response"
  | "other";

/** CRA designation, from the CRA List of charities open dataset. §3.1 K-ORG-05. */
export type CraDesignation = "Charitable Organization" | "Public Foundation" | "Private Foundation";

export interface AccountDns {
  ns_present: boolean | null;
  a_present: boolean | null;
  mx_present: boolean | null;
  ns_hosts: string[];
  mx_hosts: string[];
  smtp25_open: boolean | null;
  /**
   * D-01 requires two attempts against two independent resolvers before it may fire. Below
   * that the predicate cannot evaluate — one failed lookup is not evidence a domain is dead.
   */
  resolver_attempts?: number | null;
}

export interface AccountRelationship {
  last_contacted_at?: string | null;
  sponsor_cycles?: string[];
  declined_at?: string | null;
  declined_reason?: DeclinedReason | null;
  routed_to_national_at?: string | null;
  suppressed_at?: string | null;
  bounced_hard_at?: string | null;
}

/**
 * Page-fetch observations that §5 (franchise) and §6 (the headcount proxy set) need but that
 * §2.1's core record does not carry. Every field is optional and `undefined` means NOT
 * OBSERVED, which per §2.3 can never fire a kill.
 */
export interface AccountObservations {
  // --- §6 enterprise proxies, the replacement for the headcount field that does not exist ---
  has_investor_relations?: boolean;
  has_stock_ticker?: boolean;
  careers_open_postings?: number;
  has_supplier_procurement_path?: boolean;
  has_named_community_investment_programme?: boolean;
  store_locator_location_count?: number;

  // --- §5 franchise and branch signals ---
  /** S1: page text at the location's own URL. */
  location_page_text?: string;
  /** S2: the location has its own registrable domain, distinct from the chain's, with its own MX. */
  location_has_own_domain_with_mx?: boolean;
  /** S3: the location publishes a location-specific address (`vancouver@…`, `…@modoyogavancouver.com`). */
  location_specific_email?: string;
  /** S4: the location page names an owner/franchisee/GM by personal name. */
  named_local_owner?: string;
  /** S5: separately registered in the BC corporate registry. UNVERIFIED API shape — see §6. */
  bc_registry_distinct_entity?: boolean;
  /** S6: the chain's site has an "own a studio" / "franchise opportunities" page. */
  chain_has_franchise_page?: boolean;
  /** N1: the only published contact for every location is a head-office address. */
  only_head_office_contact?: boolean;
  /** N2: the site publishes a centralised donation/sponsorship request form. */
  has_central_donation_form?: boolean;
  /** N4: corporate-owned — careers page lists all locations as employer-of-record, no franchising page. */
  corporate_owned_all_locations?: boolean;

  // --- geography carve-outs, §3.3 ---
  /** P-04 clause 2: a BC location of an out-of-province head office has been CONFIRMED. */
  bc_branch_confirmed?: boolean;

  // --- penalty inputs, §4 ---
  /** P-11: when the registrable domain was first registered. */
  domain_registered_at?: string | null;
  /** P-06: how many person-discovery tactics have been tried. */
  discovery_tactics_attempted?: number;
  /** P-09: how many geography-resolution attempts have been made. */
  geography_resolution_attempts?: number;
  /** P-12: whether the sector plausibly ties to any of the 8 Enactus SFU projects. */
  project_industry_match?: boolean | null;
  /** P-15: how many other leads already sit on this registrable domain. */
  other_leads_on_domain?: number;
  /** P-10: whether the account has a website at all (social-only presence). */
  social_only_presence?: boolean;
  /**
   * P-08's walk-list entry condition: a customer-facing address a student could actually walk
   * into. The ICP report makes the walk-list argument for the LOCAL STOREFRONT segments only.
   */
  has_consumer_storefront?: boolean;
  /**
   * P-10: how many website-enrichment passes have run and recorded their result on this row.
   *
   * Absent website fields are only evidence of a social-only business once something has looked.
   * Below 1 the row has simply not been enriched yet, and per resolved ambiguity A1 a merely
   * absent value never penalises.
   */
  website_resolution_attempts?: number;
}

/** The §2.1 account record. Nothing outside this shape is in scope for a predicate. */
export interface Account {
  id?: string;
  legal_name: string;
  normalized_name?: string | null;
  website_url?: string | null;
  registrable_domain?: string | null;
  email?: string | null;
  email_local?: string | null;
  email_domain?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  headcount?: number | null;
  headcount_band_max?: number | null;
  address_municipality?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  postal_code?: string | null;
  phone_e164?: string | null;
  source_urls?: string[];
  lawful_basis?: LawfulBasis | null;
  lawful_basis_url?: string | null;
  lawful_basis_captured_at?: string | null;
  source_page_text?: string | null;
  source_page_lang?: "en" | "fr" | "other" | null;
  collection_method?: CollectionMethod | null;
  /** §3.1 K-ORG-05: from the CRA List of charities dataset. Absent means the import has not run. */
  cra_designation?: CraDesignation | null;
  /** §3.7 K-REP-01. Optional — the regex over name + industry works without it. */
  naics_code?: string | null;
  industry?: string | null;
  dns?: AccountDns | null;
  rel?: AccountRelationship | null;
  observations?: AccountObservations;
}

// ===========================================================================
// §2.2 — three outcomes, not two (plus the two bookkeeping outcomes the brief requires)
// ===========================================================================

export type RequiredChannel =
  | "web_form"
  | "phone"
  | "in_person"
  | "enactus_canada"
  | "sfu_advancement"
  | "grants_pipeline"
  | "renewal_motion";

interface BaseResult {
  /** e.g. "K-GEO-02". */
  rule_id: string;
  /** §2.5: snake_case, stable forever, never reworded. The slug is what code tests. */
  reason: string;
  /** The specific observed value that fired the rule. */
  detail: string;
  /** The URL or list entry that justifies it. */
  evidence_url: string;
  /** The rendered human sentence. This is what a human disagrees with. */
  message: string;
}

/**
 * WHAT a TERMINAL kills. Read verbatim off the qualifier in each rule's Outcome column, for
 * every rule in the report rather than for the subset that happened to surface in review:
 *
 *   "TERMINAL"                                    → account   (the §2.2 default)
 *   "TERMINAL for the address"                    → address   (D-05, D-07, K-REL-08)
 *   "TERMINAL for email"                          → email     (L-02, L-04)
 *   "TERMINAL for the person, not the account"    → person    (PLACEHOLDER)
 *
 * Only `account` drops the row. Every other scope clears what it owns, leaves the account in
 * the queue and lets the remaining predicates and the whole penalty pass run — a wrongly killed
 * account is invisible forever, a wrongly cleared field is refetched.
 */
export type TerminalScope = "account" | "address" | "email" | "person";

/**
 * HOW LONG a TERMINAL lasts. Orthogonal to scope, and taken from §3.4's own "Suppression
 * window" column rather than invented: `forever` (K-REL-01, K-REL-06, K-REL-08, L-01), an
 * explicit window that auto-clears (K-REL-05, "TERMINAL for this cycle, auto-clears", 12
 * months), and otherwise the §2.2 default — reversible only by a human editing a maintained
 * list.
 *
 * Modelling "for this cycle" as a scope rather than a duration is what produced the previous
 * round's finding; the two dimensions do not collapse into one another.
 */
export type TerminalDuration =
  | { kind: "forever" }
  | { kind: "until_human_clears" }
  | { kind: "until"; clears_at: string; window: string };

/**
 * A penalty this terminal levies on OTHER records, not on this one.
 *
 * K-REL-08's Outcome cell is a DUAL outcome: "TERMINAL for the address; PENALTY −40 on every
 * other lead sharing `email_domain`". The cross-record half is expressible as neither a scope
 * nor a duration, so it is emitted as data the caller applies to siblings. It is never summed
 * into this row's `penalty_total` — it does not belong to this row.
 */
export interface SiblingPenalty {
  /** The account field a sibling must match on to take this penalty. */
  match_field: "email_domain";
  match_value: string;
  rule_id: string;
  reason: string;
  tag: string;
  /** Negative. Applied to each matching sibling, which stays in the queue. */
  delta: number;
  /** When the address that caused this hard-bounced. */
  occurred_at: string;
  /** The address that bounced. `""` when the bouncing row records no address. */
  cause_address: string;
  /**
   * A sentence true of WHICHEVER row this is applied to.
   *
   * It cannot name the bouncing account as its subject and cannot assert a rejection: the
   * recipient is penalised and STAYS IN THE QUEUE. §2.5 requires the sentence on a row to
   * explain that row, so a caller that knows the recipient should re-render from the structured
   * fields above rather than reuse the bouncing row's own terminal sentence.
   */
  message: string;
}

export interface TerminalResult extends BaseResult {
  kind: "terminal";
  /** Which entity this kills. `account` is the only scope that drops the row. */
  scope: TerminalScope;
  /** How long it lasts. `forever` is the only value that is never reversible. */
  duration: TerminalDuration;
  /** Set on K-CHAN-02 so the SFU Advancement escalation is visible on the row, not lost. */
  required_channel?: RequiredChannel;
  /** L-01: "checked before every send". A recurrence on top of the duration, not a duration. */
  recheck?: "every_send";
  /** K-REL-08's cross-record half. */
  sibling_penalty?: SiblingPenalty;
}

/**
 * §2.2: "Reversible? No (except by a human editing a maintained list)". Derived from `duration`
 * so the two can never disagree.
 */
export function isReversible(t: TerminalResult): boolean {
  return t.duration.kind !== "forever";
}

/**
 * What each non-account scope clears on the surviving record.
 *
 * `email` clears nothing: L-02 and L-04 bar the SEND, not the address. The address is still
 * correct and the business is still reachable by web form, phone or a human — closing the email
 * channel is recorded on the result as `email_channel_open`, and deleting a valid address here
 * would throw away the routing the CHANNEL outcome exists to preserve.
 */
interface ScopeEffect {
  /** The account fields this scope invalidates on the surviving record. */
  clears: readonly (keyof Account)[];
  /**
   * Whether this scope bars sending a CEM. L-04 and P-08-CONSTRAINT are both CASL findings that
   * destroy the BASIS for sending rather than the address. `gateInputsFromFilterResult` carries
   * a closed channel to G_LAWFUL_BASIS as `lawful_basis_strength: "none"`, and the gate answers
   * `not_applicable` while the channel is shut — see the send-path warning in AGENTS.md.
   */
  closes_email_channel: boolean;
}

/**
 * What each non-account scope actually does — a TOTAL record, so a new `TerminalScope` cannot be
 * added without declaring its effect, and `runFilter` reads the effect from here rather than
 * from a hand-written `if` that a later edit can forget to extend.
 */
const SCOPE_EFFECTS: Record<Exclude<TerminalScope, "account">, ScopeEffect> = {
  address: { clears: ["email", "email_local", "email_domain"], closes_email_channel: false },
  email: { clears: [], closes_email_channel: true },
  person: { clears: ["contact_name", "contact_title"], closes_email_channel: false },
};

export interface ChannelResult extends BaseResult {
  kind: "channel";
  required_channel: RequiredChannel;
}

export interface PenaltyResult extends BaseResult {
  kind: "penalty";
  /** e.g. "role_account". */
  tag: string;
  /** Negative. Reduces fit_score; the row stays in the queue and stays visible. */
  delta: number;
}

export interface HoldResult extends BaseResult {
  kind: "hold";
}

export interface FlagResult extends BaseResult {
  kind: "flag";
  flag_reason: string;
}

/**
 * The explicit "we could not decide" outcome. Report §2.3 and §6 name the predicates that need
 * data the club does not have; this makes that visible on the row instead of letting it read as
 * a silent pass or a silent fail.
 */
export interface CannotEvaluateResult {
  kind: "cannot_evaluate";
  rule_id: string;
  reason: "cannot_evaluate";
  /** The fields that would have to be present for this predicate to decide. */
  missing_fields: string[];
  message: string;
}

export interface PassResult {
  kind: "pass";
  rule_id: string;
}

export type PredicateResult =
  | PassResult
  | TerminalResult
  | ChannelResult
  | PenaltyResult
  | HoldResult
  | FlagResult
  | CannotEvaluateResult;

// ---------------------------------------------------------------------------
// §2.5 — the reason string contract
// ---------------------------------------------------------------------------

function displayName(a: Account): string {
  return a.legal_name || a.normalized_name || a.registrable_domain || "This account";
}

function iso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

interface SentenceInput {
  account: Account;
  rule_id: string;
  verb: string;
  because: string;
  evidence_url: string;
  now: Date;
}

/** Renders the §2.5 example: `slug — **Name** was <verb> because <because>. (rule …, evidence …)` */
function sentence(reason: string, i: SentenceInput): string {
  const evidence = i.evidence_url ? `, evidence: ${i.evidence_url}` : "";
  return (
    `${reason} — ${displayName(i.account)} was ${i.verb} because ${i.because}. ` +
    `(rule ${i.rule_id}${evidence}, checked ${iso(i.now)})`
  );
}

function pass(rule_id: string): PassResult {
  return { kind: "pass", rule_id };
}

function cannotEvaluate(
  rule_id: string,
  missing_fields: string[],
  what: string,
): CannotEvaluateResult {
  return {
    kind: "cannot_evaluate",
    rule_id,
    reason: "cannot_evaluate",
    missing_fields,
    message:
      `${rule_id} could not be evaluated: ${what}. Missing: ${missing_fields.join(", ")}. ` +
      `Absence of evidence is never a kill (§2.3), so this account is not rejected on this rule.`,
  };
}

// ===========================================================================
// Regexes — transcribed from the report. Each one is exported so it is individually testable.
// ===========================================================================

/** §3.1 K-ORG-02. Each token is unambiguous, so STRONG fires alone. */
export const STUDENT_ORG_STRONG_RE =
  /\b(students?'?s?\s+(society|union|association|council|government)|undergraduate\s+society|graduate\s+students?\s+(society|association)|alma\s+mater\s+society|enactus|aiesec|rotaract|deca|jdc\s*west|sorority|fraternity|greek\s+(life|council)|alumni\s+association|model\s+un(ited\s+nations)?)\b/i;

/** §3.1 K-ORG-02. */
export const SCHOOL_TOKEN_RE =
  /\b(sfu|simon\s+fraser|ubc|university\s+of\s+british\s+columbia|bcit|capilano|kwantlen|kpu|langara|douglas\s+college|vancouver\s+community\s+college|emily\s+carr|fraser\s+valley|ufv|trinity\s+western|university|college|campus|student)\b/i;

/**
 * §3.1 K-ORG-02. WEAK requires a co-occurring school token, because `club` and `team` alone
 * would kill Cactus Club Cafe and every sports business in the region.
 */
export const STUDENT_WEAK_RE = /\b(club|society|team|association|chapter|council|committee)\b/i;

/** §3.1 K-ORG-03b. Every token names a body that is a membership organisation BY DEFINITION. */
export const PAID_MEMBERSHIP_HIGH_PRECISION_RE =
  /\b(board\s+of\s+trade|chamber\s+of\s+commerce|chambre\s+de\s+commerce|business\s+improvement\s+(association|area)|bia|rotary\s+club|lions\s+club|kiwanis|kinsmen|toastmasters|bni)\b/i;

/**
 * §3.1 K-ORG-03c. PENALTY ONLY, never a kill: "accelerator" and "incubator" cut both ways —
 * the Enactus Canada Project Accelerators GIVE $2,500 grants.
 */
export const PAID_MEMBERSHIP_BROAD_RE =
  /\b(professional\s+association|trade\s+association|industry\s+association|institute\s+of|association\s+of|society\s+of|federation\s+of|council\s+of|guild|networking\s+group|young\s+professionals|accelerator|incubator|cohort|membership\s+program)\b/i;

/** §3.1 K-ORG-04. */
export const GOV_RE =
  /\b(ministry\s+of|department\s+of|government\s+of|province\s+of|city\s+of|district\s+of|township\s+of|village\s+of|town\s+of|regional\s+district|metro\s+vancouver|translink|crown\s+corporation|public\s+library|school\s+district|health\s+authority|rcmp|elections\s+(bc|canada))\b/i;

/** §3.2 K-CHAN-01. */
export const APPLICATION_GATE_RE =
  /((all|any)\s+(donation|sponsorship|funding)\s+requests?\s+must|submit\s+(your\s+)?(request|application)\s+(through|via|using)|requests?\s+(are\s+)?(only\s+)?(accepted|considered)\s+(through|via)|(application|submission)\s+deadline|complete\s+(the|our)\s+(online\s+)?(form|application)|toutes\s+les\s+demandes\s+doivent|formulaire\s+de\s+demande|date\s+limite\s+(de|des)\s+(soumission|demande))/i;

/** §3.2 K-CHAN-01 — paths probed with an HTTP HEAD by the page-fetch stage. */
export const APPLICATION_GATE_PATHS: readonly string[] = [
  "/donation-request",
  "/donation-requests",
  "/sponsorship-request",
  "/community-investment",
  "/giving",
  "/grants",
  "/apply",
];

/** §3.2 K-CHAN-02. */
export const ELIGIBILITY_RE =
  /(registered\s+charit(y|ies)|charitable\s+registration\s+number|charity\s+registration\s+number|qualified\s+donee|charitable\s+(status|number)|CRA\s+registration|501\(c\)\(3\)|organisme\s+de\s+bienfaisance\s+enregistr|donataire\s+reconnu|num[ée]ro\s+d.enregistrement\s+d.organisme\s+de\s+bienfaisance|statut\s+d.organisme\s+de\s+bienfaisance)/i;

/** §3.2 K-CHAN-02 — the proximity test. The bare phrase is harmless; only a REQUIREMENT bars. */
export const REQUIREMENT_RE =
  /(must\s+be|required|require|only|eligible|eligibility|we\s+(do\s+not|don't|cannot|can't)\s+(fund|support|consider)|doit\s+[êe]tre|seuls?\s+les|admissib|exig|n.accept)/i;

/** §3.2 K-CHAN-02 — the proximity window, in characters either side of the ELIGIBILITY match. */
export const ELIGIBILITY_PROXIMITY_CHARS = 240;

/** §3.6 L-02. Runs in both languages regardless of `source_page_lang`. */
export const NO_SOLICITATION_RE =
  /(no\s+(unsolicited|solicitation|soliciting|spam)|unsolicited\s+(e-?mail|message|commercial)|do\s+not\s+(contact|e-?mail|solicit)|(please\s+)?no\s+(sales|vendor|marketing|cold)\s*(calls|e-?mails|enquiries|inquiries)?|we\s+(do\s+not|don't)\s+accept\s+unsolicited|not\s+for\s+solicitation|this\s+(address|e-?mail)\s+is\s+not\s+for|aucun(e)?\s+sollicitation|pas\s+de\s+sollicitation|ne\s+pas\s+solliciter|message[s]?\s+[ée]lectronique[s]?\s+commerciau?x?\s+non\s+sollicit[ée]s?|courriels?\s+non\s+sollicit[ée]s?|ne\s+(souhaite|veut|d[ée]sire)\s+(pas\s+)?recevoir|aucun\s+d[ée]marchage|ne\s+pas\s+nous\s+contacter)/i;

/** §3.5 placeholder contact names. Measured at 9 of 25 (36%) on the club's own seed data. */
export const PLACEHOLDER_RE =
  /\b(team|department|dept|group|staff|office|owner|gm|manager|director|officer|coordinator|program(me)?s?|relations|partnerships?|committee|to\s+whom|hiring|recruit|community\s+(engagement|investment))\b/i;

/** §3.7 K-REP-01. A legal kill, not a taste judgment. */
export const PROHIBITED_SECTOR_RE =
  /\b(cannabis|marijuana|cannabis\s+(retail|store|shop|co)|tobacco|cigarette|cigar|vape|vaping|e-?cigarette|e-?liquid|smoke\s*shop|head\s*shop)\b/i;

/** §5 step 1, signal S1. */
export const FRANCHISEE_RE =
  /(independently\s+owned\s+and\s+operated|(is\s+an?\s+)?independently\s+owned|locally\s+owned\s+(and\s+operated)?|franchisee\s+of|franchise\s+of|licensed\s+(operator|to\s+operate)|owner[-/\s]operator|owned\s+and\s+operated\s+by|entreprise\s+ind[ée]pendante|franchis[ée](\s+ind[ée]pendant)?|d[ée]tenue\s+et\s+exploit[ée]e\s+ind[ée]pendamment)/i;

/** §5 step 2, signal N3. */
export const CENTRALISED_RE =
  /(all\s+(donation|sponsorship)\s+requests?\s+(are\s+)?(handled|reviewed|managed)\s+(by|through|centrally)|(our\s+)?head\s+office\s+(handles|reviews|manages)|corporate\s+(giving|donations?|sponsorship)\s+(program|team)|(individual\s+)?(locations|stores|restaurants)\s+(do\s+not|cannot|can't)\s+(approve|make|provide)|le\s+si[èe]ge\s+social\s+(traite|g[èe]re)|les\s+demandes\s+sont\s+trait[ée]es\s+centralement)/i;

/** §3.5 D-05. Deliberately conservative: it rejects malformed, it does not certify valid. */
export const EMAIL_SYNTAX_RE = /^[^\s@,;:<>()[\]\\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * §3.5 — conventional role local-parts, aligned with RFC 2142 §§3-5.
 * NOT A KILL. 25 of 25 seeded addresses are role accounts; a role-account kill empties the
 * pipeline. It is P-08, a penalty paired with a hard constraint on the lawful basis.
 */
export const ROLE_LOCALS: ReadonlySet<string> = new Set([
  "info",
  "hello",
  "contact",
  "admin",
  "office",
  "support",
  "help",
  "sales",
  "marketing",
  "media",
  "press",
  "enquiries",
  "inquiries",
  "general",
  "hi",
  "team",
  "mail",
  "reception",
  "sponsorship",
  "sponsorships",
  "partnerships",
  "community",
  "donations",
  "giving",
  "postmaster",
  "webmaster",
  "abuse",
  "noreply",
  "no-reply",
  "donotreply",
]);

/** §3.7 K-REP-02 — sectors that need a human decision. Detection only; the pipeline never decides. */
export const SENSITIVE_SECTOR_PATTERNS: readonly { sector: string; re: RegExp }[] = [
  { sector: "gambling", re: /\b(casino|betting|sportsbook|lottery|gaming)\b/i },
  {
    sector: "payday_lending",
    re: /\b(payday|debt\s+(relief|consolidation)|credit\s+repair)\b/i,
  },
  { sector: "crypto_forex", re: /\b(crypto|forex|cfd|token\s+sale|web3\s+trading)\b/i },
  { sector: "mlm", re: /\b(mlm|multi-?level\s+marketing|direct\s+sales\s+opportunity)\b/i },
  { sector: "firearms", re: /\b(firearm|ammunition|gun\s+(shop|store))\b/i },
  { sector: "political", re: /\b(party\s+of|riding\s+association|campaign\s+for|elect)\b/i },
];

// ===========================================================================
// Helpers
// ===========================================================================

function nameKey(a: Account): string {
  return a.normalized_name ? normalizeName(a.normalized_name) : normalizeName(a.legal_name);
}

function domainKey(a: Account): string {
  return normalizeDomain(a.registrable_domain);
}

function emailLocal(a: Account): string {
  if (a.email_local) return a.email_local.toLowerCase();
  if (a.email && a.email.includes("@")) return a.email.split("@")[0].toLowerCase();
  return "";
}

function emailDomain(a: Account): string {
  if (a.email_domain) return normalizeDomain(a.email_domain);
  if (a.email && a.email.includes("@")) return normalizeDomain(a.email.split("@").pop());
  return "";
}

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 86_400_000;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Add whole months in UTC, clamping the day of month.
 *
 * `Date.prototype.setMonth` overflows (31 May + 9 months lands in March, not February) and reads
 * the local calendar, so a wake date computed with it drifts by both a few days and a timezone.
 * K-REL-07's nine-month wake has to be the same date on every machine.
 */
function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastDayOfTarget),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ),
  );
}

/**
 * The text K-REP-01 and K-REP-02 scan.
 *
 * Both the NORMALISED and the RAW name are included, separated by a token the regexes cannot
 * span. Normalisation turns punctuation into spaces, which silently defeats a pattern like
 * `multi-?level\s+marketing` — "Multi-Level Marketing" normalises to "multi level marketing" and
 * stops matching. Scanning both forms keeps the report's regexes verbatim and still catches the
 * hyphenated spelling.
 */
function sectorHaystack(a: Account): string {
  return [nameKey(a), a.legal_name, a.industry].filter(Boolean).join(" | ");
}

function listEvidence(list: KeyedList, value: string): string {
  return `${list.name}:${value}`;
}

// ===========================================================================
// §3.1 — K-ORG, organisation type
// ===========================================================================

/**
 * K-ORG-01 · Enactus Canada national partner → CHANNEL (`enactus_canada`).
 *
 * Not TERMINAL: the correct action is not "never contact", it is "a different organisation
 * contacts them". Not a penalty either — a penalty leaves the row in the queue and it
 * eventually gets sent, and a chapter email to TD competes with its own national body for the
 * same budget line at 0.8% of the value.
 *
 * varshneycapital.com is deliberately NOT on this list: it hosts a current Enactus SFU partner.
 * The Varshney Family Foundation is excluded by name only.
 */
export function kOrg01NationalPartner(a: Account, lists: QualificationLists, now: Date): PredicateResult {
  const hit = lookupList(lists.nationalPartner, a.registrable_domain, nameKey(a));
  if (!hit) return pass("K-ORG-01");
  return {
    kind: "channel",
    rule_id: "K-ORG-01",
    reason: "national_partner_route_to_enactus_canada",
    detail: hit.entity || hit.value,
    evidence_url: hit.sourceUrl || listEvidence(lists.nationalPartner, hit.value),
    required_channel: "enactus_canada",
    message: sentence("national_partner_route_to_enactus_canada", {
      account: a,
      rule_id: "K-ORG-01",
      verb: "routed to Enactus Canada",
      because:
        `it is an Enactus Canada national partner (${hit.entity || hit.value}) and the chapter ` +
        `must not compete with its own national body for the same corporate budget line`,
      evidence_url: hit.sourceUrl || listEvidence(lists.nationalPartner, hit.value),
      now,
    }),
  };
}

/**
 * §7.2 `LIST_national_flag` · Review, do not kill → FLAG (`human_review`).
 *
 * A SEPARATE LIST FROM §7.1, WITH A SEPARATE OUTCOME. §7.2's own heading is "review, do not kill"
 * and its Kill-mode cell reads "none — `human_review` only", so this emits a FLAG and never a
 * terminal and never the `enactus_canada` channel K-ORG-01 uses. Routing these to the national
 * body would be the over-broad-routing defect in a new place:
 *
 *   - PwC is on the list precisely BECAUSE it is both a named donor and a warm SFU relationship
 *     (the PwC Office Tour). §7.2's words: killing PwC destroys more than the rule protects.
 *   - Scotiabank and Canadian Western Bank are LAPSED, and the report could not distinguish
 *     "ended" from "mid-renewal". The flag is what puts that open question in front of a human
 *     instead of letting the row reach the queue as though nothing were known about it.
 *
 * A flag changes no decision on its own: `runFilter` collects it alongside K-REP-02's and the
 * account keeps being evaluated, keeps accruing penalties and stays in the queue.
 */
export function nationalFlagReview(a: Account, lists: QualificationLists, now: Date): PredicateResult {
  const hit = lookupList(lists.nationalFlag, a.registrable_domain, nameKey(a));
  if (!hit) return pass("LIST-NATIONAL-FLAG");
  const evidence = hit.sourceUrl || listEvidence(lists.nationalFlag, hit.value);
  return {
    kind: "flag",
    rule_id: "LIST-NATIONAL-FLAG",
    reason: "national_flag_needs_human_review",
    flag_reason: "lapsed_or_conflicted_national_relationship",
    detail: hit.entity || hit.value,
    evidence_url: evidence,
    message: sentence("national_flag_needs_human_review", {
      account: a,
      rule_id: "LIST-NATIONAL-FLAG",
      verb: "flagged for human review",
      because:
        `it is on the §7.2 national-flag list as ${hit.entity || hit.value} — ${hit.reason}. ` +
        `This list is review-only: the row is NOT rejected and is NOT routed to Enactus Canada, ` +
        `because the question a human has to answer is whether the national relationship still exists`,
      evidence_url: evidence,
      now,
    }),
  };
}

/**
 * K-ORG-02 · Student organisation at any school → TERMINAL.
 *
 * A student organisation is structurally a competitor for the identical dollar, has no
 * sponsorship budget, and cannot be a sponsor at any price. There is no score at which the
 * answer becomes yes. The `enactus` token deliberately matches other Enactus chapters.
 */
export function kOrg02StudentOrganisation(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const name = nameKey(a);
  const domain = domainKey(a);

  const listed = lookupList(lists.studentOrg, a.registrable_domain, name);
  const edu = lookupDomainOrSubdomain(lists.eduDomains, a.registrable_domain);
  const isEduTld = domain !== "" && (domain === "edu" || domain.endsWith(".edu"));
  const strong = name !== "" && STUDENT_ORG_STRONG_RE.test(name);
  const weakPair = name !== "" && SCHOOL_TOKEN_RE.test(name) && STUDENT_WEAK_RE.test(name);

  if (!listed && !edu && !isEduTld && !strong && !weakPair) return pass("K-ORG-02");

  let because: string;
  let detail: string;
  let evidence: string;
  if (listed) {
    because = `it is on the maintained student-organisation list as ${listed.entity || listed.value}`;
    detail = listed.entity || listed.value;
    evidence = listed.sourceUrl || listEvidence(lists.studentOrg, listed.value);
  } else if (edu) {
    because = `its domain ${domain} is ${edu.value} or a subdomain of it, which is a post-secondary institution`;
    detail = domain;
    evidence = edu.sourceUrl || listEvidence(lists.eduDomains, edu.value);
  } else if (isEduTld) {
    because = `its domain ${domain} is on the .edu TLD`;
    detail = domain;
    evidence = domain;
  } else if (strong) {
    because = `its name "${name}" matches an unambiguous student-organisation token`;
    detail = name;
    evidence = "STUDENT_ORG_STRONG_RE";
  } else {
    because = `its name "${name}" carries both a school token and a club/society token`;
    detail = name;
    evidence = "SCHOOL_TOKEN_RE + STUDENT_WEAK_RE";
  }

  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-ORG-02",
    reason: "student_organisation",
    detail,
    evidence_url: evidence,
    duration: { kind: "until_human_clears" },
    message: sentence("student_organisation", {
      account: a,
      rule_id: "K-ORG-02",
      verb: "rejected",
      because: `${because}. A student organisation draws on the same grant pool Enactus SFU draws on and has no sponsorship budget at any price`,
      evidence_url: evidence,
      now,
    }),
  };
}

/** K-ORG-03a · On the maintained pay-to-join list → TERMINAL. */
export function kOrg03aPaidMembershipList(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const hit = lookupList(lists.paidMembership, a.registrable_domain, nameKey(a));
  if (!hit) return pass("K-ORG-03a");
  const evidence = hit.sourceUrl || listEvidence(lists.paidMembership, hit.value);
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-ORG-03a",
    reason: "pay_to_join_body",
    detail: hit.entity || hit.value,
    evidence_url: evidence,
    duration: { kind: "until_human_clears" },
    message: sentence("pay_to_join_body", {
      account: a,
      rule_id: "K-ORG-03a",
      verb: "rejected",
      because: `it is on the maintained pay-to-join list as ${hit.entity || hit.value}. The club is asking companies to give, not to join`,
      evidence_url: evidence,
      now,
    }),
  };
}

/**
 * K-ORG-03b · High-precision pay-to-join regex → TERMINAL.
 * Safe as a kill because every token names a body you join and pay for by definition.
 */
export function kOrg03bPaidMembershipHighPrecision(a: Account, now: Date): PredicateResult {
  const name = nameKey(a);
  if (name === "" || !PAID_MEMBERSHIP_HIGH_PRECISION_RE.test(name)) return pass("K-ORG-03b");
  const matched = name.match(PAID_MEMBERSHIP_HIGH_PRECISION_RE)?.[0] ?? name;
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-ORG-03b",
    reason: "pay_to_join_body",
    detail: matched,
    evidence_url: "PAID_MEMBERSHIP_HIGH_PRECISION_RE",
    duration: { kind: "until_human_clears" },
    message: sentence("pay_to_join_body", {
      account: a,
      rule_id: "K-ORG-03b",
      verb: "rejected",
      because: `its name contains "${matched}", which names a membership body by definition. The club is asking companies to give, not to join`,
      evidence_url: "PAID_MEMBERSHIP_HIGH_PRECISION_RE",
      now,
    }),
  };
}

/**
 * K-ORG-03c · Broad pay-to-join regex → PENALTY -60 plus a human review queue.
 *
 * Deliberately NOT a kill. "accelerator" and "incubator" cut both ways: the Enactus Canada
 * Project Accelerators give $2,500 grants, so killing on that token would be exactly backwards.
 * This is the deterministic/judgment boundary, drawn honestly — the human decides, the code
 * then enforces the answer from `sector-policy.csv`.
 */
export function kOrg03cPaidMembershipBroad(a: Account, now: Date): PredicateResult {
  const name = nameKey(a);
  if (name === "" || !PAID_MEMBERSHIP_BROAD_RE.test(name)) return pass("K-ORG-03c");
  const matched = name.match(PAID_MEMBERSHIP_BROAD_RE)?.[0] ?? name;
  return {
    kind: "penalty",
    rule_id: "K-ORG-03c",
    reason: "possible_pay_to_join",
    tag: "possible_pay_to_join",
    delta: -60,
    detail: matched,
    evidence_url: "PAID_MEMBERSHIP_BROAD_RE",
    message: sentence("possible_pay_to_join", {
      account: a,
      rule_id: "K-ORG-03c",
      verb: "penalised -60 and queued for human review",
      because: `its name contains "${matched}", which may name a pay-to-join body — but the same token also describes bodies that GIVE grants, so this is never a kill`,
      evidence_url: "PAID_MEMBERSHIP_BROAD_RE",
      now,
    }),
  };
}

/**
 * K-ORG-04 · Government body → CHANNEL (`grants_pipeline`).
 *
 * NOT terminal, and this is a correction to the naive reading: the Museum of Vancouver,
 * Vancouver / Burnaby / Surrey libraries, Trout Lake Community Centre and the Province of BC
 * Ministry of Finance are all real Enactus SFU partners — as venue and delivery partners.
 * What is killed is the sponsorship-EMAIL motion, not the account.
 */
export function kOrg04GovernmentBody(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const domain = domainKey(a);
  const name = nameKey(a);
  const suffixHit = domain !== "" && (domain.endsWith(".gc.ca") || domain.endsWith(".gov.bc.ca"));
  const listed = domain !== "" ? lookupDomainOrSubdomain(lists.govDomains, domain) : null;
  const nameHit = name !== "" && GOV_RE.test(name);

  if (!suffixHit && !listed && !nameHit) return pass("K-ORG-04");

  const detail = suffixHit ? domain : listed ? listed.entity || listed.value : name;
  const evidence = listed
    ? listed.sourceUrl || listEvidence(lists.govDomains, listed.value)
    : suffixHit
      ? domain
      : "GOV_RE";

  return {
    kind: "channel",
    rule_id: "K-ORG-04",
    reason: "government_body_no_sponsorship_channel",
    detail,
    evidence_url: evidence,
    required_channel: "grants_pipeline",
    message: sentence("government_body_no_sponsorship_channel", {
      account: a,
      rule_id: "K-ORG-04",
      verb: "routed to the grants pipeline",
      because: `it is a public body (${detail}). Government money moves through an application in a window, never through a discretionary reply to a cold email — but public institutions ARE real Enactus SFU partners as venue and delivery partners, so the row is rerouted rather than dropped`,
      evidence_url: evidence,
      now,
    }),
  };
}

/**
 * K-ORG-05 · Registered charity, by CRA designation → TERMINAL or CHANNEL.
 *
 * The naive "exclude other charities" rule is wrong. A `Charitable Organization` carries out
 * its own programs and competes for the identical donor dollar. A `Public` or `Private
 * Foundation` primarily FUNDS others and is a legitimate source of money — just not through a
 * sponsorship email. Since the 2022 qualifying-disbursement amendments a registered charity MAY
 * grant to a non-qualified donee like Enactus SFU (CRA CG-032, ≤$5,000 treated as low value).
 *
 * Without the CRA List of charities import this predicate CANNOT EVALUATE. §6 marks it as
 * "computable after one import job" — until then, it must not guess in either direction.
 */
export function kOrg05RegisteredCharity(a: Account, now: Date): PredicateResult {
  if (!a.cra_designation) {
    return cannotEvaluate(
      "K-ORG-05",
      ["cra_designation"],
      "the CRA List of charities designation for this account is not loaded (the open-data import has not run)",
    );
  }
  const evidence =
    "https://open.canada.ca/data/en/dataset/80c00cdb-1358-415c-bb8b-0de7f12675b8";

  if (a.cra_designation === "Charitable Organization") {
    return {
      kind: "terminal",
      scope: "account",
      rule_id: "K-ORG-05",
      reason: "competing_fundraiser",
      detail: a.cra_designation,
      evidence_url: evidence,
      duration: { kind: "until_human_clears" },
      message: sentence("competing_fundraiser", {
        account: a,
        rule_id: "K-ORG-05",
        verb: "rejected",
        because:
          "the CRA designates it a Charitable Organization, meaning it carries out its own programs and raises money from arm's-length donors — it competes for the identical donor dollar and has no sponsorship budget",
        evidence_url: evidence,
        now,
      }),
    };
  }

  return {
    kind: "channel",
    rule_id: "K-ORG-05",
    reason: "grantmaker_route_to_grants_pipeline",
    detail: a.cra_designation,
    evidence_url: evidence,
    required_channel: "grants_pipeline",
    message: sentence("grantmaker_route_to_grants_pipeline", {
      account: a,
      rule_id: "K-ORG-05",
      verb: "routed to the grants pipeline",
      because: `the CRA designates it a ${a.cra_designation}, so it primarily funds others — a legitimate source of money, reachable by application rather than by a sponsorship email`,
      evidence_url: evidence,
      now,
    }),
  };
}

/** K-ORG-06 · Enactus SFU itself, its own ventures, and SFU internal units → TERMINAL. */
export function kOrg06SelfOrInternalUnit(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const hit = lookupList(lists.self, a.registrable_domain, nameKey(a));
  if (!hit) return pass("K-ORG-06");
  const evidence = hit.sourceUrl || listEvidence(lists.self, hit.value);
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-ORG-06",
    reason: "self_or_internal_unit",
    detail: hit.entity || hit.value,
    evidence_url: evidence,
    duration: { kind: "until_human_clears" },
    message: sentence("self_or_internal_unit", {
      account: a,
      rule_id: "K-ORG-06",
      verb: "rejected",
      because: `it is Enactus SFU itself, one of its own ventures, or an SFU internal unit (${hit.entity || hit.value}) — the pipeline was prospecting its own project`,
      evidence_url: evidence,
      now,
    }),
  };
}

// ===========================================================================
// §3.2 — K-SIZE and K-CHAN
// ===========================================================================

/** The observable enterprise proxies of §6 option 2, which replace the headcount field. */
export interface EnterpriseProxyReport {
  fired: string[];
  count: number;
}

export function enterpriseProxies(a: Account): EnterpriseProxyReport {
  const o = a.observations ?? {};
  const fired: string[] = [];
  if (o.has_investor_relations) fired.push("investor_relations_section");
  if (o.has_stock_ticker) fired.push("stock_ticker");
  if ((o.careers_open_postings ?? 0) >= 20) fired.push("careers_20_plus_open_postings");
  if (o.has_supplier_procurement_path) fired.push("supplier_or_procurement_path");
  if (o.has_named_community_investment_programme) fired.push("named_community_investment_programme");
  if ((o.store_locator_location_count ?? 0) >= 25) fired.push("store_locator_25_plus_locations");
  return { fired, count: fired.length };
}

/**
 * K-SIZE-01 · Enterprise scale with no local authority → TERMINAL.
 *
 * The number is 500 because that is ISED's authoritative Canadian line (small 1-99, medium
 * 100-499, large 500+). NOT 100: the club's own converted sponsors include Red Bull, a ~40-studio
 * Modo Yoga network, Rumble, The Old Spaghetti Factory, Waves Coffee House, Browns Socialhouse
 * and Cactus Club Cafe. A threshold at 100 kills every one of them. The tiers describe the ASK
 * size, not the ACCOUNT size. The escape hatch is the §5 franchise carve-out, not a lower number.
 *
 * ⚠️ §6 calls this out as the ONE predicate with a genuine data-availability problem: no free
 * source publishes headcount for BC micro-businesses, Apollo is out of scope in phase 1, and
 * LinkedIn is a hard build constraint. This implements §6's recommended option 2 — observable
 * enterprise proxies, two or more of which stand in for `headcount_band_max >= 500`.
 *
 * A SINGLE proxy does nothing here, and — per contradiction C1 above — nothing anywhere else
 * either. §6 option 2's "One -> P-03 (-20)" arm is NOT implemented: P-03 is defined in §4 as
 * "publicly traded (has a ticker / investor-relations section)", and a /suppliers path is not
 * evidence of that. Cactus Club Cafe publishes Suppliers, has no ticker, and is a PAST ENACTUS
 * SFU PARTNER. So one non-ticker proxy produces no outcome at all, which is the intended
 * behaviour and not an omission. Zero proxies and no headcount is `cannot_evaluate`.
 */
export function kSize01EnterpriseScale(a: Account, now: Date, franchise?: FranchiseStatus): PredicateResult {
  const headcount = a.headcount ?? null;
  const bandMax = a.headcount_band_max ?? null;
  const proxies = enterpriseProxies(a);

  const measuredLarge = (headcount !== null && headcount >= 500) || (bandMax !== null && bandMax >= 500);
  const proxyLarge = proxies.count >= 2;

  if (!measuredLarge && !proxyLarge) {
    if (headcount === null && bandMax === null && proxies.count === 0) {
      return cannotEvaluate(
        "K-SIZE-01",
        ["headcount", "headcount_band_max", "observations.*enterprise proxies"],
        "no headcount is available for this account and no enterprise proxy was observed. §6 records this as a specification bug: no free source publishes headcount for BC micro-businesses",
      );
    }
    return pass("K-SIZE-01");
  }

  // §5 overrides the size kill: a franchise location with local authority is a small local
  // business that happens to share a logo.
  if (franchise === "LOCAL_AUTHORITY") return pass("K-SIZE-01");

  const basis = measuredLarge ? "measured" : "proxy";
  const detail = measuredLarge
    ? `headcount ${headcount ?? bandMax} >= 500`
    : `enterprise proxies: ${proxies.fired.join(", ")}`;

  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-SIZE-01",
    reason: "enterprise_scale_no_local_authority",
    detail: `${detail} (headcount_basis=${basis})`,
    evidence_url: measuredLarge ? "headcount" : proxies.fired.join("+"),
    duration: { kind: "until_human_clears" },
    message: sentence("enterprise_scale_no_local_authority", {
      account: a,
      rule_id: "K-SIZE-01",
      verb: "rejected",
      because: `${detail}, which puts it at ISED "large" scale. At that scale a discretionary $500 does not exist as a decision — it exists only as a named community-investment programme with an application, a window and eligibility criteria. No local decision-making authority was proven (§5 returned ${franchise ?? "no result"})`,
      evidence_url: measuredLarge ? "ISED Key Small Business Statistics" : proxies.fired.join("+"),
      now,
    }),
  };
}

/**
 * K-CHAN-01 · Mandatory application channel published → CHANNEL (`web_form`).
 *
 * Verified live: cactusclubcafe.com/donation-requests/ returns HTTP 200, and Cactus Club Cafe is
 * a PAST Enactus SFU partner — so this must not be terminal. It is a channel change, and a
 * favourable one: a form submission is not a CEM sent by Enactus SFU at all, which sidesteps
 * CASL entirely.
 */
export function kChan01ApplicationChannel(
  a: Account,
  now: Date,
  opts: { application_path_found?: string | null } = {},
): PredicateResult {
  const text = a.source_page_text;
  const pathFound = opts.application_path_found ?? null;

  if (!text && !pathFound) {
    return cannotEvaluate(
      "K-CHAN-01",
      ["source_page_text", "application_path_found"],
      "no page snapshot is stored for this account and no application path was probed",
    );
  }

  const textHit = text ? APPLICATION_GATE_RE.exec(text) : null;
  if (!textHit && !pathFound) return pass("K-CHAN-01");

  const detail = pathFound ?? textHit?.[0] ?? "";
  const evidence = pathFound
    ? `${domainKey(a)}${pathFound}`
    : (a.lawful_basis_url ?? a.website_url ?? "APPLICATION_GATE_RE");

  return {
    kind: "channel",
    rule_id: "K-CHAN-01",
    reason: "apply_via_published_channel_not_email",
    detail,
    evidence_url: evidence,
    required_channel: "web_form",
    message: sentence("apply_via_published_channel_not_email", {
      account: a,
      rule_id: "K-CHAN-01",
      verb: "routed to its published request form",
      because: `it publishes a mandatory application channel ("${detail}"). A form submission is not a commercial electronic message sent by Enactus SFU at all, which sidesteps CASL entirely`,
      evidence_url: evidence,
      now,
    }),
  };
}

/**
 * K-CHAN-02 · Published eligibility rule Enactus SFU cannot satisfy → TERMINAL.
 *
 * Enactus SFU has no charitable registration and cannot obtain one — it is an SFSS club, not a
 * legal entity. This is a permanent structural bar, the same wall that disqualifies it from
 * LinkedIn for Nonprofits, Google for Nonprofits and TechSoup Canada.
 *
 * The proximity test exists because the bare phrase "registered charity" appears on many pages
 * harmlessly; only a REQUIREMENT disqualifies. The escalation route (SFU Advancement, BN
 * 118520725RR0001) is recorded ON the row rather than lost.
 */
export function kChan02IneligibleRequiresCharity(a: Account, now: Date): PredicateResult {
  const text = a.source_page_text;
  if (!text) {
    return cannotEvaluate(
      "K-CHAN-02",
      ["source_page_text"],
      "no page snapshot is stored, so a published eligibility requirement cannot be checked",
    );
  }

  ELIGIBILITY_RE.lastIndex = 0;
  const global = new RegExp(ELIGIBILITY_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) !== null) {
    const start = Math.max(0, match.index - ELIGIBILITY_PROXIMITY_CHARS);
    const end = Math.min(text.length, match.index + match[0].length + ELIGIBILITY_PROXIMITY_CHARS);
    const window = text.slice(start, end);
    if (REQUIREMENT_RE.test(window)) {
      const evidence = a.lawful_basis_url ?? a.website_url ?? "source_page_text";
      return {
        kind: "terminal",
        scope: "account",
        rule_id: "K-CHAN-02",
        reason: "ineligible_requires_registered_charity",
        detail: match[0],
        evidence_url: evidence,
        duration: { kind: "until_human_clears" },
        required_channel: "sfu_advancement",
        message: sentence("ineligible_requires_registered_charity", {
          account: a,
          rule_id: "K-CHAN-02",
          verb: "rejected",
          because: `its published eligibility requires "${match[0]}", and Enactus SFU has no charitable registration and cannot obtain one — it is an SFSS club, not a legal entity. Where a receipt is genuinely needed the route is SFU Advancement (BN 118520725RR0001) or Enactus Canada (BN 859975534RR0001), which is recorded on this row`,
          evidence_url: evidence,
          now,
        }),
      };
    }
  }
  return pass("K-CHAN-02");
}

// ===========================================================================
// §3.3 — K-GEO, geography
// ===========================================================================

/**
 * Every geography question in this module goes through `resolveGeography` in
 * qualification-lists.ts. There is no second BC-spelling set and no second alias reading here:
 * the filter and the scorer disagreeing about where a company is was a real defect in both
 * directions, so the decision lives in one place and both modules consume it.
 */
function geographyOf(a: Account, lists: QualificationLists): GeographyVerdict {
  return resolveGeography(
    {
      municipality: a.address_municipality,
      region: a.address_region,
      country: a.address_country,
      postal_code: a.postal_code,
    },
    lists,
  );
}

/** Resolve a municipality name to its Metro Vancouver canonical jurisdictions, if any. */
export function metroVancouverJurisdictions(
  municipality: string | null | undefined,
  lists: QualificationLists,
): string[] {
  return metroVancouverCanonicals(municipality, lists);
}

/**
 * Whether a municipality sits in Metro Vancouver, given whatever region was recorded ALONGSIDE
 * it. The region is not optional decoration: "Richmond" with region "VA" is not in scope, and a
 * municipality-only signature invited exactly that mistake.
 */
export function isInMetroVancouver(
  municipality: string | null | undefined,
  lists: QualificationLists,
  region?: string | null,
  country?: string | null,
  postal_code?: string | null,
): boolean {
  return (
    resolveGeography({ municipality, region, country, postal_code }, lists).band ===
    "metro_vancouver"
  );
}

/**
 * K-GEO-01 · Outside Canada → TERMINAL, and the ONLY geographic terminal that survives the
 * 2026-08-06 supersession. Everywhere in Canada is in scope; where in Canada is a WEIGHT.
 */
export function kGeo01OutsideCanada(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const geo = geographyOf(a, lists);
  if (geo.band === "unresolved") {
    return cannotEvaluate(
      "K-GEO-01",
      geo.missing_fields.map((f) => `address_${f}`),
      a.address_country
        ? `the recorded country "${a.address_country}" matches nothing this module recognises, and no other field places the account; an unrecognised value is never a kill (§2.3)`
        : "no country is recorded; a missing country is never a kill (§2.3)",
    );
  }
  if (geo.band !== "outside_canada") return pass("K-GEO-01");

  const detail = a.address_country ?? "";
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-GEO-01",
    reason: "outside_canada",
    detail,
    evidence_url: a.website_url ?? domainKey(a),
    duration: { kind: "until_human_clears" },
    message: sentence("outside_canada", {
      account: a,
      rule_id: "K-GEO-01",
      verb: "rejected",
      because: `its recorded country is ${detail}, which is outside Canada`,
      evidence_url: a.website_url ?? domainKey(a),
      now,
    }),
  };
}

/*
 * K-GEO-02 (outside_bc TERMINAL) and K-GEO-03 / P-01 (outside_metro_vancouver, -25) USED TO LIVE
 * HERE. Both were retired by the 2026-08-06 supersession recorded at the head of this file:
 * everywhere in Canada is in scope, and where in Canada is expressed ONCE, as the geography band
 * weight in config/icp.yaml. Charging a penalty as well would count one fact twice.
 */

/**
 * K-GEO-04 · Phone area code — EXPLICITLY NOT A KILL, and the obvious version is wrong.
 *
 * 604 is the only Lower-Mainland-specific NPA, and it still reaches Squamish, Whistler, the
 * Sunshine Coast and the Fraser Valley to Hope. 778, 236, 672 and 257 are PROVINCE-WIDE
 * overlays covering both 604 and 250 territory, so they carry no geographic information within
 * BC and must not influence any predicate.
 *
 * Writing `area code ∈ {604,778,236,672} ⇒ Metro Vancouver` would be a wrong rule that looks
 * right. This function exists so nobody re-derives it.
 */
export type AreaCodeSignal = "weak_positive_bc" | "no_geographic_information" | "non_bc" | "none";

export const BC_PROVINCE_WIDE_OVERLAYS: readonly string[] = ["778", "236", "672", "257"];

export function areaCodeSignal(a: Account): AreaCodeSignal {
  const phone = a.phone_e164;
  if (!phone) return "none";
  const m = /^\+1(\d{3})/.exec(phone.replace(/[^\d+]/g, ""));
  if (!m) return "none";
  const npa = m[1];
  if (npa === "604") return "weak_positive_bc";
  if (BC_PROVINCE_WIDE_OVERLAYS.includes(npa)) return "no_geographic_information";
  if (npa === "250") return "no_geographic_information";
  return "non_bc";
}

// ===========================================================================
// §3.4 — K-REL, relationship state
// ===========================================================================

export interface RelationshipOptions {
  /** The sponsorship cycle currently being worked, e.g. "2026-27". */
  current_cycle?: string | null;
}

/**
 * The suppression terminal, rendered under whichever rule id fired it.
 *
 * §2.5 requires the rendered sentence to name the rule that fired. The same predicate appears
 * twice in the spec — as L-01 in the §2.4 evaluation order and as K-REL-01 in §3.4 — so the id
 * is a parameter rather than a field rewritten after the sentence was built.
 */
function suppressionTerminal(a: Account, at: string, rule_id: string, now: Date): TerminalResult {
  return {
    kind: "terminal",
    scope: "account",
    rule_id,
    reason: "suppressed_do_not_contact",
    detail: at,
    evidence_url: "suppression list",
    duration: { kind: "forever" },
    recheck: "every_send",
    message: sentence("suppressed_do_not_contact", {
      account: a,
      rule_id,
      verb: "rejected permanently",
      because: `it was suppressed on ${at}. CASL s.11 requires an unsubscribe to be honoured within 10 business days and the suppression to be permanent and global. This rule is checked before every send and is not overridden by any allowlist`,
      evidence_url: "suppression list",
      now,
    }),
  };
}

/** K-REL-01 · Suppressed → TERMINAL, irreversible, forever. Also L-01 in the evaluation order. */
export function kRel01Suppressed(a: Account, now: Date): PredicateResult {
  const at = a.rel?.suppressed_at;
  if (!at) return pass("K-REL-01");
  return suppressionTerminal(a, at, "K-REL-01", now);
}

/** K-REL-02 · Already routed to Enactus Canada → CHANNEL until a human clears it. */
export function kRel02RoutedToNational(a: Account, now: Date): PredicateResult {
  const at = a.rel?.routed_to_national_at;
  if (!at) return pass("K-REL-02");
  return {
    kind: "channel",
    rule_id: "K-REL-02",
    reason: "routed_to_enactus_canada",
    detail: at,
    evidence_url: "rel.routed_to_national_at",
    required_channel: "enactus_canada",
    message: sentence("routed_to_enactus_canada", {
      account: a,
      rule_id: "K-REL-02",
      verb: "held at the Enactus Canada channel",
      because: `it was routed to the national body on ${at} and no human has cleared it`,
      evidence_url: "rel.routed_to_national_at",
      now,
    }),
  };
}

/**
 * K-REL-03 · Already a sponsor this cycle → CHANNEL `renewal_motion`.
 * A current sponsor must not receive a cold acquisition email; they belong in the renewals
 * motion, which is where the money is.
 */
export function kRel03AlreadySponsorThisCycle(
  a: Account,
  now: Date,
  opts: RelationshipOptions = {},
): PredicateResult {
  const cycle = opts.current_cycle;
  if (!cycle) {
    return cannotEvaluate(
      "K-REL-03",
      ["current_cycle"],
      "the current sponsorship cycle was not supplied, so prior-cycle membership cannot be tested",
    );
  }
  const cycles = a.rel?.sponsor_cycles ?? [];
  if (!cycles.includes(cycle)) return pass("K-REL-03");
  return {
    kind: "channel",
    rule_id: "K-REL-03",
    reason: "already_sponsor_this_cycle",
    detail: cycle,
    evidence_url: "rel.sponsor_cycles",
    required_channel: "renewal_motion",
    message: sentence("already_sponsor_this_cycle", {
      account: a,
      rule_id: "K-REL-03",
      verb: "moved to the renewals motion",
      because: `it is already a sponsor in cycle ${cycle}, and a current sponsor must never receive a cold acquisition email`,
      evidence_url: "rel.sponsor_cycles",
      now,
    }),
  };
}

/** K-REL-04 · Contacted within 90 days → HOLD. Timing, not merit. Not a kill. */
export function kRel04ContactedRecently(a: Account, now: Date): PredicateResult {
  const at = parseDate(a.rel?.last_contacted_at);
  if (!at) return pass("K-REL-04");
  const days = daysBetween(now, at);
  if (days > 90) return pass("K-REL-04");
  return {
    kind: "hold",
    rule_id: "K-REL-04",
    reason: "contacted_recently",
    detail: `${Math.floor(days)} days ago`,
    evidence_url: "rel.last_contacted_at",
    message: sentence("contacted_recently", {
      account: a,
      rule_id: "K-REL-04",
      verb: "held",
      because: `it was contacted ${Math.floor(days)} days ago, inside the 90-day window. A second touch after a quarter is normal, so the row is held rather than dropped`,
      evidence_url: "rel.last_contacted_at",
      now,
    }),
  };
}

/**
 * K-REL-05 · Declined within 12 months (for a reason other than timing) → TERMINAL for this
 * cycle, auto-clearing.
 *
 * 12 months, reasoned from the club's annual exec turnover: shorter re-asks a prospect within a
 * single exec's tenure, which is the behaviour that gets a club blacklisted; longer loses a
 * prospect whose circumstances changed.
 */
export const DECLINE_SUPPRESSION_MONTHS = 12;

export function kRel05DeclinedRecently(a: Account, now: Date): PredicateResult {
  const at = parseDate(a.rel?.declined_at);
  if (!at) return pass("K-REL-05");
  const reason = a.rel?.declined_reason ?? null;
  if (reason === "timing" || reason === "budget_cycle") return pass("K-REL-05");
  const clearsAt = addMonthsUtc(at, DECLINE_SUPPRESSION_MONTHS);
  if (now.getTime() >= clearsAt.getTime()) return pass("K-REL-05");
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-REL-05",
    reason: "declined_within_12_months",
    detail: `${a.rel?.declined_at} (${reason ?? "no reason recorded"})`,
    evidence_url: "rel.declined_at",
    duration: {
      kind: "until",
      clears_at: clearsAt.toISOString(),
      window: `${DECLINE_SUPPRESSION_MONTHS} months`,
    },
    message: sentence("declined_within_12_months", {
      account: a,
      rule_id: "K-REL-05",
      verb: "rejected for this cycle",
      because: `it declined on ${a.rel?.declined_at} (reason: ${reason ?? "not recorded"}), inside the 12-month suppression window. The window clears automatically so the NEXT exec team may ask again`,
      evidence_url: "rel.declined_at",
      now,
    }),
  };
}

/** K-REL-06 · Declined the category permanently → TERMINAL forever. */
export function kRel06DeclinedPermanently(a: Account, now: Date): PredicateResult {
  const reason = a.rel?.declined_reason;
  if (reason !== "never_contact_us" && reason !== "policy_no_student_groups") {
    return pass("K-REL-06");
  }
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-REL-06",
    reason: "declined_permanently",
    detail: reason,
    evidence_url: "rel.declined_reason",
    duration: { kind: "forever" },
    message: sentence("declined_permanently", {
      account: a,
      rule_id: "K-REL-06",
      verb: "rejected permanently",
      because: `it recorded "${reason}", which is an explicit refusal of the category rather than of the ask`,
      evidence_url: "rel.declined_reason",
      now,
    }),
  };
}

/** K-REL-07 · Declined on timing → PENALTY -10, wake at declined_at + 9 months. */
export function kRel07DeclinedOnTiming(a: Account, now: Date): PredicateResult {
  const at = parseDate(a.rel?.declined_at);
  const reason = a.rel?.declined_reason;
  if (!at || (reason !== "timing" && reason !== "budget_cycle")) return pass("K-REL-07");
  const wake = addMonthsUtc(at, 9);
  return {
    kind: "penalty",
    rule_id: "K-REL-07",
    reason: "declined_on_timing",
    tag: "declined_on_timing",
    delta: -10,
    detail: `wake at ${wake.toISOString().slice(0, 10)}`,
    evidence_url: "rel.declined_at",
    message: sentence("declined_on_timing", {
      account: a,
      rule_id: "K-REL-07",
      verb: "penalised -10",
      because: `it declined on ${a.rel?.declined_at} for "${reason}". A "not this year" is a scheduling fact, not a rejection — wake this row at ${wake.toISOString().slice(0, 10)}`,
      evidence_url: "rel.declined_at",
      now,
    }),
  };
}

/** §3.4 K-REL-08 · the cross-record half of the dual outcome. */
export const HARD_BOUNCE_SIBLING_DELTA = -40;

/**
 * K-REL-08 · Hard bounce → TERMINAL for the address, forever; PENALTY −40 on every OTHER lead
 * sharing `email_domain`.
 *
 * A dual outcome. The terminal half is address-scoped, so this account survives with its address
 * cleared. The −40 half lands on DIFFERENT records, which is neither a scope nor a duration, so
 * it is emitted as a `SiblingPenalty` the caller applies — describing it only in the rendered
 * sentence would leave it permanently unenforced.
 *
 * ENTRY CONDITION on the cross-record half: the shared domain must be a domain that actually
 * implies shared ownership. A free-mail provider does not — `@gmail.com` is shared by unrelated
 * businesses, and D-07 already exempts the same list for the same reason. Without this, one
 * bounced `info@gmail.com` levies the largest penalty in §4 on every free-mail lead in the
 * corpus. See the REPORT CONTRADICTIONS note at the head of this file.
 *
 * `lists` is REQUIRED, not optional. An optional parameter makes that exemption reachable-around
 * by omitting an argument — `lists?.freeMailProviders…` yields undefined, `!undefined` is true,
 * and every free-mail domain is treated as shared ownership again. A safety exemption the type
 * system does not enforce is not an exemption.
 */
export function kRel08HardBounced(
  a: Account,
  now: Date,
  lists: Pick<QualificationLists, "freeMailProviders">,
): PredicateResult {
  const at = a.rel?.bounced_hard_at;
  if (!at) return pass("K-REL-08");
  const rawDomain = emailDomain(a);
  const address = a.email ?? "";
  const outcome = siblingOutcome(rawDomain, address, at, lists, now);
  return {
    kind: "terminal",
    scope: "address",
    rule_id: "K-REL-08",
    reason: "undeliverable",
    detail: at,
    evidence_url: "rel.bounced_hard_at",
    duration: { kind: "forever" },
    message: sentence("undeliverable", {
      account: a,
      rule_id: "K-REL-08",
      verb: "rejected at this address",
      because: `mail to it hard-bounced on ${at}. The address is dead forever${siblingClause(outcome)}`,
      evidence_url: "rel.bounced_hard_at",
      now,
    }),
    sibling_penalty: outcome.levied ?? undefined,
  };
}

/**
 * Whether the −40 lands on siblings, and if not, WHY not.
 *
 * The two silences are different facts: a free-mail domain implies no shared ownership, while a
 * re-filtered row simply no longer carries the address it bounced from — `runFilter` cleared
 * `email`/`email_domain` under the address-scoped terminal while `rel.bounced_hard_at` stayed.
 * Modelling them as one empty string let the sentence assert the free-mail explanation for an
 * account whose address was corporate.
 */
type SiblingOutcome =
  | { levied: SiblingPenalty; suppressed_because: null }
  | { levied: null; suppressed_because: "free_mail_provider"; domain: string }
  | { levied: null; suppressed_because: "no_email_domain_on_record" };

function siblingOutcome(
  rawDomain: string,
  address: string,
  occurredAt: string,
  lists: Pick<QualificationLists, "freeMailProviders">,
  now: Date,
): SiblingOutcome {
  if (!rawDomain) return { levied: null, suppressed_because: "no_email_domain_on_record" };
  if (lists.freeMailProviders.domains.has(rawDomain)) {
    return { levied: null, suppressed_because: "free_mail_provider", domain: rawDomain };
  }
  return {
    levied: {
      match_field: "email_domain",
      match_value: rawDomain,
      rule_id: "K-REL-08",
      reason: "undeliverable",
      tag: "sibling_domain_hard_bounced",
      delta: HARD_BOUNCE_SIBLING_DELTA,
      occurred_at: occurredAt,
      cause_address: address,
      message: siblingBounceSentence(rawDomain, address, occurredAt, now),
    },
    suppressed_because: null,
  };
}

/**
 * The clause is DERIVED from the outcome, never written beside it, so the sentence cannot claim
 * a penalty the return value does not carry. The `never` arm makes a new outcome a compile
 * error rather than a silently unrendered case.
 */
function siblingClause(outcome: SiblingOutcome): string {
  if (outcome.levied) {
    return (
      `; every other lead sharing ${outcome.levied.match_value} takes a ` +
      `${outcome.levied.delta} penalty but stays in the queue`
    );
  }
  switch (outcome.suppressed_because) {
    case "free_mail_provider":
      return (
        `, and no other lead is penalised because ${outcome.domain} is a free-mail provider ` +
        `that implies no shared ownership`
      );
    case "no_email_domain_on_record":
      return (
        ", and no other lead is penalised because this row records no email domain to match " +
        "siblings on — the address it bounced from is no longer on the record"
      );
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/**
 * The §2.5 sentence for the row the sibling penalty is APPLIED to, which is never the row that
 * bounced. Its subject is the shared domain and the bounce event, so it stays true whichever
 * sibling receives it, and it states the outcome that row actually gets: a lower score, not a
 * rejection.
 */
function siblingBounceSentence(
  domain: string,
  causeAddress: string,
  occurredAt: string,
  now: Date,
): string {
  const cause = causeAddress ? `${causeAddress}, another address on ${domain},` : `another address on ${domain}`;
  return (
    `sibling_domain_hard_bounced — this lead is penalised ${HARD_BOUNCE_SIBLING_DELTA} because ` +
    `${cause} hard-bounced on ${occurredAt}, which is evidence that mail to ${domain} may not ` +
    `be delivered. This lead is NOT rejected: it stays in the queue with a lower score. ` +
    `(rule K-REL-08, evidence: rel.bounced_hard_at, checked ${iso(now)})`
  );
}

// ===========================================================================
// §3.5 — K-DELIV, deliverability
// ===========================================================================

/** D-01 · No nameservers after 2 attempts against 2 independent resolvers → TERMINAL. */
export function d01DeadDomain(a: Account, now: Date): PredicateResult {
  const dns = a.dns;
  if (!dns || dns.ns_present === null || dns.ns_present === undefined) {
    return cannotEvaluate("D-01", ["dns.ns_present"], "no DNS resolution result is recorded");
  }
  if (dns.ns_present) return pass("D-01");
  const attempts = dns.resolver_attempts ?? 0;
  if (attempts < 2) {
    return cannotEvaluate(
      "D-01",
      ["dns.resolver_attempts"],
      `the domain did not resolve, but only ${attempts} resolver attempt(s) are recorded. D-01 requires two attempts against two independent resolvers before it may kill`,
    );
  }
  const domain = domainKey(a);
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "D-01",
    reason: "dead_domain",
    detail: domain,
    evidence_url: domain,
    duration: { kind: "until_human_clears" },
    message: sentence("dead_domain", {
      account: a,
      rule_id: "D-01",
      verb: "rejected",
      because: `${domain} has no nameservers after ${attempts} attempts against independent resolvers — the domain is not registered`,
      evidence_url: domain,
      now,
    }),
  };
}

/** D-02 · Nameservers on a domain marketplace / parking host → TERMINAL. */
export function d02ParkedDomain(a: Account, lists: QualificationLists, now: Date): PredicateResult {
  const hosts = a.dns?.ns_hosts;
  if (!hosts || hosts.length === 0) {
    return cannotEvaluate("D-02", ["dns.ns_hosts"], "no nameserver hosts are recorded");
  }
  for (const host of hosts) {
    const h = normalizeDomain(host);
    for (const [parked, entry] of lists.parkingNameservers.domains) {
      if (h === parked || h.endsWith(`.${parked}`)) {
        return {
          kind: "terminal",
          scope: "account",
          rule_id: "D-02",
          reason: "parked_or_for_sale_domain",
          detail: h,
          evidence_url: entry.sourceUrl || listEvidence(lists.parkingNameservers, parked),
          duration: { kind: "until_human_clears" },
          message: sentence("parked_or_for_sale_domain", {
            account: a,
            rule_id: "D-02",
            verb: "rejected",
            because: `its nameserver ${h} belongs to ${entry.entity || parked}, a domain marketplace or parking service — the domain is for sale, not a business`,
            evidence_url: entry.sourceUrl || listEvidence(lists.parkingNameservers, parked),
            now,
          }),
        };
      }
    }
  }
  return pass("D-02");
}

/** D-03 · Resolves but has neither MX nor A → TERMINAL. */
export function d03CannotReceiveMail(a: Account, now: Date): PredicateResult {
  const dns = a.dns;
  if (!dns || dns.ns_present == null || dns.mx_present == null || dns.a_present == null) {
    return cannotEvaluate(
      "D-03",
      ["dns.ns_present", "dns.mx_present", "dns.a_present"],
      "the DNS record set is incomplete",
    );
  }
  if (!(dns.ns_present && !dns.mx_present && !dns.a_present)) return pass("D-03");
  const domain = domainKey(a);
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "D-03",
    reason: "domain_cannot_receive_mail",
    detail: domain,
    evidence_url: domain,
    duration: { kind: "until_human_clears" },
    message: sentence("domain_cannot_receive_mail", {
      account: a,
      rule_id: "D-03",
      verb: "rejected",
      because: `${domain} has nameservers but publishes neither an MX record nor an A record, so there is nowhere for mail to be delivered`,
      evidence_url: domain,
      now,
    }),
  };
}

/**
 * D-04 · No MX, an A record, and port 25 closed → CHANNEL (`web_form` / `phone`).
 *
 * This sharpens the evidence base rather than restating it. RFC 5321 §5.1 provides an implicit
 * MX fallback to the A record, so absence of MX alone does NOT prove undeliverability. The
 * correct test is: no MX → attempt a short-timeout TCP connect to port 25 on the A record; only
 * if that also fails is the address undeliverable. And even then it is a channel change, not a
 * kill — the business is real, email is just the wrong instrument.
 */
export function d04NoMailExchanger(a: Account, now: Date): PredicateResult {
  const dns = a.dns;
  if (!dns || dns.mx_present == null || dns.a_present == null) {
    return cannotEvaluate("D-04", ["dns.mx_present", "dns.a_present"], "the DNS record set is incomplete");
  }
  if (dns.mx_present || !dns.a_present) return pass("D-04");
  if (dns.smtp25_open == null) {
    return cannotEvaluate(
      "D-04",
      ["dns.smtp25_open"],
      `${domainKey(a)} publishes no MX but does publish an A record. RFC 5321 §5.1 allows an implicit MX fallback to that A record, so port 25 must be probed before concluding anything`,
    );
  }
  if (dns.smtp25_open) return pass("D-04");
  const domain = domainKey(a);
  return {
    kind: "channel",
    rule_id: "D-04",
    reason: "no_mail_exchanger",
    detail: domain,
    evidence_url: domain,
    required_channel: "web_form",
    message: sentence("no_mail_exchanger", {
      account: a,
      rule_id: "D-04",
      verb: "routed off email",
      because: `${domain} publishes no MX record and its A-record host refuses connections on port 25, so the implicit MX fallback fails too. The business is real; email is the wrong instrument`,
      evidence_url: domain,
      now,
    }),
  };
}

/** D-05 · Malformed address → TERMINAL for the address (not for the account). */
export function d05MalformedEmail(a: Account, now: Date): PredicateResult {
  if (!a.email) {
    return cannotEvaluate("D-05", ["email"], "no email address is recorded for this account");
  }
  if (EMAIL_SYNTAX_RE.test(a.email)) return pass("D-05");
  return {
    kind: "terminal",
    scope: "address",
    rule_id: "D-05",
    reason: "malformed_email",
    detail: a.email,
    evidence_url: "email",
    duration: { kind: "until_human_clears" },
    message: sentence("malformed_email", {
      account: a,
      rule_id: "D-05",
      verb: "rejected at this address",
      because: `"${a.email}" is not a syntactically valid address. The ACCOUNT is untouched — return it to person discovery`,
      evidence_url: "email",
      now,
    }),
  };
}

/** D-06 · Disposable mailbox provider → TERMINAL. */
export function d06DisposableEmailDomain(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const domain = emailDomain(a);
  if (!domain) {
    return cannotEvaluate("D-06", ["email_domain"], "no email domain is recorded");
  }
  const hit = lists.disposableDomains.domains.get(domain);
  if (!hit) return pass("D-06");
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "D-06",
    reason: "disposable_email_domain",
    detail: domain,
    evidence_url: hit.sourceUrl || listEvidence(lists.disposableDomains, domain),
    duration: { kind: "until_human_clears" },
    message: sentence("disposable_email_domain", {
      account: a,
      rule_id: "D-06",
      verb: "rejected",
      because: `its address is on ${domain}, a disposable mailbox provider`,
      evidence_url: hit.sourceUrl || listEvidence(lists.disposableDomains, domain),
      now,
    }),
  };
}

/**
 * D-07 · Address on a third party's corporate domain → TERMINAL for the address.
 *
 * Free providers are exempt: a Vancouver bakery legitimately uses `@gmail.com`. The kill is for
 * an address on SOMEONE ELSE'S corporate domain, which is how you email the wrong company.
 */
export function d07EmailDomainMismatch(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const mail = emailDomain(a);
  const site = domainKey(a);
  if (!mail) return cannotEvaluate("D-07", ["email_domain"], "no email domain is recorded");
  if (!site) {
    return cannotEvaluate(
      "D-07",
      ["registrable_domain"],
      "no company domain is recorded, so the address cannot be compared against it",
    );
  }
  // `mail` is derived from the raw address, so it is a HOST, not necessarily a registrable
  // domain: `info@mail.example.ca` yields `mail.example.ca`. A host under the company's own
  // domain is the company's own domain — the kill is for a THIRD PARTY's domain.
  if (isDomainOrSubdomainOf(mail, site)) return pass("D-07");
  if (lists.freeMailProviders.domains.has(mail)) return pass("D-07");
  return {
    kind: "terminal",
    scope: "address",
    rule_id: "D-07",
    reason: "email_domain_mismatch",
    detail: `${mail} != ${site}`,
    evidence_url: "email_domain",
    duration: { kind: "until_human_clears" },
    message: sentence("email_domain_mismatch", {
      account: a,
      rule_id: "D-07",
      verb: "rejected at this address",
      because: `its address is on ${mail} while the company's domain is ${site}, and ${mail} is not a free-mail provider — emailing it would reach a different company`,
      evidence_url: "email_domain",
      now,
    }),
  };
}

/**
 * Role account detection. NOT A KILL — see P-08.
 *
 * 25 of 25 seeded addresses are role accounts (`info@` x11, `hello@` x8, `sponsorship@` x2,
 * `mediarelations@` x1, `makegoodnow@` x1). A role-account kill would empty the pipeline. What
 * a role account DOES carry is a real legal weakness: relevance to a person's role is hard to
 * establish for a shared mailbox, so the penalty is paired with a hard constraint forbidding
 * `lawful_basis = conspicuous_pub`.
 *
 * LIMIT, stated rather than papered over: this recognises the conventional role shape. A BRANDED
 * PROGRAMME mailbox does not have one — `makegoodnow@` is a real seeded example, and no fixed
 * list or prefix rule will ever hold it. Missing one costs a -15 penalty, never a wrong kill,
 * which is the safe direction to fail in.
 */
export function isRoleAccount(a: Account): boolean {
  const local = emailLocal(a);
  if (!local) return false;
  if (ROLE_LOCALS.has(local)) return true;
  // Compound conventional locals such as `mediarelations@`, which no exact-match list holds.
  return /^(media|press|info|hello|contact|sponsor|partner|community|donation|giving|support|general|admin|office|team)/.test(
    local,
  );
}

/**
 * Placeholder contact name → TERMINAL FOR THE PERSON, never for the account.
 *
 * Measured at 9 of 25 (36%) on the club's own seed data: Community Engagement Team, Corporate
 * Relations, Owner / GM, Owner, Community Investment Team, Make Good Happen Program,
 * Programs & Partnerships, Program Officer, Program Director.
 *
 * The remedy is to clear `contact_name` / `contact_title` and return the account to person
 * discovery. NEVER drop the account.
 */
export function placeholderContactName(a: Account, now: Date): PredicateResult {
  const name = a.contact_name;
  if (!name || name.trim() === "") {
    return cannotEvaluate("PLACEHOLDER", ["contact_name"], "no contact name is recorded");
  }
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const tooFew = tokens.length < 2;
  const matched = PLACEHOLDER_RE.exec(name);
  if (!tooFew && !matched) return pass("PLACEHOLDER");

  const because = tooFew
    ? `"${name}" is a single token, not a given name and a family name`
    : `"${name}" contains the role word "${matched?.[0]}"`;

  return {
    kind: "terminal",
    scope: "person",
    rule_id: "PLACEHOLDER",
    reason: "placeholder_contact_name",
    detail: name,
    evidence_url: "contact_name",
    duration: { kind: "until_human_clears" },
    message: sentence("placeholder_contact_name", {
      account: a,
      rule_id: "PLACEHOLDER",
      verb: "rejected as a PERSON (the account is untouched)",
      because: `${because}, so it is a role rather than a human. Clear contact_name and contact_title and return the account to person discovery`,
      evidence_url: "contact_name",
      now,
    }),
  };
}

// ===========================================================================
// §3.6 — K-LEGAL, consent, provenance and contactability
// ===========================================================================

/** L-01 · On the suppression list → TERMINAL, checked before every send, forever. */
export function l01Suppressed(a: Account, now: Date): PredicateResult {
  const at = a.rel?.suppressed_at;
  if (!at) return pass("L-01");
  return suppressionTerminal(a, at, "L-01", now);
}

/**
 * L-02 · A no-solicitation statement at the source → TERMINAL for email.
 *
 * CASL s.10(9)(b) makes implied consent unavailable where the publication IS accompanied by a
 * statement that the person does not wish to receive unsolicited commercial electronic
 * messages. The scan runs the full bilingual pattern regardless of `source_page_lang`, because
 * a bilingual page may carry the notice in only one language.
 */
export function l02NoSolicitationStatement(a: Account, now: Date): PredicateResult {
  const text = a.source_page_text;
  if (!text) {
    return cannotEvaluate(
      "L-02",
      ["source_page_text"],
      "no page snapshot is stored, so the CASL s.10(9)(b) no-solicitation scan cannot run",
    );
  }
  const matched = NO_SOLICITATION_RE.exec(text);
  if (!matched) return pass("L-02");
  const evidence = a.lawful_basis_url ?? a.website_url ?? "source_page_text";
  return {
    kind: "terminal",
    scope: "email",
    rule_id: "L-02",
    reason: "no_solicitation_statement_at_source",
    detail: matched[0],
    evidence_url: evidence,
    duration: { kind: "until_human_clears" },
    message: sentence("no_solicitation_statement_at_source", {
      account: a,
      rule_id: "L-02",
      verb: "rejected for email",
      because: `the page the address was published on says "${matched[0]}". CASL s.10(9)(b) makes implied consent unavailable when the publication carries such a statement`,
      evidence_url: evidence,
      now,
    }),
  };
}

/**
 * L-03 · Harvested address → TERMINAL. The most consequential single rule in the spec.
 *
 * PIPEDA s.7.1(2) switches OFF every without-consent exception for an address collected by a
 * program designed or marketed primarily for generating, searching for and collecting electronic
 * addresses. CASL s.20(3)(c) then makes a prior s.7.1(2) contravention an aggravating factor
 * when the CRTC sets a penalty — the two statutes are deliberately wired together.
 *
 * So a harvested address is not merely low quality: USING IT IS PROHIBITED, and the whole
 * conspicuous-publication argument collapses with it. `collection_method` must be written at
 * collection time; it cannot be backfilled, because nobody will remember later.
 */
export const PROHIBITED_COLLECTION_METHODS: ReadonlySet<CollectionMethod> = new Set<CollectionMethod>(
  ["email_finder", "bulk_crawler", "enrichment_api"],
);

export function l03HarvestedAddress(a: Account, now: Date): PredicateResult {
  const method = a.collection_method;
  if (!method) {
    return cannotEvaluate(
      "L-03",
      ["collection_method"],
      "how this address was obtained was never recorded. §6 and §10 both flag this: the column must be written at collection time on day one, because it cannot be backfilled",
    );
  }
  if (!PROHIBITED_COLLECTION_METHODS.has(method)) return pass("L-03");
  return {
    kind: "terminal",
    scope: "account",
    rule_id: "L-03",
    reason: "harvested_address_prohibited",
    detail: method,
    evidence_url: "collection_method",
    duration: { kind: "until_human_clears" },
    message: sentence("harvested_address_prohibited", {
      account: a,
      rule_id: "L-03",
      verb: "rejected",
      because: `it was collected by ${method}. PIPEDA s.7.1(2) switches off every without-consent exception for an address collected that way, and CASL s.20(3)(c) makes the contravention an aggravating factor at penalty. Using it is prohibited, not merely low quality`,
      evidence_url: "collection_method",
      now,
    }),
  };
}

/**
 * L-04 · "Publicly available" is not "conspicuously published" → TERMINAL for email.
 *
 * The CRTC's own words: the conspicuous-publication exemption sets a HIGHER standard than the
 * simple public availability of electronic addresses, and Blackstone Learning Corp. (2016) held
 * that addresses harvested from government web pages did not establish implied consent. The
 * deterministic proxy: the address must have been published on the account's OWN domain or on a
 * tier-1 first-party source. A directory, an aggregator or a third-party listing fails.
 */
export const TIER1_SOURCES: readonly string[] = [
  "sfu.ca",
  "enactussfu.ca",
  "enactussfu.com",
  "enactus.ca",
];

export function l04NotConspicuouslyPublished(a: Account, now: Date): PredicateResult {
  if (a.lawful_basis !== "conspicuous_pub") return pass("L-04");
  if (!a.lawful_basis_url) {
    return cannotEvaluate(
      "L-04",
      ["lawful_basis_url"],
      "the basis claimed is conspicuous publication but the exact page it was published on was not stored",
    );
  }
  const published = normalizeDomain(a.lawful_basis_url);
  const own = domainKey(a);
  const allowed = new Set<string>([...TIER1_SOURCES, ...(own ? [own] : [])]);
  for (const permitted of allowed) {
    if (published === permitted || published.endsWith(`.${permitted}`)) return pass("L-04");
  }
  return {
    kind: "terminal",
    scope: "email",
    rule_id: "L-04",
    reason: "address_not_conspicuously_published",
    detail: `${published} is neither ${own || "the account's own domain"} nor a tier-1 source`,
    evidence_url: a.lawful_basis_url,
    duration: { kind: "until_human_clears" },
    message: sentence("address_not_conspicuously_published", {
      account: a,
      rule_id: "L-04",
      verb: "rejected for email",
      because: `the address was taken from ${published}, which is a third-party directory or aggregator rather than the account's own domain or a tier-1 first-party source. Public availability is a lower standard than conspicuous publication`,
      evidence_url: a.lawful_basis_url,
      now,
    }),
  };
}

/**
 * P-08's PAIRED HARD CONSTRAINT · a role account may not claim conspicuous publication
 * → TERMINAL for email.
 *
 * §4 specifies P-08 as "-15 **and** forbid `lawful_basis = conspicuous_pub`". The -15 lives in
 * `evaluatePenalties`; this is the other half, and it has to be a predicate rather than a clause
 * in a rendered sentence — a constraint that exists only as prose is a comment, and nothing
 * downstream can read it.
 *
 * WHY the forbid: s.10(9)(b) requires the message to be relevant to the recipient's ROLE, and
 * §3.6's source note is explicit that relevance to a person's role is hard to establish for a
 * SHARED mailbox. `info@` names no person, so no role relevance can be established for it, and
 * the basis is unsound whatever page it was published on.
 *
 * WHY email-scoped: identically to L-04, this invalidates the BASIS FOR SENDING, not the address
 * and not the account. The account survives with its address intact and stays reachable by web
 * form, phone or a human; `email_channel_open` goes false, and `gateInputsFromFilterResult`
 * reports `lawful_basis_strength: "none"` so a caller that recorded
 * `conspicuous_pub_named_person` for a shared mailbox no longer gets that weight awarded. The
 * closed channel is what bars the send — G_LAWFUL_BASIS reports `not_applicable`, not a block.
 *
 * The remedy for a human is to record a basis this address can actually carry, so the duration
 * is `until_human_clears` rather than `forever`.
 */
export function p08RoleAccountCannotClaimConspicuousPub(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult[] {
  if (a.lawful_basis !== "conspicuous_pub") return [pass("P-08-CONSTRAINT")];
  if (!isRoleAccount(a)) return [pass("P-08-CONSTRAINT")];
  const local = emailLocal(a);
  const evidence = a.lawful_basis_url ?? "lawful_basis";

  const terminal: TerminalResult = {
    kind: "terminal",
    scope: "email",
    rule_id: "P-08-CONSTRAINT",
    reason: "role_account_cannot_claim_conspicuous_pub",
    detail: `${local}@ with lawful_basis=conspicuous_pub`,
    evidence_url: evidence,
    duration: { kind: "until_human_clears" },
    message: sentence("role_account_cannot_claim_conspicuous_pub", {
      account: a,
      rule_id: "P-08-CONSTRAINT",
      verb: "rejected for email",
      because:
        `${local}@ is a shared role mailbox and the basis claimed for it is conspicuous ` +
        `publication. CASL requires the message to be relevant to the recipient's role, which ` +
        `cannot be established for a mailbox that names no person, so §4 forbids this basis ` +
        `for this address. The EMAIL is barred, not the account`,
      evidence_url: evidence,
      now,
    }),
  };

  // ENTRY CONDITION on the walk-list route, the same discipline every penalty got. The ICP
  // report argues the walk list for the LOCAL STOREFRONT segments; a remote-first company or an
  // account outside Greater Vancouver cannot be walked into, and asserting a walk that cannot
  // happen is worse than saying nothing.
  const walkable =
    geographyOf(a, lists).band === "metro_vancouver" &&
    a.observations?.has_consumer_storefront === true;

  if (!walkable) {
    return [
      terminal,
      {
        kind: "flag",
        rule_id: "P-08-CONSTRAINT",
        reason: "role_account_channel_unresolved",
        flag_reason: "role_account_channel_unresolved",
        detail: `${local}@`,
        evidence_url: evidence,
        message: sentence("role_account_channel_unresolved", {
          account: a,
          rule_id: "P-08-CONSTRAINT",
          verb: "flagged for a human to choose a channel",
          because:
            `the conspicuous-publication basis is unsound for the shared mailbox ${local}@, so ` +
            `the email channel is closed — but no walkable storefront in Greater Vancouver was ` +
            `observed, so the walk list is not available either. A human picks the channel. The ` +
            `row stays on the board and keeps its -15`,
          evidence_url: evidence,
          now,
        }),
      },
    ];
  }

  return [
    terminal,
    {
      kind: "channel",
      rule_id: "P-08-CONSTRAINT",
      reason: "role_account_belongs_on_the_walk_list",
      detail: `${local}@`,
      evidence_url: evidence,
      required_channel: "in_person",
      message: sentence("role_account_belongs_on_the_walk_list", {
        account: a,
        rule_id: "P-08-CONSTRAINT",
        verb: "routed to the walk list",
        because:
          `the only CASL basis a cold prospect can carry is conspicuous publication, and that ` +
          `basis is unsound for the shared mailbox ${local}@. This account has a storefront in ` +
          `Greater Vancouver, so the ICP report's own answer applies: the walk list rather than ` +
          `the email list, because an in-person ask is not a commercial electronic message at ` +
          `all. The row stays on the board and keeps its -15`,
        evidence_url: evidence,
        now,
      }),
    },
  ];
}

/** L-05 · No lawful basis recorded → HOLD. Re-qualify, do not drop. */
export function l05NoLawfulBasis(a: Account, now: Date): PredicateResult {
  if (a.lawful_basis) return pass("L-05");
  return {
    kind: "hold",
    rule_id: "L-05",
    reason: "no_lawful_basis",
    detail: "lawful_basis is null",
    evidence_url: "lawful_basis",
    message: sentence("no_lawful_basis", {
      account: a,
      rule_id: "L-05",
      verb: "held for re-qualification",
      because:
        "no CASL basis is recorded. The onus of proving consent is always on the sender, so this row cannot become contactable until a basis, its source URL and a page snapshot exist. It is held, not dropped",
      evidence_url: "lawful_basis",
      now,
    }),
  };
}

/** L-06 / L-07 · The implied-consent clock ran out → HOLD. Re-qualify, do not drop. */
export function l06l07ConsentBasisExpired(a: Account, now: Date): PredicateResult {
  const basis = a.lawful_basis;
  if (basis !== "ebr_2y" && basis !== "inquiry_6m") return pass("L-06/L-07");
  const captured = parseDate(a.lawful_basis_captured_at);
  if (!captured) {
    return cannotEvaluate(
      "L-06/L-07",
      ["lawful_basis_captured_at"],
      `the basis is ${basis} but no capture timestamp was stored, so the clock cannot be checked`,
    );
  }
  const limitMonths = basis === "ebr_2y" ? 24 : 6;
  const months = daysBetween(now, captured) / 30.4375;
  if (months <= limitMonths) return pass("L-06/L-07");
  const ruleId = basis === "ebr_2y" ? "L-06" : "L-07";
  return {
    kind: "hold",
    rule_id: ruleId,
    reason: "consent_basis_expired",
    detail: `${basis} captured ${a.lawful_basis_captured_at}, ${Math.floor(months)} months ago`,
    evidence_url: "lawful_basis_captured_at",
    message: sentence("consent_basis_expired", {
      account: a,
      rule_id: ruleId,
      verb: "held for re-qualification",
      because: `its ${basis} basis was captured ${Math.floor(months)} months ago, past the ${limitMonths}-month statutory window. The row is held so a fresh basis can be established, not dropped`,
      evidence_url: "lawful_basis_captured_at",
      now,
    }),
  };
}

/** L-08 · Conspicuous publication claimed with no stored snapshot → HOLD. */
export function l08NoProvenanceSnapshot(a: Account, now: Date): PredicateResult {
  if (a.lawful_basis !== "conspicuous_pub") return pass("L-08");
  if (a.source_page_text) return pass("L-08");
  return {
    kind: "hold",
    rule_id: "L-08",
    reason: "no_stored_provenance_snapshot",
    detail: "source_page_text is null",
    evidence_url: "source_page_text",
    message: sentence("no_stored_provenance_snapshot", {
      account: a,
      rule_id: "L-08",
      verb: "held for re-qualification",
      because:
        "it claims conspicuous publication but no snapshot of the publishing page was stored, so the stored record cannot serve as the CASL s.33(1) due-diligence evidence it is supposed to be",
      evidence_url: "source_page_text",
      now,
    }),
  };
}

// ===========================================================================
// §3.7 — K-REP, reputational
// ===========================================================================
//
// ALCOHOL IS NOT EXCLUDED, and this is stated first because the assumption is the error. The
// club's own hand-curated pipeline carries The Woods Spirit Co., a North Vancouver craft
// distillery, as an active prospect, and its published partner lists carry licensed hospitality
// throughout. The club has already made this decision. No alcohol predicate ships.

/**
 * K-REP-01 · Statutory sponsorship prohibitions → TERMINAL.
 *
 * These are legal kills, not taste judgments. Every Enactus SFU tier delivers logo placement,
 * social posts and event promotion — which is, by construction, "a promotion used in the
 * sponsorship of an entity or event". Cannabis Act s.21 and Tobacco and Vaping Products Act
 * ss.24 / 30.3 prohibit exactly that. The club cannot lawfully deliver the thing it is selling.
 */
export function kRep01StatutorySector(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult {
  const naics = (a.naics_code ?? "").trim();
  const haystack = sectorHaystack(a);

  const prohibitedNaics = lists.sectorPolicy
    .filter((r) => r.policy === "prohibited" && r.naics)
    .map((r) => r.naics);
  const naicsHit = naics !== "" && prohibitedNaics.some((code) => naics.startsWith(code));
  const reHit = haystack !== "" ? PROHIBITED_SECTOR_RE.exec(haystack) : null;

  if (!naicsHit && !reHit) return pass("K-REP-01");

  const detail = naicsHit ? `NAICS ${naics}` : (reHit?.[0] ?? "");
  const policyRow = lists.sectorPolicy.find(
    (r) =>
      r.policy === "prohibited" &&
      (naicsHit ? r.naics !== "" && naics.startsWith(r.naics) : (r.regex?.test(haystack) ?? false)),
  );
  const statute = policyRow?.decidedBy ?? "Cannabis Act s.21 / Tobacco and Vaping Products Act ss.24, 30.3";

  return {
    kind: "terminal",
    scope: "account",
    rule_id: "K-REP-01",
    reason: "sponsorship_prohibited_by_statute",
    detail,
    evidence_url: statute,
    duration: { kind: "until_human_clears" },
    message: sentence("sponsorship_prohibited_by_statute", {
      account: a,
      rule_id: "K-REP-01",
      verb: "rejected",
      because: `it operates in a sector where ${statute} prohibits using a brand element in a promotion used in sponsorship (matched: ${detail}). Every Enactus SFU tier delivers logo placement and social posts, so the club cannot lawfully deliver what it is selling. This is a legal kill, not a taste judgment`,
      evidence_url: statute,
      now,
    }),
  };
}

/**
 * K-REP-02 · Sectors that need a human decision → FLAG, never an automatic kill.
 *
 * Every one of these is a values question belonging to a student executive at a public
 * university, not to a filter stage. Encoding a guess would be worse than useless: it would look
 * like policy. The flag surfaces the account with its sector and lets a named human answer once,
 * after which the answer is written into sector-policy.csv and becomes deterministic.
 */
export function kRep02SensitiveSector(
  a: Account,
  lists: QualificationLists,
  now: Date,
): PredicateResult[] {
  const haystack = sectorHaystack(a);
  if (haystack === "") return [];
  const out: PredicateResult[] = [];

  for (const { sector, re } of SENSITIVE_SECTOR_PATTERNS) {
    const matched = re.exec(haystack);
    if (!matched) continue;
    const policy = lists.sectorPolicy.find((r) => r.sector === sector);
    if (policy?.policy === "allowed") continue;
    if (policy?.policy === "prohibited") continue; // K-REP-01 owns those

    out.push({
      kind: "flag",
      rule_id: "K-REP-02",
      reason: "sector_needs_human_decision",
      flag_reason: sector,
      detail: matched[0],
      evidence_url: "config/exclusions/sector-policy.csv",
      message: sentence("sector_needs_human_decision", {
        account: a,
        rule_id: "K-REP-02",
        verb: `flagged for a human decision on "${sector}"`,
        because: `it matched "${matched[0]}" and sector-policy.csv records ${sector} as ${policy?.policy ?? "unlisted"}. The pipeline must not invent a policy for a needs_decision row: it flags and waits`,
        evidence_url: "config/exclusions/sector-policy.csv",
        now,
      }),
    });
  }
  return out;
}

// ===========================================================================
// §5 — franchise and branch handling
// ===========================================================================
//
// "Test the location, not the brand." A franchise location with its own published contact and a
// named local owner is a small local business that happens to share a logo — exactly the club's
// best segment. A location that publishes only the chain's head-office contact is a branch of an
// enterprise, and the ask belongs to whatever channel head office publishes.
//
// The evidence a blanket chain rule is wrong: Enactus SFU has ALREADY converted Modo Yoga
// Vancouver, Rumble, skoah., iDance, The Old Spaghetti Factory, Waves Coffee House, Browns
// Socialhouse, Cactus Club Cafe, Popeye's Supplements and Red Bull.

export type FranchiseStatus = "LOCAL_AUTHORITY" | "HEAD_OFFICE" | "UNPROVEN" | "NOT_APPLICABLE";

interface FranchiseReportBase {
  /** The signal ids that fired, e.g. ["S1", "S2", "S4"]. */
  signals: string[];
  message: string;
}

/**
 * §5's verdict, as a DISCRIMINATED UNION rather than a status string beside some prose.
 *
 * A status alone let §5's HEAD_OFFICE branch say "the row is REROUTED, not dropped" while
 * nothing anywhere emitted a reroute: `status` was read only by P-04 (which wants UNPROVEN) and
 * K-SIZE-01 (which wants LOCAL_AUTHORITY), so a head-office row reached the queue unmarked and a
 * student emailed the local branch — the exact outcome §5 exists to prevent.
 *
 * The HEAD_OFFICE variant therefore CARRIES the outcome it claims. It cannot be constructed
 * without one, `franchiseReroute` below turns it into a `PredicateResult` through an exhaustive
 * switch, and `killPredicateSequence` runs that like any other rule. A future status that
 * declares an effect has to carry it too, or the switch stops compiling.
 */
export type FranchiseReport =
  | (FranchiseReportBase & { status: "NOT_APPLICABLE" })
  | (FranchiseReportBase & { status: "LOCAL_AUTHORITY" })
  | (FranchiseReportBase & { status: "UNPROVEN" })
  | (FranchiseReportBase & {
      status: "HEAD_OFFICE";
      /**
       * The reroute, as an emittable outcome. §5 step 2 maps a published application path to
       * CHANNEL `web_form` (its own worked case is Cactus Club Cafe). Where head office
       * publishes NO channel the report names none, so this is a human-review FLAG rather than
       * an invented `RequiredChannel` — and never a silent drop.
       */
      reroute: ChannelResult | FlagResult;
    });

/**
 * §5's ENTRY CONDITION: is this row a location of something bigger at all?
 *
 * §5 is titled "Franchise and branch handling" and its one-line rule is "test the LOCATION, not
 * the brand" — every signal in it is a property of a location of a chain. An independent
 * single-location business is not a location of anything, so for that row the franchise question
 * is NOT_APPLICABLE, never UNPROVEN. Running the ladder on it and falling through to Step 3 is
 * what made P-04 fire on every independent SMB in the corpus — the exact population the report
 * calls "where the yes lives".
 *
 * Admission requires observed evidence of a chain or branch relationship. Absence of that
 * evidence is not evidence of a chain (§2.3).
 */
function isChainOrBranchLocation(a: Account): boolean {
  const o = a.observations ?? {};
  return Boolean(
    // Any §5 signal was actually observed for this location (S1-S6, N1-N4 inputs).
    o.location_page_text ||
      o.location_has_own_domain_with_mx ||
      o.location_specific_email ||
      o.named_local_owner ||
      o.bc_registry_distinct_entity ||
      o.chain_has_franchise_page ||
      o.only_head_office_contact ||
      o.has_central_donation_form ||
      o.corporate_owned_all_locations ||
      // A store locator listing more than one location is direct evidence of a network.
      (o.store_locator_location_count ?? 0) >= 2 ||
      // K-GEO-02's carve-out already established that a local branch of this account exists.
      o.bc_branch_confirmed,
  );
}

export interface FranchiseOptions {
  /** Injected for deterministic tests. Defaults to the wall clock. */
  now?: Date;
  /** A path found by the K-CHAN-01 HTTP HEAD probe — what head office publishes, if anything. */
  application_path_found?: string | null;
}

/**
 * The channel K-CHAN-01 identified, if any.
 *
 * Asking K-CHAN-01 itself rather than re-reading `application_path_found` is the point: K-CHAN-01
 * ALSO recognises a published channel from `source_page_text` via APPLICATION_GATE_RE. Reading
 * only the probed path let a row carry a published web_form channel and, beside it, a flag
 * saying no channel was found.
 */
function publishedChannel(a: Account, now: Date, opts: FranchiseOptions): ChannelResult | null {
  const r = kChan01ApplicationChannel(a, now, {
    application_path_found: opts.application_path_found,
  });
  return r.kind === "channel" ? r : null;
}

export function franchiseOrBranchCarveOut(a: Account, opts: FranchiseOptions = {}): FranchiseReport {
  const o = a.observations ?? {};
  const now = opts.now ?? new Date();

  // Step 0 — the entry condition. Not a location of anything: §5 does not apply.
  if (!isChainOrBranchLocation(a)) {
    return {
      status: "NOT_APPLICABLE",
      signals: [],
      message:
        "No franchise or branch signal was observed, so this row is not a location of a chain and §5 does not apply to it. The franchise question is NOT APPLICABLE rather than unproven, and P-04 does not fire: an independent single-location business cannot have unproven autonomy as a branch of nothing.",
    };
  }

  // Step 1 — positive local-autonomy signals. ANY ONE returns LOCAL_AUTHORITY.
  const positive: string[] = [];
  if (o.location_page_text && FRANCHISEE_RE.test(o.location_page_text)) positive.push("S1");
  if (o.location_has_own_domain_with_mx) positive.push("S2");
  if (o.location_specific_email) positive.push("S3");
  if (o.named_local_owner) {
    const tokens = o.named_local_owner.trim().split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && !PLACEHOLDER_RE.test(o.named_local_owner)) positive.push("S4");
  }
  if (o.bc_registry_distinct_entity) positive.push("S5");
  if (o.chain_has_franchise_page) positive.push("S6");

  // S6 alone only proves the network is franchised at all, which is weaker than the others.
  const decisivePositive = positive.filter((s) => s !== "S6");
  if (decisivePositive.length > 0) {
    return {
      status: "LOCAL_AUTHORITY",
      signals: positive,
      message: `Local decision-making authority proven by ${decisivePositive.join(", ")}. Test the location, not the brand: this is a small local business that happens to share a logo, and it is exempt from K-SIZE-01 and K-GEO-01/02.`,
    };
  }

  // Step 2 — negative signals. ANY ONE returns HEAD_OFFICE (rerouted, not dropped).
  const negative: string[] = [];
  if (o.only_head_office_contact) negative.push("N1");
  if (o.has_central_donation_form) negative.push("N2");
  if (o.location_page_text && CENTRALISED_RE.test(o.location_page_text)) negative.push("N3");
  if (o.corporate_owned_all_locations && !o.chain_has_franchise_page) negative.push("N4");

  if (negative.length > 0) {
    return {
      status: "HEAD_OFFICE",
      signals: [...positive, ...negative],
      message: `Head office holds the decision (${negative.join(", ")}). The ask belongs to whatever channel head office publishes, so the row is REROUTED, not dropped.`,
      reroute: headOfficeReroute(a, negative, publishedChannel(a, now, opts), now),
    };
  }

  // Step 3 — neither fires.
  return {
    status: "UNPROVEN",
    signals: positive,
    message:
      "Neither a local-autonomy nor a head-office signal was observed. This takes P-04 (-30) and stays in the queue with franchise_status=unproven. \"We couldn't tell\" is not evidence of \"no\" (§2.3).",
  };
}

// ===========================================================================
// §4 — soft penalties, kept STRICTLY separate from kills
// ===========================================================================
//
// Kill only when (a) the account can never be a sponsor at any price, (b) contacting it would be
// unlawful, or (c) the correct action is a different channel or a different organisation.
// Everything else is a penalty. When in doubt, penalise — a penalty is a number a human can see
// and argue with; a kill is a row nobody ever looks at again.

export interface PenaltyContext {
  lists: QualificationLists;
  now: Date;
  franchise?: FranchiseStatus;
}

/**
 * §5 step 2's reroute, built as the outcome it is.
 *
 * Where head office publishes an application path, K-CHAN-01's channel is the right one and the
 * report's own worked case (Cactus Club Cafe → CHANNEL `web_form`) says so. Where nothing is
 * published the report names NO channel, so inventing a `RequiredChannel` would be asserting
 * routing nobody verified; the head-office finding goes to a human instead.
 */
function headOfficeReroute(
  a: Account,
  negative: string[],
  published: ChannelResult | null,
  now: Date,
): ChannelResult | FlagResult {
  const detail = negative.join(", ");
  if (published) {
    return {
      kind: "channel",
      rule_id: "FRANCHISE-HEAD-OFFICE",
      reason: "head_office_holds_the_decision",
      detail: `${detail}; head office publishes ${published.detail}`,
      evidence_url: published.evidence_url,
      required_channel: published.required_channel,
      message: sentence("head_office_holds_the_decision", {
        account: a,
        rule_id: "FRANCHISE-HEAD-OFFICE",
        verb: "rerouted to the channel head office publishes",
        because:
          `§5 signal(s) ${detail} show the decision sits with head office rather than this ` +
          `location, and K-CHAN-01 found a published channel (${published.detail}). The row is ` +
          `rerouted, not dropped: emailing the local branch asks someone who cannot say yes`,
        evidence_url: published.evidence_url,
        now,
      }),
    };
  }
  return {
    kind: "flag",
    rule_id: "FRANCHISE-HEAD-OFFICE",
    reason: "head_office_holds_the_decision",
    flag_reason: "head_office_channel_unresolved",
    detail,
    evidence_url: "observations",
    message: sentence("head_office_holds_the_decision", {
      account: a,
      rule_id: "FRANCHISE-HEAD-OFFICE",
      verb: "flagged for a human to find the head-office channel",
      because:
        `§5 signal(s) ${detail} show the decision sits with head office rather than this ` +
        `location, but no application channel was found on the site. §5 names no channel for ` +
        `that case, so the row is not rerouted to a guess and not dropped either — a human ` +
        `decides where the ask goes`,
      evidence_url: "observations",
      now,
    }),
  };
}

/**
 * Turn §5's verdict into an outcome the runner emits.
 *
 * The `default` arm is an exhaustiveness check: `never` stops compiling the moment a
 * `FranchiseStatus` is added, which forces whoever adds it to say what it emits rather than
 * describing an effect in a message nobody wires up.
 */
export function franchiseReroute(report: FranchiseReport): PredicateResult {
  switch (report.status) {
    case "HEAD_OFFICE":
      return report.reroute;
    case "LOCAL_AUTHORITY":
    case "UNPROVEN":
    case "NOT_APPLICABLE":
      return pass("FRANCHISE-HEAD-OFFICE");
    default: {
      const unhandled: never = report;
      return unhandled;
    }
  }
}

/**
 * P-04 clause 1: the account's registered head office is somewhere other than BC.
 *
 * Reads the EVIDENCE, not the band. `canada_other` is reachable from a recognised non-BC
 * province, and a band that could also be reached from absence would make P-04 charge -30 to a
 * row whose head office nobody has located yet — exactly what the captain's absence rule
 * forbids.
 */
function headOfficeOutsideBc(a: Account, lists: QualificationLists): boolean {
  const { evidence } = geographyOf(a, lists);
  return evidence.region === "contrary" || evidence.country === "contrary";
}

/**
 * P-04 clause 2: a local branch of that head office exists in scope.
 *
 * CONFIRMED evidence only. The clause used to accept a bare municipality alias recorded by an
 * enrichment pass, which levied -30 on an Ontario chain whose "operating municipality" read
 * `Richmond` — Richmond, Ontario and Richmond, Quebec are real places. Under the captain's
 * absence rule a penalty needs an observed positive fact, and only `bc_branch_confirmed` is one.
 */
function localBranchExists(a: Account): boolean {
  return Boolean(a.observations?.bc_branch_confirmed);
}

function penalty(
  a: Account,
  ctx: PenaltyContext,
  rule_id: string,
  tag: string,
  delta: number,
  detail: string,
  because: string,
  evidence_url = "",
): PenaltyResult {
  return {
    kind: "penalty",
    rule_id,
    reason: tag,
    tag,
    delta,
    detail,
    evidence_url,
    message: sentence(tag, {
      account: a,
      rule_id,
      verb: `penalised ${delta}`,
      because,
      evidence_url,
      now: ctx.now,
    }),
  };
}

/**
 * Evaluate every §4 penalty. Returns them as a list; the caller sums `delta`.
 *
 * These NEVER remove a row from the queue. That separation is the whole design: a wrongly
 * penalised account still surfaces, and a human can see the number and argue with it.
 */
export function evaluatePenalties(a: Account, ctx: PenaltyContext): PenaltyResult[] {
  const { lists, now } = ctx;
  const out: PenaltyResult[] = [];
  const o = a.observations ?? {};

  // P-01 — RETIRED 2026-08-06. Geography is expressed exactly once, as the band weight; see the
  // supersession note at the head of this file.

  // P-02 — headcount 100-499 (ISED "medium").
  const hc = a.headcount ?? a.headcount_band_max ?? null;
  if (hc !== null && hc >= 100 && hc < 500) {
    out.push(
      penalty(
        a,
        ctx,
        "P-02",
        "headcount_medium",
        -15,
        `headcount ${hc}`,
        `it employs ${hc} people, which is above the sweet spot but below the authority line. Vancity and Coast Capital sit here and have genuine, budgeted community-investment mandates`,
        "ISED Key Small Business Statistics",
      ),
    );
  }

  // P-03 — publicly traded. ENTRY CONDITION: a ticker or an investor-relations section, which is
  // what §4 defines the rule as. §6's "one proxy -> P-03" arm is not applied here; see the
  // REPORT CONTRADICTIONS note at the head of this file.
  if (o.has_stock_ticker || o.has_investor_relations) {
    const evidence = [
      o.has_stock_ticker ? "stock_ticker" : null,
      o.has_investor_relations ? "investor_relations_section" : null,
    ]
      .filter(Boolean)
      .join(", ");
    out.push(
      penalty(
        a,
        ctx,
        "P-03",
        "publicly_traded",
        -20,
        evidence,
        `it publishes ${evidence}, which is direct evidence of a publicly traded company. This correlates with formal giving, but Red Bull-style local product releases still happen, so it is a penalty and not a kill`,
      ),
    );
  }

  // P-04 — ENTRY CONDITION, from §4's own definition: "Head office outside BC, local branch
  // exists but branch autonomy unproven". All three clauses are required. §5's bare UNPROVEN
  // fall-through implements only the third; see the REPORT CONTRADICTIONS note.
  if (ctx.franchise === "UNPROVEN" && headOfficeOutsideBc(a, lists) && localBranchExists(a)) {
    out.push(
      penalty(
        a,
        ctx,
        "P-04",
        "branch_autonomy_unproven",
        -30,
        `head office ${a.address_region ?? a.address_country}, franchise_status=unproven`,
        `its head office is outside BC and a local branch exists, but neither a local-autonomy nor a head-office signal was observed for that branch. Real but weak, so the row stays in the queue`,
      ),
    );
  }

  // P-05 — the broad pay-to-join regex matched. Near-kill weight, but a human decides.
  const broad = kOrg03cPaidMembershipBroad(a, now);
  if (broad.kind === "penalty") out.push({ ...broad, rule_id: "P-05" });

  // P-06 — no named decision-maker after >= 2 discovery tactics.
  const named = a.contact_name && placeholderContactName(a, now).kind === "pass";
  if (!named && (o.discovery_tactics_attempted ?? 0) >= 2) {
    out.push(
      penalty(
        a,
        ctx,
        "P-06",
        "no_named_decision_maker",
        -25,
        `${o.discovery_tactics_attempted} tactics attempted`,
        `no named decision-maker was found after ${o.discovery_tactics_attempted} discovery tactics. The account may still be reachable at a role address, and the club converts on those`,
      ),
    );
  }

  // P-07 — free-mail address while a resolving company domain with MX exists.
  const mail = emailDomain(a);
  const site = domainKey(a);
  if (mail && site && mail !== site && lists.freeMailProviders.domains.has(mail) && a.dns?.mx_present) {
    out.push(
      penalty(
        a,
        ctx,
        "P-07",
        "free_mail_while_domain_exists",
        -10,
        `${mail} while ${site} has MX`,
        `the contact uses ${mail} even though ${site} resolves with an MX record. Prefer the domain address; do not discard the person`,
      ),
    );
  }

  // P-08 — role account. THE measurement that settles it: 25 of 25 seeded addresses are role
  // accounts, so a kill would empty the pipeline. The paired hard constraint is enforced by
  // `p08RoleAccountCannotClaimConspicuousPub` in the predicate sequence, not by this sentence.
  if (isRoleAccount(a)) {
    const p = penalty(
      a,
      ctx,
      "P-08",
      "role_account",
      -15,
      emailLocal(a),
      `its address is the role mailbox ${emailLocal(a)}@. 25 of 25 seeded addresses are role accounts, so killing them would empty the pipeline — but CASL relevance is hard to establish for a shared mailbox, so this penalty is paired with a hard constraint enforced by rule P-08-CONSTRAINT: lawful_basis = conspicuous_pub is FORBIDDEN for this address`,
    );
    out.push(p);
  }

  // P-09 — unresolved geography after one retry.
  const noGeo =
    !a.address_country && !a.address_region && !a.address_municipality && !a.postal_code;
  if (noGeo && (o.geography_resolution_attempts ?? 0) >= 1) {
    out.push(
      penalty(
        a,
        ctx,
        "P-09",
        "unresolved_geography",
        -15,
        `${o.geography_resolution_attempts} resolution attempts`,
        "no geography evidence of any kind was found after a retry. Absence of evidence is never a kill, so this is a penalty",
      ),
    );
  }

  // P-10 — no website, social-only presence. ENTRY CONDITION, per resolved ambiguity A1: either
  // social-only presence was OBSERVED, or the website fields are empty AND a website-enrichment
  // pass has run and recorded its failure. Absent website fields on their own are absence of
  // evidence, not evidence of an Instagram-only business, and the rows they wrongly marked down
  // are exactly the thin-web-presence local operators the ICP ranks highest-converting.
  const websiteLookupRan = (o.website_resolution_attempts ?? 0) >= 1;
  const noWebsiteAfterLookup = websiteLookupRan && !a.website_url && !a.registrable_domain;
  if (o.social_only_presence || noWebsiteAfterLookup) {
    out.push(
      penalty(
        a,
        ctx,
        "P-10",
        "social_only_presence",
        -20,
        o.social_only_presence
          ? (a.website_url ?? "social_only_presence observed")
          : `no website found after ${o.website_resolution_attempts} enrichment attempt(s)`,
        o.social_only_presence
          ? "a social-only presence was observed for it. Many Vancouver micro-businesses are Instagram-only, and several current partners look exactly like this (Baaad Anna's, Nordic Yarn, Freesia Soap)"
          : `no website was found for it after ${o.website_resolution_attempts} enrichment attempt(s). Many Vancouver micro-businesses are Instagram-only, and several current partners look exactly like this (Baaad Anna's, Nordic Yarn, Freesia Soap)`,
      ),
    );
  }

  // P-11 — domain registered less than 12 months ago.
  const registered = parseDate(o.domain_registered_at);
  if (registered && daysBetween(now, registered) < 365) {
    out.push(
      penalty(
        a,
        ctx,
        "P-11",
        "new_domain",
        -15,
        o.domain_registered_at ?? "",
        `its domain was registered on ${o.domain_registered_at}, less than 12 months ago. New businesses have no discretionary budget yet — but Enactus's own ventures are new too`,
      ),
    );
  }

  // P-12 — no plausible tie to any of the 8 projects.
  if (o.project_industry_match === false) {
    out.push(
      penalty(
        a,
        ctx,
        "P-12",
        "no_project_tie",
        -20,
        a.industry ?? "",
        "its sector has no plausible tie to any of the 8 Enactus SFU projects. Weak fit is not no fit, and CASL relevance can still be argued from role",
      ),
    );
  }

  // P-13 — a human marked the sector `discouraged` in sector-policy.csv.
  const haystack = sectorHaystack(a);
  for (const row of lists.sectorPolicy) {
    if (row.policy !== "discouraged" || !row.regex) continue;
    if (!row.regex.test(haystack)) continue;
    out.push(
      penalty(
        a,
        ctx,
        "P-13",
        "sector_discouraged",
        -50,
        row.sector,
        `${row.decidedBy || "a human"} marked the sector "${row.sector}" as discouraged on ${row.decidedAt || "an unrecorded date"}. The human's answer, applied deterministically`,
        "config/exclusions/sector-policy.csv",
      ),
    );
  }

  // P-15 — another lead already exists on the same registrable domain.
  if ((o.other_leads_on_domain ?? 0) >= 1) {
    out.push(
      penalty(
        a,
        ctx,
        "P-15",
        "duplicate_domain_lead",
        -35,
        `${o.other_leads_on_domain} other lead(s) on ${site}`,
        `${o.other_leads_on_domain} other lead(s) already sit on ${site}. Two students emailing the same business is the coordination failure nobody has solved — but a large local employer can legitimately carry two contacts, so this is not a kill`,
      ),
    );
  }

  return out;
}

// ===========================================================================
// §2.4 — the runner
// ===========================================================================

export interface FilterOptions {
  /** Injected for deterministic tests. Defaults to the wall clock. */
  now?: Date;
  /** The sponsorship cycle currently being worked, e.g. "2026-27". Needed by K-REL-03. */
  current_cycle?: string | null;
  /** A path found by the K-CHAN-01 HTTP HEAD probe, e.g. "/donation-requests". */
  application_path_found?: string | null;
  /**
   * §5's verdict, computed once by `runFilter` and threaded in so the report on `FilterResult`
   * and the reroute the sequence emits are the SAME object.
   */
  franchise?: FranchiseReport;
}

export interface OverriddenKill {
  rule_id: string;
  reason: string;
  message: string;
  overridden_by: string;
}

export interface FilterResult {
  decision: "terminal" | "channel" | "pass";

  // §2.5 reason-string contract, populated from the FIRST terminal (or the first channel).
  reject_reason: string | null;
  reject_detail: string | null;
  reject_evidence_url: string | null;
  reject_rule_id: string | null;
  reject_at: string | null;
  message: string | null;
  required_channel: RequiredChannel | null;

  /**
   * ACCOUNT-SCOPED HARD KILLS, and only those. Separate from `penalties`, always.
   * A non-empty `kills` is the one thing that drops the row.
   */
  kills: TerminalResult[];
  /**
   * Terminals scoped narrower than the account — address (D-05, D-07, K-REL-08), email (L-02,
   * L-04) or person (PLACEHOLDER). What they name is unusable; the ACCOUNT survives, keeps being
   * evaluated and keeps accruing penalties. Surfaced rather than discarded so a human still sees
   * why the contact was cleared or the channel closed.
   */
  field_terminals: TerminalResult[];
  /** The account fields `field_terminals` cleared, e.g. `["contact_name", "contact_title"]`. */
  cleared_fields: string[];
  /**
   * False once an email-scoped terminal has fired: this account must not be sent a CEM. The
   * address itself is untouched, because the business is still reachable by form, phone or a
   * human — that routing is exactly what §2.2's CHANNEL outcome exists to preserve.
   *
   * THIS FLAG, NOT A GATE VERDICT, IS THE OPERATIVE PROTECTION AGAINST A SEND.
   * `gateInputsFromFilterResult` in src/lib/scoring.ts reports `lawful_basis_strength: "none"`
   * from it, but `evaluateGates` answers G_LAWFUL_BASIS `not_applicable` for a closed channel —
   * an unreachable row is not an unqualified one. See AGENTS.md under "Drafts only, never send".
   */
  email_channel_open: boolean;
  /**
   * Penalties this row levies on OTHER rows (K-REL-08's −40 on every lead sharing the bounced
   * `email_domain`). NEVER counted in `penalty_total`: they do not belong to this row.
   */
  sibling_penalties: SiblingPenalty[];
  /**
   * The account as it should be persisted after filtering: the input record with every field a
   * `field_terminals` entry invalidated cleared, ready to go back to discovery.
   */
  account: Account;
  channels: ChannelResult[];
  /** SOFT PENALTIES. The row stays in the queue and stays visible. */
  penalties: PenaltyResult[];
  penalty_total: number;
  holds: HoldResult[];
  flags: FlagResult[];
  /** Predicates that could not decide, with the fields that would let them. */
  cannot_evaluate: CannotEvaluateResult[];
  /** Kills the never-kill allowlist suppressed. Recorded so the override is auditable. */
  overridden_kills: OverriddenKill[];

  franchise: FranchiseReport;
  area_code_signal: AreaCodeSignal;
  evaluated_rule_ids: string[];
}

/**
 * The §2.4 evaluation order, as a lazy sequence.
 *
 * Cheapest and most certain first, so a caller can stop at the first TERMINAL without paying
 * for the rest. Steps 1-7 cost nothing and require no network; step 8 consumes DNS facts the
 * caller already resolved. NO MODEL IS INVOKED AT ANY POINT.
 */
export function killPredicateSequence(
  a: Account,
  lists: QualificationLists,
  opts: FilterOptions = {},
): (() => PredicateResult | PredicateResult[])[] {
  const now = opts.now ?? new Date();
  // Computed ONCE per run and threaded in. Two call sites over the same inputs are value-equal
  // only until one of them is passed a different clock, and then the verdict reported on
  // `FilterResult.franchise` and the reroute actually emitted disagree with nothing to catch it.
  const franchise =
    opts.franchise ??
    franchiseOrBranchCarveOut(a, { now, application_path_found: opts.application_path_found });

  return [
    // 1. suppression
    () => l01Suppressed(a, now),
    // 2. relationship state
    () => kRel02RoutedToNational(a, now),
    () => kRel03AlreadySponsorThisCycle(a, now, { current_cycle: opts.current_cycle }),
    () => kRel04ContactedRecently(a, now),
    () => kRel06DeclinedPermanently(a, now),
    () => kRel05DeclinedRecently(a, now),
    () => kRel07DeclinedOnTiming(a, now),
    () => kRel08HardBounced(a, now, lists),
    // 3. national partner (§7.1 → CHANNEL) and the separate §7.2 review list (→ FLAG only)
    () => kOrg01NationalPartner(a, lists, now),
    () => nationalFlagReview(a, lists, now),
    // 4. org type
    () => kOrg06SelfOrInternalUnit(a, lists, now),
    () => kOrg02StudentOrganisation(a, lists, now),
    () => kOrg03aPaidMembershipList(a, lists, now),
    () => kOrg03bPaidMembershipHighPrecision(a, now),
    () => kOrg04GovernmentBody(a, lists, now),
    () => kOrg05RegisteredCharity(a, now),
    // 5. statutory sector
    () => kRep01StatutorySector(a, lists, now),
    () => kRep02SensitiveSector(a, lists, now),
    // 6. geography
    () => kGeo01OutsideCanada(a, lists, now),
    // 7. size
    () => kSize01EnterpriseScale(a, now, franchise.status),
    () => kChan01ApplicationChannel(a, now, { application_path_found: opts.application_path_found }),
    () => kChan02IneligibleRequiresCharity(a, now),
    // §5 step 2's reroute, AFTER K-CHAN-02: the report's own caveat is "rerouted, not dropped,
    // unless K-CHAN-02 also fires", and K-CHAN-02 is an account-scoped terminal that
    // short-circuits, so the ordering implements the caveat rather than restating it.
    () => franchiseReroute(franchise),
    // 8. deliverability
    () => d01DeadDomain(a, now),
    () => d02ParkedDomain(a, lists, now),
    () => d03CannotReceiveMail(a, now),
    () => d04NoMailExchanger(a, now),
    () => d05MalformedEmail(a, now),
    () => d06DisposableEmailDomain(a, lists, now),
    () => d07EmailDomainMismatch(a, lists, now),
    () => placeholderContactName(a, now),
    // 9. consent and provenance
    () => l02NoSolicitationStatement(a, now),
    () => l03HarvestedAddress(a, now),
    () => l04NotConspicuouslyPublished(a, now),
    () => p08RoleAccountCannotClaimConspicuousPub(a, lists, now),
    () => l05NoLawfulBasis(a, now),
    () => l06l07ConsentBasisExpired(a, now),
    () => l08NoProvenanceSnapshot(a, now),
  ];
}

/**
 * Run every predicate in the §2.4 order EXHAUSTIVELY, without short-circuiting.
 *
 * This is the diagnostic view — useful in tests and in a "why was this rejected?" panel, where
 * you want every rule's verdict rather than only the first one that fired. `runFilter()` drives
 * the same sequence lazily and stops at the first TERMINAL.
 */
export function evaluateKillPredicates(
  a: Account,
  lists: QualificationLists,
  opts: FilterOptions = {},
): PredicateResult[] {
  const results: PredicateResult[] = [];
  for (const run of killPredicateSequence(a, lists, opts)) {
    const r = run();
    if (Array.isArray(r)) results.push(...r);
    else results.push(r);
  }
  return results;
}

/**
 * Run the whole filter for one account.
 *
 * `never-kill-domains.csv` overrides every §3 predicate EXCEPT L-01 / K-REL-01 suppression.
 * That is the safety valve for the failure mode the spec cares about most: a wrongly killed
 * account is invisible forever. Overridden kills are recorded rather than discarded, so the
 * override is auditable.
 *
 * ⚠️ ONE CONSEQUENCE WORTH KNOWING, implemented as §7.7 specifies rather than quietly narrowed.
 * The allowlist also seeds from `current-and-past-sponsors.csv`, so a past sponsor whose domain
 * has since gone dead has its D-01 `dead_domain` kill overridden too. That is arguably the
 * intended behaviour — the business may still exist even though the domain lapsed, and losing
 * the row loses the relationship — but the account will still be undeliverable by email, and
 * `overridden_kills` is where that shows up. If this proves wrong in practice, the narrow fix is
 * to exempt D-01/D-02 from the override the way L-01 is exempt.
 */
export function runFilter(
  account: Account,
  lists: QualificationLists,
  opts: FilterOptions = {},
): FilterResult {
  const now = opts.now ?? new Date();
  const franchise = franchiseOrBranchCarveOut(account, {
    now,
    application_path_found: opts.application_path_found,
  });
  const neverKill =
    lookupList(lists.neverKillDomains, account.registrable_domain, null) ??
    (account.registrable_domain
      ? (lists.currentAndPastSponsors.domains.get(domainKey(account)) ?? null)
      : null);

  const kills: TerminalResult[] = [];
  const fieldTerminals: TerminalResult[] = [];
  const clearedFields = new Set<string>();
  const siblingPenalties: SiblingPenalty[] = [];
  let emailChannelOpen = true;
  const channels: ChannelResult[] = [];
  const holds: HoldResult[] = [];
  const flags: FlagResult[] = [];
  const cannot: CannotEvaluateResult[] = [];
  const overridden: OverriddenKill[] = [];
  const evaluated: string[] = [];
  const inlinePenalties: PenaltyResult[] = [];

  let decided = false;

  // §2.4: cheapest and most certain first, short-circuiting on the first TERMINAL. The sequence
  // is lazy, so nothing after the decision is evaluated at all.
  outer: for (const run of killPredicateSequence(account, lists, { ...opts, now, franchise })) {
    const produced = run();
    for (const r of Array.isArray(produced) ? produced : [produced]) {
      evaluated.push(r.rule_id);

      switch (r.kind) {
        case "pass":
          break;
        case "terminal": {
          // A terminal scoped narrower than the account kills what it names, never the row. It
          // clears what it owns, stays visible, and evaluation continues — including the whole
          // penalty pass. The never-kill allowlist has nothing to suppress here: it protects the
          // ACCOUNT, and an unusable address stays unusable for a past sponsor too.
          if (r.scope !== "account") {
            const effect = SCOPE_EFFECTS[r.scope];
            fieldTerminals.push(r);
            for (const field of effect.clears) clearedFields.add(field);
            if (effect.closes_email_channel) emailChannelOpen = false;
            if (r.sibling_penalty) siblingPenalties.push(r.sibling_penalty);
            break;
          }
          if (r.sibling_penalty) siblingPenalties.push(r.sibling_penalty);
          // L-01 / K-REL-01 suppression is never overridable, by anything.
          const suppressionRule = r.rule_id === "L-01" || r.rule_id === "K-REL-01";
          if (neverKill && !suppressionRule) {
            overridden.push({
              rule_id: r.rule_id,
              reason: r.reason,
              message: r.message,
              overridden_by: `never-kill allowlist: ${neverKill.entity || neverKill.value} — ${neverKill.reason}`,
            });
          } else {
            kills.push(r);
            decided = true;
          }
          break;
        }
        case "channel":
          // A channel is not a kill, so the never-kill allowlist has nothing to suppress: the
          // routing information is exactly what keeps the row usable. Two rules reaching the
          // same route from the same evidence (K-CHAN-01 and §5's head-office reroute) is one
          // instruction, not two, so the route is recorded once.
          if (!channels.some((c) => c.required_channel === r.required_channel)) channels.push(r);
          break;
        case "penalty":
          inlinePenalties.push(r);
          break;
        case "hold":
          holds.push(r);
          break;
        case "flag":
          flags.push(r);
          break;
        case "cannot_evaluate":
          cannot.push(r);
          break;
      }
    }
    if (decided) break outer;
  }

  // Step 10 — penalties. Skipped when a TERMINAL fired, because the row is out of the queue and
  // a score on a rejected row means nothing.
  const penalties = kills.length > 0 ? [] : dedupePenalties([...inlinePenalties, ...evaluatePenalties(account, { lists, now, franchise: franchise.status })]);

  // The surviving record. A field terminal clears its field so the account goes back to
  // discovery with the unusable value gone, rather than being carried forward or dropped.
  const cleaned: Account = { ...account };
  for (const field of clearedFields) {
    (cleaned as unknown as Record<string, unknown>)[field] = null;
  }

  const primaryKill = kills[0] ?? null;
  const primaryChannel = channels[0] ?? null;

  const decision: FilterResult["decision"] = primaryKill
    ? "terminal"
    : primaryChannel
      ? "channel"
      : "pass";

  const primary = primaryKill ?? primaryChannel;

  return {
    decision,
    reject_reason: primary?.reason ?? null,
    reject_detail: primary?.detail ?? null,
    reject_evidence_url: primary?.evidence_url ?? null,
    reject_rule_id: primary?.rule_id ?? null,
    reject_at: primary ? now.toISOString() : null,
    message: primary?.message ?? null,
    required_channel:
      primaryKill?.required_channel ?? primaryChannel?.required_channel ?? null,
    kills,
    field_terminals: fieldTerminals,
    cleared_fields: [...clearedFields],
    email_channel_open: emailChannelOpen,
    sibling_penalties: siblingPenalties,
    account: cleaned,
    channels,
    penalties,
    penalty_total: penalties.reduce((acc, p) => acc + p.delta, 0),
    holds,
    flags,
    cannot_evaluate: cannot,
    overridden_kills: overridden,
    franchise,
    area_code_signal: areaCodeSignal(account),
    evaluated_rule_ids: evaluated,
  };
}

/**
 * Two rules can produce the same tag for one signal. Charge it once.
 *
 * The original pair (K-GEO-03 and P-01, both `outside_metro_vancouver`) was retired by the
 * 2026-08-06 supersession — geography is a band weight now — so nothing exercises this today.
 * It stays because the shape recurs: a §3 predicate and its §4 penalty naming one fact.
 */
function dedupePenalties(penalties: PenaltyResult[]): PenaltyResult[] {
  const seen = new Set<string>();
  const out: PenaltyResult[] = [];
  for (const p of penalties) {
    if (seen.has(p.tag)) continue;
    seen.add(p.tag);
    out.push(p);
  }
  return out;
}

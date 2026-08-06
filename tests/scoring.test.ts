import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type CompanyFacts,
  type SegmentAssignment,
  affiliationEvidenceClears,
  assignSegment,
  computeObjectives,
  deriveAsk,
  evaluateGates,
  gateInputsFromFilterResult,
  geographyBand,
  isRealPersonName,
  resolvePYes,
  scoreAccess,
  scoreAffinity,
  scoreCompany,
  scoreFit,
  triggerBonus,
} from "../src/lib/scoring";
import {
  DEFAULT_ICP_CONFIG_PATH,
  IcpConfigError,
  SCORE_BLOCKS,
  SEGMENT_IDS,
  loadIcpConfig,
  parseIcpConfig,
  validateIcpConfig,
} from "../src/lib/icp-config";
import { runFilter } from "../src/lib/filter";
import { loadQualificationLists } from "../src/lib/qualification-lists";

const config = loadIcpConfig();
const NOW = new Date("2026-08-06T12:00:00.000Z");

function company(over: Partial<CompanyFacts> & { legal_name: string }): CompanyFacts {
  return {
    relationship_tier: "cold",
    alumni_evidence: "none",
    project_match: "none",
    lawful_basis_strength: "none",
    ...over,
  };
}

// ===========================================================================
// The config file — the thing a non-programmer retunes
// ===========================================================================

describe("config/icp.yaml", () => {
  it.each(SCORE_BLOCKS)("%s weights sum to exactly 100", (blockName) => {
    const block = config[blockName] as Record<string, number>;
    const total = Object.values(block).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it("ships the report's starting weights verbatim", () => {
    expect(config.fit_score).toEqual({
      segment_match: 40,
      size_band: 20,
      geography: 20,
      industry_specificity: 10,
      entity_signals: 10,
    });
    expect(config.affinity_score).toEqual({
      relationship_tier: 35,
      alumni_evidence: 30,
      project_values_match: 15,
      local_proximity: 10,
      giving_posture: 10,
    });
    expect(config.access_score).toEqual({
      named_approver: 30,
      approver_collapse: 25,
      deliverable_contact: 20,
      lawful_basis_strength: 15,
      channel_available: 10,
    });
  });

  it("ships the report's p_yes ESTIMATE midpoints", () => {
    expect(config.p_yes.S1_renewal_in_kind).toBe(0.4);
    expect(config.p_yes.S1_renewal_cash).toBe(0.15);
    expect(config.p_yes.S6_alumni_led).toBe(0.45);
    expect(config.p_yes.S13_b2b_trade).toBe(0.02);
  });

  it("ships the club's REAL published tiers and invents no numbers", () => {
    expect(config.ask_ladder.bronze).toMatchObject({ amount_low: 100, amount_high: 250 });
    expect(config.ask_ladder.silver).toMatchObject({ amount_low: 250, amount_high: 500 });
    expect(config.ask_ladder.gold).toMatchObject({ amount_low: 500, amount_high: 1000 });
    expect(config.ask_ladder.diamond).toMatchObject({ amount_low: 1000, amount_high: 5000 });
    expect(config.ask_ladder.in_kind).toMatchObject({ amount_low: 0, amount_high: 0 });
  });

  it("gates trigger recency rather than decaying it", () => {
    expect(config.trigger_bonus.max_age_days.funding_round).toBe(180);
    expect(config.trigger_bonus.max_age_days.job_posting).toBe(60);
    expect(config.trigger_bonus.max_bonus).toBe(25);
  });

  it("covers all 17 segments with an effort, an ask rule and an objective", () => {
    for (const id of SEGMENT_IDS) {
      expect(config.segments[id], id).toBeDefined();
      expect(config.effort_minutes[id], id).toBeGreaterThan(0);
      expect(config.ask_rules[id], id).toBeDefined();
    }
  });

  it("marks S15 and S16 as relationship-only and S17 as excluded", () => {
    expect(config.segments.S15.objective).toBe("relationship_only");
    expect(config.segments.S16.objective).toBe("relationship_only");
    expect(config.segments.S17.objective).toBe("excluded");
  });

  it("REJECTS a retune whose weights no longer sum to 100", () => {
    const original = readFileSync(DEFAULT_ICP_CONFIG_PATH, "utf8");
    expect(original).toContain("segment_match: 40");
    const yaml = original.replace("segment_match: 40", "segment_match: 45");
    expect(() => parseIcpConfig(yaml)).toThrow(IcpConfigError);
    try {
      parseIcpConfig(yaml);
    } catch (e) {
      expect((e as IcpConfigError).problems.join(" ")).toContain("fit_score weights sum to 105");
    }
  });

  const badConfigs: [string, unknown, string][] = [
    ["a missing block", { fit_score: {} }, "affinity_score is missing"],
    [
      "a negative weight",
      { fit_score: { a: -5, b: 105 }, affinity_score: {}, access_score: {} },
      "negative",
    ],
    ["a non-mapping top level", "hello", "top level is not a mapping"],
  ];

  it.each(badConfigs)("reports %s", (_label, raw, expected) => {
    expect(validateIcpConfig(raw).join(" ")).toContain(expected);
  });

  it("rejects a p_yes outside 0..1", () => {
    const problems = validateIcpConfig({ ...config, p_yes: { S2_local_consumer: 55 } });
    expect(problems.join(" ")).toContain("must be a probability between 0 and 1");
  });
});

// ===========================================================================
// §4 — assignment precedence
// ===========================================================================

describe("assignSegment — the §4 precedence ladder", () => {
  const cases: [string, Partial<CompanyFacts>, SegmentAssignment][] = [
    ["an excluded account", { is_excluded: true }, "EXCLUDED"],
    ["the club's institutional home", { is_institutional_home: true }, "EXCLUDED_INSTITUTIONAL"],
    ["an individual person", { is_individual_person: true }, "S17"],
    ["a grant-making foundation", { is_grantmaking_foundation: true }, "S14"],
    ["a credit union", { is_credit_union: true }, "S10"],
    [
      "a family office with a public philanthropic profile",
      { is_family_office_principal: true, has_public_philanthropic_profile: true },
      "S12",
    ],
    [
      "a library asked for space",
      { is_public_or_civic: true, civic_ask_shape: "space_or_programming" },
      "S16",
    ],
    ["a 5,000-person enterprise", { headcount: 5000 }, "S15"],
    ["a national enterprise", { is_national_enterprise: true }, "S15"],
    ["an Enactus-alum-led company", { alumni_evidence: "enactus_alum_led" }, "S6"],
    ["a club vendor", { sells_to_club_or_student_orgs: true }, "S5"],
    ["a campus recruiter", { runs_campus_recruiting: true }, "S7"],
    ["a brand with a structured programme", { has_structured_brand_programme: true }, "S8"],
    ["a company that raised 6 months ago", { raised_institutional_capital_at: "2026-02-01" }, "S11"],
    [
      "a project-aligned operator",
      { project_match: "human_confirmed", matched_project: "Alara" },
      "S9",
    ],
    ["a CPG brand with no storefront", { is_consumer_packaged_goods: true }, "S4"],
    ["a trial-model studio", { has_trial_offer: true }, "S3"],
    ["a consumer storefront", { has_consumer_storefront: true }, "S2"],
    ["a B2B trade business", { is_b2b_trade: true }, "S13"],
    ["nothing recognisable", {}, "UNSEGMENTED"],
  ];

  it.each(cases)("assigns %s to %s", (_label, over, expected) => {
    expect(assignSegment(company({ legal_name: "X", ...over }), { now: NOW }).segment).toBe(expected);
  });

  it("lands every company in EXACTLY ONE segment", () => {
    for (const [, over] of cases) {
      const r = assignSegment(company({ legal_name: "X", ...over }), { now: NOW });
      expect(typeof r.segment).toBe("string");
    }
  });

  it("always explains which rung fired", () => {
    for (const [, over] of cases) {
      expect(assignSegment(company({ legal_name: "X", ...over }), { now: NOW }).basis.length).toBeGreaterThan(
        10,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The three ambiguities §4 says "will actually bite".
// ---------------------------------------------------------------------------

describe("§4 ambiguity 1 · museum, theatre or library — S2 or S16?", () => {
  it("sends Vancouver Maritime Museum to S2, because it sits on the PRIZE list", () => {
    const r = assignSegment(
      company({
        legal_name: "Vancouver Maritime Museum",
        is_public_or_civic: true,
        civic_ask_shape: "transferable_item",
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S2");
    expect(r.basis).toContain("transferable item");
  });

  it("sends Vancouver Public Library to S16, because it hosted Unify Gather events", () => {
    const r = assignSegment(
      company({
        legal_name: "Vancouver Public Library",
        is_public_or_civic: true,
        civic_ask_shape: "space_or_programming",
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S16");
  });

  it("decides on the ASK, not the institution type — the same body can go either way", () => {
    const base = { legal_name: "Museum of Vancouver", is_public_or_civic: true } as const;
    expect(
      assignSegment(company({ ...base, civic_ask_shape: "transferable_item" }), { now: NOW }).segment,
    ).toBe("S2");
    expect(
      assignSegment(company({ ...base, civic_ask_shape: "space_or_programming" }), { now: NOW }).segment,
    ).toBe("S16");
  });
});

describe("§4 ambiguity 2 · franchise location or head office?", () => {
  it("sends the LOCATION to S2 on its storefront", () => {
    const r = assignSegment(
      company({ legal_name: "The Old Spaghetti Factory (Gastown)", unit: "location", has_consumer_storefront: true }),
      { now: NOW },
    );
    expect(r.segment).toBe("S2");
  });

  it("sends head office to S8 on its structured programme", () => {
    const r = assignSegment(
      company({
        legal_name: "Pattison Food Group",
        unit: "head_office",
        has_structured_brand_programme: true,
        has_consumer_storefront: true,
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S8");
  });

  it("keeps Red Bull in S8, not S15, while its headcount is unknown", () => {
    // The disqualifier report establishes that no free source publishes headcount. With
    // headcount unknown and no is_national_enterprise assertion, the S15 rung cannot fire, and
    // the verified Student Marketeer programme lands Red Bull in S8 as §3.1 maps it.
    const r = assignSegment(
      company({ legal_name: "Red Bull", has_structured_brand_programme: true }),
      { now: NOW },
    );
    expect(r.segment).toBe("S8");
  });

  it("but S15 DOES win once headcount is actually known to exceed 500", () => {
    const r = assignSegment(
      company({ legal_name: "Red Bull", has_structured_brand_programme: true, headcount: 5000 }),
      { now: NOW },
    );
    expect(r.segment).toBe("S15");
  });
});

describe("§4 ambiguity 3 · a past partner that is also a trial-model studio", () => {
  it.each([
    ["skoah.", "skoah."],
    ["Modo Yoga Vancouver", "Modo Yoga Vancouver"],
    ["Rumble", "Rumble Boxing"],
  ])("assigns %s to S1 with underlying_segment S3", (_label, name) => {
    const r = assignSegment(
      company({ legal_name: name, relationship_tier: "lapsed_partner", has_trial_offer: true }),
      { now: NOW },
    );
    expect(r.segment).toBe("S1");
    expect(r.underlying_segment).toBe("S3");
    expect(r.basis).toContain("renewal motion owns the outreach");
  });

  it("assigns Vellum Wellness to S1 with underlying S4", () => {
    const r = assignSegment(
      company({
        legal_name: "Vellum Wellness",
        relationship_tier: "lapsed_partner",
        is_consumer_packaged_goods: true,
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S1");
    expect(r.underlying_segment).toBe("S4");
  });

  it("assigns Varshney Capital Corp to S1 with underlying S12", () => {
    const r = assignSegment(
      company({
        legal_name: "Varshney Capital Corp",
        relationship_tier: "active_partner",
        is_family_office_principal: true,
        has_public_philanthropic_profile: true,
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S1");
    expect(r.underlying_segment).toBe("S12");
  });

  it("lets the renewal motion override EVERY other rung", () => {
    const r = assignSegment(
      company({
        legal_name: "Everything At Once",
        relationship_tier: "active_partner",
        alumni_evidence: "enactus_alum_led",
        project_match: "human_confirmed",
        matched_project: "Nourish",
        has_trial_offer: true,
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S1");
    expect(r.underlying_segment).toBe("S6");
  });
});

describe("further precedence overlaps the report enumerates", () => {
  it("sends Manning Elliott to S7, the textbook mid-market talent recruiter", () => {
    const r = assignSegment(
      company({ legal_name: "Manning Elliott", headcount: 220, runs_campus_recruiting: true }),
      { now: NOW },
    );
    expect(r.segment).toBe("S7");
  });

  it("escalates a funded startup with an SFU founder to S6, which is the outcome you want", () => {
    const r = assignSegment(
      company({
        legal_name: "Some Vancouver Startup",
        alumni_evidence: "sfu_alum_led",
        raised_institutional_capital_at: "2026-02-01",
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S6");
  });

  it("sends Plantee Bioplastics to S9 on its project tie", () => {
    const r = assignSegment(
      company({
        legal_name: "Plantee Bioplastics",
        project_match: "human_confirmed",
        matched_project: "Alara",
        is_consumer_packaged_goods: true,
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S9");
  });

  it("REPORT CONTRADICTION: §4's ladder sends a funded CPG brand to S11, not S4", () => {
    // §5 S4 asserts "§4 precedence sends CPG to S4", but §4's ladder tests
    // raised_institutional_capital BEFORE consumer_packaged_goods. §4 is the normative ladder,
    // so it wins here. Recorded as a test so the divergence is visible, not buried.
    const r = assignSegment(
      company({
        legal_name: "A Funded Vancouver CPG Brand",
        is_consumer_packaged_goods: true,
        raised_institutional_capital_at: "2026-02-01",
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S11");
  });

  it("treats a raise older than 36 months as no longer an S11 signal", () => {
    const r = assignSegment(
      company({
        legal_name: "An Older Startup",
        is_consumer_packaged_goods: true,
        raised_institutional_capital_at: "2020-01-01",
      }),
      { now: NOW },
    );
    expect(r.segment).toBe("S4");
  });

  it("keeps UNSEGMENTED visible as a legitimate terminal state", () => {
    const r = assignSegment(company({ legal_name: "Nothing Matched" }), { now: NOW });
    expect(r.segment).toBe("UNSEGMENTED");
    expect(r.basis).toContain("do not contact");
  });
});

// ===========================================================================
// §6.3 — hard gates
// ===========================================================================

describe("evaluateGates", () => {
  it("makes G_GEO SOFT for S6 only — an alum elsewhere still qualifies", () => {
    const alum = company({
      legal_name: "Toronto Alum Co",
      alumni_evidence: "enactus_alum_led",
      municipality: "Toronto",
      region: "ON",
    });
    const s6 = evaluateGates(alum, "S6", config, { now: NOW }).find((g) => g.gate === "G_GEO");
    expect(s6?.verdict).toBe("not_applicable");

    const notS6 = evaluateGates({ ...alum, alumni_evidence: "none" }, "S2", config, { now: NOW }).find(
      (g) => g.gate === "G_GEO",
    );
    expect(notS6?.verdict).toBe("fail");
  });

  it("cannot evaluate G_SIZE without a headcount, and does not treat that as a failure", () => {
    const g = evaluateGates(company({ legal_name: "X" }), "S2", config, { now: NOW }).find(
      (x) => x.gate === "G_SIZE",
    );
    expect(g?.verdict).toBe("cannot_evaluate");
    expect(g?.message).toContain("absence of evidence is never a kill");
  });

  it("REASSIGNS rather than blocks when G_SIZE fails", () => {
    const g = evaluateGates(company({ legal_name: "X", headcount: 400 }), "S2", config, {
      now: NOW,
    }).find((x) => x.gate === "G_SIZE");
    expect(g?.verdict).toBe("fail");
    expect(g?.effect).toBe("reassign");
  });

  it("PARKS a stale trigger rather than killing the lead", () => {
    const g = evaluateGates(
      company({
        legal_name: "X",
        triggers: [{ kind: "funding_round", observed_at: "2024-01-01" }],
      }),
      "S11",
      config,
      { now: NOW },
    ).find((x) => x.gate === "G_TRIGGER_FRESH");
    expect(g?.verdict).toBe("fail");
    expect(g?.effect).toBe("park");
    expect(g?.message).toContain("do not kill");
  });

  it("applies G_ELIGIBILITY to S8, S10 and S14 only", () => {
    for (const seg of ["S8", "S10", "S14"] as const) {
      const g = evaluateGates(
        company({ legal_name: "X", eligibility_requires_charity: true }),
        seg,
        config,
        { now: NOW },
      ).find((x) => x.gate === "G_ELIGIBILITY");
      expect(g?.verdict, seg).toBe("fail");
    }
    const other = evaluateGates(
      company({ legal_name: "X", eligibility_requires_charity: true }),
      "S2",
      config,
      { now: NOW },
    ).find((x) => x.gate === "G_ELIGIBILITY");
    expect(other?.verdict).toBe("not_applicable");
  });

  it("CAPS AFFINITY rather than killing when the S6 affiliation evidence does not clear", () => {
    const g = evaluateGates(
      company({ legal_name: "X", alumni_evidence: "enactus_alum_led" }),
      "S6",
      config,
      { now: NOW },
    ).find((x) => x.gate === "G_AFFILIATION_EVIDENCE");
    expect(g?.verdict).toBe("fail");
    expect(g?.effect).toBe("cap_affinity");
  });
});

describe("G_AFFILIATION_EVIDENCE · the bar the report calls non-negotiable", () => {
  const cases: [string, Parameters<typeof affiliationEvidenceClears>[0], boolean][] = [
    ["nothing", [], false],
    ["one tier-1 source", [{ url: "https://www.sfu.ca/alumni/news/x.html", literal_substring_present: true }], true],
    [
      "one tier-2 source alone",
      [{ url: "https://betakit.com/story", literal_substring_present: true }],
      false,
    ],
    [
      "two tier-2 sources on DIFFERENT domains",
      [
        { url: "https://betakit.com/story", literal_substring_present: true },
        { url: "https://dailyhive.com/story", literal_substring_present: true },
      ],
      true,
    ],
    [
      "two tier-2 sources on the SAME domain",
      [
        { url: "https://betakit.com/story-a", literal_substring_present: true },
        { url: "https://betakit.com/story-b", literal_substring_present: true },
      ],
      false,
    ],
    [
      "a tier-1 source WITHOUT the literal substring",
      [{ url: "https://www.sfu.ca/alumni/news/x.html", literal_substring_present: false }],
      false,
    ],
  ];

  it.each(cases)("with %s → %s", (_label, sources, expected) => {
    expect(affiliationEvidenceClears(sources, config)).toBe(expected);
  });

  it("caps the alumni term to the no-alumni level and says so in the breakdown", () => {
    const c = company({ legal_name: "Claimed Alum Co", alumni_evidence: "enactus_alum_led" });
    const capped = scoreAffinity(c, "S6", config, { affiliation_capped: true });
    const uncapped = scoreAffinity(c, "S6", config, { affiliation_capped: false });
    expect(capped.terms.find((t) => t.term === "alumni_evidence")?.points).toBe(0);
    expect(uncapped.terms.find((t) => t.term === "alumni_evidence")?.points).toBe(30);
    expect(capped.terms.find((t) => t.term === "alumni_evidence")?.basis).toContain(
      "must not appear in copy",
    );
  });
});

// ===========================================================================
// §6.4 — the three scores
// ===========================================================================

describe("geographyBand", () => {
  const cases: [string, Partial<CompanyFacts>, string][] = [
    ["Burnaby", { municipality: "Burnaby" }, "core"],
    ["Vancouver", { municipality: "Vancouver" }, "core"],
    ["Surrey", { municipality: "Surrey" }, "core"],
    ["Richmond", { municipality: "Richmond" }, "metro"],
    ["a V5 postal code", { postal_code: "V5A 1S6" }, "metro"],
    ["Kelowna", { municipality: "Kelowna", region: "BC" }, "bc_outside_metro"],
    ["Toronto", { municipality: "Toronto", region: "ON" }, "elsewhere"],
    ["nothing at all", {}, "elsewhere"],
  ];

  it.each(cases)("puts %s in the %s band", (_label, over, expected) => {
    expect(geographyBand(company({ legal_name: "X", ...over }), config)).toBe(expected);
  });
});

describe("the three scores", () => {
  it("never exposes a blended total", () => {
    const r = scoreCompany(company({ legal_name: "X", has_consumer_storefront: true }), config, {
      now: NOW,
    });
    expect(r).not.toHaveProperty("total");
    expect(r).not.toHaveProperty("score");
    expect(r.fit.score).toBeTypeOf("number");
    expect(r.affinity.score).toBeTypeOf("number");
    expect(r.access.score).toBeTypeOf("number");
  });

  it("keeps every score inside 0..100", () => {
    const maximal = company({
      legal_name: "Maximal Co",
      relationship_tier: "active_partner",
      alumni_evidence: "enactus_alum_led",
      project_match: "human_confirmed",
      matched_project: "Alara",
      municipality: "Burnaby",
      region: "BC",
      headcount: 20,
      industry_sub_vertical: true,
      orgbook_status: "ACT",
      orgbook_entity_type: "SP",
      registration_date: "2010-01-01",
      contact_name: "Jane Whitcombe",
      contact_title: "Owner",
      deliverable_contact: true,
      lawful_basis_strength: "ebr_2y",
      channel_available: true,
      within_2km_of_campus: true,
      has_giving_page: true,
      has_trial_offer: true,
      prior_ask_class: "in_kind_service",
    });
    const r = scoreCompany(maximal, config, { now: NOW });
    for (const b of [r.fit, r.affinity, r.access]) {
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(100);
    }
  });

  it("explains every term, so a card can answer 'why is this a 74?'", () => {
    const r = scoreCompany(
      company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" }),
      config,
      { now: NOW },
    );
    for (const b of [r.fit, r.affinity, r.access]) {
      for (const t of b.terms) {
        expect(t.basis.length, `${t.term} has no basis`).toBeGreaterThan(5);
        expect(t.points).toBeLessThanOrEqual(t.max);
      }
    }
  });

  it("says out loud when a low fit score is caused by MISSING data rather than bad fit", () => {
    const r = scoreFit(
      company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" }),
      "S2",
      config,
      { now: NOW, missing: [] },
    );
    const sizeTerm = r.terms.find((t) => t.term === "size_band");
    expect(sizeTerm?.points).toBe(0);
    expect(sizeTerm?.basis).toContain("depressed by missing data, not by a bad fit");
  });

  it("accepts OrgBook SP/GP as the free headcount proxy the club can actually obtain", () => {
    const r = scoreFit(
      company({ legal_name: "X", has_consumer_storefront: true, orgbook_entity_type: "SP" }),
      "S2",
      config,
      { now: NOW, missing: [] },
    );
    expect(r.terms.find((t) => t.term === "size_band")?.points).toBe(20);
  });

  it("scores the ideal band above the ceiling band", () => {
    const inIdeal = scoreFit(company({ legal_name: "X", headcount: 20 }), "S2", config, { now: NOW });
    const underCeiling = scoreFit(company({ legal_name: "X", headcount: 80 }), "S2", config, {
      now: NOW,
    });
    const ideal = inIdeal.terms.find((t) => t.term === "size_band")?.points ?? 0;
    const ceiling = underCeiling.terms.find((t) => t.term === "size_band")?.points ?? 0;
    expect(ideal).toBeGreaterThan(ceiling);
  });

  it.each([
    ["active_partner", 35],
    ["lapsed_partner", 30],
    ["engaged_non_monetary", 22],
    ["prospected", 6],
    ["cold", 0],
  ] as const)("scores relationship_tier %s at %d", (tier, points) => {
    const r = scoreAffinity(company({ legal_name: "X", relationship_tier: tier }), "S1", config);
    expect(r.terms.find((t) => t.term === "relationship_tier")?.points).toBe(points);
  });

  it("scores a human-confirmed project match far above a keyword-only one", () => {
    const confirmed = scoreAffinity(
      company({ legal_name: "X", project_match: "human_confirmed" }),
      "S9",
      config,
    );
    const keyword = scoreAffinity(
      company({ legal_name: "X", project_match: "keyword_only" }),
      "S9",
      config,
    );
    expect(confirmed.terms.find((t) => t.term === "project_values_match")?.points).toBe(15);
    expect(keyword.terms.find((t) => t.term === "project_values_match")?.points).toBe(5);
  });

  it("awards approver_collapse on OrgBook SP/GP, the report's direct machine evidence", () => {
    const r = scoreAccess(company({ legal_name: "X", orgbook_entity_type: "SP" }), "S2", config);
    expect(r.terms.find((t) => t.term === "approver_collapse")?.points).toBe(25);
  });

  it("uses the per-segment seniority allowlist for named_approver", () => {
    const recruiter = company({
      legal_name: "Manning Elliott",
      contact_name: "Dana Lee",
      contact_title: "Campus Recruiting Lead",
    });
    expect(scoreAccess(recruiter, "S7", config).terms.find((t) => t.term === "named_approver")?.points).toBe(
      30,
    );
    // The same title is NOT on S2's owner-shaped allowlist.
    expect(scoreAccess(recruiter, "S2", config).terms.find((t) => t.term === "named_approver")?.points).toBe(
      0,
    );
  });

  it.each(["Owner / GM", "Program Officer", "Community Investment Team", "Owner"])(
    "refuses to treat the role placeholder %j as a named approver",
    (name) => {
      expect(isRealPersonName(name)).toBe(false);
      const r = scoreAccess(
        company({ legal_name: "X", contact_name: name, contact_title: "Owner" }),
        "S2",
        config,
      );
      expect(r.terms.find((t) => t.term === "named_approver")?.points).toBe(0);
    },
  );
});

// ===========================================================================
// Trigger bonus
// ===========================================================================

describe("triggerBonus", () => {
  it("caps the bonus at max_bonus", () => {
    const r = triggerBonus(
      company({
        legal_name: "X",
        triggers: [
          { kind: "grant_window_open", observed_at: "2026-08-01" },
          { kind: "student_job_posting", observed_at: "2026-08-01" },
          { kind: "funding_round", observed_at: "2026-07-01" },
        ],
      }),
      config,
      { now: NOW },
    );
    expect(r.bonus).toBe(25);
    expect(r.applied).toHaveLength(3);
  });

  it("PARKS a stale funding round instead of down-weighting it", () => {
    const r = triggerBonus(
      company({ legal_name: "X", triggers: [{ kind: "funding_round", observed_at: "2025-01-01" }] }),
      config,
      { now: NOW },
    );
    expect(r.bonus).toBe(0);
    expect(r.parked[0]).toMatchObject({ kind: "funding_round", max_age_days: 180 });
  });

  it("treats a 60-day-old job posting as stale, because a stale posting is not a trigger", () => {
    const fresh = triggerBonus(
      company({ legal_name: "X", triggers: [{ kind: "student_job_posting", observed_at: "2026-07-20" }] }),
      config,
      { now: NOW },
    );
    const stale = triggerBonus(
      company({ legal_name: "X", triggers: [{ kind: "student_job_posting", observed_at: "2026-01-01" }] }),
      config,
      { now: NOW },
    );
    expect(fresh.bonus).toBe(20);
    expect(stale.bonus).toBe(0);
  });

  it("treats the national-championship win as a rising tide, not a differentiator", () => {
    expect(config.trigger_bonus.values.club_national_win).toBe(8);
  });
});

// ===========================================================================
// The derived ask
// ===========================================================================

describe("deriveAsk — derived, never scored, never invented by a student", () => {
  it.each([
    ["S2", "in_kind_prize", "in_kind"],
    ["S3", "in_kind_service", "in_kind"],
    ["S7", "cash_gold", "gold"],
    ["S12", "cash_diamond", "diamond"],
    ["S13", "cash_bronze", "bronze"],
    ["S14", "grant_application", "grant"],
    ["S15", "non_monetary_time", "none"],
    ["S16", "in_kind_venue", "none"],
  ] as const)("gives %s the %s ask at tier %s", (segment, cls, tier) => {
    const ask = deriveAsk(company({ legal_name: "X" }), segment, null, config);
    expect(ask?.class).toBe(cls);
    expect(ask?.tier).toBe(tier);
  });

  it("never opens with cash for a neighbourhood storefront", () => {
    const ask = deriveAsk(company({ legal_name: "Crema Artisan Bakers" }), "S2", null, config);
    expect(ask?.amount_low).toBe(0);
    expect(ask?.amount_high).toBe(0);
    expect(ask?.imputed_low).toBe(25);
    expect(ask?.imputed_high).toBe(75);
  });

  it("tiers S6 by AFFINITY, not by company size", () => {
    const enactus = deriveAsk(
      company({ legal_name: "X", alumni_evidence: "enactus_alum_led" }),
      "S6",
      null,
      config,
    );
    const sfu = deriveAsk(
      company({ legal_name: "X", alumni_evidence: "sfu_alum_led" }),
      "S6",
      null,
      config,
    );
    expect(enactus?.tier).toBe("diamond");
    expect(sfu?.tier).toBe("silver");
    expect(enactus?.basis).toContain("personal, not budgetary");
  });

  const escalations: [string, string, string][] = [
    ["in_kind_prize", "cash_bronze", "bronze"],
    ["in_kind_service", "cash_bronze", "bronze"],
    ["cash_bronze", "cash_silver", "silver"],
    ["cash_silver", "cash_gold", "gold"],
    ["cash_gold", "cash_diamond", "diamond"],
    ["non_monetary_time", "in_kind_prize", "in_kind"],
  ];

  it.each(escalations)("S1 escalates last year's %s to %s", (prior, cls, tier) => {
    const ask = deriveAsk(
      company({ legal_name: "X", relationship_tier: "lapsed_partner", prior_ask_class: prior as never }),
      "S1",
      "S3",
      config,
    );
    expect(ask?.class).toBe(cls);
    expect(ask?.tier).toBe(tier);
  });

  it("says out loud when the prior ask is unknown, because that data does not exist anywhere", () => {
    const ask = deriveAsk(
      company({ legal_name: "X", relationship_tier: "lapsed_partner" }),
      "S1",
      "S3",
      config,
    );
    expect(ask?.basis).toContain("does not exist anywhere and must be reconstructed internally");
  });

  it("returns null rather than inventing an ask for an unsegmented company", () => {
    expect(deriveAsk(company({ legal_name: "X" }), "UNSEGMENTED", null, config)).toBeNull();
    expect(deriveAsk(company({ legal_name: "X" }), "EXCLUDED", null, config)).toBeNull();
  });
});

// ===========================================================================
// The two objectives — the whole point of the exercise
// ===========================================================================

describe("the two objectives", () => {
  it("keeps deployable cash and relationship volume apart and never sums them", () => {
    const o = computeObjectives("S7", deriveAsk(company({ legal_name: "X" }), "S7", null, config), config);
    expect(o.deployable_cash.applicable).toBe(true);
    expect(o.relationship_volume.applicable).toBe(true);
    expect(o).not.toHaveProperty("combined");
    expect(o).not.toHaveProperty("total");
  });

  it("marks the cash objective NOT APPLICABLE — not zero — for Tier B", () => {
    for (const seg of ["S15", "S16"] as const) {
      const o = computeObjectives(seg, deriveAsk(company({ legal_name: "X" }), seg, null, config), config);
      expect(o.deployable_cash.applicable, seg).toBe(false);
      expect(o.deployable_cash.expected_cash, seg).toBeUndefined();
      expect(o.deployable_cash.note, seg).toContain("NOT APPLICABLE");
      expect(o.deployable_cash.note, seg).toContain("failed sale");
      // The relationship objective is where a Tier B success actually shows up.
      expect(o.relationship_volume.applicable, seg).toBe(true);
      expect(o.relationship_volume.expected_relationships, seg).toBeGreaterThan(0);
    }
  });

  it("excludes S17 from both objectives entirely", () => {
    const o = computeObjectives("S17", deriveAsk(company({ legal_name: "X" }), "S17", null, config), config);
    expect(o.deployable_cash.applicable).toBe(false);
    expect(o.relationship_volume.applicable).toBe(false);
  });

  it("shows the structural finding: the volume engine produces logos and $0 cash", () => {
    // S2 converts far more often than S7 and is worth nothing in deployable cash.
    const s2 = computeObjectives("S2", deriveAsk(company({ legal_name: "X" }), "S2", null, config), config);
    const s7 = computeObjectives("S7", deriveAsk(company({ legal_name: "X" }), "S7", null, config), config);

    expect(s2.deployable_cash.expected_cash).toBe(0);
    expect(s2.deployable_cash.note).toContain("in-kind is where the yes lives and it pays nothing");
    expect(s7.deployable_cash.expected_cash).toBeGreaterThan(0);

    // ...and yet S2 wins decisively on relationships per hour.
    expect(s2.relationship_volume.relationships_per_hour!).toBeGreaterThan(
      s7.relationship_volume.relationships_per_hour!,
    );
    // A pipeline ranked on cash alone would pick S7; ranked on volume alone it would pick S2.
    expect(s7.deployable_cash.cash_per_hour!).toBeGreaterThan(s2.deployable_cash.cash_per_hour!);
  });

  it("splits S1's p_yes between the in-kind renewal and the cash escalation", () => {
    const inKind = resolvePYes(config, "S1", "in_kind_prize");
    const cash = resolvePYes(config, "S1", "cash_bronze");
    expect(inKind).toEqual({ key: "S1_renewal_in_kind", value: 0.4 });
    expect(cash).toEqual({ key: "S1_renewal_cash", value: 0.15 });
  });

  it("resolves a p_yes for every scoreable segment", () => {
    for (const id of SEGMENT_IDS) {
      if (config.segments[id].objective === "excluded") continue;
      expect(resolvePYes(config, id, null), id).not.toBeNull();
    }
  });

  it("computes cash_per_hour from p_yes, the ask midpoint and effort_minutes", () => {
    const ask = deriveAsk(company({ legal_name: "X" }), "S7", null, config);
    const o = computeObjectives("S7", ask, config);
    // p_yes 0.075 x midpoint($500,$1000) = $56.25 expected; effort 45 min -> $75.00/hour.
    expect(o.deployable_cash.expected_cash).toBeCloseTo(56.25, 5);
    expect(o.deployable_cash.cash_per_hour).toBeCloseTo(75, 5);
  });

  it("carries the imputed in-kind value separately from cash, never folded into it", () => {
    const ask = deriveAsk(company({ legal_name: "X" }), "S3", null, config);
    const o = computeObjectives("S3", ask, config);
    expect(o.deployable_cash.expected_cash).toBe(0);
    expect(o.relationship_volume.expected_imputed_in_kind).toBeGreaterThan(0);
  });
});

// ===========================================================================
// End to end
// ===========================================================================

describe("scoreCompany", () => {
  it("scores a COLD Manning Elliott-shaped firm as S7 with a correctly-priced Gold ask", () => {
    const r = scoreCompany(
      company({
        legal_name: "A Mid-Market Lower Mainland Firm",
        headcount: 220,
        runs_campus_recruiting: true,
        municipality: "Burnaby",
        region: "BC",
        contact_name: "Dana Lee",
        contact_title: "Campus Recruiting Lead",
        deliverable_contact: true,
        lawful_basis_strength: "conspicuous_pub_named_person",
        domain_resolves: true,
        orgbook_status: "ACT",
        triggers: [{ kind: "student_job_posting", observed_at: "2026-07-20" }],
      }),
      config,
      { now: NOW },
    );
    expect(r.segment).toBe("S7");
    expect(r.ask?.tier).toBe("gold");
    expect(r.trigger_bonus.bonus).toBe(20);
    expect(r.objectives.deployable_cash.expected_cash).toBeGreaterThan(0);
  });

  it("scores the REAL Manning Elliott as S1 with underlying S7, because it is already on the wall", () => {
    // §3.3 maps Manning Elliott's business profile to S7. §4 then overrides live assignment: it
    // is on the 2025-26 partnerships wall, so relationship_tier != cold and the RENEWAL motion
    // owns the outreach while S7 still owns the ask, the tier and the copy.
    const r = scoreCompany(
      company({
        legal_name: "Manning Elliott",
        registrable_domain: "manningelliott.com",
        headcount: 220,
        runs_campus_recruiting: true,
        municipality: "Burnaby",
        region: "BC",
        relationship_tier: "engaged_non_monetary",
        industry_sub_vertical: true,
        orgbook_status: "ACT",
        registration_date: "1950-01-01",
        contact_name: "Dana Lee",
        contact_title: "Campus Recruiting Lead",
        deliverable_contact: true,
        lawful_basis_strength: "conspicuous_pub_named_person",
        channel_available: true,
        domain_resolves: true,
        no_solicitation_found: false,
        triggers: [{ kind: "student_job_posting", observed_at: "2026-07-20" }],
      }),
      config,
      { now: NOW },
    );
    expect(r.segment).toBe("S1");
    expect(r.underlying_segment).toBe("S7");
    // The underlying segment still owns the ask: Gold is correctly priced for a talent recruiter.
    expect(r.ask?.tier).toBe("gold");
    expect(r.blocked).toBe(false);
    expect(r.trigger_bonus.bonus).toBe(20);
    // Renewal p_yes, not cold p_yes — and the report's point: nobody has ever asked it for money.
    expect(r.objectives.deployable_cash.note).toContain("S1_renewal_cash");
    expect(r.objectives.deployable_cash.expected_cash).toBeGreaterThan(0);
  });

  it("blocks on a failed gate no matter how high the scores are", () => {
    const r = scoreCompany(
      company({
        legal_name: "Suppressed But Perfect",
        relationship_tier: "active_partner",
        has_consumer_storefront: true,
        municipality: "Burnaby",
        region: "BC",
        headcount: 10,
        suppressed: true,
        lawful_basis_strength: "ebr_2y",
      }),
      config,
      { now: NOW },
    );
    expect(r.affinity.score).toBeGreaterThan(30);
    expect(r.blocked).toBe(true);
    expect(r.blocking_gates).toContain("G_SUPPRESSED");
  });

  it("lists what it could not evaluate rather than silently scoring zero", () => {
    const r = scoreCompany(company({ legal_name: "Bare Co" }), config, { now: NOW });
    expect(r.missing_inputs.length).toBeGreaterThan(0);
    expect(r.missing_inputs).toContain("headcount");
  });

  it("is deterministic", () => {
    const c = company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" });
    expect(JSON.stringify(scoreCompany(c, config, { now: NOW }))).toBe(
      JSON.stringify(scoreCompany(c, config, { now: NOW })),
    );
  });

  it("re-scores instantly when the weights change, with no model involved", () => {
    const c = company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" });
    const retuned = {
      ...config,
      fit_score: { ...config.fit_score, geography: 40, segment_match: 20 },
    };
    const before = scoreCompany(c, config, { now: NOW }).fit.terms.find((t) => t.term === "geography");
    const after = scoreCompany(c, retuned, { now: NOW }).fit.terms.find((t) => t.term === "geography");
    expect(before?.max).toBe(20);
    expect(after?.max).toBe(40);
  });
});

describe("gateInputsFromFilterResult", () => {
  const lists = loadQualificationLists();

  it("maps a suppression kill onto the G_SUPPRESSED gate input", () => {
    const result = runFilter(
      { legal_name: "X", rel: { suppressed_at: "2025-01-01" } },
      lists,
      { now: NOW },
    );
    expect(gateInputsFromFilterResult(result)).toMatchObject({ suppressed: true, is_excluded: true });
  });

  it("maps a clean pass onto a non-excluded, non-suppressed company", () => {
    const result = runFilter(
      {
        legal_name: "Crema Artisan Bakers",
        registrable_domain: "example.ca",
        email: "info@example.ca",
        address_region: "BC",
        address_municipality: "Burnaby",
        address_country: "CA",
      },
      lists,
      { now: NOW },
    );
    const inputs = gateInputsFromFilterResult(result);
    expect(inputs.is_excluded).toBe(false);
    expect(inputs.suppressed).toBe(false);
  });
});

describe("the module contract", () => {
  it("imports no model client", () => {
    const source = readFileSync(new URL("../src/lib/scoring.ts", import.meta.url), "utf8");
    const imports = source.match(/^import[\s\S]*?from\s+"([^"]+)";/gm) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/llm|openai|anthropic|@ai-sdk|exa/i);
    }
  });

  it("keeps the weights out of the code — no score constant is hardcoded", () => {
    const source = readFileSync(new URL("../src/lib/scoring.ts", import.meta.url), "utf8");
    // Every weight is read from the config object rather than written as a literal.
    expect(source).not.toMatch(/segment_match:\s*\d+/);
    expect(source).not.toMatch(/relationship_tier:\s*35/);
  });
});

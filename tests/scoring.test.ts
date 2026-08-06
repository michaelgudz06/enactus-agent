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
const lists = loadQualificationLists();
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

  it("ACCEPTS a legitimate fractional retune whose parts do not sum to 100 in binary", () => {
    // Five one-decimal weights that add to 100 on paper and to 100.00000000000001 in IEEE-754.
    // A VP retuning the ICP must not be told the file is broken over that.
    const fractional = {
      segment_match: 27.7,
      size_band: 56.5,
      geography: 7.9,
      industry_specificity: 3.7,
      entity_signals: 4.2,
    };
    expect(Object.values(fractional).reduce((a, b) => a + b, 0)).not.toBe(100);

    const problems = validateIcpConfig({
      ...config,
      fit_score: fractional,
      affinity_score: fractional,
      access_score: fractional,
    });
    expect(problems.filter((p) => p.includes("sum to"))).toEqual([]);
  });

  it("still rejects a retune that is genuinely off by a visible amount", () => {
    const problems = validateIcpConfig({ ...config, fit_score: { a: 50, b: 49.9 } });
    expect(problems.join(" ")).toContain("weights sum to 99.9, not 100");
  });

  // The geography block is load-bearing: `scoreFit` reads bands[band] straight into clamp(), so
  // a missing key used to produce NaN through the whole fit score with no error anywhere.
  describe("the geography block is validated as loudly as the weights", () => {
    it.each(["core", "metro", "bc_outside_metro", "elsewhere"])(
      "rejects a config whose %s band was deleted, naming the key",
      (band) => {
        const bands = { ...config.geography.bands } as Record<string, number>;
        delete bands[band];
        const problems = validateIcpConfig({
          ...config,
          geography: { ...config.geography, bands },
        });
        expect(problems.join(" ")).toContain(`geography.bands.${band} is missing`);
      },
    );

    it("rejects a renamed band rather than silently scoring NaN", () => {
      const { bc_outside_metro, ...rest } = config.geography.bands;
      const problems = validateIcpConfig({
        ...config,
        geography: { ...config.geography, bands: { ...rest, bc_outside_the_metro: bc_outside_metro } },
      });
      expect(problems.join(" ")).toContain("geography.bands.bc_outside_metro is missing");
    });

    it.each([
      ["a non-numeric band", { bands: { ...config.geography.bands, core: "twenty" } }, "not a number"],
      ["a negative band", { bands: { ...config.geography.bands, core: -5 } }, "negative"],
      ["an empty core list", { core: [] }, "geography.core is empty"],
      ["a missing core list", { core: undefined }, "geography.core is missing or not a list"],
      ["a blank postal prefix", { postal_prefixes: ["V5", " "] }, "non-string or blank entry"],
    ])("rejects %s", (_label, over, expected) => {
      const problems = validateIcpConfig({ ...config, geography: { ...config.geography, ...over } });
      expect(problems.join(" ")).toContain(expected);
    });

    it("rejects a config with no geography block at all", () => {
      const withoutGeography: Record<string, unknown> = { ...config };
      delete withoutGeography.geography;
      expect(validateIcpConfig(withoutGeography).join(" ")).toContain("geography is missing");
    });

    it("accepts the shipped file, and every band actually scores a finite number", () => {
      expect(validateIcpConfig(config).filter((p) => p.startsWith("geography"))).toEqual([]);
      for (const municipality of ["Burnaby", "Richmond", "Kelowna", "Toronto"]) {
        const r = scoreCompany(
          company({ legal_name: "X", municipality, region: municipality === "Kelowna" ? "BC" : undefined }),
          config,
          { lists, now: NOW },
        );
        expect(Number.isFinite(r.fit.score), municipality).toBe(true);
      }
    });
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
    const s6 = evaluateGates(alum, "S6", config, { lists, now: NOW }).find((g) => g.gate === "G_GEO");
    expect(s6?.verdict).toBe("not_applicable");

    const notS6 = evaluateGates({ ...alum, alumni_evidence: "none" }, "S2", config, { lists, now: NOW }).find(
      (g) => g.gate === "G_GEO",
    );
    expect(notS6?.verdict).toBe("fail");
  });

  it("cannot evaluate G_SIZE without a headcount, and does not treat that as a failure", () => {
    const g = evaluateGates(company({ legal_name: "X" }), "S2", config, { lists, now: NOW }).find(
      (x) => x.gate === "G_SIZE",
    );
    expect(g?.verdict).toBe("cannot_evaluate");
    expect(g?.effect).toBe("none");
  });

  describe("G_EXISTS · missing data is never a kill", () => {
    function existsGate(over: Partial<CompanyFacts>) {
      return evaluateGates(company({ legal_name: "X", ...over }), "S2", config, {
        lists,
        now: NOW,
      }).find((x) => x.gate === "G_EXISTS");
    }

    it("never reports dead_domain for a domain that demonstrably resolves", () => {
      // DNS is in; OrgBook has not been imported and no source count exists yet.
      const g = existsGate({ domain_resolves: true });
      expect(g?.verdict).toBe("cannot_evaluate");
      expect(g?.effect).toBe("none");
    });

    it("does not block scoring when corroboration is merely absent", () => {
      const r = scoreCompany(
        company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby", domain_resolves: true }),
        config,
        { lists, now: NOW },
      );
      expect(r.blocking_gates).not.toContain("G_EXISTS");
      expect(r.missing_inputs).toContain("G_EXISTS");
    });

    it("cannot evaluate when nothing at all is recorded", () => {
      expect(existsGate({})?.verdict).toBe("cannot_evaluate");
    });

    it("still FAILS on contrary evidence", () => {
      expect(existsGate({ domain_resolves: false })?.verdict).toBe("fail");
      expect(existsGate({ domain_resolves: true, domain_parked: true })?.verdict).toBe("fail");
      // Corroboration was recorded and fell short — that is evidence, not absence.
      expect(existsGate({ domain_resolves: true, independent_live_sources: 1 })?.verdict).toBe("fail");
    });

    it("passes on corroborated existence", () => {
      expect(existsGate({ domain_resolves: true, orgbook_status: "ACT" })?.verdict).toBe("pass");
      expect(existsGate({ domain_resolves: true, independent_live_sources: 2 })?.verdict).toBe("pass");
    });
  });

  // The gate set walked once end to end, the way terminals and penalties were. For every
  // blocking gate: what does it return when its inputs are ABSENT, and what does it return on
  // CONTRARY EVIDENCE? Absent must never block.
  describe("every blocking gate · absent inputs cannot_evaluate, only contrary evidence fails", () => {
    function gate(name: string, over: Partial<CompanyFacts>, segment: SegmentAssignment = "S2") {
      return evaluateGates(company({ legal_name: "X", ...over }), segment, config, {
        lists,
        now: NOW,
      }).find((g) => g.gate === name);
    }

    it.each([
      ["G_GEO", {}, { municipality: "Toronto", region: "ON" }, "S2"],
      ["G_EXISTS", {}, { domain_resolves: false }, "S2"],
      ["G_SIZE", {}, { headcount: 400 }, "S2"],
      ["G_DELIVERABLE", {}, { deliverable_contact: false }, "S2"],
      ["G_NO_SOLICIT", {}, { no_solicitation_found: true }, "S2"],
      ["G_ELIGIBILITY", {}, { eligibility_requires_charity: true }, "S8"],
    ] as const)("%s", (name, absent, contrary, segment) => {
      const unknown = gate(name, absent, segment);
      expect(unknown?.verdict, `${name} on absent input`).toBe("cannot_evaluate");
      expect(unknown?.effect, `${name} on absent input`).toBe("none");

      const known = gate(name, contrary, segment);
      expect(known?.verdict, `${name} on contrary evidence`).toBe("fail");
    });

    it("G_NAMED_PERSON cannot evaluate an absent name and never blocks either way", () => {
      expect(gate("G_NAMED_PERSON", {})?.verdict).toBe("cannot_evaluate");
      expect(gate("G_NAMED_PERSON", { contact_name: "Owner / GM" })?.verdict).toBe("fail");
      expect(gate("G_NAMED_PERSON", { contact_name: "Owner / GM" })?.effect).toBe("none");
    });

    it.each([
      ["G_EXCLUDED", { is_excluded: true }],
      ["G_SUPPRESSED", { suppressed: true }],
    ] as const)("%s fails only on a recorded hit, and an unset field lets the row through", (name, hit) => {
      expect(gate(name, {})?.verdict).toBe("pass");
      expect(gate(name, hit)?.verdict).toBe("fail");
    });
  });

  // G_GEO was the second gate caught blocking on missing data. Partial geography is an
  // unresolved place name, not a place known to be out of area, and filter.ts returns
  // cannot_evaluate on the identical input.
  describe("G_GEO · partial geography is unresolved, not out of area", () => {
    function geoGate(over: Partial<CompanyFacts>) {
      return evaluateGates(company({ legal_name: "X", ...over }), "S2", config, {
        lists,
        now: NOW,
      }).find((g) => g.gate === "G_GEO");
    }

    it.each([
      ["a municipality with no region or postal code", { municipality: "Abbotsford" }],
      ["a municipality the alias map does not carry", { municipality: "Nowheresville" }],
      ["a postal code outside the metro prefixes, with no region", { postal_code: "V2S 1A1" }],
      ["nothing at all", {}],
    ])("cannot evaluate %s", (_label, over) => {
      const g = geoGate(over);
      expect(g?.verdict).toBe("cannot_evaluate");
      expect(g?.effect).toBe("none");
    });

    it("does not block scoring on partial geography, and records the gap", () => {
      const r = scoreCompany(
        company({
          legal_name: "Abbotsford Bakery",
          municipality: "Abbotsford",
          has_consumer_storefront: true,
          relationship_tier: "cold",
          lawful_basis_strength: "express",
        }),
        config,
        { lists, now: NOW },
      );
      expect(r.blocked).toBe(false);
      expect(r.blocking_gates).not.toContain("G_GEO");
      expect(r.missing_inputs).toContain("G_GEO");
    });

    it("still FAILS on a recorded region that is not BC", () => {
      expect(geoGate({ municipality: "Toronto", region: "ON" })?.verdict).toBe("fail");
      expect(geoGate({ region: "SK" })?.verdict).toBe("fail");
    });

    it("passes a BC municipality outside Metro Vancouver on the strength of the region", () => {
      const g = geoGate({ municipality: "Abbotsford", region: "BC" });
      expect(g?.verdict).toBe("pass");
    });

    it.each([
      ["Burnaby", "metro"],
      ["Anmore", "metro"],
      ["Bowen Island", "metro"],
    ])("passes %s from metro-vancouver.csv alone", (municipality) => {
      expect(geoGate({ municipality })?.verdict).toBe("pass");
    });
  });

  it("REASSIGNS rather than blocks when G_SIZE fails", () => {
    const g = evaluateGates(company({ legal_name: "X", headcount: 400 }), "S2", config, {
      lists,
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
      { lists, now: NOW },
    ).find((x) => x.gate === "G_TRIGGER_FRESH");
    expect(g?.verdict).toBe("fail");
    expect(g?.effect).toBe("park");
  });

  it("applies G_ELIGIBILITY to S8, S10 and S14 only", () => {
    for (const seg of ["S8", "S10", "S14"] as const) {
      const g = evaluateGates(
        company({ legal_name: "X", eligibility_requires_charity: true }),
        seg,
        config,
        { lists, now: NOW },
      ).find((x) => x.gate === "G_ELIGIBILITY");
      expect(g?.verdict, seg).toBe("fail");
    }
    const other = evaluateGates(
      company({ legal_name: "X", eligibility_requires_charity: true }),
      "S2",
      config,
      { lists, now: NOW },
    ).find((x) => x.gate === "G_ELIGIBILITY");
    expect(other?.verdict).toBe("not_applicable");
  });

  it("CAPS AFFINITY rather than killing when the S6 affiliation evidence does not clear", () => {
    const g = evaluateGates(
      company({ legal_name: "X", alumni_evidence: "enactus_alum_led" }),
      "S6",
      config,
      { lists, now: NOW },
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
    expect(geographyBand(company({ legal_name: "X", ...over }), config, lists)).toBe(expected);
  });

  // The maintained CSV carries all 23 member jurisdictions; the six below were absent from the
  // shorter list config/icp.yaml used to carry, so G_GEO killed them as `out_of_area`. A local
  // business on Bowen Island is exactly the in-kind prospect this pipeline exists to find.
  const PREVIOUSLY_BLOCKED = [
    "Anmore",
    "Belcarra",
    "Bowen Island",
    "Lions Bay",
    "Tsawwassen First Nation",
    "Electoral Area A",
  ];

  it.each(PREVIOUSLY_BLOCKED)("counts %s as Metro Vancouver, not elsewhere", (municipality) => {
    expect(geographyBand(company({ legal_name: "X", municipality }), config, lists)).toBe("metro");
  });

  it.each(PREVIOUSLY_BLOCKED)("does not let G_GEO block a business in %s", (municipality) => {
    const g = evaluateGates(
      company({ legal_name: "X", municipality, has_consumer_storefront: true }),
      "S2",
      config,
      { lists, now: NOW },
    ).find((x) => x.gate === "G_GEO");
    expect(g?.verdict).toBe("pass");
  });

  it("resolves a neighbourhood alias to its jurisdiction's band", () => {
    // Kitsilano is an alias of the City of Vancouver in metro-vancouver.csv.
    expect(geographyBand(company({ legal_name: "X", municipality: "Kitsilano" }), config, lists)).toBe(
      "core",
    );
    expect(geographyBand(company({ legal_name: "X", municipality: "Steveston" }), config, lists)).toBe(
      "metro",
    );
  });

  it("agrees with the filter's membership test, because both read the same list", async () => {
    const { isInMetroVancouver } = await import("../src/lib/filter");
    for (const j of lists.metroVancouver) {
      const band = geographyBand(company({ legal_name: "X", municipality: j.canonical }), config, lists);
      expect(isInMetroVancouver(j.canonical, lists), j.canonical).toBe(true);
      expect(band === "core" || band === "metro", `${j.canonical} → ${band}`).toBe(true);
    }
  });
});

describe("the three scores", () => {
  it("never exposes a blended total", () => {
    const r = scoreCompany(company({ legal_name: "X", has_consumer_storefront: true }), config, {
      lists,
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
    const r = scoreCompany(maximal, config, { lists, now: NOW });
    for (const b of [r.fit, r.affinity, r.access]) {
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(100);
    }
  });

  it("explains every term, so a card can answer 'why is this a 74?'", () => {
    const r = scoreCompany(
      company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" }),
      config,
      { lists, now: NOW },
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
      { lists, now: NOW, missing: [] },
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
      { lists, now: NOW, missing: [] },
    );
    expect(r.terms.find((t) => t.term === "size_band")?.points).toBe(20);
  });

  it("scores the ideal band above the ceiling band", () => {
    const inIdeal = scoreFit(company({ legal_name: "X", headcount: 20 }), "S2", config, { lists, now: NOW });
    const underCeiling = scoreFit(company({ legal_name: "X", headcount: 80 }), "S2", config, {
      lists,
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
      { lists, now: NOW },
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
      { lists, now: NOW },
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
      { lists, now: NOW },
    );
    expect(r.affinity.score).toBeGreaterThan(30);
    expect(r.blocked).toBe(true);
    expect(r.blocking_gates).toContain("G_SUPPRESSED");
  });

  it("lists what it could not evaluate rather than silently scoring zero", () => {
    const r = scoreCompany(company({ legal_name: "Bare Co" }), config, { lists, now: NOW });
    expect(r.missing_inputs.length).toBeGreaterThan(0);
    expect(r.missing_inputs).toContain("headcount");
  });

  it("is deterministic", () => {
    const c = company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" });
    expect(JSON.stringify(scoreCompany(c, config, { lists, now: NOW }))).toBe(
      JSON.stringify(scoreCompany(c, config, { lists, now: NOW })),
    );
  });

  it("re-scores instantly when the weights change, with no model involved", () => {
    const c = company({ legal_name: "X", has_consumer_storefront: true, municipality: "Burnaby" });
    const retuned = {
      ...config,
      geography: { ...config.geography, bands: { ...config.geography.bands, core: 5 } },
      fit_score: { ...config.fit_score, geography: 40, segment_match: 20 },
    };
    const before = scoreCompany(c, config, { lists, now: NOW });
    const after = scoreCompany(c, retuned, { lists, now: NOW });
    const beforeGeo = before.fit.terms.find((t) => t.term === "geography");
    const afterGeo = after.fit.terms.find((t) => t.term === "geography");

    // The ceiling moved because the config said so, and so did the points actually awarded.
    expect(beforeGeo?.max).toBe(20);
    expect(afterGeo?.max).toBe(40);
    expect(beforeGeo?.points).toBe(20);
    expect(afterGeo?.points).toBe(5);
    expect(after.fit.score).not.toBe(before.fit.score);
  });
});

describe("gateInputsFromFilterResult", () => {

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

  // The linchpin of the whole scope model. Without these, reverting `is_excluded` to
  // `result.decision === "terminal"` would leave every filter test green.
  const base = {
    legal_name: "Some Local Business",
    registrable_domain: "example.ca",
    address_region: "BC",
    address_municipality: "Burnaby",
    address_country: "CA",
  };

  it("an ADDRESS-scoped terminal marks the contact undeliverable WITHOUT excluding the account", () => {
    const result = runFilter({ ...base, email: "someone@othercompany.ca" }, lists, { now: NOW });

    expect(result.kills).toEqual([]);
    const inputs = gateInputsFromFilterResult(result);
    expect(inputs.is_excluded).toBe(false);
    expect(inputs.deliverable_contact).toBe(false);

    // And the gate that follows from it: G_EXCLUDED must not block, G_DELIVERABLE must.
    const scored = scoreCompany({ ...company({ legal_name: base.legal_name }), ...inputs }, config, {
      lists,
      now: NOW,
    });
    expect(scored.segment).not.toBe("EXCLUDED");
    expect(scored.blocking_gates).not.toContain("G_EXCLUDED");
    expect(scored.blocking_gates).toContain("G_DELIVERABLE");
  });

  it("an EMAIL-scoped terminal reaches G_NO_SOLICIT and never G_EXCLUDED", () => {
    const result = runFilter(
      { ...base, email: "info@example.ca", source_page_text: "Please no unsolicited emails." },
      lists,
      { now: NOW },
    );

    expect(result.kills).toEqual([]);
    const inputs = gateInputsFromFilterResult(result);
    expect(inputs.is_excluded).toBe(false);
    expect(inputs.no_solicitation_found).toBe(true);

    const scored = scoreCompany({ ...company({ legal_name: base.legal_name }), ...inputs }, config, {
      lists,
      now: NOW,
    });
    expect(scored.segment).not.toBe("EXCLUDED");
    expect(scored.blocking_gates).not.toContain("G_EXCLUDED");
  });

  // L-04 is the finding that the CLAIMED CASL basis is invalid — a third-party directory URL is
  // not conspicuous publication — so G_LAWFUL_BASIS is the gate that owns it. Without this the
  // rescope from `account` to `email` silently removed L-04's only enforcement.
  it("L-04 closes the email channel and FAILS G_LAWFUL_BASIS, with the account surviving", () => {
    const result = runFilter(
      {
        ...base,
        email: "info@example.ca",
        lawful_basis: "conspicuous_pub",
        lawful_basis_url: "https://some-directory.example.org/listing/123",
      },
      lists,
      { now: NOW },
    );

    // The account survives and keeps accruing penalties.
    expect(result.decision).not.toBe("terminal");
    expect(result.kills).toEqual([]);
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.email_channel_open).toBe(false);

    // The closed channel reaches the adapter...
    const inputs = gateInputsFromFilterResult(result);
    expect(inputs.is_excluded).toBe(false);
    expect(inputs.lawful_basis_strength).toBe("none");

    // ...and blocks at G_LAWFUL_BASIS rather than at G_EXCLUDED.
    const scored = scoreCompany({ ...company({ legal_name: base.legal_name }), ...inputs }, config, {
      lists,
      now: NOW,
    });
    expect(scored.segment).not.toBe("EXCLUDED");
    expect(scored.blocking_gates).not.toContain("G_EXCLUDED");
    expect(scored.blocking_gates).toContain("G_LAWFUL_BASIS");
    expect(scored.blocked).toBe(true);
  });

  it("leaves a caller's recorded lawful basis alone when the email channel stays open", () => {
    const result = runFilter({ ...base, email: "info@example.ca" }, lists, { now: NOW });
    expect(result.email_channel_open).toBe(true);

    const inputs = gateInputsFromFilterResult(result);
    expect(inputs.lawful_basis_strength).toBeUndefined();

    const scored = scoreCompany(
      { ...company({ legal_name: base.legal_name, lawful_basis_strength: "express" }), ...inputs },
      config,
      { lists, now: NOW },
    );
    expect(scored.blocking_gates).not.toContain("G_LAWFUL_BASIS");
  });

  it("a PERSON-scoped terminal never excludes the account", () => {
    const result = runFilter(
      { ...base, email: "info@example.ca", contact_name: "Owner / GM" },
      lists,
      { now: NOW },
    );
    expect(gateInputsFromFilterResult(result).is_excluded).toBe(false);
  });

  it("only an ACCOUNT-scoped terminal excludes", () => {
    const result = runFilter({ ...base, legal_name: "Enactus UBC" }, lists, { now: NOW });
    expect(result.kills.every((k) => k.scope === "account")).toBe(true);
    expect(gateInputsFromFilterResult(result).is_excluded).toBe(true);
  });

  // The never-kill allowlist keeps a past sponsor in the corpus when its domain dies. It does not
  // make the dead domain deliverable, and the adapter must never turn a suppressed kill into a
  // POSITIVE assertion that the address works.
  it("never reports an OVERRIDDEN deliverability kill as a deliverable contact", () => {
    const result = runFilter(
      {
        legal_name: "Modo Yoga Vancouver",
        registrable_domain: "modoyogavancouver.com",
        email: "info@modoyogavancouver.com",
        address_municipality: "Vancouver",
        address_region: "BC",
        address_country: "CA",
        dns: {
          ns_present: false,
          a_present: false,
          mx_present: false,
          ns_hosts: [],
          mx_hosts: [],
          smtp25_open: null,
          resolver_attempts: 2,
        },
      },
      lists,
      { now: NOW },
    );

    // The allowlist did its job: the account survives rather than being dropped.
    expect(result.overridden_kills.map((k) => k.rule_id)).toContain("D-01");
    expect(result.kills).toEqual([]);

    const inputs = gateInputsFromFilterResult(result);
    expect(inputs.is_excluded).toBe(false);
    expect(inputs.deliverable_contact).toBe(false);

    // And the score does not award the deliverable-contact weight to a domain with no nameservers.
    const scored = scoreCompany({ ...company({ legal_name: "Modo Yoga Vancouver" }), ...inputs }, config, {
      lists,
      now: NOW,
    });
    expect(scored.access.terms.find((t) => t.term === "deliverable_contact")?.points).toBe(0);
    expect(scored.blocking_gates).toContain("G_DELIVERABLE");
  });
});

// The module contract — "imports no model client" and "the weights live in config, not in code"
// — is proved by execution: see tests/no-model-client.test.ts for the first, and
// "re-scores instantly when the weights change" above for the second.

import { describe, expect, it } from "vitest";
import {
  type Account,
  type FilterOptions,
  type PredicateResult,
  BC_PROVINCE_WIDE_OVERLAYS,
  DECLINE_SUPPRESSION_MONTHS,
  areaCodeSignal,
  d01DeadDomain,
  d02ParkedDomain,
  d03CannotReceiveMail,
  d04NoMailExchanger,
  d05MalformedEmail,
  d06DisposableEmailDomain,
  d07EmailDomainMismatch,
  evaluateKillPredicates,
  evaluatePenalties,
  franchiseOrBranchCarveOut,
  isReversible,
  isRoleAccount,
  kChan01ApplicationChannel,
  kChan02IneligibleRequiresCharity,
  kGeo01OutsideCanada,
  kOrg01NationalPartner,
  kOrg02StudentOrganisation,
  kOrg03aPaidMembershipList,
  kOrg03bPaidMembershipHighPrecision,
  kOrg03cPaidMembershipBroad,
  kOrg04GovernmentBody,
  kOrg05RegisteredCharity,
  kOrg06SelfOrInternalUnit,
  kRel01Suppressed,
  kRel03AlreadySponsorThisCycle,
  kRel08HardBounced,
  kRel04ContactedRecently,
  kRel05DeclinedRecently,
  kRel06DeclinedPermanently,
  kRel07DeclinedOnTiming,
  kRep01StatutorySector,
  kRep02SensitiveSector,
  kSize01EnterpriseScale,
  l02NoSolicitationStatement,
  l03HarvestedAddress,
  l04NotConspicuouslyPublished,
  l05NoLawfulBasis,
  nationalFlagReview,
  p08RoleAccountCannotClaimConspicuousPub,
  placeholderContactName,
  runFilter,
} from "../src/lib/filter";
import { loadQualificationLists, resolveGeography } from "../src/lib/qualification-lists";

const lists = loadQualificationLists();

/** Fixed clock so every date-relative assertion is deterministic. */
const NOW = new Date("2026-08-06T12:00:00.000Z");

function account(over: Partial<Account> & { legal_name: string }): Account {
  return over;
}

/** Every fixture below is a company named by one of the two reports. */
const FIXTURES = {
  affinityCreditUnion: account({
    legal_name: "Affinity Credit Union",
    registrable_domain: "affinitycu.ca",
    email: "sponsorship@affinitycu.ca",
    address_municipality: "Saskatoon",
    address_region: "SK",
    address_country: "CA",
  }),
  // Outside Canada — the one geographic terminal that survives the 2026-08-06 supersession.
  seattleRoasters: account({
    legal_name: "Seattle Roasters",
    registrable_domain: "seattleroasters.com",
    address_municipality: "Seattle",
    address_region: "WA",
    address_country: "US",
  }),
  cactusClubCafe: account({
    legal_name: "Cactus Club Cafe",
    registrable_domain: "cactusclubcafe.com",
    address_municipality: "Vancouver",
    address_region: "BC",
    address_country: "CA",
  }),
  modoYogaVancouver: account({
    legal_name: "Modo Yoga Vancouver",
    registrable_domain: "modoyogavancouver.com",
    address_municipality: "Vancouver",
    address_region: "BC",
    address_country: "CA",
  }),
  theWoodsSpirit: account({
    legal_name: "The Woods Spirit Co.",
    registrable_domain: "thewoodsspirit.com",
    industry: "craft distillery, spirits",
    address_municipality: "North Vancouver",
    address_region: "BC",
    address_country: "CA",
  }),
};

function ruleResult(results: PredicateResult[], ruleId: string): PredicateResult | undefined {
  return results.find((r) => r.rule_id === ruleId);
}

function run(a: Account, opts: FilterOptions = {}) {
  return runFilter(a, lists, { now: NOW, ...opts });
}

// ===========================================================================
// §3.1 K-ORG
// ===========================================================================

describe("K-ORG-01 · Enactus Canada national partner → CHANNEL", () => {
  const cases: [string, Partial<Account>, "channel" | "pass"][] = [
    ["TD by domain", { legal_name: "TD", registrable_domain: "td.com" }, "channel"],
    ["Desjardins by domain", { legal_name: "Desjardins", registrable_domain: "desjardins.ca" }, "channel"],
    [
      "the Dobson Foundation, a lead in the club's own seed data",
      { legal_name: "The Dobson Foundation", registrable_domain: "dobsonfoundation.org" },
      "channel",
    ],
    ["RBC Foundation by name", { legal_name: "RBC Foundation" }, "channel"],
    ["Capital Power, missing from the prior list", { legal_name: "Capital Power" }, "channel"],
    // The two traps the report caught by measurement.
    [
      "rbcfoundation.com, which is Richard Bland College Foundation",
      { legal_name: "Richard Bland College Foundation", registrable_domain: "rbcfoundation.com" },
      "pass",
    ],
    [
      "pcfinancial.com, which is parked on Afternic",
      { legal_name: "Not PC Financial", registrable_domain: "pcfinancial.com" },
      "pass",
    ],
    ["mnp.com, a different organisation", { legal_name: "Not MNP", registrable_domain: "mnp.com" }, "pass"],
    // The carve-out that protects a converted relationship.
    [
      "Varshney Capital Corp, a CURRENT partner sharing a domain with a national donor",
      { legal_name: "Varshney Capital Corp", registrable_domain: "varshneycapital.com" },
      "pass",
    ],
    ["PwC, which is review-not-kill", { legal_name: "PwC", registrable_domain: "pwc.com" }, "pass"],
  ];

  it.each(cases)("%s", (_label, over, expected) => {
    const r = kOrg01NationalPartner(account({ legal_name: "x", ...over }), lists, NOW);
    expect(r.kind).toBe(expected);
  });

  it("routes to enactus_canada rather than killing, and names the listed entity", () => {
    const r = kOrg01NationalPartner(account({ legal_name: "TD", registrable_domain: "td.com" }), lists, NOW);
    expect(r.kind).toBe("channel");
    if (r.kind !== "channel") return;
    expect(r.required_channel).toBe("enactus_canada");
    expect(r.reason).toBe("national_partner_route_to_enactus_canada");
    expect(r.detail).toBeTruthy();
    expect(r.evidence_url).toBeTruthy();
  });
});

describe("K-ORG-02 · student organisation → TERMINAL", () => {
  const cases: [string, Partial<Account>, "terminal" | "pass"][] = [
    ["Enactus SFU itself", { legal_name: "Enactus SFU" }, "terminal"],
    ["another Enactus chapter", { legal_name: "Enactus UBC" }, "terminal"],
    ["AIESEC", { legal_name: "AIESEC in SFU" }, "terminal"],
    ["a students' society", { legal_name: "Simon Fraser Student Society" }, "terminal"],
    ["an undergraduate society", { legal_name: "Beedie Undergraduate Society" }, "terminal"],
    ["a fraternity", { legal_name: "Delta Sigma Fraternity" }, "terminal"],
    ["SFU Surge, caught only by the maintained list", { legal_name: "SFU Surge", registrable_domain: "sfusurge.com" }, "terminal"],
    ["Axis Consulting, an Enactus SFU spin-out", { legal_name: "Axis Consulting", registrable_domain: "sfuaxisconsulting.com" }, "terminal"],
    ["an SFU subdomain", { legal_name: "Some Unit", registrable_domain: "beedie.sfu.ca" }, "terminal"],
    ["a .edu domain", { legal_name: "Some School", registrable_domain: "stanford.edu" }, "terminal"],
    // The weak-token design: `club` and `team` alone must NOT kill a business.
    ["Cactus Club Cafe", { legal_name: "Cactus Club Cafe" }, "pass"],
    ["a sports business", { legal_name: "Vancouver Whitecaps Team Store" }, "pass"],
    ["a yoga studio", { legal_name: "Modo Yoga Vancouver" }, "pass"],
    ["a chamber-sounding business", { legal_name: "Club Monaco" }, "pass"],
  ];

  it.each(cases)("%s", (_label, over, expected) => {
    expect(kOrg02StudentOrganisation(account({ legal_name: "x", ...over }), lists, NOW).kind).toBe(
      expected,
    );
  });

  it("fires the weak pair only when a school token co-occurs", () => {
    expect(kOrg02StudentOrganisation(account({ legal_name: "Campus Investment Club" }), lists, NOW).kind).toBe(
      "terminal",
    );
    expect(kOrg02StudentOrganisation(account({ legal_name: "Investment Club" }), lists, NOW).kind).toBe("pass");
  });
});

describe("K-ORG-03 · pay-to-join bodies", () => {
  it.each([
    ["Greater Vancouver Board of Trade", "Greater Vancouver Board of Trade"],
    ["Burnaby Board of Trade", "Burnaby Board of Trade"],
    ["a chamber of commerce", "Surrey Chamber of Commerce"],
    ["a BIA", "Mount Pleasant Business Improvement Association"],
    ["a Rotary club", "Rotary Club of Vancouver"],
    ["Toastmasters", "Vancouver Toastmasters"],
  ])("kills %s on the high-precision regex", (_label, name) => {
    expect(kOrg03bPaidMembershipHighPrecision(account({ legal_name: name }), NOW).kind).toBe("terminal");
  });

  it("kills a listed body by domain", () => {
    const r = kOrg03aPaidMembershipList(
      account({ legal_name: "GVBOT", registrable_domain: "boardoftrade.com" }),
      lists,
      NOW,
    );
    expect(r.kind).toBe("terminal");
  });

  it.each([
    ["accelerator", "Vancouver Startup Accelerator"],
    ["incubator", "Coastal Incubator"],
    ["association of", "Association of BC Manufacturers"],
    ["institute of", "Institute of Corporate Directors"],
  ])(
    "PENALISES rather than kills %s, because the Enactus Canada accelerators GIVE $2,500 grants",
    (_label, name) => {
      const a = account({ legal_name: name });
      expect(kOrg03bPaidMembershipHighPrecision(a, NOW).kind).toBe("pass");
      const r = kOrg03cPaidMembershipBroad(a, NOW);
      expect(r.kind).toBe("penalty");
      if (r.kind !== "penalty") return;
      expect(r.delta).toBe(-60);
    },
  );
});

describe("K-ORG-04 · government body → CHANNEL grants_pipeline, never TERMINAL", () => {
  const cases: [string, Partial<Account>][] = [
    ["a .gc.ca domain", { legal_name: "Some Agency", registrable_domain: "acoa-apeca.gc.ca" }],
    ["a .gov.bc.ca domain", { legal_name: "Some Ministry", registrable_domain: "www2.gov.bc.ca" }],
    ["Innovate BC, in the club's own seed data", { legal_name: "Innovate BC", registrable_domain: "innovatebc.ca" }],
    ["a city by name", { legal_name: "City of Burnaby" }],
    ["a library by name", { legal_name: "Vancouver Public Library" }],
    ["TransLink", { legal_name: "TransLink" }],
    ["a health authority", { legal_name: "Fraser Health Authority" }],
  ];

  it.each(cases)("%s routes rather than drops", (_label, over) => {
    const r = kOrg04GovernmentBody(account({ legal_name: "x", ...over }), lists, NOW);
    expect(r.kind).toBe("channel");
    if (r.kind !== "channel") return;
    expect(r.required_channel).toBe("grants_pipeline");
  });

  it("reroutes rather than dropping — the outcome is a channel, never a terminal", () => {
    const r = kOrg04GovernmentBody(account({ legal_name: "Vancouver Public Library" }), lists, NOW);
    if (r.kind !== "channel") throw new Error("expected a channel");
    expect(r.required_channel).toBe("grants_pipeline");
    expect(r.reason).toBe("government_body_no_sponsorship_channel");
  });
});

describe("K-ORG-05 · registered charity, by CRA designation", () => {
  it("CANNOT EVALUATE without the CRA dataset, rather than silently passing or failing", () => {
    const r = kOrg05RegisteredCharity(account({ legal_name: "Some Charity" }), NOW);
    expect(r.kind).toBe("cannot_evaluate");
    if (r.kind !== "cannot_evaluate") return;
    expect(r.missing_fields).toContain("cra_designation");
    expect(r.reason).toBe("cannot_evaluate");
  });

  it.each([
    ["Charitable Organization", "terminal", "competing_fundraiser"],
    ["Public Foundation", "channel", "grantmaker_route_to_grants_pipeline"],
    ["Private Foundation", "channel", "grantmaker_route_to_grants_pipeline"],
  ] as const)("designation %s → %s", (designation, kind, reason) => {
    const r = kOrg05RegisteredCharity(
      account({ legal_name: "Some Charity", cra_designation: designation }),
      NOW,
    );
    expect(r.kind).toBe(kind);
    if (r.kind === "pass" || r.kind === "cannot_evaluate") return;
    expect(r.reason).toBe(reason);
  });
});

describe("K-ORG-06 · self and internal units → TERMINAL", () => {
  const cases: [string, Partial<Account>][] = [
    [
      "Second Savour, which the pipeline was prospecting as a lead",
      { legal_name: "Second Savour", registrable_domain: "secondsavour.ca" },
    ],
    ["Enactus SFU's own site", { legal_name: "Enactus SFU", registrable_domain: "enactussfu.ca" }],
    ["SFU", { legal_name: "Simon Fraser University", registrable_domain: "sfu.ca" }],
    ["a venture by name", { legal_name: "SKYES" }],
  ];

  it.each(cases)("%s", (_label, over) => {
    expect(kOrg06SelfOrInternalUnit(account({ legal_name: "x", ...over }), lists, NOW).kind).toBe(
      "terminal",
    );
  });
});

// ===========================================================================
// §3.2 K-SIZE / K-CHAN
// ===========================================================================

describe("K-SIZE-01 · enterprise scale — the one predicate with a real data problem", () => {
  it("CANNOT EVALUATE when no headcount and no proxy is available", () => {
    const r = kSize01EnterpriseScale(account({ legal_name: "Red Bull" }), NOW, "UNPROVEN");
    expect(r.kind).toBe("cannot_evaluate");
    if (r.kind !== "cannot_evaluate") return;
    expect(r.missing_fields).toEqual(
      expect.arrayContaining(["headcount", "headcount_band_max"]),
    );
  });

  it("kills at the ISED large threshold of 500, not at 100", () => {
    expect(kSize01EnterpriseScale(account({ legal_name: "Big Co", headcount: 500 }), NOW, "UNPROVEN").kind).toBe(
      "terminal",
    );
    expect(kSize01EnterpriseScale(account({ legal_name: "Mid Co", headcount: 499 }), NOW, "UNPROVEN").kind).toBe(
      "pass",
    );
    // 100 would kill every converted sponsor the club has.
    expect(kSize01EnterpriseScale(account({ legal_name: "Local Co", headcount: 120 }), NOW, "UNPROVEN").kind).toBe(
      "pass",
    );
  });

  it("is overridden by a §5 LOCAL_AUTHORITY franchise finding", () => {
    const a = account({ legal_name: "Modo Yoga Vancouver", headcount: 900 });
    expect(kSize01EnterpriseScale(a, NOW, "UNPROVEN").kind).toBe("terminal");
    expect(kSize01EnterpriseScale(a, NOW, "LOCAL_AUTHORITY").kind).toBe("pass");
  });

  it("never kills on a SINGLE enterprise proxy — Cactus Club Cafe publishes Suppliers and is a past partner", () => {
    const r = kSize01EnterpriseScale(
      account({ legal_name: "Cactus Club Cafe", observations: { has_supplier_procurement_path: true } }),
      NOW,
      "UNPROVEN",
    );
    expect(r.kind).toBe("pass");
  });

  it("treats two or more proxies as ISED-large, and says the basis was a proxy", () => {
    const r = kSize01EnterpriseScale(
      account({
        legal_name: "Big Retailer",
        observations: { has_investor_relations: true, store_locator_location_count: 40 },
      }),
      NOW,
      "UNPROVEN",
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.detail).toContain("headcount_basis=proxy");
  });
});

describe("K-CHAN-01 · published application channel → CHANNEL web_form", () => {
  it("routes Cactus Club Cafe to its /donation-requests form rather than killing it", () => {
    const r = kChan01ApplicationChannel(FIXTURES.cactusClubCafe, NOW, {
      application_path_found: "/donation-requests",
    });
    expect(r.kind).toBe("channel");
    if (r.kind !== "channel") return;
    expect(r.required_channel).toBe("web_form");
    expect(r.reason).toBe("apply_via_published_channel_not_email");
  });

  it.each([
    "All donation requests must be submitted online.",
    "Please submit your request through our portal.",
    "Requests are only accepted through the form below.",
    "Application deadline: 1 September.",
    "Toutes les demandes doivent être soumises en ligne.",
  ])("matches the page text %j", (text) => {
    const r = kChan01ApplicationChannel(account({ legal_name: "X", source_page_text: text }), NOW);
    expect(r.kind).toBe("channel");
  });

  it("cannot evaluate with no snapshot and no probe", () => {
    expect(kChan01ApplicationChannel(account({ legal_name: "X" }), NOW).kind).toBe("cannot_evaluate");
  });
});

describe("K-CHAN-02 · published eligibility the club cannot satisfy → TERMINAL", () => {
  it("fires only when a REQUIREMENT sits near the eligibility phrase", () => {
    const requiring = "Applicants must be a registered charity in good standing with the CRA.";
    const harmless =
      "We are proud to have supported many a registered charity over the years, alongside schools and clubs.";
    expect(kChan02IneligibleRequiresCharity(account({ legal_name: "X", source_page_text: requiring }), NOW).kind).toBe(
      "terminal",
    );
    expect(kChan02IneligibleRequiresCharity(account({ legal_name: "X", source_page_text: harmless }), NOW).kind).toBe(
      "pass",
    );
  });

  it("records the SFU Advancement escalation on the row instead of losing it", () => {
    const r = kChan02IneligibleRequiresCharity(
      account({ legal_name: "X", source_page_text: "Only registered charities are eligible." }),
      NOW,
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.required_channel).toBe("sfu_advancement");
    expect(r.reason).toBe("ineligible_requires_registered_charity");
  });

  it("matches the French statutory vocabulary too", () => {
    const r = kChan02IneligibleRequiresCharity(
      account({
        legal_name: "X",
        source_page_text: "Seul un organisme de bienfaisance enregistré est admissible.",
      }),
      NOW,
    );
    expect(r.kind).toBe("terminal");
  });

  it("KNOWN GAP: the report's ELIGIBILITY_RE is singular-only, so the French plural slips through", () => {
    // `organisme\s+de\s+bienfaisance\s+enregistr` does not match "organismeS de bienfaisance".
    // Implemented as the report specifies; recorded here so the gap is visible rather than
    // discovered in production. Failing OPEN is the safe direction: it produces a missed kill,
    // never a wrong one.
    const r = kChan02IneligibleRequiresCharity(
      account({
        legal_name: "X",
        source_page_text: "Seuls les organismes de bienfaisance enregistrés sont admissibles.",
      }),
      NOW,
    );
    expect(r.kind).toBe("pass");
  });
});

// ===========================================================================
// §3.3 K-GEO
// ===========================================================================

describe("K-GEO · geography, under the 2026-08-06 supersession", () => {
  function bandOf(over: Partial<Account>) {
    return resolveGeography(
      {
        municipality: over.address_municipality,
        region: over.address_region,
        country: over.address_country,
      },
      lists,
    ).band;
  }

  // IN SCOPE: anywhere in Canada. Affinity Credit Union (Saskatoon, SK) used to be an
  // account-scoped kill; it is now a prospect at the lowest Canadian band.
  it("keeps a Saskatchewan credit union on the board at a lower band", () => {
    const result = run(FIXTURES.affinityCreditUnion);
    expect(result.kills).toHaveLength(0);
    expect(bandOf(FIXTURES.affinityCreditUnion)).toBe("canada_other");
  });

  it("charges no geography penalty anywhere in Canada, because the band already says it", () => {
    for (const over of [
      { address_municipality: "Abbotsford", address_region: "BC", address_country: "CA" },
      { address_municipality: "Toronto", address_region: "ON", address_country: "CA" },
      { address_municipality: "Saskatoon", address_region: "SK", address_country: "CA" },
    ]) {
      const result = run(account({ legal_name: "X", ...over }));
      expect(result.penalties.map((p) => p.tag)).not.toContain("outside_metro_vancouver");
      expect(result.penalties.map((p) => p.rule_id)).not.toContain("P-01");
    }
  });

  it.each([
    ["Burnaby", "BC", "metro_vancouver"],
    ["Kitsilano", "BC", "metro_vancouver"],
    ["Steveston", "BC", "metro_vancouver"],
    ["Fort Langley", "BC", "metro_vancouver"],
    ["UBC", "BC", "metro_vancouver"],
    ["Abbotsford", "BC", "bc_other"],
    ["Squamish", "BC", "bc_other"],
    ["Chilliwack", "BC", "bc_other"],
    ["Kelowna", "BC", "bc_other"],
    ["Toronto", "ON", "canada_other"],
    ["Saskatoon", "SK", "canada_other"],
  ])("puts %s, %s in the %s band", (municipality, region, band) => {
    expect(
      bandOf({ address_municipality: municipality, address_region: region, address_country: "CA" }),
    ).toBe(band);
  });

  // The one geographic terminal that survives.
  it("terminals outside Canada, and nowhere else", () => {
    const r = kGeo01OutsideCanada(
      account({
        legal_name: "Acme",
        address_municipality: "Seattle",
        address_region: "WA",
        address_country: "US",
      }),
      lists,
      NOW,
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.reason).toBe("outside_canada");
    expect(r.scope).toBe("account");
  });

  it.each(["ON", "SK", "AB", "Ontario", "Quebec"])(
    "does NOT terminal a Canadian account in %s",
    (region) => {
      const a = account({
        legal_name: "Acme",
        address_municipality: "Somewhere",
        address_region: region,
        address_country: "CA",
      });
      expect(kGeo01OutsideCanada(a, lists, NOW).kind).toBe("pass");
      expect(run(a).kills).toHaveLength(0);
    },
  );

  // "CA" is the ISO code this module uses for CANADA. An earlier enumeration read it as
  // California and terminalled a Vancouver bakery; province is now derived only within Canada.
  it("never reads the region token CA as California", () => {
    const a = account({
      legal_name: "Crema Artisan Bakers",
      address_municipality: "Vancouver",
      address_region: "CA",
      address_country: "CA",
    });
    expect(run(a).kills).toHaveLength(0);
    expect(bandOf(a)).toBe("metro_vancouver");
  });

  // UNRECOGNISED IS ABSENT, IN EVERY BRANCH — not merely "never a kill".
  describe("an unrecognised value takes exactly the path an absent one takes", () => {
    const burnaby = {
      legal_name: "Crema Artisan Bakers",
      registrable_domain: "crema.ca",
      address_municipality: "Burnaby",
      address_country: "CA",
    };

    it.each([
      "BC",
      "bc",
      "B.C.",
      "B.C",
      "British Columbia",
      "British Columbia, Canada",
      "Colombie-Britannique",
      "Colombie Britannique",
      "Freedonia",
      "Canada",
      "CA",
    ])("keeps a Burnaby account in the metro band with region %j", (region) => {
      const a = account({ ...burnaby, address_region: region });
      expect(run(a).kills).toHaveLength(0);
      expect(bandOf(a)).toBe("metro_vancouver");
    });

    it("resolves identically whether an unrecognised region is present or omitted", () => {
      const present = bandOf({ ...burnaby, address_region: "Freedonia" });
      const omitted = bandOf(burnaby);
      expect(present).toBe(omitted);
    });

    it("resolves identically whether an UNRECOGNISED country is present or omitted", () => {
      // "British Columbia" in the country field is a plausible data-entry slip, and it must not
      // drop a Burnaby bakery: an unrecognised country is UNKNOWN, never outside_canada.
      for (const country of ["Freedonia", "British Columbia", "North America", "   "]) {
        expect(bandOf({ ...burnaby, address_country: country }), country).toBe(
          bandOf({ ...burnaby, address_country: undefined }),
        );
        expect(
          run(account({ ...burnaby, address_region: "BC", address_country: country })).kills,
          country,
        ).toHaveLength(0);
      }
      // A RECOGNISED country that is not Canada is the one contrary reading.
      expect(bandOf({ ...burnaby, address_country: "US" })).toBe("outside_canada");
    });

    it("keeps the alias precondition: a bare alias needs positive evidence of Canada", () => {
      expect(
        bandOf({ address_municipality: "Richmond", address_region: "ON", address_country: "CA" }),
      ).toBe("canada_other");
      expect(bandOf({ address_municipality: "Richmond", address_region: "BC" })).toBe(
        "metro_vancouver",
      );
      // Richmond BC and Richmond VA are indistinguishable on a bare municipality, so the honest
      // answer is unresolved — a weighting lost, never a place on the board.
      expect(bandOf({ address_municipality: "Richmond" })).toBe("unresolved");
      expect(bandOf({ address_municipality: "Richmond", address_region: "VA" })).toBe("unresolved");
    });
  });

  it("never kills on a missing country", () => {
    expect(kGeo01OutsideCanada(account({ legal_name: "Unknown Co" }), lists, NOW).kind).toBe(
      "cannot_evaluate",
    );
  });

  // The Superpilot shape (seed row: Igor Faletski, SFU BSc '07) is why §3.3's K-GEO-05
  // multi-basis rescue existed — it stopped a remote-first company with a Vancouver founder
  // being killed as outside_bc. A6 deleted that kill, so the row is now in scope on the band
  // alone at canada_other, with no second dimension needed. That is the whole premise of A7.
  it("keeps a remote-first company with a Vancouver founder, on the band alone", () => {
    const remoteFirst = account({
      legal_name: "Superpilot",
      registrable_domain: "superpilot.ai",
      address_municipality: "Toronto",
      address_region: "ON",
      address_country: "CA",
    });
    expect(kGeo01OutsideCanada(remoteFirst, lists, NOW).kind).toBe("pass");
    expect(bandOf(remoteFirst)).toBe("canada_other");

    const result = run(remoteFirst);
    expect(result.decision).not.toBe("terminal");
    expect(result.kills).toEqual([]);
  });

  // The cut is not free, and this pins the one shape it costs: a company registered OUTSIDE
  // CANADA is now killed whoever its founder is. A single geographic terminal is the point.
  //
  // The row is built with the RETIRED enrichment key still on it, cast in deliberately, because
  // that is the only way to state the behaviour change: a persisted row written before the cut
  // still carries `decision_maker_municipality`, and it must no longer rescue anything.
  it("no longer spares a company registered outside Canada for a local decision-maker", () => {
    const usRegistered = {
      ...account({
        legal_name: "Superpilot US",
        registrable_domain: "superpilot.io",
        address_municipality: "Vancouver",
        address_region: "WA",
        address_country: "US",
      }),
      observations: { decision_maker_municipality: "Vancouver", operating_municipality: "Vancouver" },
    } as unknown as Account;

    const verdict = kGeo01OutsideCanada(usRegistered, lists, NOW);
    expect(verdict.kind).toBe("terminal");
    expect(verdict.kind === "terminal" && verdict.scope).toBe("account");
    expect(run(usRegistered).decision).toBe("terminal");
  });
});

describe("K-GEO-04 · area codes — the wrong rule that looks right", () => {
  it("treats 604 as a WEAK positive only", () => {
    expect(areaCodeSignal(account({ legal_name: "X", phone_e164: "+16045551212" }))).toBe(
      "weak_positive_bc",
    );
  });

  it.each(BC_PROVINCE_WIDE_OVERLAYS)(
    "treats the province-wide overlay %s as carrying NO geographic information",
    (npa) => {
      expect(areaCodeSignal(account({ legal_name: "X", phone_e164: `+1${npa}5551212` }))).toBe(
        "no_geographic_information",
      );
    },
  );

  it("treats a non-BC area code as corroborating evidence only", () => {
    expect(areaCodeSignal(account({ legal_name: "X", phone_e164: "+14165551212" }))).toBe("non_bc");
  });

  it("never returns a kill-shaped value for any area code", () => {
    for (const npa of ["604", "778", "236", "672", "257", "250", "416"]) {
      const signal = areaCodeSignal(account({ legal_name: "X", phone_e164: `+1${npa}5551212` }));
      expect(["weak_positive_bc", "no_geographic_information", "non_bc"]).toContain(signal);
    }
  });
});

// ===========================================================================
// §3.4 K-REL
// ===========================================================================

describe("K-REL · relationship state", () => {
  it("K-REL-01 suppression is TERMINAL and irreversible", () => {
    const r = kRel01Suppressed(
      account({ legal_name: "X", rel: { suppressed_at: "2025-01-01T00:00:00Z" } }),
      NOW,
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.duration.kind).toBe("forever");
    expect(isReversible(r)).toBe(false);
    expect(r.recheck).toBe("every_send");
  });

  it("K-REL-03 sends a current sponsor to the renewals motion, not to a cold email", () => {
    const r = kRel03AlreadySponsorThisCycle(
      account({ legal_name: "X", rel: { sponsor_cycles: ["2026-27"] } }),
      NOW,
      { current_cycle: "2026-27" },
    );
    expect(r.kind).toBe("channel");
    if (r.kind !== "channel") return;
    expect(r.required_channel).toBe("renewal_motion");
  });

  it("K-REL-03 cannot evaluate without a current cycle", () => {
    expect(
      kRel03AlreadySponsorThisCycle(account({ legal_name: "X", rel: { sponsor_cycles: [] } }), NOW).kind,
    ).toBe("cannot_evaluate");
  });

  it("K-REL-04 HOLDS a recent contact rather than dropping it", () => {
    const r = kRel04ContactedRecently(
      account({ legal_name: "X", rel: { last_contacted_at: "2026-07-01" } }),
      NOW,
    );
    expect(r.kind).toBe("hold");
  });

  it("K-REL-04 passes once a quarter has gone by", () => {
    expect(
      kRel04ContactedRecently(account({ legal_name: "X", rel: { last_contacted_at: "2026-01-01" } }), NOW)
        .kind,
    ).toBe("pass");
  });

  const declineCases: [string, string, Account["rel"], "terminal" | "penalty" | "pass"][] = [
    ["a recent no_budget decline", "K-REL-05", { declined_at: "2026-06-01", declined_reason: "no_budget" }, "terminal"],
    ["a decline older than 12 months", "K-REL-05", { declined_at: "2025-01-01", declined_reason: "no_budget" }, "pass"],
    ["a timing decline", "K-REL-05", { declined_at: "2026-06-01", declined_reason: "timing" }, "pass"],
    ["a budget_cycle decline", "K-REL-05", { declined_at: "2026-06-01", declined_reason: "budget_cycle" }, "pass"],
  ];

  it.each(declineCases)("%s → %s", (_label, _rule, rel, expected) => {
    expect(kRel05DeclinedRecently(account({ legal_name: "X", rel }), NOW).kind).toBe(expected);
  });

  it("K-REL-05 uses a 12-month window reasoned from annual exec turnover", () => {
    expect(DECLINE_SUPPRESSION_MONTHS).toBe(12);
    const r = kRel05DeclinedRecently(
      account({ legal_name: "X", rel: { declined_at: "2026-06-01", declined_reason: "not_a_fit" } }),
      NOW,
    );
    if (r.kind !== "terminal") throw new Error("expected a terminal");
    expect(r.duration.kind).toBe("until");
    if (r.duration.kind !== "until") return;
    expect(r.duration.clears_at.slice(0, 10)).toBe("2027-06-01");
    expect(r.duration.window).toBe("12 months");
    expect(isReversible(r)).toBe(true);
  });

  it.each(["never_contact_us", "policy_no_student_groups"] as const)(
    "K-REL-06 makes %s permanent",
    (reason) => {
      const r = kRel06DeclinedPermanently(
        account({ legal_name: "X", rel: { declined_reason: reason } }),
        NOW,
      );
      expect(r.kind).toBe("terminal");
      if (r.kind !== "terminal") return;
      expect(r.duration.kind).toBe("forever");
      expect(isReversible(r)).toBe(false);
    },
  );

  it("K-REL-07 treats a timing decline as scheduling, with a 9-month wake", () => {
    const r = kRel07DeclinedOnTiming(
      account({ legal_name: "X", rel: { declined_at: "2026-06-01", declined_reason: "timing" } }),
      NOW,
    );
    expect(r.kind).toBe("penalty");
    if (r.kind !== "penalty") return;
    expect(r.delta).toBe(-10);
    expect(r.detail).toContain("2027-03-01");
  });
});

// ===========================================================================
// §3.5 K-DELIV
// ===========================================================================

describe("K-DELIV · deliverability", () => {
  // The four domains still NXDOMAIN when the report reproduced the 36% finding.
  it.each(["dobsonfoundation.ca", "heavypdg.ca", "nhholdings.ca", "thewoodsspirit.com"])(
    "D-01 kills %s once two independent resolvers have failed",
    (domain) => {
      const a = account({
        legal_name: "X",
        registrable_domain: domain,
        dns: {
          ns_present: false,
          a_present: false,
          mx_present: false,
          ns_hosts: [],
          mx_hosts: [],
          smtp25_open: null,
          resolver_attempts: 2,
        },
      });
      const r = d01DeadDomain(a, NOW);
      expect(r.kind).toBe("terminal");
      if (r.kind !== "terminal") return;
      expect(r.reason).toBe("dead_domain");
    },
  );

  it("D-01 refuses to kill on a single failed lookup", () => {
    const r = d01DeadDomain(
      account({
        legal_name: "X",
        registrable_domain: "example.ca",
        dns: { ns_present: false, a_present: false, mx_present: false, ns_hosts: [], mx_hosts: [], smtp25_open: null, resolver_attempts: 1 },
      }),
      NOW,
    );
    expect(r.kind).toBe("cannot_evaluate");
  });

  it("D-02 kills iuvox.com, which the club seeded and which lives on a domain marketplace", () => {
    const r = d02ParkedDomain(
      account({
        legal_name: "Iuvox",
        registrable_domain: "iuvox.com",
        dns: { ns_present: true, a_present: true, mx_present: false, ns_hosts: ["ns1.brandbucket.com"], mx_hosts: [], smtp25_open: null },
      }),
      lists,
      NOW,
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.reason).toBe("parked_or_for_sale_domain");
  });

  it.each(["ns3.afternic.com", "ns1.sedoparking.com", "dns1.parkingcrew.net", "ns1.hugedomains.com"])(
    "D-02 recognises the parking nameserver %s",
    (host) => {
      const r = d02ParkedDomain(
        account({
          legal_name: "X",
          dns: { ns_present: true, a_present: true, mx_present: false, ns_hosts: [host], mx_hosts: [], smtp25_open: null },
        }),
        lists,
        NOW,
      );
      expect(r.kind).toBe("terminal");
    },
  );

  it.each(["ns1.bodis.com", "ns1.namecheap.com"])(
    "D-02 does NOT ship %s, which the report tested and rejected",
    (host) => {
      const r = d02ParkedDomain(
        account({
          legal_name: "X",
          dns: { ns_present: true, a_present: true, mx_present: false, ns_hosts: [host], mx_hosts: [], smtp25_open: null },
        }),
        lists,
        NOW,
      );
      expect(r.kind).toBe("pass");
    },
  );

  it("D-03 kills a domain with nameservers but no MX and no A", () => {
    expect(
      d03CannotReceiveMail(
        account({
          legal_name: "X",
          dns: { ns_present: true, a_present: false, mx_present: false, ns_hosts: ["a"], mx_hosts: [], smtp25_open: null },
        }),
        NOW,
      ).kind,
    ).toBe("terminal");
  });

  // D-04 sharpens the evidence base: RFC 5321 §5.1 gives an implicit MX fallback to the A record.
  it.each(["bakdcookies.com", "superpilot.ai", "windowwizards.ca"])(
    "D-04 will not conclude anything about %s until port 25 is probed",
    (domain) => {
      const r = d04NoMailExchanger(
        account({
          legal_name: "X",
          registrable_domain: domain,
          dns: { ns_present: true, a_present: true, mx_present: false, ns_hosts: ["a"], mx_hosts: [], smtp25_open: null },
        }),
        NOW,
      );
      expect(r.kind).toBe("cannot_evaluate");
      if (r.kind !== "cannot_evaluate") return;
      expect(r.missing_fields).toContain("dns.smtp25_open");
    },
  );

  it("D-04 routes off email — it does NOT kill — once port 25 is confirmed closed", () => {
    const r = d04NoMailExchanger(
      account({
        legal_name: "X",
        registrable_domain: "bakdcookies.com",
        dns: { ns_present: true, a_present: true, mx_present: false, ns_hosts: ["a"], mx_hosts: [], smtp25_open: false },
      }),
      NOW,
    );
    expect(r.kind).toBe("channel");
    if (r.kind !== "channel") return;
    expect(r.required_channel).toBe("web_form");
  });

  it("D-04 passes when the implicit MX fallback actually works", () => {
    expect(
      d04NoMailExchanger(
        account({
          legal_name: "X",
          dns: { ns_present: true, a_present: true, mx_present: false, ns_hosts: ["a"], mx_hosts: [], smtp25_open: true },
        }),
        NOW,
      ).kind,
    ).toBe("pass");
  });

  it.each([
    ["info@example.ca", "pass"],
    ["hello world@example.ca", "terminal"],
    ["noatsign.example.ca", "terminal"],
    ["info@example", "terminal"],
    ["info@@example.ca", "terminal"],
  ] as const)("D-05 on %j → %s", (email, expected) => {
    expect(d05MalformedEmail(account({ legal_name: "X", email }), NOW).kind).toBe(expected);
  });

  it("D-06 kills a disposable mailbox provider", () => {
    expect(
      d06DisposableEmailDomain(account({ legal_name: "X", email: "a@mailinator.com" }), lists, NOW).kind,
    ).toBe("terminal");
  });

  const d07Cases: [string, string, string, "terminal" | "pass"][] = [
    ["matching domain", "info@example.ca", "example.ca", "pass"],
    ["a Vancouver bakery on gmail", "bakery@gmail.com", "example.ca", "pass"],
    ["a BC small business on shaw.ca", "shop@shaw.ca", "example.ca", "pass"],
    ["someone else's corporate domain", "info@othercompany.com", "example.ca", "terminal"],
    // A mail host UNDER the company's own domain is the company's own domain. `emailDomain()`
    // derives a host, not a registrable domain, so these used to be killed as a third party's.
    ["a mail subdomain of the company's own domain", "info@mail.example.ca", "example.ca", "pass"],
    ["a deeper subdomain", "info@smtp.mail.example.ca", "example.ca", "pass"],
    // The reverse is NOT the company's own domain: example.ca is not under mail.example.ca.
    ["a parent of the company's domain", "info@example.ca", "mail.example.ca", "terminal"],
    // Sharing a suffix is not sharing a domain.
    ["a lookalike suffix", "info@notexample.ca", "example.ca", "terminal"],
  ];

  it.each(d07Cases)("D-07 with %s", (_label, email, domain, expected) => {
    expect(
      d07EmailDomainMismatch(
        account({ legal_name: "X", email, registrable_domain: domain }),
        lists,
        NOW,
      ).kind,
    ).toBe(expected);
  });

  it("scopes D-05 and D-07 to the address, never to the account", () => {
    for (const r of [
      d05MalformedEmail(account({ legal_name: "X", email: "not an address" }), NOW),
      d07EmailDomainMismatch(
        account({ legal_name: "X", email: "info@othercompany.com", registrable_domain: "example.ca" }),
        lists,
        NOW,
      ),
    ]) {
      expect(r.kind).toBe("terminal");
      if (r.kind !== "terminal") continue;
      expect(r.scope).toBe("address");
    }
  });
});

// ---------------------------------------------------------------------------
// The role-account case the report explicitly DISPROVED by measurement.
// ---------------------------------------------------------------------------

describe("role accounts — 25 of 25 seeded addresses are role accounts, so a kill empties the pipeline", () => {
  // The distribution the report enumerates: info@ x11, hello@ x8, sponsorship@ x2,
  // mediarelations@ x1, makegoodnow@ x1. That accounts for 23 of the 25 it measured; the
  // remaining two locals are not named anywhere in the report, so they are not invented here.
  const SEEDED_LOCALS = [
    ...Array<string>(11).fill("info"),
    ...Array<string>(8).fill("hello"),
    ...Array<string>(2).fill("sponsorship"),
    "mediarelations",
    "makegoodnow",
  ];

  it("recognises every conventionally-shaped seeded address as a role account", () => {
    expect(SEEDED_LOCALS).toHaveLength(23);
    const recognised = SEEDED_LOCALS.filter((local) =>
      isRoleAccount(account({ legal_name: "X", email: `${local}@example.ca` })),
    );
    // 22 of 23. `makegoodnow@` is a BRANDED PROGRAMME mailbox with no conventional role shape,
    // and no fixed list or prefix rule will ever hold it.
    expect(recognised).toHaveLength(22);
    expect(isRoleAccount(account({ legal_name: "X", email: "makegoodnow@example.ca" }))).toBe(false);
  });

  it("still never kills the branded programme mailbox it cannot classify", () => {
    // Failing to classify it costs a -15 penalty, never a wrong kill. That is the safe direction.
    const a = account({
      legal_name: "Seeded Business",
      registrable_domain: "example.ca",
      email: "makegoodnow@example.ca",
    });
    const kills = evaluateKillPredicates(a, lists, { now: NOW }).filter((r) => r.kind === "terminal");
    expect(kills).toHaveLength(0);
  });

  it("recognises the whole RFC 2142 role set the report lists", () => {
    for (const local of [
      "contact",
      "admin",
      "office",
      "support",
      "sales",
      "marketing",
      "press",
      "enquiries",
      "partnerships",
      "donations",
      "giving",
      "webmaster",
      "noreply",
    ]) {
      expect(isRoleAccount(account({ legal_name: "X", email: `${local}@example.ca` })), local).toBe(
        true,
      );
    }
  });

  it("does not misclassify a personal address as a role account", () => {
    for (const local of ["justin.cheung", "praveen", "j.doe", "igor"]) {
      expect(isRoleAccount(account({ legal_name: "X", email: `${local}@example.ca` })), local).toBe(
        false,
      );
    }
  });

  it("KILLS NONE of them — every one survives the full kill sequence on this ground", () => {
    for (const local of [...new Set(SEEDED_LOCALS)]) {
      const a = account({
        legal_name: "Seeded Business",
        registrable_domain: "example.ca",
        email: `${local}@example.ca`,
      });
      const results = evaluateKillPredicates(a, lists, { now: NOW });
      const kills = results.filter((r) => r.kind === "terminal");
      expect(kills, `${local}@ was killed: ${JSON.stringify(kills)}`).toHaveLength(0);
    }
  });

  it("penalises a role account -15", () => {
    const penalties = evaluatePenalties(
      account({ legal_name: "X", registrable_domain: "example.ca", email: "info@example.ca" }),
      { lists, now: NOW },
    );
    const p08 = penalties.find((p) => p.rule_id === "P-08");
    expect(p08?.delta).toBe(-15);
    expect(p08?.tag).toBe("role_account");
  });
});

// ---------------------------------------------------------------------------
// P-08's OTHER half. §4 specifies "-15 AND forbid lawful_basis = conspicuous_pub". A constraint
// that exists only inside a rendered sentence is a comment, so this asserts the forbidden
// combination is actually rejected — through the predicate, through runFilter, and out the far
// side into the gate input the scorer reads.
// ---------------------------------------------------------------------------

describe("P-08's paired hard constraint · a role account may not claim conspicuous_pub", () => {
  // The walkable shape: a storefront inside Greater Vancouver, which is the population the ICP
  // report makes the walk-list argument for.
  const roleClaimingConspicuousPub = account({
    legal_name: "Example Ltd",
    registrable_domain: "example.ca",
    email: "info@example.ca",
    address_municipality: "Burnaby",
    address_region: "BC",
    address_country: "CA",
    lawful_basis: "conspicuous_pub",
    lawful_basis_url: "https://example.ca/contact",
    observations: { has_consumer_storefront: true },
  });

  it("passes L-04, which only tests the PUBLISHING DOMAIN — so L-04 cannot be the enforcement", () => {
    expect(l04NotConspicuouslyPublished(roleClaimingConspicuousPub, NOW).kind).toBe("pass");
  });

  it("rejects the combination for email, leaving the account and the address intact", () => {
    const [terminal] = p08RoleAccountCannotClaimConspicuousPub(
      roleClaimingConspicuousPub,
      lists,
      NOW,
    );
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind !== "terminal") return;
    expect(terminal.reason).toBe("role_account_cannot_claim_conspicuous_pub");
    expect(terminal.scope).toBe("email");
    expect(terminal.duration.kind).toBe("until_human_clears");
    expect(isReversible(terminal)).toBe(true);
  });

  // §3.5: the treatment for a role account is a penalty plus a constraint, NEVER a kill. The ICP
  // report names the alternative route for the LOCAL STOREFRONT segments: the walk list, because
  // an in-person ask is not a CEM at all.
  it("routes a walkable storefront to the walk list", () => {
    const channel = p08RoleAccountCannotClaimConspicuousPub(
      roleClaimingConspicuousPub,
      lists,
      NOW,
    ).find((r) => r.kind === "channel");
    expect(channel).toBeDefined();
    if (channel?.kind !== "channel") return;
    expect(channel.required_channel).toBe("in_person");
    expect(channel.reason).toBe("role_account_belongs_on_the_walk_list");
  });

  // ENTRY CONDITION. A walk a student cannot make is worse than saying nothing, so the route is
  // only asserted where an in-person ask is actually possible.
  it.each([
    ["no storefront signal", { observations: {} }],
    [
      "a storefront outside Greater Vancouver",
      {
        address_municipality: "Abbotsford",
        observations: { has_consumer_storefront: true },
      },
    ],
    [
      "a remote-first company with no address at all",
      {
        address_municipality: null,
        address_region: null,
        observations: { has_consumer_storefront: true },
      },
    ],
  ])("flags for a human rather than asserting a walk, given %s", (_label, over) => {
    const a = account({ ...roleClaimingConspicuousPub, ...over });
    const out = p08RoleAccountCannotClaimConspicuousPub(a, lists, NOW);
    expect(out.some((r) => r.kind === "channel")).toBe(false);
    const flag = out.find((r) => r.kind === "flag");
    expect(flag).toBeDefined();
    if (flag?.kind !== "flag") return;
    expect(flag.flag_reason).toBe("role_account_channel_unresolved");

    // Never a kill, never a block — the row stays on the board with its -15 either way.
    const result = run(a);
    expect(result.kills).toHaveLength(0);
    expect(result.email_channel_open).toBe(false);
    expect(result.penalties.find((p) => p.rule_id === "P-08")?.delta).toBe(-15);
  });

  it.each([
    ["a named person on the same claim", { email: "priya.patel@example.ca" }],
    ["a role account on a different basis", { lawful_basis: "express" as const }],
    ["a role account with no basis recorded", { lawful_basis: null }],
  ])("does not fire for %s", (_label, over) => {
    const out = p08RoleAccountCannotClaimConspicuousPub(
      { ...roleClaimingConspicuousPub, ...over },
      lists,
      NOW,
    );
    expect(out.every((r) => r.kind === "pass")).toBe(true);
  });

  it("closes the email channel through runFilter without dropping the row", () => {
    const result = run(roleClaimingConspicuousPub);
    expect(result.decision).not.toBe("terminal");
    expect(result.kills).toHaveLength(0);
    expect(result.email_channel_open).toBe(false);
    expect(result.field_terminals.map((t) => t.rule_id)).toContain("P-08-CONSTRAINT");
    expect(result.required_channel).toBe("in_person");
    // The address survives: the SEND is barred, not the contact.
    expect(result.account.email).toBe("info@example.ca");
    // And the -15 half still lands, because both halves of P-08 fire together.
    expect(result.penalties.find((p) => p.rule_id === "P-08")?.delta).toBe(-15);
  });

  // THE WALK MUST BE WALKABLE. An Ottawa-area business whose municipality happens to collide
  // with a Metro Vancouver alias was routed onto the Greater Vancouver walk list, because the
  // postal district that places it in Ontario was never read as contrary province evidence.
  it("does not route an out-of-province namesake onto the Vancouver walk list", () => {
    const result = run({
      legal_name: "Richmond Ontario Bakery",
      registrable_domain: "robakery.ca",
      email: "info@robakery.ca",
      address_municipality: "Richmond",
      postal_code: "K0A 2Z0",
      lawful_basis: "conspicuous_pub",
      observations: { has_consumer_storefront: true },
    });
    expect(result.kills).toHaveLength(0);
    expect(result.required_channel).not.toBe("in_person");
    expect(result.email_channel_open).toBe(false);
    expect(result.flags.map((f) => f.flag_reason)).toContain("role_account_channel_unresolved");
  });

  it("leaves the email channel open for the same account on a basis it can carry", () => {
    const result = run({ ...roleClaimingConspicuousPub, lawful_basis: "express" });
    expect(result.email_channel_open).toBe(true);
    expect(result.field_terminals.map((t) => t.rule_id)).not.toContain("P-08-CONSTRAINT");
    expect(result.required_channel).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Placeholder names — TERMINAL for the person, never for the account.
// ---------------------------------------------------------------------------

describe("placeholder contact names — 9 of 25 measured", () => {
  const MEASURED = [
    "Community Engagement Team",
    "Corporate Relations",
    "Owner / GM",
    "Owner",
    "Community Investment Team",
    "Make Good Happen Program",
    "Programs & Partnerships",
    "Program Officer",
    "Program Director",
  ];

  it.each(MEASURED)("rejects %j as a person", (name) => {
    const r = placeholderContactName(account({ legal_name: "X", contact_name: name }), NOW);
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.reason).toBe("placeholder_contact_name");
    expect(r.scope).toBe("person");
  });

  it.each(["Justin Cheung", "Praveen Varshney", "Christine Vukusic", "Igor Faletski"])(
    "accepts the real person %j",
    (name) => {
      expect(placeholderContactName(account({ legal_name: "X", contact_name: name }), NOW).kind).toBe(
        "pass",
      );
    },
  );

  it("scopes the terminal to the person, not the account", () => {
    const r = placeholderContactName(
      account({ legal_name: "X", contact_name: "Owner / GM" }),
      NOW,
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.scope).toBe("person");
  });

  it("never drops the ACCOUNT when only the person is a placeholder", () => {
    const burnabySmb = account({
      legal_name: "Some Local Business",
      registrable_domain: "example.ca",
      email: "info@example.ca",
      contact_name: "Owner / GM",
      contact_title: "Owner",
      address_region: "BC",
      address_municipality: "Burnaby",
      address_country: "CA",
    });
    const result = run(burnabySmb);

    // THE INVARIANT: the account survives.
    expect(result.decision).not.toBe("terminal");
    expect(result.kills).toEqual([]);

    // The unusable person is cleared and returned to discovery, and stays visible to a human.
    expect(result.account.contact_name).toBeNull();
    expect(result.account.contact_title).toBeNull();
    expect(result.cleared_fields).toEqual(
      expect.arrayContaining(["contact_name", "contact_title"]),
    );
    expect(result.field_terminals.map((t) => t.reason)).toContain("placeholder_contact_name");

    // Evaluation did NOT short-circuit: the penalty pass still ran and still charged P-08.
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.penalties.map((p) => p.tag)).toContain("role_account");
    expect(result.evaluated_rule_ids).toContain("L-02");
  });

  it("leaves the input account untouched — the cleared record is a copy", () => {
    const input = account({
      legal_name: "Some Local Business",
      registrable_domain: "example.ca",
      contact_name: "Owner / GM",
    });
    run(input);
    expect(input.contact_name).toBe("Owner / GM");
  });
});

describe("address-scoped terminals · the address dies, the account does not", () => {
  const base = {
    legal_name: "Some Local Business",
    registrable_domain: "example.ca",
    address_region: "BC",
    address_municipality: "Burnaby",
    address_country: "CA",
  } as const;

  const CASES: { name: string; over: Partial<Account>; rule: string }[] = [
    { name: "D-05 malformed address", over: { email: "info at example.ca" }, rule: "D-05" },
    {
      name: "D-07 third-party corporate domain",
      over: { email: "someone@othercompany.ca" },
      rule: "D-07",
    },
    {
      name: "K-REL-08 hard bounce",
      over: { email: "info@example.ca", rel: { bounced_hard_at: "2026-05-01" } },
      rule: "K-REL-08",
    },
  ];

  it.each(CASES)("$name keeps the account and clears the address", ({ over, rule }) => {
    const result = run(account({ ...base, ...over }));

    expect(result.decision).not.toBe("terminal");
    expect(result.kills).toEqual([]);
    expect(result.field_terminals.map((t) => t.rule_id)).toContain(rule);
    expect(result.field_terminals.every((t) => t.scope === "address")).toBe(true);
    expect(result.account.email).toBeNull();
    expect(result.cleared_fields).toContain("email");
    // Evaluation did NOT short-circuit: L-05 is the last step of the §2.4 order.
    expect(result.evaluated_rule_ids).toContain("L-05");
  });

  it("still accrues the penalties it has earned through an address-scoped terminal", () => {
    // A role address that hard-bounced: the address dies, and P-08 is still charged.
    const result = run(
      account({ ...base, email: "info@example.ca", rel: { bounced_hard_at: "2026-05-01" } }),
    );
    expect(result.field_terminals.map((t) => t.rule_id)).toContain("K-REL-08");
    expect(result.penalties.map((p) => p.rule_id)).toContain("P-08");
  });

  it("K-REL-08 no longer short-circuits the rules that follow it", () => {
    const result = run(
      account({ ...base, email: "info@example.ca", rel: { bounced_hard_at: "2026-05-01" } }),
    );
    // K-REL-08 sits at step 2 of the §2.4 order; D-07 and the L-rules sit at steps 8 and 9.
    expect(result.evaluated_rule_ids).toContain("D-07");
    expect(result.evaluated_rule_ids).toContain("L-05");
  });

  it("an account-scoped terminal still drops the row and still skips the penalty pass", () => {
    const result = run(
      account({
        ...base,
        email: "info@example.ca",
        rel: { suppressed_at: "2026-01-01" },
      }),
    );
    expect(result.decision).toBe("terminal");
    expect(result.kills[0].scope).toBe("account");
    expect(result.penalties).toEqual([]);
    expect(result.field_terminals).toEqual([]);
  });

  it("K-REL-08 emits the -40 for SIBLING rows as data, not as a sentence", () => {
    const result = run(
      account({ ...base, email: "info@example.ca", rel: { bounced_hard_at: "2026-05-01" } }),
    );
    expect(result.sibling_penalties).toEqual([
      expect.objectContaining({
        match_field: "email_domain",
        match_value: "example.ca",
        rule_id: "K-REL-08",
        delta: -40,
      }),
    ]);
    // It belongs to OTHER rows, so it must never be counted against this one.
    expect(result.penalties.map((p) => p.tag)).not.toContain("sibling_domain_hard_bounced");
    expect(result.penalty_total).toBe(result.penalties.reduce((a, p) => a + p.delta, 0));
  });

  it("emits no sibling penalty when there is no domain to match siblings on", () => {
    const result = run(account({ ...base, rel: { bounced_hard_at: "2026-05-01" } }));
    expect(result.sibling_penalties).toEqual([]);
  });

  it("a row with no hard bounce levies nothing on its siblings", () => {
    expect(run(account({ ...base, email: "info@example.ca" })).sibling_penalties).toEqual([]);
  });

  // A shared free-mail provider is not shared ownership. D-07 already exempts the same list.
  // Without this, one bounced info@gmail.com charges -40 to every free-mail lead in the corpus.
  it.each(["gmail.com", "shaw.ca", "telus.net", "outlook.com"])(
    "levies NOTHING on siblings when the bounced address is on %s",
    (provider) => {
      const result = run(
        account({
          ...base,
          registrable_domain: null,
          email: `info@${provider}`,
          rel: { bounced_hard_at: "2026-05-01" },
        }),
      );
      // The address itself still dies...
      expect(result.field_terminals.map((t) => t.rule_id)).toContain("K-REL-08");
      // ...and nobody else is touched.
      expect(result.sibling_penalties).toEqual([]);
    },
  );

  it("still levies on siblings for a company domain", () => {
    const result = run(
      account({ ...base, email: "info@example.ca", rel: { bounced_hard_at: "2026-05-01" } }),
    );
    expect(result.sibling_penalties.map((p) => p.match_value)).toEqual(["example.ca"]);
  });

  // §2.5: the sentence on a row explains THAT row. A sibling penalty is applied to a DIFFERENT
  // account, so it must not name the bouncing account or assert a rejection that never happened
  // to the recipient — the recipient is down-weighted and stays in the queue.
  it("renders the sibling sentence about the shared domain, not about the bouncing account", () => {
    const bouncer = account({
      ...base,
      legal_name: "Acme Ltd",
      email: "info@example.ca",
      rel: { bounced_hard_at: "2026-05-01" },
    });
    const [sibling] = run(bouncer).sibling_penalties;
    expect(sibling).toBeDefined();

    // The bouncing account is not the subject of the recipient's sentence.
    expect(sibling.message).not.toContain("Acme Ltd");
    // And it makes no affirmative rejection claim — `sentence()` renders those as "was <verb>".
    expect(sibling.message).not.toMatch(/\bwas (rejected|killed|dropped)\b/i);

    // The facts a caller needs to re-render for a named recipient travel structurally.
    expect(sibling).toMatchObject({
      match_field: "email_domain",
      match_value: "example.ca",
      occurred_at: "2026-05-01",
      cause_address: "info@example.ca",
    });

    // It is NOT the bouncing row's own terminal sentence.
    const terminal = run(bouncer).field_terminals.find((t) => t.rule_id === "K-REL-08");
    expect(sibling.message).not.toBe(terminal?.message);
  });

  it("still names the shared domain when the bouncing row records no address", () => {
    const [sibling] = run(
      account({ ...base, email_domain: "example.ca", rel: { bounced_hard_at: "2026-05-01" } }),
    ).sibling_penalties;
    expect(sibling).toBeDefined();
    expect(sibling).toMatchObject({ match_value: "example.ca", cause_address: "" });
    expect(sibling.message).toContain("example.ca");
    expect(sibling.message).not.toMatch(/\bwas (rejected|killed|dropped)\b/i);
  });

  // The predicate exercised DIRECTLY, not only through runFilter. runFilter happens to pass the
  // lists; a direct caller is where an omitted argument would have re-opened the corpus-wide
  // free-mail behaviour, so both branches are pinned at the function boundary.
  describe("called directly", () => {
    it("emits the sibling penalty for a corporate domain", () => {
      const r = kRel08HardBounced(
        account({ ...base, email: "info@example.ca", rel: { bounced_hard_at: "2026-05-01" } }),
        NOW,
        lists,
      );
      expect(r.kind).toBe("terminal");
      if (r.kind !== "terminal") return;
      expect(r.scope).toBe("address");
      expect(r.duration.kind).toBe("forever");
      expect(r.sibling_penalty).toMatchObject({
        match_field: "email_domain",
        match_value: "example.ca",
        delta: -40,
      });
    });

    it("emits NO sibling penalty for a free-mail domain", () => {
      const r = kRel08HardBounced(
        account({
          ...base,
          registrable_domain: null,
          email: "info@gmail.com",
          rel: { bounced_hard_at: "2026-05-01" },
        }),
        NOW,
        lists,
      );
      expect(r.kind).toBe("terminal");
      if (r.kind !== "terminal") return;
      expect(r.scope).toBe("address");
      expect(r.sibling_penalty).toBeUndefined();
    });
  });

  // THE RE-FILTER PATH. The first pass clears email/email_local/email_domain via the
  // address-scoped terminal while rel.bounced_hard_at stays on the record, so a second pass over
  // the PERSISTED row sees a bounce with no domain. The two silences are different facts and the
  // row must not claim the free-mail one.
  it("distinguishes 'no email domain on the record' from 'the domain is free-mail'", () => {
    const first = run(
      account({
        ...base,
        legal_name: "Acme Ltd",
        email: "info@example.ca",
        rel: { bounced_hard_at: "2026-05-01" },
      }),
    );
    expect(first.cleared_fields).toEqual(expect.arrayContaining(["email", "email_domain"]));
    expect(first.sibling_penalties.map((p) => p.match_value)).toEqual(["example.ca"]);

    // Re-filter the record as it was persisted.
    const second = run(first.account);
    const reTerminal = second.field_terminals.find((t) => t.rule_id === "K-REL-08");
    expect(reTerminal).toBeDefined();
    expect(second.sibling_penalties).toEqual([]);

    const freeMail = run(
      account({
        ...base,
        registrable_domain: null,
        email: "info@gmail.com",
        rel: { bounced_hard_at: "2026-05-01" },
      }),
    ).field_terminals.find((t) => t.rule_id === "K-REL-08");
    expect(freeMail).toBeDefined();

    // Both rows emit no sibling penalty, but for different reasons, and the sentences differ.
    expect(reTerminal?.message).not.toBe(freeMail?.message);
    expect(reTerminal?.message).not.toMatch(/free-mail/i);
    expect(freeMail?.message).toMatch(/free-mail/i);
  });
});

// ---------------------------------------------------------------------------
// §3.6 — "TERMINAL for email": the SEND is barred, the account and the address are not.
// ---------------------------------------------------------------------------

describe("email-scoped terminals · the email channel closes, the account does not", () => {
  const base = {
    legal_name: "Some Local Business",
    registrable_domain: "example.ca",
    email: "info@example.ca",
    address_region: "BC",
    address_municipality: "Burnaby",
    address_country: "CA",
  } as const;

  const CASES: { name: string; over: Partial<Account>; rule: string }[] = [
    {
      name: "L-02 no-solicitation notice at the source",
      over: { source_page_text: "Please no unsolicited emails." },
      rule: "L-02",
    },
    {
      name: "L-04 address taken from a third-party directory",
      over: {
        lawful_basis: "conspicuous_pub",
        lawful_basis_url: "https://some-directory.example.org/listing/123",
      },
      rule: "L-04",
    },
  ];

  it.each(CASES)("$name keeps the account and closes email", ({ over, rule }) => {
    const result = run(account({ ...base, ...over }));

    expect(result.decision).not.toBe("terminal");
    expect(result.kills).toEqual([]);
    expect(result.field_terminals.map((t) => t.rule_id)).toContain(rule);
    expect(result.field_terminals.find((t) => t.rule_id === rule)?.scope).toBe("email");

    // The channel is shut...
    expect(result.email_channel_open).toBe(false);
    // ...but the address survives, because the business is still reachable another way.
    expect(result.account.email).toBe("info@example.ca");
    expect(result.cleared_fields).not.toContain("email");

    // Evaluation continued and the penalty pass still ran.
    expect(result.penalties.length).toBeGreaterThan(0);
  });

  it("leaves the email channel open when nothing bars the send", () => {
    expect(run(account(base)).email_channel_open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DURATION — orthogonal to scope, read off §3.4's "Suppression window" column.
// ---------------------------------------------------------------------------

describe("terminal duration", () => {
  it("K-REL-05 is bounded by a 12-month window that carries its own clear date", () => {
    const r = kRel05DeclinedRecently(
      account({ legal_name: "X", rel: { declined_at: "2026-06-01", declined_reason: "no_budget" } }),
      NOW,
    );
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.scope).toBe("account");
    expect(r.duration).toEqual({
      kind: "until",
      clears_at: "2027-06-01T00:00:00.000Z",
      window: "12 months",
    });
    expect(isReversible(r)).toBe(true);
  });

  // A scheduler wakes a row at the `clears_at` the terminal itself published. If the guard and
  // the published date disagree by even a fraction of a day, that wake-up re-suppresses the row.
  it.each(["2026-06-01", "2026-03-01", "2026-08-06", "2025-12-31"])(
    "K-REL-05 clears EXACTLY at the clears_at it published, for a decline on %s",
    (declined_at) => {
      const declined = account({
        legal_name: "X",
        rel: { declined_at, declined_reason: "no_budget" },
      });
      const justBefore = new Date(Date.parse(declined_at) + 1000);
      const suppressing = kRel05DeclinedRecently(declined, justBefore);
      expect(suppressing.kind).toBe("terminal");
      if (suppressing.kind !== "terminal" || suppressing.duration.kind !== "until") return;

      const clearsAt = Date.parse(suppressing.duration.clears_at);
      // One millisecond before the published instant it is still suppressed...
      expect(kRel05DeclinedRecently(declined, new Date(clearsAt - 1)).kind).toBe("terminal");
      // ...and at that exact instant it is not.
      expect(kRel05DeclinedRecently(declined, new Date(clearsAt)).kind).toBe("pass");
    },
  );

  it("a forever terminal never clears, no matter how much time passes", () => {
    const suppressed = account({ legal_name: "X", rel: { suppressed_at: "2020-01-01" } });
    const later = new Date("2099-01-01T00:00:00.000Z");
    const r = kRel01Suppressed(suppressed, later);
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.duration.kind).toBe("forever");
    expect(isReversible(r)).toBe(false);
  });

  it("a forever suppression is not overridable by the never-kill allowlist", () => {
    // varshneycapital.com is ON the never-kill allowlist, so every other kill is overridden.
    const result = run(
      account({
        legal_name: "Varshney Capital Corp",
        registrable_domain: "varshneycapital.com",
        rel: { suppressed_at: "2025-01-01" },
      }),
    );
    expect(result.decision).toBe("terminal");
    expect(result.kills.map((k) => k.rule_id)).toContain("L-01");
    expect(result.overridden_kills.map((k) => k.rule_id)).not.toContain("L-01");
  });

  it("every terminal the §2.4 order can emit carries a scope and a duration", () => {
    const results = evaluateKillPredicates(FIXTURES.seattleRoasters, lists, { now: NOW });
    const terminals = results.filter((r) => r.kind === "terminal");
    expect(terminals.length).toBeGreaterThan(0);
    for (const t of terminals) {
      if (t.kind !== "terminal") continue;
      expect(["account", "address", "email", "person"], t.rule_id).toContain(t.scope);
      expect(["forever", "until_human_clears", "until"], t.rule_id).toContain(t.duration.kind);
    }
  });
});

// ===========================================================================
// §3.6 K-LEGAL
// ===========================================================================

describe("K-LEGAL · consent and provenance", () => {
  it.each([
    "No unsolicited emails please.",
    "We do not accept unsolicited proposals.",
    "Please no sales calls.",
    "Do not contact this address for marketing.",
    "Aucune sollicitation.",
    "Nous ne souhaitons pas recevoir de courriels non sollicités.",
    "Ne pas nous contacter.",
  ])("L-02 catches %j in either language", (text) => {
    expect(l02NoSolicitationStatement(account({ legal_name: "X", source_page_text: text }), NOW).kind).toBe(
      "terminal",
    );
  });

  it("L-02 cannot evaluate without a stored snapshot", () => {
    expect(l02NoSolicitationStatement(account({ legal_name: "X" }), NOW).kind).toBe("cannot_evaluate");
  });

  it.each(["email_finder", "bulk_crawler", "enrichment_api"] as const)(
    "L-03 kills an address collected by %s — using it is PROHIBITED, not merely low quality",
    (method) => {
      const r = l03HarvestedAddress(account({ legal_name: "X", collection_method: method }), NOW);
      expect(r.kind).toBe("terminal");
      if (r.kind !== "terminal") return;
      expect(r.reason).toBe("harvested_address_prohibited");
      expect(r.detail).toBe(method);
    },
  );

  it.each(["own_site_fetch", "business_card", "inbound_enquiry", "human_paste"] as const)(
    "L-03 allows %s",
    (method) => {
      expect(l03HarvestedAddress(account({ legal_name: "X", collection_method: method }), NOW).kind).toBe(
        "pass",
      );
    },
  );

  it("L-03 cannot evaluate when collection_method was never written", () => {
    const r = l03HarvestedAddress(account({ legal_name: "X" }), NOW);
    expect(r.kind).toBe("cannot_evaluate");
    if (r.kind !== "cannot_evaluate") return;
    expect(r.missing_fields).toContain("collection_method");
  });

  const l04Cases: [string, string, "terminal" | "pass"][] = [
    ["the account's own domain", "https://example.ca/contact", "pass"],
    ["a subdomain of the account's own domain", "https://about.example.ca/contact", "pass"],
    ["a tier-1 source", "https://www.sfu.ca/beedie/news/story.html", "pass"],
    ["a third-party directory", "https://someaggregator.com/listing/example", "terminal"],
  ];

  it.each(l04Cases)("L-04 with %s", (_label, url, expected) => {
    expect(
      l04NotConspicuouslyPublished(
        account({
          legal_name: "X",
          registrable_domain: "example.ca",
          lawful_basis: "conspicuous_pub",
          lawful_basis_url: url,
        }),
        NOW,
      ).kind,
    ).toBe(expected);
  });

  it("L-05 HOLDS rather than drops when no basis is recorded", () => {
    const r = l05NoLawfulBasis(account({ legal_name: "X" }), NOW);
    expect(r.kind).toBe("hold");
    if (r.kind !== "hold") return;
    expect(r.reason).toBe("no_lawful_basis");
  });
});

// ===========================================================================
// §3.7 K-REP
// ===========================================================================

describe("K-REP-01 · statutory prohibitions — a legal kill, not a taste judgment", () => {
  it.each([
    ["a cannabis retailer", "Green Leaf Cannabis", ""],
    ["a marijuana dispensary", "Coastal Marijuana Dispensary", ""],
    ["a tobacconist", "Downtown Tobacco Shop", ""],
    ["a vape shop", "Vape Nation", ""],
    ["a smoke shop", "Main St Smoke Shop", ""],
    ["an industry field", "Some Brand", "e-liquid manufacturing"],
  ])("kills %s", (_label, name, industry) => {
    const r = kRep01StatutorySector(account({ legal_name: name, industry }), lists, NOW);
    expect(r.kind).toBe("terminal");
    if (r.kind !== "terminal") return;
    expect(r.reason).toBe("sponsorship_prohibited_by_statute");
    expect(r.scope).toBe("account");
    expect(r.duration.kind).toBe("until_human_clears");
  });

  it("does NOT exclude alcohol — the club's own pipeline carries a craft distillery", () => {
    expect(kRep01StatutorySector(FIXTURES.theWoodsSpirit, lists, NOW).kind).toBe("pass");
  });

  it.each([
    "Steamworks Brewing Company",
    "Vancouver Urban Winery",
    "Browns Socialhouse",
    "Cactus Club Cafe",
    "The Rio Theatre",
  ])("does not kill the licensed hospitality partner %j", (name) => {
    expect(kRep01StatutorySector(account({ legal_name: name }), lists, NOW).kind).toBe("pass");
  });
});

describe("K-REP-02 · sensitive sectors → FLAG, never an automatic kill", () => {
  it.each([
    ["gambling", "River Rock Casino"],
    ["payday_lending", "Fast Payday Loans"],
    ["crypto_forex", "Vancouver Crypto Exchange"],
    ["mlm", "Prime Multi-Level Marketing"],
    ["firearms", "Lower Mainland Gun Store"],
  ])("flags %s without deciding", (sector, name) => {
    const results = kRep02SensitiveSector(account({ legal_name: name }), lists, NOW);
    const flag = results.find((r) => r.kind === "flag" && r.flag_reason === sector);
    expect(flag, `${sector} was not flagged`).toBeDefined();
    if (flag?.kind !== "flag") throw new Error("expected a flag");
    expect(flag.reason).toBe("sector_needs_human_decision");
    expect(flag.rule_id).toBe("K-REP-02");
  });

  it("produces no TERMINAL for any sensitive sector", () => {
    for (const name of ["River Rock Casino", "Fast Payday Loans", "Prime MLM"]) {
      const results = kRep02SensitiveSector(account({ legal_name: name }), lists, NOW);
      expect(results.every((r) => r.kind === "flag")).toBe(true);
    }
  });
});

// ===========================================================================
// §5 — franchise versus corporate branch. The most expensive error in the spec.
// ===========================================================================

describe("§5 · franchise or branch — test the LOCATION, not the brand", () => {
  it("Modo Yoga Vancouver is LOCAL_AUTHORITY, on its own published words", () => {
    const report = franchiseOrBranchCarveOut(
      account({
        ...FIXTURES.modoYogaVancouver,
        observations: {
          // Verbatim from modoyoga.com, verified 2026-08-06.
          location_page_text:
            "Modo Yoga North Vancouver is an independently owned and operated franchisee of Modo Yoga International, Inc.",
          location_has_own_domain_with_mx: true,
          named_local_owner: "Jane Whitcombe",
          chain_has_franchise_page: true,
        },
      }),
    );
    expect(report.status).toBe("LOCAL_AUTHORITY");
    expect(report.signals).toEqual(expect.arrayContaining(["S1", "S2", "S4", "S6"]));
  });

  it("Cactus Club Cafe is HEAD_OFFICE and is REROUTED, not dropped", () => {
    const report = franchiseOrBranchCarveOut(
      account({
        ...FIXTURES.cactusClubCafe,
        observations: { has_central_donation_form: true, only_head_office_contact: true },
      }),
      { now: NOW, application_path_found: "/donation-requests" },
    );
    expect(report.status).toBe("HEAD_OFFICE");
    expect(report.signals).toEqual(expect.arrayContaining(["N1", "N2"]));
    if (report.status !== "HEAD_OFFICE") return;
    // The reroute is CARRIED, not described: §5's worked case maps this row to CHANNEL web_form.
    expect(report.reroute.kind).toBe("channel");
    if (report.reroute.kind !== "channel") return;
    expect(report.reroute.required_channel).toBe("web_form");
    expect(report.reroute.reason).toBe("head_office_holds_the_decision");
  });

  // The live defect: §5 said "REROUTED, not dropped" and nothing emitted a reroute, so a
  // head-office row reached the queue unmarked and a student emailed the local branch.
  describe("§5 step 2's reroute is emitted, not merely narrated", () => {
    const headOfficeOnly = {
      legal_name: "Some Chain Location",
      registrable_domain: "somechain.ca",
      address_municipality: "Vancouver",
      address_region: "BC",
      address_country: "CA",
      observations: { only_head_office_contact: true },
    };

    it("routes to web_form through runFilter when head office publishes a path", () => {
      const result = run(account(headOfficeOnly), { application_path_found: "/donation-requests" });
      expect(result.decision).toBe("channel");
      expect(result.required_channel).toBe("web_form");
      expect(result.kills).toHaveLength(0);
      // §5 reaches the same route from the same evidence as K-CHAN-01, so the row carries the
      // instruction once rather than twice.
      expect(result.channels.filter((c) => c.required_channel === "web_form")).toHaveLength(1);
      // The head-office finding itself is still on the row.
      expect(result.franchise.status).toBe("HEAD_OFFICE");
    });

    // K-CHAN-01 recognises a published channel from the PAGE TEXT as well as from a probed path.
    // Reading only the probed path left a row carrying a web_form channel beside a flag saying
    // no channel existed.
    it("routes to web_form on a page-text hit with no probed path", () => {
      const result = run(
        account({
          ...headOfficeOnly,
          source_page_text: "All donation requests must be submitted through our online form.",
        }),
      );
      expect(result.decision).toBe("channel");
      expect(result.required_channel).toBe("web_form");
      expect(result.flags.map((f) => f.rule_id)).not.toContain("FRANCHISE-HEAD-OFFICE");
    });

    it("records the route once when K-CHAN-01 and §5 reach it from the same evidence", () => {
      const result = run(account(headOfficeOnly), { application_path_found: "/donation-requests" });
      expect(result.channels.filter((c) => c.required_channel === "web_form")).toHaveLength(1);
    });

    it("flags for human review when head office publishes NO channel, rather than inventing one", () => {
      const result = run(account(headOfficeOnly));
      // §5 names no channel for this case, so the row is neither routed to a guess...
      expect(result.channels.map((c) => c.rule_id)).not.toContain("FRANCHISE-HEAD-OFFICE");
      expect(result.required_channel).toBeNull();
      // ...nor dropped, nor left unmarked — which is what it used to be.
      expect(result.kills).toHaveLength(0);
      const flag = result.flags.find((f) => f.rule_id === "FRANCHISE-HEAD-OFFICE");
      expect(flag).toBeDefined();
      expect(flag?.flag_reason).toBe("head_office_channel_unresolved");
      expect(flag?.reason).toBe("head_office_holds_the_decision");
    });

    it("marks nothing when §5 does not return HEAD_OFFICE", () => {
      const local = run(
        account({
          ...headOfficeOnly,
          observations: { location_has_own_domain_with_mx: true, named_local_owner: "Jane Whitcombe" },
        }),
      );
      expect(local.franchise.status).toBe("LOCAL_AUTHORITY");
      expect(local.flags.map((f) => f.rule_id)).not.toContain("FRANCHISE-HEAD-OFFICE");
      expect(local.channels.map((c) => c.rule_id)).not.toContain("FRANCHISE-HEAD-OFFICE");
    });

    // §5's own caveat: "rerouted, not dropped, UNLESS K-CHAN-02 also fires". K-CHAN-02 is an
    // account-scoped terminal, so it short-circuits and the reroute never runs.
    it("is pre-empted by K-CHAN-02, which the report says takes precedence", () => {
      const result = run(
        account({
          ...headOfficeOnly,
          source_page_text: "Only registered charities are eligible for our community fund.",
        }),
        { application_path_found: "/donation-requests" },
      );
      expect(result.decision).toBe("terminal");
      expect(result.reject_rule_id).toBe("K-CHAN-02");
      expect(result.channels.map((c) => c.rule_id)).not.toContain("FRANCHISE-HEAD-OFFICE");
      expect(result.flags.map((f) => f.rule_id)).not.toContain("FRANCHISE-HEAD-OFFICE");
    });
  });

  // Red Bull is a chain, so §5 applies to it — but the fixture has to SAY it is a chain, because
  // §5's entry condition is observed evidence, not the absence of evidence.
  const redBullLocation = {
    legal_name: "Red Bull",
    address_region: "AT",
    address_country: "AT",
    observations: {
      chain_has_franchise_page: true,
      bc_branch_confirmed: true,
    },
  } as const;

  it("Red Bull is UNPROVEN — and 'we could not tell' is not evidence of 'no'", () => {
    const report = franchiseOrBranchCarveOut(account({ ...redBullLocation }));
    expect(report.status).toBe("UNPROVEN");
  });

  it("gives Red Bull P-04 (-30) and keeps it in the queue", () => {
    const penalties = evaluatePenalties(account({ ...redBullLocation }), {
      lists,
      now: NOW,
      franchise: "UNPROVEN",
    });
    const p04 = penalties.find((p) => p.rule_id === "P-04");
    expect(p04?.delta).toBe(-30);
  });

  // ENTRY CONDITION — §5 is scoped to locations of a chain. An independent single-location
  // business is not a branch of anything, so the franchise question does not arise for it.
  describe("§5's entry condition — an independent business is not a branch of anything", () => {
    const independentBakery = {
      legal_name: "Crema Artisan Bakers",
      registrable_domain: "cremabakers.ca",
      email: "info@cremabakers.ca",
      address_municipality: "Burnaby",
      address_region: "BC",
      address_country: "CA",
    } as const;

    it("reports NOT_APPLICABLE rather than UNPROVEN", () => {
      const report = franchiseOrBranchCarveOut(account({ ...independentBakery }));
      expect(report.status).toBe("NOT_APPLICABLE");
      expect(report.signals).toEqual([]);
    });

    it("is NOT penalised by any franchise or branch rule", () => {
      const result = run(account({ ...independentBakery }));
      expect(result.penalties.map((p) => p.rule_id)).not.toContain("P-04");
      expect(result.franchise.status).toBe("NOT_APPLICABLE");
    });

    it("P-04 does not fire even if a caller passes UNPROVEN, without the §4 clauses", () => {
      const penalties = evaluatePenalties(account({ ...independentBakery }), {
        lists,
        now: NOW,
        franchise: "UNPROVEN",
      });
      expect(penalties.map((p) => p.rule_id)).not.toContain("P-04");
    });

    it("still enters §5 once a single chain signal is observed", () => {
      const report = franchiseOrBranchCarveOut(
        account({ ...independentBakery, observations: { store_locator_location_count: 3 } }),
      );
      expect(report.status).not.toBe("NOT_APPLICABLE");
    });
  });

  // P-04's own §4 definition has three clauses, not one.
  describe("P-04 requires all three clauses of its §4 definition", () => {
    const branch = {
      legal_name: "A Chain Location",
      observations: { chain_has_franchise_page: true, bc_branch_confirmed: true },
    } as const;

    function p04(over: Partial<Account>) {
      return evaluatePenalties(account({ ...branch, ...over }), {
        lists,
        now: NOW,
        franchise: "UNPROVEN",
      }).find((p) => p.rule_id === "P-04");
    }

    it("fires when the head office is outside BC and a local branch exists", () => {
      expect(p04({ address_region: "ON" })?.delta).toBe(-30);
    });

    it("does not fire when the head office is IN BC", () => {
      expect(p04({ address_region: "BC" })).toBeUndefined();
    });

    it("does not fire when no local branch is established", () => {
      expect(
        p04({ address_region: "ON", observations: { chain_has_franchise_page: true } }),
      ).toBeUndefined();
    });

    it("does not fire when the head office location is unknown — absence is not evidence", () => {
      expect(p04({})).toBeUndefined();
    });

    // Clause 2 used to accept a bare municipality alias recorded as an "operating municipality",
    // which levied -30 on an Ontario chain whose branch was in Richmond, ONTARIO. The clause now
    // takes CONFIRMED evidence only, so the namesake hazard cannot reach a penalty path.
    it("takes confirmed branch evidence only, never a bare municipality namesake", () => {
      const ontarioChain = account({
        legal_name: "Ontario Chain Co",
        registrable_domain: "onchain.ca",
        address_municipality: "Toronto",
        address_region: "ON",
        address_country: "CA",
        observations: { store_locator_location_count: 12, chain_has_franchise_page: true },
      });
      // The retired enrichment key is cast in on purpose: a row persisted before the cut still
      // carries it, and Richmond, ONTARIO must no longer read as a BC branch.
      const withNamesake = {
        ...ontarioChain,
        observations: { ...ontarioChain.observations, operating_municipality: "Richmond" },
      } as unknown as Account;
      const penalties = evaluatePenalties(withNamesake, { lists, now: NOW, franchise: "UNPROVEN" });
      expect(penalties.map((p) => p.rule_id)).not.toContain("P-04");

      const confirmed = evaluatePenalties(
        account({
          ...ontarioChain,
          observations: { ...ontarioChain.observations, bc_branch_confirmed: true },
        }),
        { lists, now: NOW, franchise: "UNPROVEN" },
      );
      expect(confirmed.find((p) => p.rule_id === "P-04")?.delta).toBe(-30);
    });
  });

  it("treats the franchise-opportunities page (S6) alone as insufficient for LOCAL_AUTHORITY", () => {
    // S6 only proves the network is franchised at all — it says nothing about THIS location.
    const report = franchiseOrBranchCarveOut(
      account({ legal_name: "Some Chain Location", observations: { chain_has_franchise_page: true } }),
    );
    expect(report.status).toBe("UNPROVEN");
  });

  it("rejects a placeholder as a named local owner", () => {
    const report = franchiseOrBranchCarveOut(
      account({ legal_name: "Some Location", observations: { named_local_owner: "Owner / GM" } }),
    );
    expect(report.status).toBe("UNPROVEN");
  });

  it("recognises CENTRALISED_RE as a head-office signal", () => {
    const report = franchiseOrBranchCarveOut(
      account({
        legal_name: "Some Chain",
        observations: {
          location_page_text: "All donation requests are handled centrally by our head office.",
        },
      }),
    );
    expect(report.status).toBe("HEAD_OFFICE");
  });
});

// ===========================================================================
// §4 — every penalty's ENTRY CONDITION, taken from its own definition row
// ===========================================================================

describe("P-03 · publicly traded, on evidence of being publicly traded", () => {
  function p03(over: Partial<Account>) {
    return evaluatePenalties(account({ legal_name: "Some Co", ...over }), { lists, now: NOW }).find(
      (p) => p.rule_id === "P-03",
    );
  }

  it.each([
    ["a stock ticker", { has_stock_ticker: true }],
    ["an investor-relations section", { has_investor_relations: true }],
  ])("fires on %s", (_label, observations) => {
    expect(p03({ observations })?.delta).toBe(-20);
  });

  // §4 defines P-03 as "Publicly traded (has a ticker / investor-relations section)". §6's
  // single-proxy arm is not evidence of that. Cactus Club Cafe is the report's own example and a
  // PAST PARTNER: penalising it as publicly traded for a suppliers page is factually untrue.
  it.each([
    ["a suppliers/procurement page", { has_supplier_procurement_path: true }],
    ["20+ open job postings", { careers_open_postings: 25 }],
    ["a 25+ location store locator", { store_locator_location_count: 30 }],
    ["a named community-investment programme", { has_named_community_investment_programme: true }],
  ])("does NOT fire on %s alone", (_label, observations) => {
    expect(p03({ observations })).toBeUndefined();
  });

  it("does not tag Cactus Club Cafe, a past partner, as publicly traded", () => {
    const result = run(
      account({
        ...FIXTURES.cactusClubCafe,
        observations: { has_supplier_procurement_path: true, has_central_donation_form: true },
      }),
    );
    expect(result.penalties.map((p) => p.rule_id)).not.toContain("P-03");
  });

  // §6's separate two-or-more-proxy arm is its own rule and is unchanged by this.
  it("leaves K-SIZE-01's two-or-more-proxy arm alone", () => {
    const twoProxies = account({
      legal_name: "A Real Enterprise",
      observations: { has_supplier_procurement_path: true, careers_open_postings: 40 },
    });
    expect(kSize01EnterpriseScale(twoProxies, NOW, "UNPROVEN").kind).toBe("terminal");
  });
});

// ===========================================================================
// Resolved ambiguity A1 — a penalty fires on an observed fact, or on a missing value whose
// resolution attempt is recorded. Never on a value that is merely absent.
// ===========================================================================

describe("P-10 · social-only presence, on evidence rather than on an empty field", () => {
  function p10(over: Partial<Account>) {
    return evaluatePenalties(account({ legal_name: "Corner Bakery", ...over }), {
      lists,
      now: NOW,
    }).find((p) => p.rule_id === "P-10");
  }

  // The population this protects: a freshly discovered local operator carrying a name, a
  // municipality and a phone number, before any enrichment pass has run.
  it("does NOT fire on a freshly discovered row that nothing has looked up yet", () => {
    expect(
      p10({ address_municipality: "Vancouver", address_region: "BC", phone_e164: "+16045550100" }),
    ).toBeUndefined();
  });

  it("fires on an OBSERVED social-only presence, with or without a lookup attempt", () => {
    expect(p10({ observations: { social_only_presence: true } })?.delta).toBe(-20);
  });

  it("fires on empty website fields ONCE an enrichment pass has recorded its failure", () => {
    expect(p10({ observations: { website_resolution_attempts: 1 } })?.delta).toBe(-20);
  });

  it("does not fire when the enrichment pass FOUND a website", () => {
    expect(
      p10({ registrable_domain: "cornerbakery.ca", observations: { website_resolution_attempts: 1 } }),
    ).toBeUndefined();
  });

  // P-09 and P-06 were already this shape and are the model the rest was derived against.
  it.each([
    ["P-09", { observations: { geography_resolution_attempts: 1 } }, "P-09"],
    ["P-06", { observations: { discovery_tactics_attempted: 2 } }, "P-06"],
  ])("%s likewise needs its recorded attempt before it fires", (_label, over, ruleId) => {
    const bare = evaluatePenalties(account({ legal_name: "Corner Bakery" }), { lists, now: NOW });
    expect(bare.map((p) => p.rule_id)).not.toContain(ruleId);
    const attempted = evaluatePenalties(account({ legal_name: "Corner Bakery", ...over }), {
      lists,
      now: NOW,
    });
    expect(attempted.map((p) => p.rule_id)).toContain(ruleId);
  });

  // P-09 asks whether the geography RESOLVED, which is the shared verdict's question, not
  // whether the fields are blank. Deciding it from raw truthiness was a second geography reading
  // inside the module, and it disagreed: an unrecognised municipality is present but unresolved.
  it.each([
    ["an unrecognised municipality", { address_municipality: "Nowheresville" }],
    ["an unrecognised region", { address_region: "Freedonia" }],
    ["an unparseable postal code", { postal_code: "not a postal code" }],
    ["nothing at all", {}],
  ])("fires P-09 on %s once a resolution attempt is recorded", (_label, over) => {
    const penalties = evaluatePenalties(
      account({ legal_name: "Y", ...over, observations: { geography_resolution_attempts: 1 } }),
      { lists, now: NOW },
    );
    expect(penalties.find((p) => p.rule_id === "P-09")?.delta).toBe(-15);
  });

  it("does not fire P-09 once the geography actually resolves", () => {
    const penalties = evaluatePenalties(
      account({
        legal_name: "Y",
        address_municipality: "Burnaby",
        address_region: "BC",
        observations: { geography_resolution_attempts: 1 },
      }),
      { lists, now: NOW },
    );
    expect(penalties.map((p) => p.rule_id)).not.toContain("P-09");
  });

  it("charges a bare, unenriched row nothing at all", () => {
    const result = run(
      account({
        legal_name: "Corner Bakery",
        address_municipality: "Vancouver",
        address_region: "BC",
        phone_e164: "+16045550100",
      }),
    );
    expect(result.decision).toBe("pass");
    expect(result.penalty_total).toBe(0);
  });
});

// ===========================================================================
// §7.2 LIST_national_flag — "review, do not kill". A different list from §7.1, with a different
// outcome: a human-review flag, never a terminal and never the enactus_canada channel.
// ===========================================================================

describe("§7.2 national-flag list → FLAG only", () => {
  it.each([
    ["PwC", "pwc.com"],
    ["Scotiabank", "scotiabank.com"],
    ["Canadian Western Bank", "cwbank.com"],
    ["WWF Canada", "wwf.ca"],
    ["Porter Airlines", "flyporter.com"],
  ])("flags %s for human review", (name, domain) => {
    const r = nationalFlagReview(account({ legal_name: name, registrable_domain: domain }), lists, NOW);
    expect(r.kind).toBe("flag");
    if (r.kind !== "flag") return;
    expect(r.reason).toBe("national_flag_needs_human_review");
    expect(r.flag_reason).toBe("lapsed_or_conflicted_national_relationship");
    expect(r.detail).toBe(name);
  });

  it("flags a name-only entry that has no verified domain", () => {
    const r = nationalFlagReview(
      account({ legal_name: "Varshney Family Foundation" }),
      lists,
      NOW,
    );
    expect(r.kind).toBe("flag");
  });

  it("passes an account on neither list", () => {
    expect(
      nationalFlagReview(account({ legal_name: "Corner Bakery", registrable_domain: "example.ca" }), lists, NOW)
        .kind,
    ).toBe("pass");
  });

  it.each([
    ["pwc.com", "PwC"],
    ["scotiabank.com", "Scotiabank"],
  ])("surfaces %s through runFilter without rejecting or rerouting it", (domain, name) => {
    const result = run(account({ legal_name: name, registrable_domain: domain }));
    expect(result.flags.map((f) => f.rule_id)).toContain("LIST-NATIONAL-FLAG");
    // "Kill mode: none — human_review only". Neither a terminal nor a channel on this ground.
    expect(result.decision).toBe("pass");
    expect(result.kills).toHaveLength(0);
    expect(result.required_channel).toBeNull();
    expect(result.channels.map((c) => c.required_channel)).not.toContain("enactus_canada");
  });

  // Routing PwC to the national body would be the §7.1 outcome applied to the §7.2 list.
  it("is a different list from §7.1 — a flagged entity is not a national partner", () => {
    expect(
      kOrg01NationalPartner(account({ legal_name: "PwC", registrable_domain: "pwc.com" }), lists, NOW).kind,
    ).toBe("pass");
  });
});

// ===========================================================================
// The runner — §2.4 order, the never-kill allowlist, and kill/penalty separation
// ===========================================================================

describe("runFilter", () => {
  it("rejects an account outside Canada with a reason a human can read and argue with", () => {
    const result = run(FIXTURES.seattleRoasters);
    expect(result.decision).toBe("terminal");
    expect(result.reject_reason).toBe("outside_canada");
    expect(result.reject_rule_id).toBe("K-GEO-01");
    expect(result.reject_detail).toBe("US");
    expect(result.reject_evidence_url).toBeTruthy();
    expect(result.reject_at).toBe(NOW.toISOString());
  });

  it("populates the whole §2.5 reason-string contract on every rejection", () => {
    const result = run(FIXTURES.seattleRoasters);
    expect(result.reject_reason).toBeTruthy();
    expect(result.reject_detail).toBeTruthy();
    expect(result.reject_evidence_url).toBeTruthy();
    expect(result.reject_rule_id).toBeTruthy();
    expect(result.reject_at).toBeTruthy();
    expect(result.message).toBeTruthy();
  });

  it("gives every kill, channel, hold, flag and penalty a human-readable message", () => {
    const messy = account({
      legal_name: "Abbotsford Widgets",
      registrable_domain: "example.ca",
      email: "info@example.ca",
      address_region: "BC",
      address_municipality: "Abbotsford",
      address_country: "CA",
      industry: "online casino",
    });
    const result = run(messy);
    for (const item of [
      ...result.kills,
      ...result.channels,
      ...result.penalties,
      ...result.holds,
      ...result.flags,
    ]) {
      expect(item.message.length).toBeGreaterThan(20);
    }
    for (const c of result.cannot_evaluate) {
      expect(c.missing_fields.length).toBeGreaterThan(0);
      expect(c.message.length).toBeGreaterThan(20);
    }
  });

  it("keeps hard kills and soft penalties in separate places", () => {
    const result = run(FIXTURES.seattleRoasters);
    expect(result.kills.every((k) => k.kind === "terminal")).toBe(true);
    expect(result.penalties.every((p) => p.kind === "penalty")).toBe(true);
    // A terminal short-circuits before the penalty pass: a score on a rejected row means nothing.
    expect(result.penalties).toHaveLength(0);
  });

  it("sums penalties only for rows that stay in the queue", () => {
    const result = run(
      account({
        legal_name: "Squamish Bakery",
        registrable_domain: "example.ca",
        email: "info@example.ca",
        address_region: "BC",
        address_municipality: "Squamish",
        address_country: "CA",
        collection_method: "own_site_fetch",
        lawful_basis: "b2b_relationship",
      }),
    );
    expect(result.decision).toBe("pass");
    expect(result.penalty_total).toBeLessThan(0);
    expect(result.penalties.map((p) => p.tag)).toContain("role_account");
  });

  // Geography is expressed EXACTLY ONCE, as the band weight. Charging a penalty as well would
  // count the same fact twice, so the retired -25 must not reappear from any rule.
  it("expresses geography through the band alone, never as a penalty", () => {
    const result = run(
      account({
        legal_name: "Squamish Bakery",
        registrable_domain: "example.ca",
        email: "info@example.ca",
        address_region: "BC",
        address_municipality: "Squamish",
        address_country: "CA",
      }),
    );
    expect(result.penalties.map((p) => p.tag)).not.toContain("outside_metro_vancouver");
    expect(result.penalties.map((p) => p.rule_id)).not.toContain("P-01");
  });

  it("short-circuits on the first TERMINAL", () => {
    const result = run(
      account({
        legal_name: "Enactus SFU",
        registrable_domain: "enactussfu.ca",
        rel: { suppressed_at: "2025-01-01" },
      }),
    );
    expect(result.kills).toHaveLength(1);
    expect(result.kills[0].rule_id).toBe("L-01");
  });

  it("names the rule that fired in the sentence a human reads (§2.5)", () => {
    // The suppression predicate appears twice in the spec — as L-01 in the §2.4 order and as
    // K-REL-01 in §3.4. Whichever id the row shows, the rendered sentence must cite the same one.
    const result = run(account({ legal_name: "X", rel: { suppressed_at: "2025-01-01" } }));
    expect(result.reject_rule_id).toBe("L-01");
    expect(result.message).toContain("(rule L-01");
    expect(result.message).not.toContain("K-REL-01");

    const direct = kRel01Suppressed(
      account({ legal_name: "X", rel: { suppressed_at: "2025-01-01" } }),
      NOW,
    );
    expect(direct.kind).toBe("terminal");
    if (direct.kind !== "terminal") return;
    expect(direct.message).toContain("(rule K-REL-01");
  });

  it("routes rather than rejects a national partner", () => {
    const result = run(account({ legal_name: "TD Bank Group", registrable_domain: "td.com" }));
    expect(result.decision).toBe("channel");
    expect(result.required_channel).toBe("enactus_canada");
  });

  it("lets the never-kill allowlist override a §3 kill, and RECORDS the override", () => {
    // Varshney Capital Corp would otherwise be killed as outside Canada; the allowlist protects
    // the converted relationship, and the suppressed kill stays visible.
    const result = run(
      account({
        legal_name: "Varshney Capital Corp",
        registrable_domain: "varshneycapital.com",
        address_municipality: "Seattle",
        address_region: "WA",
        address_country: "US",
      }),
    );
    expect(result.decision).not.toBe("terminal");
    expect(result.overridden_kills.map((o) => o.reason)).toContain("outside_canada");
    expect(result.overridden_kills[0].overridden_by).toContain("never-kill allowlist");
  });

  it("does NOT let the allowlist override suppression", () => {
    const result = run(
      account({
        legal_name: "Varshney Capital Corp",
        registrable_domain: "varshneycapital.com",
        rel: { suppressed_at: "2025-01-01" },
      }),
    );
    expect(result.decision).toBe("terminal");
    expect(result.reject_reason).toBe("suppressed_do_not_contact");
    expect(result.overridden_kills).toHaveLength(0);
  });

  it("surfaces every predicate that could not be evaluated, with its missing fields", () => {
    const bare = account({ legal_name: "Unknown Co" });
    const result = run(bare);
    const byRule = Object.fromEntries(result.cannot_evaluate.map((c) => [c.rule_id, c.missing_fields]));
    expect(byRule["K-ORG-05"]).toContain("cra_designation");
    expect(byRule["K-SIZE-01"]).toContain("headcount");
    expect(byRule["K-GEO-01"]).toContain("address_country");
    expect(byRule["L-03"]).toContain("collection_method");
  });

  it("never returns a terminal for an account it merely knows nothing about", () => {
    const result = run(account({ legal_name: "Unknown Co" }));
    expect(result.decision).toBe("pass");
    expect(result.kills).toHaveLength(0);
    expect(result.cannot_evaluate.length).toBeGreaterThan(0);
  });

  it("evaluates in the §2.4 order — suppression first, deliverability after org type", () => {
    const ids = evaluateKillPredicates(account({ legal_name: "X" }), lists, { now: NOW }).map(
      (r) => r.rule_id,
    );
    expect(ids[0]).toBe("L-01");
    expect(ids.indexOf("K-ORG-02")).toBeLessThan(ids.indexOf("K-GEO-01"));
    expect(ids.indexOf("K-GEO-01")).toBeLessThan(ids.indexOf("D-01"));
    expect(ids.indexOf("D-01")).toBeLessThan(ids.indexOf("L-02"));
  });
});

describe("the module contract", () => {
  // "imports no model client" is proved by executing the module graph with the model boundary
  // armed to throw — see tests/no-model-client.test.ts.

  it("is deterministic — the same account scores identically twice", () => {
    const a = FIXTURES.affinityCreditUnion;
    expect(JSON.stringify(run(a))).toBe(JSON.stringify(run(a)));
  });

  it("finds no result without a rule_id", () => {
    const results = evaluateKillPredicates(FIXTURES.cactusClubCafe, lists, { now: NOW });
    for (const r of results) expect(r.rule_id).toBeTruthy();
    expect(ruleResult(results, "K-ORG-01")).toBeDefined();
  });
});

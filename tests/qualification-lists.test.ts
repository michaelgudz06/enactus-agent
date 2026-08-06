import { describe, expect, it } from "vitest";
import {
  buildQualificationLists,
  isDomainOrSubdomainOf,
  loadQualificationLists,
  lookupList,
  normalizeDomain,
  normalizeMunicipality,
  normalizeName,
  parseCsv,
  resolveGeography,
} from "../src/lib/qualification-lists";

const lists = loadQualificationLists();

describe("parseCsv", () => {
  it("reads a header row into keyed objects", () => {
    expect(parseCsv("a,b\n1,2\n3,4\n")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  const cases: [string, string, Record<string, string>[]][] = [
    ["quoted field with a comma", 'a,b\n"x, y",z\n', [{ a: "x, y", b: "z" }]],
    ["doubled quotes", 'a\n"he said ""hi"""\n', [{ a: 'he said "hi"' }]],
    ["embedded newline", 'a,b\n"line1\nline2",z\n', [{ a: "line1\nline2", b: "z" }]],
    ["CRLF line endings", "a,b\r\n1,2\r\n", [{ a: "1", b: "2" }]],
    ["missing trailing field", "a,b,c\n1,2\n", [{ a: "1", b: "2", c: "" }]],
    ["blank lines are skipped", "a\n1\n\n2\n", [{ a: "1" }, { a: "2" }]],
    ["empty input", "", []],
  ];

  it.each(cases)("handles %s", (_label, input, expected) => {
    expect(parseCsv(input)).toEqual(expected);
  });
});

describe("normalizeName — the §2.1 normalized_name contract", () => {
  const cases: [string, string][] = [
    ["MNP LLP", "mnp"],
    ["Always Beyond Corp.", "always beyond"],
    ["The Woods Spirit Co.", "the woods spirit"],
    // "corporation" is deliberately NOT in the legal-suffix set.
    ["Canadian Tire Corporation", "canadian tire corporation"],
    ["Jeanne Sauvé Foundation", "jeanne sauve foundation"],
    ["Baaad Anna's", "baaad annas"],
    ["Pandora's Locks", "pandoras locks"],
    ["skoah.", "skoah"],
    ["bäk'd", "bakd"],
    ["Greens & Beans", "greens and beans"],
    ["Ames Tile & Stone", "ames tile and stone"],
    ["rb GLOBAL", "rb global"],
    ["Co-operators", "co operators"],
    ["  Enactus   SFU  ", "enactus sfu"],
    ["", ""],
  ];

  it.each(cases)("normalizes %j to %j", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("never strips a suffix that is the entire name", () => {
    expect(normalizeName("Co")).toBe("co");
  });

  it("returns an empty string for null and undefined rather than throwing", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
  });
});

describe("normalizeDomain", () => {
  const cases: [string, string][] = [
    ["https://www.Example.CA/path?q=1", "example.ca"],
    ["WWW.EXAMPLE.CA.", "example.ca"],
    ["example.ca:8443", "example.ca"],
    ["//example.ca", "example.ca"],
    ["sponsorship@affinitycu.ca", "affinitycu.ca"],
    ["", ""],
  ];
  it.each(cases)("normalizes %j to %j", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });
});

describe("isDomainOrSubdomainOf", () => {
  it("matches the domain itself and any subdomain", () => {
    expect(isDomainOrSubdomainOf("sfu.ca", "sfu.ca")).toBe(true);
    expect(isDomainOrSubdomainOf("beedie.sfu.ca", "sfu.ca")).toBe(true);
  });

  it("does not match a domain that merely ends in the same letters", () => {
    expect(isDomainOrSubdomainOf("notsfu.ca", "sfu.ca")).toBe(false);
  });
});

describe("the shipped seed data", () => {
  it("loads every list named in report §7", () => {
    expect(lists.nationalPartner.entries.length).toBeGreaterThan(0);
    expect(lists.studentOrg.entries.length).toBeGreaterThan(0);
    expect(lists.paidMembership.entries.length).toBeGreaterThan(0);
    expect(lists.eduDomains.entries.length).toBeGreaterThan(0);
    expect(lists.govDomains.entries.length).toBeGreaterThan(0);
    expect(lists.self.entries.length).toBeGreaterThan(0);
    expect(lists.neverKillDomains.entries.length).toBeGreaterThan(0);
    expect(lists.parkingNameservers.entries.length).toBe(9);
    expect(lists.freeMailProviders.entries.length).toBeGreaterThan(0);
    expect(lists.disposableDomains.entries.length).toBeGreaterThan(0);
    expect(lists.currentAndPastSponsors.entries.length).toBeGreaterThan(0);
  });

  it("carries the national partners the report re-verified live on 2026-08-06", () => {
    for (const domain of [
      "td.com",
      "desjardins.com",
      "canadiantire.ca",
      "nbc.ca",
      "rbc.com",
      "jeannesauve.org",
      "alterna.ca",
      "capitalpower.com",
      "pcfinancial.ca",
      "mnp.ca",
      "thebsf.ca",
      "thorekscott.com",
      "zellerfamilyfoundation.ca",
      "alwaysbeyond.com",
      "ecclesiastical.ca",
    ]) {
      expect(lists.nationalPartner.domains.has(domain), `${domain} missing`).toBe(true);
    }
  });

  it("ships NONE of the two wrong-domain traps the report caught", () => {
    // rbcfoundation.com is Richard Bland College Foundation, a US community college.
    expect(lists.nationalPartner.domains.has("rbcfoundation.com")).toBe(false);
    // pcfinancial.com is parked on ns3.afternic.com.
    expect(lists.nationalPartner.domains.has("pcfinancial.com")).toBe(false);
    // mnp.com is a different organisation entirely.
    expect(lists.nationalPartner.domains.has("mnp.com")).toBe(false);
  });

  it("keeps varshneycapital.com off the national-partner list and on never-kill", () => {
    // The Varshney FAMILY FOUNDATION is a national donor; Varshney Capital Corp is a CURRENT
    // Enactus SFU partner, and they share a domain. A domain-level exclusion would destroy a
    // converted relationship, so the foundation is excluded by NAME only.
    expect(lists.nationalPartner.domains.has("varshneycapital.com")).toBe(false);
    expect(lists.nationalPartner.names.has("varshney family foundation")).toBe(true);
    expect(lists.neverKillDomains.domains.has("varshneycapital.com")).toBe(true);
  });

  it("puts PwC and Scotiabank on the review list, not the kill list", () => {
    expect(lists.nationalPartner.domains.has("pwc.com")).toBe(false);
    expect(lists.nationalFlag.domains.has("pwc.com")).toBe(true);
    expect(lists.nationalPartner.domains.has("scotiabank.com")).toBe(false);
    expect(lists.nationalFlag.domains.has("scotiabank.com")).toBe(true);
  });

  it("excludes AFP and the Veritas Foundation, which are not funders", () => {
    expect(lists.nationalPartner.domains.has("afpglobal.org")).toBe(false);
    expect(lists.nationalPartner.domains.has("theveritasfoundation.com")).toBe(false);
  });

  it("stores every name-kind row already normalised, so lookups are exact", () => {
    for (const list of [
      lists.nationalPartner,
      lists.nationalFlag,
      lists.studentOrg,
      lists.paidMembership,
      lists.self,
    ]) {
      for (const [key] of list.names) {
        expect(normalizeName(key), `${list.name} row "${key}" is not normalised`).toBe(key);
      }
    }
  });

  it("stores every domain-kind row already normalised", () => {
    for (const list of Object.values(lists)) {
      if (!list || typeof list !== "object" || !("domains" in list)) continue;
      for (const [key] of (list as { domains: Map<string, unknown> }).domains) {
        expect(normalizeDomain(key)).toBe(key);
      }
    }
  });

  it("drops rows whose value is a deliberate blank rather than wildcard-matching them", () => {
    const built = buildQualificationLists({
      "self.csv": "kind,value,entity\nname,,Unverified Entity\ndomain,,Unverified\n",
    });
    expect(built.self.entries).toHaveLength(0);
    expect(lookupList(built.self, null, "")).toBeNull();
  });

  it("carries all 23 Metro Vancouver member jurisdictions", () => {
    expect(lists.metroVancouver).toHaveLength(23);
  });

  it("keeps the City and District of North Vancouver as two distinct jurisdictions", () => {
    const shared = lists.metroVancouverAliases.get("north vancouver") ?? [];
    expect(shared).toContain("City of North Vancouver");
    expect(shared).toContain("District of North Vancouver");
    expect(shared).toHaveLength(2);
  });

  it("keeps the City and Township of Langley as two distinct jurisdictions", () => {
    const canonicals = lists.metroVancouver.map((j) => j.canonical);
    expect(canonicals).toContain("City of Langley");
    expect(canonicals).toContain("Township of Langley");
  });

  it("resolves the neighbourhood aliases the report enumerated verbatim", () => {
    const cases: [string, string][] = [
      ["Kitsilano", "City of Vancouver"],
      ["Gastown", "City of Vancouver"],
      ["Steveston", "City of Richmond"],
      ["Whalley", "City of Surrey"],
      ["Ladner", "City of Delta"],
      ["Fort Langley", "Township of Langley"],
      ["Deep Cove", "District of North Vancouver"],
      ["Horseshoe Bay", "District of West Vancouver"],
      ["UBC", "Electoral Area A"],
    ];
    for (const [alias, canonical] of cases) {
      expect(lists.metroVancouverAliases.get(normalizeMunicipality(alias)) ?? [], alias).toContain(
        canonical,
      );
    }
  });

  it("pre-seeds cannabis, tobacco and vaping as prohibited ON STATUTE", () => {
    for (const sector of ["cannabis", "tobacco", "vaping"]) {
      const row = lists.sectorPolicy.find((r) => r.sector === sector);
      expect(row?.policy, sector).toBe("prohibited");
      expect(row?.decidedBy, sector).toMatch(/Act/);
    }
  });

  it("pre-seeds alcohol as ALLOWED, because the club already made that decision", () => {
    expect(lists.sectorPolicy.find((r) => r.sector === "alcohol")?.policy).toBe("allowed");
  });

  it("leaves the seven values-call sectors deliberately undecided", () => {
    for (const sector of [
      "gambling",
      "payday_lending",
      "crypto_forex",
      "mlm",
      "adult_entertainment",
      "firearms",
      "political",
    ]) {
      expect(lists.sectorPolicy.find((r) => r.sector === sector)?.policy, sector).toBe(
        "needs_decision",
      );
    }
  });

  // sector-policy.csv is edited by the VP External Relations, not by a programmer. A pattern that
  // will not compile has to fail once, at load, naming the row — not once per account, from deep
  // inside the penalty pass, with a bare SyntaxError.
  describe("sector-policy patterns are validated at load", () => {
    const header = "sector,naics,pattern,policy,decided_by,decided_at,note\n";

    function build(rows: string) {
      return buildQualificationLists({ "sector-policy.csv": header + rows });
    }

    it("rejects an unbalanced pattern and names the offending row", () => {
      expect(() => build("payday_lending,,payday(,needs_decision,,,\n")).toThrow(
        /sector-policy\.csv row "payday_lending"/,
      );
      expect(() => build("payday_lending,,payday(,needs_decision,,,\n")).toThrow(/payday\(/);
    });

    it("rejects an invalid quantifier", () => {
      expect(() => build('gambling,,"casino{2,1}",needs_decision,,,\n')).toThrow(
        /sector-policy\.csv row "gambling"/,
      );
    });

    it("compiles a valid pattern once, case-insensitively", () => {
      const row = build("gambling,,casino|betting,needs_decision,,,\n").sectorPolicy[0];
      expect(row.regex).toBeInstanceOf(RegExp);
      expect(row.regex?.test("Riverside CASINO Ltd")).toBe(true);
      expect(row.regex?.test("Riverside Bakery")).toBe(false);
    });

    it("leaves a deliberately blank pattern as null rather than the match-everything regex", () => {
      const row = build("adult_entertainment,7139,,needs_decision,,,\n").sectorPolicy[0];
      expect(row.regex).toBeNull();
      // The shipped file relies on this: adult_entertainment has no enumerated detection.
      expect(lists.sectorPolicy.find((r) => r.sector === "adult_entertainment")?.regex).toBeNull();
    });

    it("accepts the shipped file", () => {
      for (const row of lists.sectorPolicy) {
        expect(row.pattern === "" ? row.regex === null : row.regex instanceof RegExp, row.sector).toBe(
          true,
        );
      }
    });
  });
});

// ===========================================================================
// The shared geography verdict. NOT-RECOGNISED MEANS ABSENT, in every branch and every field —
// the property that keeps a spelling from costing a real prospect its band or its place.
// ===========================================================================

describe("resolveGeography · an unrecognised value behaves exactly as an omitted one", () => {
  // A deliberately wide parameter type: a postal code passed here must be INERT, and the point
  // of the assertion below is that GeographyFacts does not carry it at all.
  function band(facts: Record<string, string | undefined>) {
    return resolveGeography(facts, lists).band;
  }

  it.each([
    ["region", { municipality: "Burnaby", region: "Freedonia" }, { municipality: "Burnaby" }],
    ["country", { municipality: "Burnaby", country: "  " }, { municipality: "Burnaby" }],
    [
      "region on a row with a country",
      { municipality: "Burnaby", region: "Ruritania", country: "CA" },
      { municipality: "Burnaby", country: "CA" },
    ],
    ["municipality", { region: "BC", municipality: "Nowheresville" }, { region: "BC" }],
  ])("resolves identically whether an unrecognised %s is present or omitted", (_f, present, omitted) => {
    expect(band(present)).toBe(band(omitted));
  });

  it("never reads the token CA as anything but Canada", () => {
    expect(band({ municipality: "Vancouver", region: "CA", country: "CA" })).toBe("metro_vancouver");
    expect(resolveGeography({ country: "CA" }, lists).evidence.country).toBe("known");
    // As a REGION, "CA" is not a Canadian province, so it is unknown — never California.
    expect(resolveGeography({ region: "CA" }, lists).evidence.region).toBe("unknown");
  });

  // Report §8 rejected FSA-prefix geography in writing, and a coarse V3-V7 set proved it: V3G
  // and V4X are Abbotsford, not Metro Vancouver. A postal code must move nothing.
  // THE DISTRICT IS READ IN BOTH DIRECTIONS. `V` supports British Columbia and any other
  // ASSIGNED district contradicts it, because the mapping is exhaustive and unambiguous. Read
  // only permissively, an Ottawa postal code left a colliding `Richmond` alias scoring metro.
  it.each([
    ["K0A 2Z0", "Ottawa area, Ontario"],
    ["M5V 1A1", "Toronto, Ontario"],
    ["J0B 2H0", "Richmond, Quebec"],
    ["T2P 1J9", "Calgary, Alberta"],
    ["B3H 4R2", "Halifax, Nova Scotia"],
  ])("reads %s (%s) as contrary evidence against British Columbia", (postal) => {
    expect(resolveGeography({ postal_code: postal }, lists).evidence.region).toBe("contrary");
    // And it therefore overrules a colliding municipality alias rather than supporting it.
    expect(band({ municipality: "Richmond", postal_code: postal })).toBe("canada_other");
    expect(band({ municipality: "Delta", postal_code: postal })).toBe("canada_other");
  });

  it("still reads a V district as British Columbia, and never as membership", () => {
    expect(resolveGeography({ postal_code: "V5A 1S6" }, lists).evidence.region).toBe("known");
    expect(band({ municipality: "Burnaby", postal_code: "V5A 1S6" })).toBe("metro_vancouver");
    // V3G is Abbotsford: the district places the province, never the municipality.
    expect(band({ municipality: "Abbotsford", postal_code: "V3G 2J5" })).toBe("bc_other");
  });

  // D, F, I, O, Q, U, W and Z are unassigned, so a format match on one is not a Canadian postal
  // code — it decides neither the country nor the province.
  it.each(["D1D 1D1", "F1F 1F1", "O1O 1O1", "Z1Z 1Z1"])(
    "treats the unassigned district in %s as no evidence at all",
    (postal) => {
      const verdict = resolveGeography({ municipality: "Burnaby", postal_code: postal }, lists);
      expect(verdict).toEqual(resolveGeography({ municipality: "Burnaby" }, lists));
      expect(verdict.evidence.country).toBe("unknown");
      expect(verdict.evidence.region).toBe("unknown");
    },
  );

  // A postal code is read ONLY for its country and province FORMAT — a Canadian postal code
  // says Canada, and the V district says British Columbia. It never decides Metro Vancouver
  // MEMBERSHIP: report §8 rejected FSA-prefix geography, and V3G/V4X are Abbotsford.
  it("reads a postal code for province, never for membership", () => {
    const withPostal = { municipality: "Abbotsford", region: "BC", postal_code: "V3G 2J5" };
    expect(band(withPostal)).toBe("bc_other");
    expect(band(withPostal)).toBe(band({ municipality: "Abbotsford", region: "BC" }));
    // The V district is British Columbia, and that is all it says.
    expect(band({ postal_code: "V5A 1S6" })).toBe("bc_other");
    expect(band({ municipality: "Abbotsford", postal_code: "V3G 2J5" })).toBe("bc_other");
    // A malformed postal decides nothing at all.
    expect(band({ postal_code: "not a postal code" })).toBe("unresolved");
  });

  // THE PROPERTY, not an example of it: for EVERY field, present-but-unrecognised must return an
  // object EQUAL to omitted. Two rounds achieved never-a-kill and still diverged on the band,
  // which is how the drift kept recurring — so this asserts deep equality of the whole verdict.
  it.each([
    ["country", "country", "Freedonia"],
    ["country", "country", "British Columbia"],
    ["region", "region", "Freedonia"],
    ["region", "region", "WA"],
    ["municipality", "municipality", "Nowheresville"],
    ["postal_code", "postal_code", "not-a-postal-code"],
  ])("an unrecognised %s resolves to the IDENTICAL verdict as an omitted one", (_l, field, value) => {
    const rows: Record<string, string | undefined>[] = [
      { municipality: "Burnaby", region: "BC", country: "CA" },
      { municipality: "Burnaby" },
      { region: "ON", country: "CA" },
      {},
    ];
    for (const row of rows) {
      const omitted = { ...row, [field]: undefined };
      const present = { ...row, [field]: value };
      expect(resolveGeography(present, lists), `${field}=${value} on ${JSON.stringify(row)}`).toEqual(
        resolveGeography(omitted, lists),
      );
    }
  });

  it("puts every band a Canadian row can reach outside the kill path", () => {
    for (const facts of [
      { municipality: "Burnaby", region: "BC", country: "CA" },
      { municipality: "Abbotsford", region: "BC", country: "CA" },
      { municipality: "Toronto", region: "ON", country: "CA" },
      { country: "CA" },
      {},
    ]) {
      expect(band(facts)).not.toBe("outside_canada");
    }
    expect(band({ municipality: "Seattle", region: "WA", country: "US" })).toBe("outside_canada");
  });
});

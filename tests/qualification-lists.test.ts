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

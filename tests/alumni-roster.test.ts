import { describe, test, expect } from "vitest";
import {
  academicYearOfCapture,
  academicYearOfLabel,
  acceptEntry,
  applyRemovals,
  carriesContactDetail,
  compressYears,
  csvCell,
  findNearDuplicates,
  isPlausiblePersonName,
  isPlausibleRole,
  mergeSightings,
  nameKey,
  normaliseNameCase,
  parseAlumniBusinessOwners,
  parseCollapseomatic,
  parseCompetitionCoaches,
  parseEmployeeCards,
  parseNextTeam,
  parseRemovalList,
  parseSpotlightName,
  parseSquarespaceTeam,
  parseStrongThenRole,
  parseWixTeam,
  parseWixTeamYear,
  parseWordpressRoster,
  toCsv,
  type Sighting,
} from "../scripts/alumni-roster/parse.ts";

/**
 * Fixtures are trimmed from the real archived pages. Each keeps the contact
 * detail the original carried, because the point of most of these tests is that
 * the parser leaves it behind.
 */

const sighting = (over: Partial<Sighting> = {}): Sighting => ({
  name: "Rajin Shokar",
  role: "President",
  year: "2016-17",
  sourceUrl: "https://web.archive.org/web/20161106125533id_/http://enactussfu.com/executives/",
  capturedAt: "2026-08-06",
  confidence: "high",
  ...over,
});

describe("privacy guards", () => {
  test("an email address is a contact detail", () => {
    expect(carriesContactDetail("president@sifesimonfraser.com")).toBe(true);
  });

  test("Wayback's own redaction marker is treated as a contact detail", () => {
    expect(carriesContactDetail("*protected email*")).toBe(true);
  });

  test.each(["778 782 3475", "+1 (604) 555-0123", "https://linkedin.com/in/someone", "www.example.ca"])(
    "%s is a contact detail",
    (value) => {
      expect(carriesContactDetail(value)).toBe(true);
    },
  );

  test("a name and a role are not", () => {
    expect(carriesContactDetail("Xinyan Chen")).toBe(false);
    expect(carriesContactDetail("Director of External Relations")).toBe(false);
  });

  test("a candidate carrying contact detail is dropped, not cleaned up and kept", () => {
    expect(acceptEntry("Benjamin Che", "President — president@sifesimonfraser.com")).toBeNull();
  });
});

describe("field validation", () => {
  test.each(["Xinyan Chen", "Cody de Leijer", "Wayne Yan Muk", "Patty Rattanaleelart"])(
    "%s reads as a person",
    (value) => {
      expect(isPlausiblePersonName(value)).toBe(true);
    },
  );

  test.each([
    ["Ak", "a single token is not a full name"],
    ["Our Team", "a section heading is not a person"],
    ["Core Operations", "a roster section is not a person"],
    ["Anne Marie de la Cruz Fernandez", "five tokens is a sentence, not a name"],
    ["", "nothing is not a name"],
  ])("%s is rejected (%s)", (value) => {
    expect(isPlausiblePersonName(value)).toBe(false);
  });

  test("a role may carry punctuation but not an essay", () => {
    expect(isPlausibleRole("VP Finance & External Relations")).toBe(true);
    expect(isPlausibleRole("Co-PM of Second Savour")).toBe(true);
    expect(isPlausibleRole("x".repeat(81))).toBe(false);
  });

  test("one comma is a role; two make it a list of people", () => {
    expect(isPlausibleRole("VP Finance, External")).toBe(true);
    expect(isPlausibleRole("Zamling Sherpa, Yogya Agrawal, Eva Chan")).toBe(false);
  });

  test("ALL CAPS is title-cased; other casing is left exactly as published", () => {
    expect(normaliseNameCase("ANDREW MA")).toBe("Andrew Ma");
    expect(normaliseNameCase("Cody de Leijer")).toBe("Cody de Leijer");
    expect(normaliseNameCase("GURANSH  GILL")).toBe("Guransh Gill");
  });

  test("the dedup key ignores case, accents and punctuation", () => {
    expect(nameKey("Cédric Tanafranca")).toBe(nameKey("cedric  tanafranca"));
    expect(nameKey("Cody de Leijer")).not.toBe(nameKey("Cody de Leijeru"));
  });
});

describe("academic year", () => {
  test("a September capture belongs to the year that starts then", () => {
    expect(academicYearOfCapture("20130903210222")).toBe("2013-14");
  });

  test("a February capture belongs to the year that started the previous August", () => {
    expect(academicYearOfCapture("20150214190309")).toBe("2014-15");
  });

  test("August is the boundary", () => {
    expect(academicYearOfCapture("20180731235959")).toBe("2017-18");
    expect(academicYearOfCapture("20180801000000")).toBe("2018-19");
  });

  test("the century rolls over without producing 2099-100", () => {
    expect(academicYearOfCapture("20990901000000")).toBe("2099-00");
  });

  test("a timestamp that is not a Wayback stamp is an error, not a guess", () => {
    expect(() => academicYearOfCapture("2013")).toThrow(/14-digit/);
  });

  test.each([
    ["President 2004/2005", "2004-05"],
    ["MEET OUR 2022/2023 TEAM", "2022-23"],
    ["2018-2019", "2018-19"],
  ])("%s reads as %s", (label, expected) => {
    expect(academicYearOfLabel(label)).toBe(expected);
  });

  test("a lone year stays a lone year rather than being widened into a term", () => {
    expect(academicYearOfLabel("Founded organization in 1991")).toBe("1991");
  });

  test("prose with no year at all yields nothing", () => {
    expect(academicYearOfLabel("Co-Founder of Quikpiq")).toBeNull();
  });
});

describe("the 2012 collapseomatic theme", () => {
  const html = `
    <div class="post-content page-content">
    <p><span class="collapseomatic " id="id6362" title="Benjamin Che, President">Benjamin Che, President</span>
    <div id="target-id6362" class="collapseomatic_content "><strong>Email: president@sifesimonfraser.com</strong></div>
    <p><span class="collapseomatic " id="id7302" title="Xinyan Chen, Director of External Relations">Xinyan Chen, Director of External Relations</span>
    <div id="target-id7302" class="collapseomatic_content "><strong>Email: external.relations@sifesimonfraser.com</strong></div>
    </div>`;

  test("reads the name and role out of the entry title", () => {
    expect(parseCollapseomatic(html)).toEqual([
      { name: "Benjamin Che", role: "President" },
      { name: "Xinyan Chen", role: "Director of External Relations" },
    ]);
  });

  test("the role address in the collapsed sibling never reaches a field", () => {
    const flat = JSON.stringify(parseCollapseomatic(html));
    expect(flat).not.toContain("@");
    expect(flat).not.toContain("sifesimonfraser");
  });

  test("a role containing a comma survives the split", () => {
    expect(
      parseCollapseomatic(`<span class="collapseomatic" title="Guransh Gill, VP Finance, External">x</span>`),
    ).toEqual([{ name: "Guransh Gill", role: "VP Finance, External" }]);
  });
});

describe("the 2013 strong-then-role theme", () => {
  const html = `
    <div class="one_third">
    <p><img src="/x.jpg" /><br />
    <strong>Lara Ahmad</strong><br />
    President<br />
    <script type="text/javascript">var ml="obfuscated address";</script><noscript>*protected email*</noscript></p>
    <p><strong>Jason Manoharan</strong><br />
    Director of Program Development<br />
    <noscript>*protected email*</noscript></p>
    </div>`;

  test("reads the pair and leaves the obfuscated address behind", () => {
    expect(parseStrongThenRole(html)).toEqual([
      { name: "Lara Ahmad", role: "President" },
      { name: "Jason Manoharan", role: "Director of Program Development" },
    ]);
  });
});

describe("the 2015 employee-card theme", () => {
  const html = `
    <li class="mk-employee-item"><div class="team-info-wrapper">
    <span class="team-member-name">Rajin Shokar</span><span class="team-member-position">President</span>
    <ul class="mk-employeee-networks"><li><noscript>*protected email*</noscript></li></ul>
    </div></li>
    <li class="mk-employee-item"><div class="team-info-wrapper">
    <span class="team-member-name">Tarah Domingo</span><span class="team-member-position">Director of External Relations</span>
    </div></li>`;

  test("pairs the name span with the position span", () => {
    expect(parseEmployeeCards(html)).toEqual([
      { name: "Rajin Shokar", role: "President" },
      { name: "Tarah Domingo", role: "Director of External Relations" },
    ]);
  });

  test("the dispatcher picks the theme the page actually uses", () => {
    expect(parseWordpressRoster(html)).toEqual(parseEmployeeCards(html));
    expect(
      parseWordpressRoster(`<span class="collapseomatic" title="Benjamin Che, President">x</span>`),
    ).toEqual([{ name: "Benjamin Che", role: "President" }]);
  });

  test("a page with no roster on it yields nothing rather than guessing", () => {
    expect(parseWordpressRoster("<p>Alumni are an extremely valuable part of the club.</p>")).toEqual([]);
  });
});

describe("the 2012 alumni page", () => {
  const html = `
    <h2>Enactus SFU Alumni Business Owners</h2>
    <ul>
    <li><strong>Jade Bourelle</strong> &#8211; Founded organization in 1991. President and Chief Executive Officer of Talent Technology Corporation</li>
    <li><strong>Minna Van</strong> &#8211; President 2004/2005. Co-Founder of Atomic Media and The Network Hub</li>
    <li><strong>Anoop Aulakh</strong> &#8211; President 2009/2010. Co-Founder of Quikpiq.</li>
    </ul>
    <h2>Enactus SFU Alumni Network</h2>
    <p>please let us know by emailing <a href="mailto:community@enactussfu.com">community@enactussfu.com</a></p>`;

  test("recovers the pre-2012 presidents the exec pages never covered", () => {
    expect(parseAlumniBusinessOwners(html)).toEqual([
      { name: "Jade Bourelle", role: "Founded organization", year: "1991" },
      { name: "Minna Van", role: "President", year: "2004-05" },
      { name: "Anoop Aulakh", role: "President", year: "2009-10" },
    ]);
  });

  test("the employer named in the same sentence is never read", () => {
    const flat = JSON.stringify(parseAlumniBusinessOwners(html));
    expect(flat).not.toContain("Talent Technology");
    expect(flat).not.toContain("Atomic Media");
    expect(flat).not.toContain("Quikpiq");
  });

  test("the network call-to-action below is not a roster and yields nobody", () => {
    expect(parseAlumniBusinessOwners(`<h2>Enactus SFU Alumni Network</h2><p>email us</p>`)).toEqual([]);
  });
});

describe("the Wix our-team page", () => {
  const html = `
    <p class="font_5"><span>MEET OUR 2022/2023 TEAM</span></p>
    <p class="font_5"><span>ANDREW MA</span></p>
    <p class="font_8"><span>President</span></p>
    <p class="font_5"><span>GURANSH GILL</span></p>
    <p class="font_8"><span>VP of Finance and External Relations</span></p>`;

  test("pairs an ALL CAPS run with the run after it", () => {
    expect(parseWixTeam(html)).toEqual([
      { name: "Andrew Ma", role: "President" },
      { name: "Guransh Gill", role: "VP of Finance and External Relations" },
    ]);
  });

  test("prefers the year the page declares over the capture date", () => {
    expect(parseWixTeamYear(html)).toBe("2022-23");
    expect(parseWixTeamYear("<p>no year here</p>")).toBeNull();
  });
});

describe("the Squarespace the-team page", () => {
  /** Squarespace serves the cards as entity-encoded JSON on an attribute. */
  const context = (payload: unknown) =>
    JSON.stringify(payload).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  const html = `<ul data-current-context="${context({
    userItems: [
      { title: "Sandra Chen", description: "<p>President</p>", imageId: "64b0", authorId: "64af" },
      { title: "Justin Brower", description: "<p>Director of Finance</p>", filename: "Screen Shot.jpg" },
    ],
  })}" >`;

  test("reads the name and role out of the card payload", () => {
    expect(parseSquarespaceTeam(html)).toEqual([
      { name: "Sandra Chen", role: "President" },
      { name: "Justin Brower", role: "Director of Finance" },
    ]);
  });

  test("the image filenames and author ids in the same payload are not read", () => {
    const flat = JSON.stringify(parseSquarespaceTeam(html));
    expect(flat).not.toContain("Screen Shot");
    expect(flat).not.toContain("64af");
  });

  test("the project-member list on the same page yields nothing", () => {
    // A project name paired with a comma-run of members — and the source runs
    // some of those names together, so splitting them would be guesswork.
    const members = `<ul data-current-context="${context({
      userItems: [
        {
          title: "Himalayan Skyes",
          description: "<p>Zamling Sherpa, Yogya Agrawal, Ethan ChanMarianne Li, Eva Chan</p>",
        },
      ],
    })}" >`;

    expect(parseSquarespaceTeam(members)).toEqual([]);
  });

  test("an attribute that is not the card payload is skipped without throwing", () => {
    expect(parseSquarespaceTeam(`<div data-current-context="not json at all" >`)).toEqual([]);
  });
});

describe("the current team page", () => {
  const html = `
    <h2 class="text-primary-yellow">Core Operations<!-- --> </h2>
    <a href="https://www.linkedin.com/in/naia-wong/" target="_blank"><div></div></a>
    <img alt="Naia Wong" src="/naia.jpg"/>
    <h3> <!-- -->Naia Wong<!-- --> </h3><p class="text-white opacity-[70%]">President</p>
    <a href="https://www.linkedin.com/in/caleb-wu/"><div></div></a>
    <h3> <!-- -->Caleb Wu<!-- --> </h3><p class="text-white opacity-[70%]">Director of Web &amp; Tech</p>`;

  test("reads the card heading and the role beneath it", () => {
    expect(parseNextTeam(html)).toEqual([
      { name: "Naia Wong", role: "President" },
      { name: "Caleb Wu", role: "Director of Web & Tech" },
    ]);
  });

  test("the LinkedIn URL on the card is not recorded and not followed", () => {
    expect(JSON.stringify(parseNextTeam(html))).not.toContain("linkedin");
  });

  test("the section heading above the cards is not mistaken for a person", () => {
    expect(parseNextTeam(html).map((e) => e.name)).not.toContain("Core Operations");
  });
});

describe("the competition page", () => {
  const html = `
    <h5 class="text-primary-yellow"> 2026 </h5><h1> Regionals </h1>
    <h3>Presenters: Ak, Francesca</h3><h3>Designer: Neal Sison</h3>
    <h3>Coaches: Brandon Xu, David Guo, Eva Yueng</h3>
    <h5 class="text-primary-yellow"> 2025 </h5><h1> Nationals </h1>
    <h3>Coaches: Sam Thiara, Vinay Aery</h3>
    <h3>Coaches: Daniel Furlot &amp; Tim MacDougall</h3>`;

  test("attributes each coach to the season under the heading above them", () => {
    expect(parseCompetitionCoaches(html)).toEqual([
      { name: "Brandon Xu", role: "Competition coach", year: "2025-26" },
      { name: "David Guo", role: "Competition coach", year: "2025-26" },
      { name: "Eva Yueng", role: "Competition coach", year: "2025-26" },
      { name: "Sam Thiara", role: "Competition coach", year: "2024-25" },
      { name: "Vinay Aery", role: "Competition coach", year: "2024-25" },
      { name: "Daniel Furlot", role: "Competition coach", year: "2024-25" },
      { name: "Tim MacDougall", role: "Competition coach", year: "2024-25" },
    ]);
  });

  test("presenters and designers on the same page are not coaches and are not taken", () => {
    const names = parseCompetitionCoaches(html).map((e) => e.name);
    expect(names).not.toContain("Neal Sison");
    expect(names).not.toContain("Francesca");
  });

  test("coaches listed before any year heading are dropped rather than dated by guess", () => {
    expect(parseCompetitionCoaches(`<h3>Coaches: Brandon Xu</h3>`)).toEqual([]);
  });
});

describe("community spotlight posts", () => {
  test.each([
    [`<title>Community Spotlight: Maria Sandjaja - Enactus Alumni | Enactus SFU</title>`, "Maria Sandjaja"],
    [`<title>Community Spotlight: Sabaina Saif &#8211; Enactus Alumni | Enactus SFU</title>`, "Sabaina Saif"],
    [`<title itemprop="name">Community Spotlight: Ivy So - SIFE Alumni | Enactus SFU</title>`, "Ivy So"],
    [`<title>Enactus SFU - Community Spotlight: Anoop Aulakh - Enactus Alumni</title>`, "Anoop Aulakh"],
    [`<h1 class="t">Community Spotlight: Elliot Lobo &#8211; Enactus Alumni</h1>`, "Elliot Lobo"],
  ])("recovers the name from %s", (html, expected) => {
    expect(parseSpotlightName(html)).toBe(expected);
  });

  test("a post that is not a spotlight yields nothing", () => {
    expect(parseSpotlightName(`<title>ACE 2012 Regional Exposition Results | Enactus SFU</title>`)).toBeNull();
  });
});

describe("year spans", () => {
  test("consecutive years collapse into a run", () => {
    expect(compressYears(["2015-16", "2016-17", "2017-18"])).toBe("2015-16..2017-18");
  });

  test("a break in service is kept, not smoothed over", () => {
    expect(compressYears(["2022-23", "2025-26", "2026-27"])).toBe("2022-23;2025-26..2026-27");
  });

  test("repeated sightings of one year collapse to that year", () => {
    expect(compressYears(["2016-17", "2016-17"])).toBe("2016-17");
  });

  test("a source that stated no year contributes nothing rather than a blank run", () => {
    expect(compressYears(["", "2016-17", ""])).toBe("2016-17");
    expect(compressYears(["", ""])).toBe("");
  });
});

describe("merging sightings into people", () => {
  test("one row per person, not one per snapshot", () => {
    const rows = mergeSightings([
      sighting({ year: "2015-16" }),
      sighting({ year: "2016-17" }),
      sighting({ year: "2016-17" }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].yearsActive).toBe("2015-16..2016-17");
    expect(rows[0].role).toBe("President");
  });

  test("a person who held two roles keeps both, each with its own years", () => {
    const [row] = mergeSightings([
      sighting({ role: "Director of Program Innovation", year: "2015-16", sourceUrl: "u1" }),
      sighting({ role: "President", year: "2016-17", sourceUrl: "u2" }),
    ]);

    expect(row.role).toBe("Director of Program Innovation (2015-16); President (2016-17)");
    expect(row.yearsActive).toBe("2015-16..2016-17");
    expect(row.sourceUrl).toBe("u1 | u2");
  });

  test("a single distinct capture date is written once, not repeated per role", () => {
    const [row] = mergeSightings([
      sighting({ role: "Director", year: "2015-16" }),
      sighting({ role: "President", year: "2016-17" }),
    ]);

    expect(row.capturedAt).toBe("2026-08-06");
  });

  test("the strongest sighting sets the confidence — one direct read establishes a name", () => {
    const [row] = mergeSightings([
      sighting({ role: "", year: "", confidence: "low" }),
      sighting({ confidence: "high" }),
    ]);

    expect(row.confidence).toBe("high");
  });

  test("a source that states no role drops out once another states one", () => {
    const [row] = mergeSightings([
      sighting({ name: "Anoop Aulakh", role: "", year: "", confidence: "low", sourceUrl: "spotlight" }),
      sighting({ name: "Anoop Aulakh", role: "President", year: "2009-10", sourceUrl: "alumni" }),
    ]);

    expect(row.role).toBe("President");
    expect(row.sourceUrl).toBe("alumni");
  });

  test("a person known only from a source that states no role still gets a row", () => {
    const [row] = mergeSightings([
      sighting({ name: "Ivy So", role: "", year: "", confidence: "low", sourceUrl: "spotlight" }),
    ]);

    expect(row).toMatchObject({ name: "Ivy So", role: "", yearsActive: "", confidence: "low" });
  });

  test("names differing only in case or accent are the same person", () => {
    expect(mergeSightings([sighting({ name: "ANDREW MA" }), sighting({ name: "Andrew Ma" })])).toHaveLength(1);
  });

  test("rows come out sorted by name", () => {
    const rows = mergeSightings([sighting({ name: "Zahra Hirji" }), sighting({ name: "Adam Paroo" })]);
    expect(rows.map((r) => r.name)).toEqual(["Adam Paroo", "Zahra Hirji"]);
  });
});

describe("removal requests", () => {
  test("reads one name per line and ignores comments and blanks", () => {
    const removed = parseRemovalList("# people who asked\n\nMinna Van\nIvy So  # asked 2026-08\n");
    expect(removed).toEqual(new Set([nameKey("Minna Van"), nameKey("Ivy So")]));
  });

  test("an empty list removes nobody", () => {
    expect(parseRemovalList("# nobody yet\n").size).toBe(0);
  });

  test("every sighting of a removed person goes, not just the one that names them best", () => {
    const kept = applyRemovals(
      [
        sighting({ name: "Minna Van", role: "President", year: "2004-05" }),
        sighting({ name: "Minna Van", role: "", year: "", confidence: "low" }),
        sighting({ name: "Rajin Shokar" }),
      ],
      parseRemovalList("Minna Van"),
    );

    expect(kept.map((s) => s.name)).toEqual(["Rajin Shokar"]);
  });

  test("a request written in a different case or with punctuation still lands", () => {
    const removed = parseRemovalList("MINNA  VAN");
    expect(applyRemovals([sighting({ name: "Minna Van" })], removed)).toEqual([]);
  });

  test("removal happens before the merge, so the person cannot survive as a row", () => {
    const kept = applyRemovals(
      [sighting({ name: "Minna Van" }), sighting({ name: "Andrew Ma" })],
      parseRemovalList("Minna Van"),
    );

    expect(mergeSightings(kept).map((r) => r.name)).toEqual(["Andrew Ma"]);
  });
});

describe("near duplicates", () => {
  test("a one-character difference is reported, not merged", () => {
    const rows = mergeSightings([
      sighting({ name: "Tim MacDougal" }),
      sighting({ name: "Tim MacDougall" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(findNearDuplicates(rows)).toEqual([["Tim MacDougal", "Tim MacDougall"]]);
  });

  test("two genuinely different people are not reported", () => {
    const rows = mergeSightings([sighting({ name: "Kevin Huang" }), sighting({ name: "Wendy Huang" })]);
    expect(findNearDuplicates(rows)).toEqual([]);
  });
});

describe("csv", () => {
  test("a cell containing a comma or a quote is quoted", () => {
    expect(csvCell("Director of Finance")).toBe("Director of Finance");
    expect(csvCell('VP Finance, External')).toBe('"VP Finance, External"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  test("the header row is the shape the pipeline expects", () => {
    const csv = toCsv(mergeSightings([sighting()]));
    expect(csv.split("\n")[0]).toBe("name,role,years_active,source_url,captured_at,confidence");
  });

  test("every row carries a source URL and a capture date", () => {
    const csv = toCsv(mergeSightings([sighting(), sighting({ name: "Ivy So", role: "", year: "" })]));
    for (const line of csv.trim().split("\n").slice(1)) {
      const cells = line.split(",");
      expect(cells[3]).toMatch(/^http/);
      expect(cells[4]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

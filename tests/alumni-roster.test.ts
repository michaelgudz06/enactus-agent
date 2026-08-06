import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import {
  academicYearOfCapture,
  academicYearOfLabel,
  acceptEntry,
  applyRemovals,
  carriesContactDetail,
  compressYears,
  coverageByYear,
  csvCell,
  expandYears,
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
  parseRosterCsv,
  parseSourceRegistry,
  parseSpotlightName,
  parseSquarespaceTeam,
  parseStrongThenRole,
  parseWixTeam,
  parseWixTeamYear,
  parseWordpressRoster,
  refreshCoverageClaims,
  sourceOfCacheFile,
  toCsv,
  type Sighting,
} from "../scripts/alumni-roster/parse.ts";

/**
 * Fixtures are trimmed from the real archived pages. Each keeps the contact
 * detail the original carried, because the point of most of these tests is that
 * the parser leaves it behind.
 */

/**
 * The build script, run the way a student runs it, against a two-name cache.
 * `removals: null` means the removal list is not there at all — the case a
 * deleted or renamed `removed.txt` produces, which must never pass silently.
 */
const BUILD_SCRIPT = fileURLToPath(new URL("../scripts/alumni-roster/build.ts", import.meta.url));
const CACHED_PAGE = "team-20260114044549.html";
const CACHED_URL = "https://web.archive.org/web/20260114044549id_/https://www.enactussfu.ca/team";
const CACHED_HTML = `
  <h3> <!-- -->Naia Wong<!-- --> </h3><p class="text-white opacity-[70%]">President</p>
  <h3> <!-- -->Caleb Wu<!-- --> </h3><p class="text-white opacity-[70%]">Director of Web &amp; Tech</p>`;

/** A competition page the club redesigned: it downloads fine and holds no roster. */
const REDESIGNED_PAGE = "competition-20260114044549.html";
const REDESIGNED_URL =
  "https://web.archive.org/web/20260114044549id_/https://www.enactussfu.ca/competition";
const REDESIGNED_HTML = `<h5 class="text-primary-yellow"> 2026 </h5><h1> Regionals </h1>`;

const STRAY_PAGE = "faculty-advisors-20130205151700.html";
const STRAY_ROW =
  "faculty\tarchived\tfaculty-advisors\tenactussfu.com/faculty-advisors/\thttp://enactussfu.com/faculty-advisors/\t-";
const TEAM_ROW = "team\tarchived\tteam\twww.enactussfu.ca/team\thttps://www.enactussfu.ca/team\t-";
const COMPETITION_ROW =
  "competition\tarchived\tcompetition\twww.enactussfu.ca/competition\thttps://www.enactussfu.ca/competition\t-";

function runBuild({
  removals = "# nobody yet\n",
  unrecordedPage = false,
  emptySource = false,
  strayPage = false,
  expectedEmpty = null,
  registry = null,
  registryMissing = false,
  seed = null,
}: {
  removals?: string | null;
  unrecordedPage?: boolean;
  emptySource?: boolean;
  strayPage?: boolean;
  expectedEmpty?: string | null;
  registry?: string | null;
  registryMissing?: boolean;
  seed?: string | null;
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "alumni-roster-"));
  const cacheDir = path.join(root, "cache");
  const outDir = path.join(root, "alumni");
  mkdirSync(cacheDir);
  mkdirSync(outDir);

  writeFileSync(path.join(cacheDir, CACHED_PAGE), CACHED_HTML);
  let manifest = `${CACHED_PAGE}\t${CACHED_URL}\n`;
  if (emptySource) {
    writeFileSync(path.join(cacheDir, REDESIGNED_PAGE), REDESIGNED_HTML);
    manifest += `${REDESIGNED_PAGE}\t${REDESIGNED_URL}\n`;
  }
  if (strayPage) {
    // Downloaded, recorded, readable — and belonging to no declared source.
    writeFileSync(path.join(cacheDir, STRAY_PAGE), CACHED_HTML);
    manifest += `${STRAY_PAGE}\thttps://web.archive.org/web/20130205151700id_/http://enactussfu.com/faculty-advisors/\n`;
  }
  writeFileSync(path.join(cacheDir, "manifest.tsv"), manifest);
  if (unrecordedPage) writeFileSync(path.join(cacheDir, "team-20260301000000.html"), CACHED_HTML);
  if (removals !== null) writeFileSync(path.join(outDir, "removed.txt"), removals);
  if (expectedEmpty !== null) {
    writeFileSync(path.join(outDir, "expected-empty-sources.txt"), expectedEmpty);
  }

  // The registry declares exactly the pages this cache holds, so the fixture
  // exercises the gates rather than tripping over sources it never fetched.
  const registryPath = path.join(root, "sources.tsv");
  const rows = registry ?? [TEAM_ROW, ...(emptySource ? [COMPETITION_ROW] : [])].join("\n");
  if (!registryMissing) writeFileSync(registryPath, `# fixture registry\n${rows}\n`);

  const outFile = path.join(outDir, "past-executives.csv");
  if (seed !== null) writeFileSync(outFile, seed);

  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", BUILD_SCRIPT, cacheDir, outFile, registryPath],
    { encoding: "utf8", env: { ...process.env, ROSTER_CAPTURED_AT: "2026-08-06" } },
  );

  return { ...run, outFile };
}

/** Entity-encoded JSON on an attribute, the way Squarespace serves its cards. */
const squarespaceContext = (payload: unknown) =>
  JSON.stringify(payload).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * One cached page per source the committed registry declares, so a run over
 * this cache exercises every declared source at once: each has to find a parser
 * and each has to yield a name.
 */
const PAGE_FOR_PREFIX: Record<string, string> = {
  exec: `<li class="mk-employee-item"><div class="team-info-wrapper">
    <span class="team-member-name">Rajin Shokar</span><span class="team-member-position">President</span>
    </div></li>`,
  pm: `<li class="mk-employee-item"><div class="team-info-wrapper">
    <span class="team-member-name">Adam Paroo</span><span class="team-member-position">Soap for Hope Program Manager</span>
    </div></li>`,
  projectpm: `<li class="mk-employee-item"><div class="team-info-wrapper">
    <span class="team-member-name">Patrick Juan</span><span class="team-member-position">Startup Homes Project Manager</span>
    </div></li>`,
  alumni: `<h2>Enactus SFU Alumni Business Owners</h2><ul>
    <li><strong>Minna Van</strong> &#8211; President 2004/2005. Co-Founder of Atomic Media</li></ul>`,
  ourteam: `<p class="font_5"><span>MEET OUR 2022/2023 TEAM</span></p>
    <p class="font_5"><span>ANDREW MA</span></p><p class="font_8"><span>President</span></p>`,
  theteam: `<ul data-current-context="${squarespaceContext({
    userItems: [{ title: "Sandra Chen", description: "<p>President</p>" }],
  })}" >`,
  team: CACHED_HTML,
  competition: `<h5 class="text-primary-yellow"> 2026 </h5><h1> Regionals </h1>
    <h3>Coaches: Brandon Xu, Eva Yueng</h3>`,
  spotlight: `<title>Community Spotlight: Ivy So - SIFE Alumni | Enactus SFU</title>`,
  "live-team": CACHED_HTML,
  "live-competition": `<h5 class="text-primary-yellow"> 2025 </h5><h1> Nationals </h1>
    <h3>Coaches: Sam Thiara, Vinay Aery</h3>`,
};

const REGISTRY_PATH = fileURLToPath(new URL("../scripts/alumni-roster/sources.tsv", import.meta.url));
const declaredSources = () => parseSourceRegistry(readFileSync(REGISTRY_PATH, "utf8"));

/** A cache holding one page for every declared source, minus those named. */
function runBuildOverEveryDeclaredSource({ without = [] as string[], seed = null as string | null }) {
  const root = mkdtempSync(path.join(tmpdir(), "alumni-roster-full-"));
  const cacheDir = path.join(root, "cache");
  const outDir = path.join(root, "alumni");
  mkdirSync(cacheDir);
  mkdirSync(outDir);

  let manifest = "";
  for (const source of declaredSources()) {
    if (without.includes(source.key)) continue;
    const file =
      source.kind === "live" ? `${source.prefix}.html` : `${source.prefix}-20260114044549.html`;
    writeFileSync(path.join(cacheDir, file), PAGE_FOR_PREFIX[source.prefix] ?? "");
    manifest += `${file}\thttps://web.archive.org/web/20260114044549id_/https://example.invalid/${source.prefix}\n`;
  }
  writeFileSync(path.join(cacheDir, "manifest.tsv"), manifest);
  writeFileSync(path.join(outDir, "removed.txt"), "# nobody yet\n");

  const outFile = path.join(outDir, "past-executives.csv");
  if (seed !== null) writeFileSync(outFile, seed);

  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", BUILD_SCRIPT, cacheDir, outFile],
    { encoding: "utf8", env: { ...process.env, ROSTER_CAPTURED_AT: "2026-08-06" } },
  );

  return { ...run, outFile };
}

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

  test("a run expands back to every year it spans, including the ones inside it", () => {
    expect(expandYears("2015-16..2017-18")).toEqual(["2015-16", "2016-17", "2017-18"]);
    expect(expandYears("2022-23;2025-26..2026-27")).toEqual(["2022-23", "2025-26", "2026-27"]);
    expect(expandYears("1991")).toEqual(["1991"]);
    expect(expandYears("")).toEqual([]);
  });
});

describe("coverage by year", () => {
  test("a person counts in every year of their span, not just its ends", () => {
    const rows = mergeSightings([
      sighting({ name: "Gurleen Battu", year: "2016-17" }),
      sighting({ name: "Gurleen Battu", year: "2017-18" }),
      sighting({ name: "Gurleen Battu", year: "2018-19" }),
      sighting({ name: "Rajin Shokar", year: "2016-17" }),
    ]);

    expect(coverageByYear(rows).years).toEqual([
      ["2016-17", 2],
      ["2017-18", 1],
      ["2018-19", 1],
    ]);
  });

  test("a person the source dated with no year is counted as undated, not as a year", () => {
    const rows = mergeSightings([
      sighting({ name: "Ivy So", role: "", year: "", confidence: "low" }),
      sighting({ name: "Rajin Shokar", year: "2016-17" }),
    ]);

    expect(coverageByYear(rows)).toEqual({ years: [["2016-17", 1]], undated: 1 });
  });

  test("years come out in order regardless of the order the rows were seen in", () => {
    const rows = mergeSightings([
      sighting({ name: "Naia Wong", year: "2026-27" }),
      sighting({ name: "Jade Bourelle", year: "1991" }),
      sighting({ name: "Minna Van", year: "2004-05" }),
    ]);

    expect(coverageByYear(rows).years.map(([year]) => year)).toEqual([
      "1991",
      "2004-05",
      "2026-27",
    ]);
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

  test("two roles observed in the same years keep the order they were read in", () => {
    const asRead = [
      sighting({ name: "Vanessa Lee", role: "Director of Internal Operations", year: "2013-14", sourceUrl: "u-internal" }),
      sighting({ name: "Vanessa Lee", role: "President", year: "2013-14", sourceUrl: "u-president" }),
    ];

    const [row] = mergeSightings(asRead);
    expect(row.role).toBe("Director of Internal Operations (2013-14); President (2013-14)");
    expect(row.sourceUrl).toBe("u-internal | u-president");

    const [reversed] = mergeSightings([...asRead].reverse());
    expect(reversed.role).toBe("President (2013-14); Director of Internal Operations (2013-14)");
    expect(reversed.sourceUrl).toBe("u-president | u-internal");
  });

  test("the earliest sighting of a role supplies its URL, and a tie takes the first read", () => {
    const [row] = mergeSightings([
      sighting({ role: "President", year: "2016-17", sourceUrl: "first" }),
      sighting({ role: "President", year: "2016-17", sourceUrl: "second" }),
      sighting({ role: "President", year: "2015-16", sourceUrl: "earliest" }),
    ]);

    expect(row.sourceUrl).toBe("earliest");
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

  test("a reader that skips leading # lines lands on the header, then the rows", () => {
    const built = runBuild();
    const lines = readFileSync(built.outFile, "utf8").split("\n");
    const body = lines.slice(lines.findIndex((line) => !line.startsWith("#")));

    expect(lines[0].startsWith("#")).toBe(true);
    expect(body[0]).toBe("name,role,years_active,source_url,captured_at,confidence");
    expect(body.slice(1).filter(Boolean).map((line) => line.split(",")[0])).toEqual([
      "Caleb Wu",
      "Naia Wong",
    ]);
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

describe("building the roster from a cache", () => {
  test("the run reports how many names the removal list held, including none", () => {
    const run = runBuild();

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/removed:\s+0 name\(s\)/);
    expect(readFileSync(run.outFile, "utf8")).toContain("Naia Wong");
  });

  test("a name on the removal list reaches no row, and the run says so", () => {
    const run = runBuild({ removals: "Naia Wong\n" });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/removed:\s+1 name\(s\)/);
    const csv = readFileSync(run.outFile, "utf8");
    expect(csv).not.toContain("Naia Wong");
    expect(csv).toContain("Caleb Wu");
  });

  test("a missing removal list stops the build instead of reinstating everyone on it", () => {
    const run = runBuild({ removals: null });

    expect(run.status).not.toBe(0);
    expect(existsSync(run.outFile)).toBe(false);
  });

  test("a missing removal list leaves the roster that is already there alone", () => {
    const run = runBuild({ removals: null, seed: "the roster from the last good build\n" });

    expect(run.status).not.toBe(0);
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("a cached page the manifest never recorded stops the build rather than shrinking it", () => {
    const run = runBuild({ unrecordedPage: true, seed: "the roster from the last good build\n" });

    expect(run.status).not.toBe(0);
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("the coverage report the README quotes is printed by the run itself", () => {
    expect(runBuild().stdout).toMatch(/coverage:\s+2025-26=2/);
  });
});

describe("a source that parses to no names", () => {
  test("the roster already committed is not replaced by the smaller one", () => {
    const run = runBuild({ emptySource: true, seed: "the roster from the last good build\n" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("competition");
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("with no exemption list at all it is still a failure, not a pass", () => {
    const run = runBuild({ emptySource: true, expectedEmpty: null });

    expect(run.status).not.toBe(0);
    expect(existsSync(run.outFile)).toBe(false);
  });

  test("a source named on the exemption list is allowed through, and reported", () => {
    const run = runBuild({ emptySource: true, expectedEmpty: "competition\n" });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("competition");
    expect(readFileSync(run.outFile, "utf8")).toContain("Naia Wong");
  });

  test("exempting one source does not exempt the others", () => {
    const run = runBuild({ emptySource: true, expectedEmpty: "program-managers\n" });

    expect(run.status).not.toBe(0);
    expect(existsSync(run.outFile)).toBe(false);
  });

  test("an entry for a source that did not run is reported as stale", () => {
    const run = runBuild({ expectedEmpty: "# retired years ago\nprogram-managers\n" });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/stale entry[\s\S]*program-managers/);
  });

  test("an entry for a source that is producing names again is reported as stale", () => {
    const run = runBuild({ expectedEmpty: "team\n" });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/stale entry[\s\S]*producing names again/);
  });
});

describe("the committed roster and the README that describes it", () => {
  /**
   * past-executives.csv is generated output and the README's coverage table is a
   * claim about it. Recomputing one from the other is the only thing keeping the
   * file's own gap report honest once someone rebuilds the roster.
   */
  const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

  const committedRows = () =>
    parseRosterCsv(readFileSync(repoFile("config/alumni/past-executives.csv"), "utf8"));

  const readmeCoverage = () => {
    const readme = readFileSync(repoFile("config/alumni/README.md"), "utf8");
    const table = /## Gaps in the record[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(table).toBeDefined();

    const counts: Array<[string, number]> = [];
    for (const [, year, people] of table!.matchAll(/(\d{4}(?:-\d{2})?)\s+(\d+)/g)) {
      counts.push([year, Number(people)]);
    }
    return counts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  };

  test("the coverage table is what the committed CSV actually contains", () => {
    expect(readmeCoverage()).toEqual(coverageByYear(committedRows()).years);
  });

  test("every person in the file reaches the coverage report, dated or not", () => {
    const rows = committedRows();
    const coverage = coverageByYear(rows);
    const dated = rows.filter((row) => row.yearsActive !== "").length;

    expect(dated + coverage.undated).toBe(rows.length);
  });

  /** The sentences around the table make the same claim in prose. */
  const readmeClaims = () => {
    const readme = readFileSync(repoFile("config/alumni/README.md"), "utf8");
    const headline = /([\d,]+) people,\s+across (\d+) of the \d+ years/.exec(readme);
    const undated = /(\w+) more (?:people carry|person carries) no year at all/.exec(readme);
    expect(headline).not.toBeNull();
    expect(undated).not.toBeNull();

    const words: Record<string, number> = {
      No: 0, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9, Ten: 10,
    };
    const spelled = undated![1];
    expect(Object.keys(words)).toContain(spelled);

    return {
      people: Number(headline![1].replace(/,/g, "")),
      years: Number(headline![2]),
      undated: words[spelled],
    };
  };

  test("the headline the section opens with is the file it describes", () => {
    const rows = committedRows();
    const coverage = coverageByYear(rows);

    expect(readmeClaims()).toEqual({
      people: rows.length,
      years: coverage.years.length,
      undated: coverage.undated,
    });
  });
});

describe("the real snapshot cache, when there is one", () => {
  /**
   * The cache is gitignored, so this runs only on a machine that has fetched
   * one. It records what a real fetch produces for the live competition page,
   * which no synthetic fixture can settle: if that source were legitimately
   * empty, the zero-yield gate would refuse to rebuild the committed roster.
   */
  const cacheDir = fileURLToPath(new URL("../.cache/alumni-roster", import.meta.url));
  const livePage = path.join(cacheDir, "live-competition.html");
  const cached = existsSync(livePage);

  test.skipIf(!cached)("the live competition page still names coaches", () => {
    const coaches = parseCompetitionCoaches(readFileSync(livePage, "utf8"));

    expect(coaches.length).toBeGreaterThan(0);
    for (const coach of coaches) expect(coach.role).toBe("Competition coach");
  });
});

describe("the source registry", () => {
  const rows = [
    "executives\tarchived\texec\tenactussfu.com/executives/\thttp://enactussfu.com/executives/\t-",
    "team (live)\tlive\tlive-team\t-\thttps://www.enactussfu.ca/team\t-",
  ].join("\n");

  test("reads a row per source and skips comments and blank lines", () => {
    expect(parseSourceRegistry(`# what we fetch\n\n${rows}\n`)).toEqual([
      {
        key: "executives",
        kind: "archived",
        prefix: "exec",
        cdxPattern: "enactussfu.com/executives/",
        url: "http://enactussfu.com/executives/",
        postFilter: "-",
      },
      {
        key: "team (live)",
        kind: "live",
        prefix: "live-team",
        cdxPattern: "-",
        url: "https://www.enactussfu.ca/team",
        postFilter: "-",
      },
    ]);
  });

  test.each([
    ["executives\tarchived\texec\tpattern\turl", "a row missing a column"],
    ["executives\tsomehow\texec\tpattern\turl\t-", "a kind neither script can act on"],
    ["executives\tarchived\texec\tpattern\turl\t", "a column left empty rather than dashed"],
    ["posts\tspotlight\tposts\tpattern\t-\t-", "a sweep with no post filter to match on"],
    ["a\tarchived\tx\tp\tu\t-\nb\tarchived\tx\tp\tu\t-", "two sources claiming one cache prefix"],
    ["a\tarchived\tx\tp\tu\t-\na\tlive\ty\tp\tu\t-", "the same key twice"],
    ["# only comments\n", "a registry declaring nothing"],
  ])("throws on %s", (contents) => {
    expect(() => parseSourceRegistry(contents)).toThrow();
  });

  test("a cached page is claimed by the source whose prefix it carries", () => {
    const sources = parseSourceRegistry(rows);
    expect(sourceOfCacheFile("exec-20130205151700.html", sources)?.key).toBe("executives");
    expect(sourceOfCacheFile("live-team.html", sources)?.key).toBe("team (live)");
  });

  test("a page no source claims is claimed by nothing rather than the nearest match", () => {
    const sources = parseSourceRegistry(rows);
    expect(sourceOfCacheFile("executives.html", sources)).toBeNull();
    expect(sourceOfCacheFile("live-team-20260114044549.html", sources)).toBeNull();
    expect(sourceOfCacheFile("faculty-20130205151700.html", sources)).toBeNull();
  });

  test("the committed registry is well formed and declares each key and prefix once", () => {
    const sources = declaredSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources.map((s) => s.key)).size).toBe(sources.length);
    expect(new Set(sources.map((s) => s.prefix)).size).toBe(sources.length);
    for (const source of sources) {
      expect(["archived", "spotlight", "live"]).toContain(source.kind);
    }
  });
});

describe("every source the registry declares", () => {
  test("has a parser in the build and yields names through it", () => {
    const run = runBuildOverEveryDeclaredSource({});

    expect(run.stderr).not.toContain("cannot parse");
    expect(run.status).toBe(0);

    const reported = /sources:\s+(.*)/.exec(run.stdout)?.[1] ?? "";
    const counts = new Map(
      reported.split(", ").map((pair) => {
        const at = pair.lastIndexOf("=");
        return [pair.slice(0, at), Number(pair.slice(at + 1))] as const;
      }),
    );
    for (const source of declaredSources()) {
      expect(counts.get(source.key)).toBeGreaterThan(0);
    }
  });

  test("a source that fetched no page at all stops the build, like one that parsed to none", () => {
    const run = runBuildOverEveryDeclaredSource({
      without: ["executives"],
      seed: "the roster from the last good build\n",
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("executives");
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("a cached page no source declares stops the build rather than being ignored", () => {
    const run = runBuild({ strayPage: true, seed: "the roster from the last good build\n" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(STRAY_PAGE);
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("declaring the source without writing its parser is a failure too, not a skip", () => {
    const run = runBuild({
      strayPage: true,
      registry: [TEAM_ROW, STRAY_ROW].join("\n"),
      seed: "the roster from the last good build\n",
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("cannot parse");
    expect(run.stderr).toContain("faculty");
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("an exemption naming no declared source is reported as exempting nothing", () => {
    const run = runBuild({ expectedEmpty: "competitionn\n" });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/stale entry[\s\S]*competitionn/);
  });

  test.each([
    ["missing", { registryMissing: true }],
    ["declaring nothing", { registry: "" }],
    ["malformed", { registry: "team\tarchived\tteam" }],
  ])("a registry that is %s stops the build before it writes anything", (_case, options) => {
    const run = runBuild({ ...options, seed: "the roster from the last good build\n" });

    expect(run.status).not.toBe(0);
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });
});

describe("refreshing what the README says about the roster", () => {
  const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
  const CSV = repoFile("config/alumni/past-executives.csv");
  const README = repoFile("config/alumni/README.md");

  /**
   * A copy of the committed pair in a directory with no cache, no registry and
   * no network — the position a student is in when an alum emails and the only
   * thing they have is a fresh clone.
   */
  function runRefresh({ dropRowsFor = null as string | null } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "alumni-refresh-"));
    const csv = path.join(root, "past-executives.csv");
    const readme = path.join(root, "README.md");

    const committed = readFileSync(CSV, "utf8");
    writeFileSync(
      csv,
      dropRowsFor === null
        ? committed
        : committed
            .split("\n")
            .filter((line) => !line.startsWith(`${dropRowsFor},`))
            .join("\n"),
    );
    writeFileSync(readme, readFileSync(README, "utf8"));

    const before = { csv: readFileSync(csv, "utf8"), readme: readFileSync(readme, "utf8") };
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", BUILD_SCRIPT, "--refresh-readme", csv, readme],
      { encoding: "utf8", env: { ...process.env } },
    );

    return { ...run, csv, readme, before };
  }

  const claimsIn = (readme: string) => {
    const table = /## Gaps in the record[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";
    const years: Array<[string, number]> = [];
    for (const [, year, people] of table.matchAll(/(\d{4}(?:-\d{2})?)\s+(\d+)/g)) {
      years.push([year, Number(people)]);
    }
    const headline = /([\d,]+) people,\s+across (\d+) of the \d+ years/.exec(readme);
    const undated = /(\w+) more (?:people carry|person carries) no year at all/.exec(readme);
    return {
      years: years.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      people: Number(headline?.[1].replace(/,/g, "")),
      spelled: undated?.[1],
    };
  };

  test("the committed README already matches the committed roster, so a refresh changes nothing", () => {
    const run = runRefresh();

    expect(run.status).toBe(0);
    expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
  });

  test("it never edits the roster it reads", () => {
    const run = runRefresh({ dropRowsFor: "Naia Wong" });

    expect(run.status).toBe(0);
    expect(readFileSync(run.csv, "utf8")).toBe(run.before.csv);
  });

  test("honouring a removal by hand leaves the README stale, and the refresh fixes it", () => {
    const run = runRefresh({ dropRowsFor: "Naia Wong" });
    const rows = parseRosterCsv(readFileSync(run.csv, "utf8"));
    const coverage = coverageByYear(rows);

    // The state a student is in the moment they delete the row.
    expect(claimsIn(run.before.readme).people).not.toBe(rows.length);

    expect(run.status).toBe(0);
    const after = claimsIn(readFileSync(run.readme, "utf8"));
    expect(after.people).toBe(rows.length);
    expect(after.years).toEqual(coverage.years);
  });

  test("a roster it cannot read stops it rather than half-rewriting the README", () => {
    const root = mkdtempSync(path.join(tmpdir(), "alumni-refresh-bad-"));
    const csv = path.join(root, "past-executives.csv");
    const readme = path.join(root, "README.md");
    writeFileSync(csv, "# a preamble and nothing else\n");
    writeFileSync(readme, readFileSync(README, "utf8"));

    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", BUILD_SCRIPT, "--refresh-readme", csv, readme],
      { encoding: "utf8" },
    );

    expect(run.status).not.toBe(0);
    expect(readFileSync(readme, "utf8")).toBe(readFileSync(README, "utf8"));
  });
});

describe("the coverage claims, as text", () => {
  const readme = [
    "## Gaps in the record",
    "",
    "A gap is a gap — 3 people,",
    "across 2 of the 36 years since the chapter was founded:",
    "",
    "```",
    "2015-16   2    2024-25   1  ← coaches only",
    "```",
    "",
    "Six more people carry no year at all — the Community Spotlight names.",
    "",
  ].join("\n");

  test("a note beside a year survives a refresh that changes its count", () => {
    const refreshed = refreshCoverageClaims(readme, 9, {
      years: [
        ["2015-16", 4],
        ["2024-25", 5],
      ],
      undated: 2,
    });

    expect(refreshed).toContain("2015-16   4    2024-25   5  ← coaches only");
    expect(refreshed).toContain("9 people,\nacross 2 of the 36 years");
    expect(refreshed).toContain("Two more people carry no year at all");
  });

  test("one undated person reads as one person, not as one people", () => {
    const refreshed = refreshCoverageClaims(readme, 9, { years: [["2015-16", 9]], undated: 1 });
    expect(refreshed).toContain("One more person carries no year at all");
  });

  test("a year with no note is written without one", () => {
    const refreshed = refreshCoverageClaims(readme, 2, { years: [["1991", 2]], undated: 0 });
    expect(refreshed).toContain("```\n1991      2\n```");
  });

  test.each([
    ["the coverage table", readme.replace("## Gaps in the record", "## Gaps")],
    ["the headline", readme.replace("3 people,", "some people,")],
    ["the undated sentence", readme.replace("Six more people carry", "Six more people held")],
  ])("a README missing %s throws rather than silently leaving a number stale", (_case, text) => {
    expect(() => refreshCoverageClaims(text, 3, { years: [["2015-16", 3]], undated: 0 })).toThrow();
  });
});

describe("the roster CSV, read back", () => {
  test("what toCsv writes is what parseRosterCsv reads, quoting and all", () => {
    const rows = mergeSightings([
      sighting({ name: "Guransh Gill", role: "VP Finance, External" }),
      sighting({ name: 'Ivy "So"', role: "", year: "", confidence: "low" }),
    ]);

    expect(parseRosterCsv(toCsv(rows))).toEqual(rows);
  });

  test("the committed preamble is skipped, not read as a row", () => {
    const withPreamble = `# private\n#\n# generated\n${toCsv(mergeSightings([sighting()]))}`;
    expect(parseRosterCsv(withPreamble)).toEqual(mergeSightings([sighting()]));
  });

  test.each([
    ["a row short a column", "name,role,years_active,source_url,captured_at,confidence\na,b,c,d,e\n"],
    ["a confidence level that is not one", "name,role,years_active,source_url,captured_at,confidence\na,b,c,d,e,f\n"],
    ["a header that is not the roster's", "name,role\na,b\n"],
    ["nothing but comments", "# all comment\n"],
  ])("throws on %s", (_case, contents) => {
    expect(() => parseRosterCsv(contents)).toThrow();
  });
});

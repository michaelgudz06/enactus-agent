import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import {
  academicYearOfCapture,
  academicYearOfLabel,
  acceptEntry,
  applyConfirmedSpellings,
  applyRemovals,
  canonicaliseRemovals,
  carriesContactDetail,
  compressYears,
  confirmedSpellingMap,
  coverageByYear,
  csvCell,
  expandYears,
  findNearDuplicates,
  isPlausiblePersonName,
  isPlausibleRole,
  mergeSightings,
  nameKey,
  nearMissesOnRemovalList,
  normaliseNameCase,
  parseConfirmedSpellings,
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
const { ROSTER_CAPTURED_AT: _exportedPin, ...inheritedEnv } = process.env;
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

/**
 * The club's competition page, in two snapshots that spell one coach's name two
 * different ways — the shape the committed roster met for real, and the one the
 * removal list cannot match across on its own.
 */
const VARIANT_PAGES: Array<[string, string]> = [
  ["competition-20260114050523.html", "2025\t Tim MacDougall"],
  ["competition-20260516055532.html", "2026\t Tim MacDougal"],
];
const variantHtml = (spec: string) => {
  const [year, name] = spec.split("\t");
  return `<h5 class="text-primary-yellow"> ${year} </h5><h1> Regionals </h1>
    <h3>Coaches: ${name}</h3>`;
};

function runBuild({
  removals = "# nobody yet\n",
  unrecordedPage = false,
  emptySource = false,
  strayPage = false,
  expectedEmpty = null,
  spellings = null,
  variantSpellings = false,
  registry = null,
  registryMissing = false,
  seed = null,
}: {
  removals?: string | null;
  unrecordedPage?: boolean;
  emptySource?: boolean;
  strayPage?: boolean;
  expectedEmpty?: string | null;
  spellings?: string | null;
  variantSpellings?: boolean;
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
  if (variantSpellings) {
    for (const [file, spec] of VARIANT_PAGES) {
      writeFileSync(path.join(cacheDir, file), variantHtml(spec));
      manifest += `${file}\thttps://web.archive.org/web/${/-(\d{14})/.exec(file)![1]}id_/https://www.enactussfu.ca/competition\n`;
    }
  }
  writeFileSync(path.join(cacheDir, "manifest.tsv"), manifest);
  if (unrecordedPage) writeFileSync(path.join(cacheDir, "team-20260301000000.html"), CACHED_HTML);
  if (removals !== null) writeFileSync(path.join(outDir, "removed.txt"), removals);
  if (expectedEmpty !== null) {
    writeFileSync(path.join(outDir, "expected-empty-sources.txt"), expectedEmpty);
  }
  if (spellings !== null) writeFileSync(path.join(outDir, "confirmed-spellings.tsv"), spellings);

  // The registry declares exactly the pages this cache holds, so the fixture
  // exercises the gates rather than tripping over sources it never fetched.
  const registryPath = path.join(root, "sources.tsv");
  const rows =
    registry ??
    [TEAM_ROW, ...(emptySource || variantSpellings ? [COMPETITION_ROW] : [])].join("\n");
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

/**
 * The coverage report config/alumni/README.md carries: a generated block, so
 * reading it back is reading an owned output contract, not implementation text.
 */
function parseCoverageReport(block: string) {
  const [table, ...rest] = block.split(/\n\s*\n/);
  const totals = rest.join("\n");

  const years: Array<[string, number]> = [];
  for (const [, year, count] of table.matchAll(/(\d{4}(?:-\d{2})?)\s+(\d+)/g)) {
    years.push([year, Number(count)]);
  }

  const field = (name: string) => new RegExp(`${name} (\\S+)`).exec(totals)?.[1];
  return {
    years: years.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    people: Number(field("people")),
    yearsCovered: Number(field("years covered")),
    span: Number(/years covered \d+ of the (\d+) academic years/.exec(totals)?.[1]),
    foundingYear: Number(/since the chapter was founded in (\d{4})/.exec(totals)?.[1]),
    earliest: field("earliest"),
    latest: field("latest"),
    undated: Number(field("with no year")),
  };
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

  test("role, source_url and captured_at can be split and zipped by index", () => {
    const [two] = mergeSightings([
      sighting({ role: "Director", year: "2015-16" }),
      sighting({ role: "President", year: "2016-17" }),
    ]);

    // Both roles came off the same page on the same day; the entry is still
    // written per role, because a consumer pairs these three columns by index.
    expect(two.role.split("; ")).toHaveLength(2);
    expect(two.sourceUrl.split(" | ")).toHaveLength(2);
    expect(two.capturedAt.split(" | ")).toHaveLength(2);

    const [one] = mergeSightings([sighting()]);
    expect(one.sourceUrl.split(" | ")).toHaveLength(1);
    expect(one.capturedAt).toBe("2026-08-06");
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

describe("a removal that names one of two spellings", () => {
  test("the spelling still in the file is named back to whoever listed the other", () => {
    expect(nearMissesOnRemovalList(["Tim MacDougall"], ["Adam Paroo", "Tim MacDougal"])).toEqual([
      ["Tim MacDougall", "Tim MacDougal"],
    ]);
  });

  test("it reports what the student wrote, not the key it matched on", () => {
    expect(nearMissesOnRemovalList(["TIM  MACDOUGALL"], ["Tim MacDougal"])).toEqual([
      ["TIM  MACDOUGALL", "Tim MacDougal"],
    ]);
  });

  test("a removal that landed says nothing, which is the common case", () => {
    expect(nearMissesOnRemovalList(["Minna Van"], ["Adam Paroo", "Rajin Shokar"])).toEqual([]);
  });

  test("an empty list says nothing", () => {
    expect(nearMissesOnRemovalList([], ["Tim MacDougal"])).toEqual([]);
  });

  test("a name still in the file under the very spelling listed is not a near miss", () => {
    // That is an unfinished removal, which the exact check refuses; this one
    // only speaks about what an exact match cannot see.
    expect(nearMissesOnRemovalList(["Minna Van"], ["Minna Van"])).toEqual([]);
  });

  test("two people a character apart are reported, because a person decides, not this", () => {
    expect(nearMissesOnRemovalList(["Ann Lee"], ["Anna Lee"])).toEqual([["Ann Lee", "Anna Lee"]]);
  });
});

describe("spellings a human has confirmed", () => {
  const ROW = [
    "Tim MacDougal",
    "Tim MacDougall",
    "https://web.archive.org/web/20260516055532id_/https://www.enactussfu.ca/competition",
    "captain",
    "2026-08-06",
  ].join("\t");

  test("reads a row per correction and skips comments and blank lines", () => {
    expect(parseConfirmedSpellings(`# settled\n\n${ROW}\n`)).toEqual([
      {
        published: "Tim MacDougal",
        confirmed: "Tim MacDougall",
        sourceUrl:
          "https://web.archive.org/web/20260516055532id_/https://www.enactussfu.ca/competition",
        confirmedBy: "captain",
        confirmedOn: "2026-08-06",
      },
    ]);
  });

  test("an empty file confirms nothing rather than failing", () => {
    expect(parseConfirmedSpellings("# nobody has confirmed anything\n")).toEqual([]);
  });

  test.each([
    ["a row missing a column", "Tim MacDougal\tTim MacDougall\thttps://x.invalid/p\tcaptain"],
    ["a published spelling that is not a name", `Executives\tTim MacDougall\thttps://x.invalid/p\tcaptain\t2026-08-06`],
    ["a confirmed spelling that is not a name", `Tim MacDougal\tcompetition@enactussfu.ca\thttps://x.invalid/p\tcaptain\t2026-08-06`],
    ["a correction to the same spelling", `Tim MacDougal\tTim MacDougal\thttps://x.invalid/p\tcaptain\t2026-08-06`],
    ["no snapshot the published spelling was read from", `Tim MacDougal\tTim MacDougall\t-\tcaptain\t2026-08-06`],
    ["a contact detail where the confirming role goes", `Tim MacDougal\tTim MacDougall\thttps://x.invalid/p\tvpexternal@enactussfu.ca\t2026-08-06`],
    ["no date on the confirmation", `Tim MacDougal\tTim MacDougall\thttps://x.invalid/p\tcaptain\tlast week`],
    [
      "one spelling corrected twice, so the rows disagree",
      `Tim MacDougal\tTim MacDougall\thttps://x.invalid/p\tcaptain\t2026-08-06\nTim MacDougal\tTim MacDougald\thttps://x.invalid/p\tcaptain\t2026-08-06`,
    ],
    [
      "a chain, where what one row confirms another row corrects",
      `Tim MacDougal\tTim MacDougall\thttps://x.invalid/p\tcaptain\t2026-08-06\nTim MacDougall\tTim MacDougale\thttps://x.invalid/p\tcaptain\t2026-08-06`,
    ],
  ])("throws on %s", (_case, contents) => {
    expect(() => parseConfirmedSpellings(contents)).toThrow();
  });

  test("every sighting of the published spelling is renamed, before anything is merged", () => {
    const spellings = confirmedSpellingMap(parseConfirmedSpellings(ROW));
    const rows = mergeSightings(
      applyConfirmedSpellings(
        [
          sighting({ name: "Tim MacDougal", role: "Competition coach", year: "2025-26" }),
          sighting({ name: "Tim MacDougall", role: "Competition coach", year: "2024-25" }),
        ],
        spellings,
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Tim MacDougall");
    expect(rows[0].yearsActive).toBe("2024-25..2025-26");
    expect(findNearDuplicates(rows)).toEqual([]);
  });

  test("a request to be removed lands under either spelling", () => {
    const spellings = confirmedSpellingMap(parseConfirmedSpellings(ROW));
    const sightings = applyConfirmedSpellings(
      [sighting({ name: "Tim MacDougal" }), sighting({ name: "Rajin Shokar" })],
      spellings,
    );

    for (const written of ["Tim MacDougal", "Tim MacDougall"]) {
      const removed = canonicaliseRemovals(parseRemovalList(written), spellings);
      expect(applyRemovals(sightings, removed).map((s) => s.name)).toEqual(["Rajin Shokar"]);
    }
  });

  test("with nothing confirmed, sightings and removals are left exactly as they were", () => {
    const none = confirmedSpellingMap([]);
    const sightings = [sighting({ name: "Tim MacDougal" })];

    expect(applyConfirmedSpellings(sightings, none)).toBe(sightings);
    expect(canonicaliseRemovals(parseRemovalList("Minna Van"), none)).toEqual(
      parseRemovalList("Minna Van"),
    );
  });

  test("the committed file is well formed and every correction is dated and attributed", () => {
    const committed = parseConfirmedSpellings(
      readFileSync(fileURLToPath(new URL("../config/alumni/confirmed-spellings.tsv", import.meta.url)), "utf8"),
    );

    expect(committed.length).toBeGreaterThan(0);
    for (const spelling of committed) {
      expect(spelling.confirmedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(spelling.confirmedBy).not.toBe("");
      expect(spelling.sourceUrl).toMatch(/^https?:\/\//);
    }
  });

  test("no row in the committed roster still carries a spelling that was corrected", () => {
    const committed = parseConfirmedSpellings(
      readFileSync(fileURLToPath(new URL("../config/alumni/confirmed-spellings.tsv", import.meta.url)), "utf8"),
    );
    const rows = parseRosterCsv(
      readFileSync(fileURLToPath(new URL("../config/alumni/past-executives.csv", import.meta.url)), "utf8"),
    );
    const names = new Set(rows.map((row) => nameKey(row.name)));

    for (const spelling of committed) {
      expect(names.has(nameKey(spelling.published))).toBe(false);
      expect(names.has(nameKey(spelling.confirmed))).toBe(true);
    }
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

describe("a person the club's pages spell two ways, through the build", () => {
  const CONFIRMED = [
    "Tim MacDougal",
    "Tim MacDougall",
    "https://web.archive.org/web/20260516055532id_/https://www.enactussfu.ca/competition",
    "captain",
    "2026-08-06",
  ].join("\t");

  const namesIn = (file: string) =>
    parseRosterCsv(readFileSync(file, "utf8")).map((row) => row.name);

  test("with nothing confirmed they are two rows, and the run says which two", () => {
    const run = runBuild({ variantSpellings: true });

    expect(run.status).toBe(0);
    expect(namesIn(run.outFile)).toContain("Tim MacDougal");
    expect(namesIn(run.outFile)).toContain("Tim MacDougall");
    expect(run.stderr).toMatch(/near-duplicate names[\s\S]*Tim MacDougal\s+\/\s+Tim MacDougall/);
    expect(run.stderr).toContain("confirmed-spellings.tsv");
  });

  test("a confirmed spelling makes them one row, and the rebuild keeps it that way", () => {
    const run = runBuild({ variantSpellings: true, spellings: `# settled\n${CONFIRMED}\n` });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/spellings:\s+1 confirmed, 1 sighting\(s\) renamed/);

    const rows = parseRosterCsv(readFileSync(run.outFile, "utf8"));
    const merged = rows.filter((row) => row.name.startsWith("Tim MacDoug"));
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("Tim MacDougall");
    expect(merged[0].yearsActive).toBe("2024-25..2025-26");
    // Still one source URL and one capture date per role, as every row is.
    expect(merged[0].sourceUrl.split(" | ")).toHaveLength(1);
    expect(run.stderr).not.toContain("near-duplicate names");
  });

  test("once confirmed, a removal written under either spelling takes them out", () => {
    for (const written of ["Tim MacDougal", "Tim MacDougall"]) {
      const run = runBuild({
        variantSpellings: true,
        spellings: `${CONFIRMED}\n`,
        removals: `${written}\n`,
      });

      expect(run.status).toBe(0);
      expect(namesIn(run.outFile).filter((name) => name.startsWith("Tim MacDoug"))).toEqual([]);
    }
  });

  test("a removal naming one of two unconfirmed spellings is reported, not silently half done", () => {
    const run = runBuild({ variantSpellings: true, removals: "Tim MacDougall\n" });

    expect(run.status).toBe(0);
    // The rebuild is the moment the unregistered spelling comes back, so this is
    // where it has to be said.
    expect(namesIn(run.outFile)).toContain("Tim MacDougal");
    expect(run.stderr).toContain("possibly unfinished removal");
    expect(run.stderr).toMatch(/on the list: Tim MacDougall\s+\/\s+still in the file: Tim MacDougal/);
  });

  test("a removal that landed leaves the run silent about it", () => {
    const run = runBuild({ removals: "Naia Wong\n" });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("possibly unfinished removal");
  });

  test.each([
    ["a list nobody is on", "# nobody yet\n"],
    ["an empty list", ""],
  ])("%s says nothing at all", (_case, removals) => {
    const run = runBuild({ variantSpellings: true, removals });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("possibly unfinished removal");
  });

  test("a malformed correction stops the build rather than splitting the person again", () => {
    const run = runBuild({
      variantSpellings: true,
      spellings: "Tim MacDougal\tTim MacDougall\tcaptain\n",
      seed: "the roster from the last good build\n",
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("confirmed-spellings.tsv");
    expect(readFileSync(run.outFile, "utf8")).toBe("the roster from the last good build\n");
  });

  test("no file at all confirms nothing, and is not an error", () => {
    const run = runBuild({ variantSpellings: true, spellings: null });

    expect(run.status).toBe(0);
    expect(namesIn(run.outFile)).toContain("Tim MacDougal");
  });

  test("a correction nothing spells that way any more is reported as stale", () => {
    const run = runBuild({ spellings: `${CONFIRMED}\n` });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/stale entry on confirmed-spellings.tsv[\s\S]*Tim MacDougal/);
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

  /**
   * The generated block under "Gaps in the record": the per-year table and the
   * totals line beneath it. Every count this README states about the roster is
   * in there, so this is the whole of what can drift.
   */
  const readmeReport = () => {
    const readme = readFileSync(repoFile("config/alumni/README.md"), "utf8");
    const block = /## Gaps in the record[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    return parseCoverageReport(block!);
  };

  test("the coverage table is what the committed CSV actually contains", () => {
    expect(readmeReport().years).toEqual(coverageByYear(committedRows()).years);
  });

  test("the totals line is what the committed CSV actually contains", () => {
    const rows = committedRows();
    const coverage = coverageByYear(rows);
    const report = readmeReport();

    expect(report.people).toBe(rows.length);
    expect(report.yearsCovered).toBe(coverage.years.length);
    expect(report.undated).toBe(coverage.undated);
    expect(report.earliest).toBe(coverage.years[0][0]);
    expect(report.latest).toBe(coverage.years.at(-1)![0]);
  });

  test("every person in the file reaches the coverage report, dated or not", () => {
    const rows = committedRows();
    const coverage = coverageByYear(rows);
    const dated = rows.filter((row) => row.yearsActive !== "").length;

    expect(dated + coverage.undated).toBe(rows.length);
  });

  test("the roster pairs a source and a capture date with every role it lists", () => {
    for (const row of committedRows()) {
      const roles = row.role === "" ? 1 : row.role.split("; ").length;
      expect(row.sourceUrl.split(" | ")).toHaveLength(roles);
      expect(row.capturedAt.split(" | ")).toHaveLength(roles);
    }
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
    ["a\tarchived\t../escape\tp\tu\t-", "a cache prefix that is a path rather than a name"],
    ["a\tarchived\tteam page\tp\tu\t-", "a cache prefix with a space in it"],
    [
      "a\tarchived\tlive\tp\tu\t-\nb\tlive\tlive-team\t-\tu\t-",
      "a prefix that would claim another source's pages",
    ],
    [
      "a\tlive\tlive-team\t-\tu\t-\nb\tarchived\tlive\tp\tu\t-",
      "the same clash, declared the other way round",
    ],
    ["# only comments\n", "a registry declaring nothing"],
  ])("throws on %s", (contents) => {
    expect(() => parseSourceRegistry(contents)).toThrow();
  });

  test("the committed prefixes are names, and no two of them claim one page", () => {
    const prefixes = declaredSources().map((source) => source.prefix);

    for (const prefix of prefixes) expect(prefix).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
    for (const prefix of prefixes) {
      for (const other of prefixes) {
        if (prefix !== other) expect(other.startsWith(`${prefix}-`)).toBe(false);
      }
    }
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
  /**
   * The refresh derives everything from the committed CSV, so the environment
   * it runs in must not be able to say otherwise: `ROSTER_CAPTURED_AT` is
   * stripped rather than passed through, or a developer who exports it would
   * see these tests fail pointing at the README instead of at their shell.
   */
  function runRefresh({
    dropRowsFor = null,
    dropYear = null,
    csvText = null,
    removals = null,
    spellings = null,
    env = {},
  }: {
    dropRowsFor?: string | null;
    dropYear?: string | null;
    csvText?: string | null;
    removals?: string | null;
    spellings?: string | null;
    env?: Record<string, string>;
  } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "alumni-refresh-"));
    const csv = path.join(root, "past-executives.csv");
    const readme = path.join(root, "README.md");

    const committed = readFileSync(CSV, "utf8");
    const preamble = committed.split("\n").filter((line) => line.startsWith("#")).join("\n") + "\n";
    const kept = parseRosterCsv(committed).filter(
      (row) =>
        row.name !== dropRowsFor && !(dropYear !== null && expandYears(row.yearsActive).includes(dropYear)),
    );
    writeFileSync(
      csv,
      csvText ?? (dropRowsFor === null && dropYear === null ? committed : preamble + toCsv(kept)),
    );
    writeFileSync(readme, readFileSync(README, "utf8"));
    // Beside the roster, where the student edits it.
    if (removals !== null) writeFileSync(path.join(root, "removed.txt"), removals);
    if (spellings !== null) writeFileSync(path.join(root, "confirmed-spellings.tsv"), spellings);

    const before = { csv: readFileSync(csv, "utf8"), readme: readFileSync(readme, "utf8") };
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", BUILD_SCRIPT, "--refresh-readme", csv, readme],
      { encoding: "utf8", env: { ...inheritedEnv, ...env } },
    );

    return { ...run, csv, readme, before };
  }

  const claimsIn = (readme: string) =>
    parseCoverageReport(/## Gaps in the record[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1] ?? "");

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

  test("dropping the earliest person costs the numerator, never the denominator", () => {
    const before = claimsIn(readFileSync(README, "utf8"));
    const run = runRefresh({ dropRowsFor: "Jade Bourelle" });
    const after = claimsIn(readFileSync(run.readme, "utf8"));

    expect(run.status).toBe(0);
    expect(after.people).toBe(before.people - 1);
    expect(after.yearsCovered).toBe(before.yearsCovered - 1);
    expect(after.earliest).not.toBe(before.earliest);
    // The share of the club's history this file covers must fall, not rise.
    expect(after.span).toBe(before.span);
    expect(after.foundingYear).toBe(before.foundingYear);
  });

  test("dropping the latest cohort leaves the denominator alone too", () => {
    const before = claimsIn(readFileSync(README, "utf8"));
    const run = runRefresh({ dropYear: "2026-27" });
    const after = claimsIn(readFileSync(run.readme, "utf8"));

    expect(run.status).toBe(0);
    expect(after.people).toBeLessThan(before.people);
    expect(after.latest).not.toBe(before.latest);
    expect(after.span).toBe(before.span);
  });

  test("a capture date exported into the environment does not date the roster", () => {
    const run = runRefresh({ env: { ROSTER_CAPTURED_AT: "2024-03-01" } });

    expect(run.status).toBe(0);
    // The rows say when they were captured; the shell does not get a vote.
    expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
  });

  test("a roster dated before the years it covers is refused, not reported", () => {
    const row = [
      "Naia Wong",
      "President",
      "2026-27",
      "https://www.enactussfu.ca/team",
      "2019-01-01",
      "high",
    ].join(",");
    const run = runRefresh({
      csvText: `# fixture\nname,role,years_active,source_url,captured_at,confidence\n${row}\n`,
    });

    expect(run.status).not.toBe(0);
    expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
  });

  test("a name on the removal list whose row is still there stops the refresh", () => {
    const run = runRefresh({ removals: "Minna Van\n" });

    expect(run.status).not.toBe(0);
    // Names the person, so the student knows which row is still to go.
    expect(run.stderr).toContain("Minna Van");
    expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
    expect(readFileSync(run.csv, "utf8")).toBe(run.before.csv);
  });

  test("a removal carried through to the roster passes, and refreshes", () => {
    const run = runRefresh({ dropRowsFor: "Minna Van", removals: "Minna Van\n" });
    const after = claimsIn(readFileSync(run.readme, "utf8"));

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("Minna Van");
    expect(after.people).toBe(parseRosterCsv(readFileSync(run.csv, "utf8")).length);
  });

  test.each([
    ["a list nobody is on", "# nobody yet\n"],
    ["an empty list", ""],
    ["no list at all", null],
  ])("%s leaves the refresh exactly as it was", (_case, removals) => {
    const run = runRefresh({ removals });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("unfinished removal");
    expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
  });

  describe("a removal written under a spelling the roster settled", () => {
    const CONFIRMED =
      "Tim MacDougal\tTim MacDougall\thttps://web.archive.org/web/20260516055532id_/https://www.enactussfu.ca/competition\tcaptain\t2026-08-06\n";

    test("is the same unfinished removal as any other, and stops the refresh", () => {
      const run = runRefresh({ removals: "Tim MacDougal\n", spellings: CONFIRMED });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("unfinished removal");
      // Names the row as the file spells it, so the student knows what to delete.
      expect(run.stderr).toContain("Tim MacDougall");
      expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
    });

    test("passes once the row is gone, under either spelling", () => {
      for (const written of ["Tim MacDougal", "Tim MacDougall"]) {
        const run = runRefresh({
          dropRowsFor: "Tim MacDougall",
          removals: `${written}\n`,
          spellings: CONFIRMED,
        });

        expect(run.status).toBe(0);
        expect(run.stderr).not.toContain("unfinished removal");
      }
    });

    test("with nothing confirmed it is a warning naming the other spelling, never a refusal", () => {
      const run = runRefresh({ removals: "Tim MacDougal\n" });

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("possibly unfinished removal");
      expect(run.stderr).toMatch(
        /on the list: Tim MacDougal\s+\/\s+still in the file: Tim MacDougall/,
      );
      // A warning refreshes the README; only a refusal leaves it alone.
      expect(readFileSync(run.readme, "utf8")).toBe(run.before.readme);
    });

    test.each([
      ["a list nobody is on", "# nobody yet\n"],
      ["an empty list", ""],
      ["no list at all", null],
      ["a removal correctly carried through", "Minna Van\n"],
    ])("%s says nothing about near misses", (_case, removals) => {
      const run = runRefresh({
        dropRowsFor: removals === "Minna Van\n" ? "Minna Van" : null,
        removals,
      });

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain("possibly unfinished removal");
    });
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

describe("the coverage report, as text", () => {
  const readme = [
    "## Gaps in the record",
    "",
    "A gap is a gap, and this is the only place that counts anybody:",
    "",
    "```",
    "2015-16   2    2024-25   1  ← coaches only",
    "",
    "people 3    with no year 6    earliest 2015-16    latest 2024-25",
    "years covered 2 of the 10 academic years since the chapter was founded in 1991",
    "```",
    "",
    "The people with no year are the Community Spotlight names.",
    "",
  ].join("\n");

  const reportIn = (text: string) =>
    parseCoverageReport(/## Gaps in the record[\s\S]*?```\n([\s\S]*?)```/.exec(text)?.[1] ?? "");

  test("the table and the totals beneath it are rewritten together", () => {
    const refreshed = reportIn(
      refreshCoverageClaims(
        readme,
        9,
        {
          years: [
            ["2015-16", 4],
            ["2024-25", 5],
          ],
          undated: 2,
        },
        2026,
      ),
    );

    expect(refreshed.years).toEqual([
      ["2015-16", 4],
      ["2024-25", 5],
    ]);
    expect(refreshed.people).toBe(9);
    expect(refreshed.yearsCovered).toBe(2);
    expect(refreshed.undated).toBe(2);
    expect(refreshed.earliest).toBe("2015-16");
    expect(refreshed.latest).toBe("2024-25");
  });

  test("the span runs from the founding year, not from the roster's earliest row", () => {
    const withFounder = reportIn(
      refreshCoverageClaims(
        readme,
        2,
        {
          years: [
            ["1991", 1],
            ["2026-27", 1],
          ],
          undated: 0,
        },
        2026,
      ),
    );
    const withoutFounder = reportIn(
      refreshCoverageClaims(readme, 1, { years: [["2026-27", 1]], undated: 0 }, 2026),
    );

    expect(withFounder.span).toBe(36);
    expect(withFounder.yearsCovered).toBe(2);
    // Losing the earliest row costs the numerator, never the denominator.
    expect(withoutFounder.span).toBe(36);
    expect(withoutFounder.yearsCovered).toBe(1);
    expect(withoutFounder.foundingYear).toBe(1991);
  });

  test("the span moves with the year the roster was captured, and nothing else", () => {
    const later = reportIn(
      refreshCoverageClaims(readme, 1, { years: [["2026-27", 1]], undated: 0 }, 2030),
    );

    expect(later.span).toBe(40);
  });

  test("a note beside a year survives a refresh that changes its count", () => {
    const refreshed = refreshCoverageClaims(
      readme,
      9,
      {
        years: [
          ["2015-16", 4],
          ["2024-25", 5],
        ],
        undated: 2,
      },
      2026,
    );

    expect(refreshed).toContain("2015-16   4    2024-25   5  ← coaches only");
  });

  test("a year with no note is written without one", () => {
    const refreshed = refreshCoverageClaims(readme, 2, { years: [["1991", 2]], undated: 0 }, 2026);
    expect(refreshed).toContain("```\n1991      2\n");
  });

  test("a README whose report has moved throws rather than leaving it stale", () => {
    expect(() =>
      refreshCoverageClaims(
        readme.replace("## Gaps in the record", "## Gaps"),
        3,
        { years: [["2015-16", 3]], undated: 0 },
        2026,
      ),
    ).toThrow();
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

describe("recording where a cached page came from", () => {
  const FETCH_SCRIPT = fileURLToPath(
    new URL("../scripts/alumni-roster/fetch-snapshots.sh", import.meta.url),
  );

  /**
   * Stands in for curl: answers a CDX query with one capture and writes a body
   * to whatever `-o` names. Enough for the archived path as well as the live
   * one, which is where a cached page's provenance can go stale.
   */
  const STUB_CURL = `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *cdx/search*)
    if [ -n "$out" ]; then
      printf '20260114044549 http://enactussfu.com/community-spotlight-ivy-so/ 200\\n' > "$out"
    else
      printf '20260114044549 200 DIGESTAAA\\n'
    fi
    ;;
  *) [ -n "$out" ] && printf '<h3>a page</h3>' > "$out" ;;
esac
exit 0
`;

  const liveRow = (url: string) => `team (live)\tlive\tlive-team\t-\t${url}\t-\n`;
  const archivedRow = (url: string) =>
    `executives\tarchived\texec\tenactussfu.com/executives/\t${url}\t-\n`;
  const ARCHIVED_PAGE = "exec-20260114044549.html";
  const archivedUrl = (url: string) => `https://web.archive.org/web/20260114044549id_/${url}`;

  /** The fetcher, run against a registry declaring one source. */
  function runFetch(
    cacheDir: string,
    url: string,
    { row = liveRow, cwd = undefined as string | undefined } = {},
  ) {
    const root = mkdtempSync(path.join(tmpdir(), "alumni-fetch-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });

    const script = path.join(root, "fetch-snapshots.sh");
    copyFileSync(FETCH_SCRIPT, script);
    writeFileSync(path.join(root, "sources.tsv"), row(url));

    return spawnSync("bash", [script, cacheDir], {
      encoding: "utf8",
      cwd,
      env: { ...inheritedEnv, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
  }

  /**
   * A repository that ignores `.cache/`, inside a plain directory that is not a
   * repository at all — the two positions the guard has to tell apart, neither
   * of which may be decided by where the command happened to be run from.
   * Realpathed, because git answers in physical paths and a comparison against
   * a symlinked `/var` would be deciding something else.
   */
  function scaffoldRepo() {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "alumni-guard-")));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    writeFileSync(path.join(repo, ".gitignore"), ".cache/\n");
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    return { root, repo };
  }

  /** manifest.tsv is persisted state the build reads; the last line for a name wins. */
  const recordedUrl = (cacheDir: string, file: string) =>
    readFileSync(path.join(cacheDir, "manifest.tsv"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith(`${file}\t`))
      .at(-1)
      ?.split("\t")[1];

  test("a live page re-fetched from a new URL is recorded against the URL it came from", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "alumni-cache-"));

    const first = runFetch(cacheDir, "https://www.enactussfu.ca/team");
    expect(first.status).toBe(0);
    expect(recordedUrl(cacheDir, "live-team.html")).toBe("https://www.enactussfu.ca/team");

    // The club renames the page and the maintainer edits that one registry row.
    const second = runFetch(cacheDir, "https://www.enactussfu.ca/our-team");
    expect(second.status).toBe(0);
    expect(recordedUrl(cacheDir, "live-team.html")).toBe("https://www.enactussfu.ca/our-team");
  });

  test("re-fetching from the same URL does not grow the manifest", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "alumni-cache-"));
    runFetch(cacheDir, "https://www.enactussfu.ca/team");
    runFetch(cacheDir, "https://www.enactussfu.ca/team");

    const lines = readFileSync(path.join(cacheDir, "manifest.tsv"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("live-team.html\t"));
    expect(lines).toHaveLength(1);
  });

  test("a cached page keeps the URL it was actually fetched from, not the registry's latest", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "alumni-cache-"));
    const fetched = "http://enactussfu.com/executives/";

    expect(runFetch(cacheDir, fetched, { row: archivedRow }).status).toBe(0);
    expect(recordedUrl(cacheDir, ARCHIVED_PAGE)).toBe(archivedUrl(fetched));

    // The maintainer edits that one registry row. The page is already on disk,
    // so it is not downloaded again — and so it did not come from the new URL.
    const second = runFetch(cacheDir, "https://www.enactussfu.ca/executives", { row: archivedRow });
    expect(second.status).toBe(0);
    expect(recordedUrl(cacheDir, ARCHIVED_PAGE)).toBe(archivedUrl(fetched));
  });

  test("a cached page the manifest forgot is fetched again, not stamped with a guess", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "alumni-cache-"));
    const fetched = "http://enactussfu.com/executives/";
    runFetch(cacheDir, fetched, { row: archivedRow });

    // build.ts drops a page the manifest does not know and says to re-run this
    // script, so re-running has to genuinely record it.
    writeFileSync(path.join(cacheDir, "manifest.tsv"), "");
    expect(runFetch(cacheDir, fetched, { row: archivedRow }).status).toBe(0);
    expect(recordedUrl(cacheDir, ARCHIVED_PAGE)).toBe(archivedUrl(fetched));
  });

  test("a registry checked out with CRLF line endings is read, not reported twice", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "alumni-cache-"));
    const url = "https://www.enactussfu.ca/team";

    // parseSourceRegistry trims every field, so a carriage return on the last
    // column is one whitespace problem — not a malformed filter here and a
    // malformed registry there.
    const run = runFetch(cacheDir, url, { row: (u) => liveRow(u).replace(/\n/g, "\r\n") });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("line 1");
    expect(recordedUrl(cacheDir, "live-team.html")).toBe(url);
  });

  test("both readers reject the same registry, so neither finds a source the other cannot", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "alumni-cache-"));
    const clashing = "a\tarchived\tlive\tp\thttps://example.invalid/a\t-\n" +
      "b\tlive\tlive-team\t-\thttps://example.invalid/b\t-\n";

    const fetched = runFetch(cacheDir, "unused", { row: () => clashing });

    expect(fetched.status).not.toBe(0);
    expect(fetched.stderr).toContain("would claim each other's pages");
    expect(() => parseSourceRegistry(clashing)).toThrow(/would claim each other's pages/);
  });

  test("a cache inside the repository that git does not ignore is refused, unwritten", () => {
    const inRepo = fileURLToPath(new URL("../not-ignored-cache", import.meta.url));
    rmSync(inRepo, { recursive: true, force: true });

    try {
      const fetched = runFetch(inRepo, "https://www.enactussfu.ca/team");
      expect(fetched.status).not.toBe(0);
      // Refused before anything was written, not warned about afterwards.
      expect(existsSync(inRepo)).toBe(false);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  test("the build refuses one too, and it is the guard that refuses it", () => {
    const inRepo = fileURLToPath(new URL("../not-ignored-cache", import.meta.url));
    const outDir = mkdtempSync(path.join(tmpdir(), "alumni-guard-out-"));
    const outFile = path.join(outDir, "past-executives.csv");
    rmSync(inRepo, { recursive: true, force: true });

    try {
      // A cache this build could otherwise read all the way through: a page, its
      // manifest entry and a removal list beside the output. With the guard taken
      // out the run gets past every other gate, so the refusal below is the
      // guard's and not a missing manifest standing in for it.
      mkdirSync(inRepo);
      writeFileSync(path.join(inRepo, CACHED_PAGE), CACHED_HTML);
      writeFileSync(path.join(inRepo, "manifest.tsv"), `${CACHED_PAGE}\t${CACHED_URL}\n`);
      writeFileSync(path.join(outDir, "removed.txt"), "# nobody yet\n");
      const registry = path.join(outDir, "sources.tsv");
      writeFileSync(registry, `${TEAM_ROW}\n`);

      const built = spawnSync(
        process.execPath,
        ["--experimental-strip-types", BUILD_SCRIPT, inRepo, outFile, registry],
        { encoding: "utf8", env: inheritedEnv },
      );

      expect(built.status).not.toBe(0);
      expect(built.stderr).toContain("refusing to read a cache git does not ignore");
      expect(existsSync(outFile)).toBe(false);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  test("the cache git is told to ignore is allowed", () => {
    const ignored = fileURLToPath(new URL("../.cache/alumni-roster-fixture", import.meta.url));
    try {
      const run = runFetch(ignored, "https://www.enactussfu.ca/team");

      expect(run.status).toBe(0);
      expect(recordedUrl(ignored, "live-team.html")).toBe("https://www.enactussfu.ca/team");
    } finally {
      rmSync(ignored, { recursive: true, force: true });
    }
  });

  describe("the guard asks about the cache path, not the working directory", () => {
    test("a run started outside any repository still cannot write into one", () => {
      const { root, repo } = scaffoldRepo();
      const target = path.join(repo, "holds-real-pages");

      // Started from `root`, which is not a repository at all: the old guard
      // asked git where it was, got no answer, and took that for permission.
      const fetched = runFetch("repo/holds-real-pages", "https://www.enactussfu.ca/team", {
        cwd: root,
      });

      expect(fetched.status).not.toBe(0);
      expect(fetched.stderr).toContain("refusing to cache archived pages");
      expect(existsSync(target)).toBe(false);
    });

    test("the build, started outside any repository, refuses the same path", () => {
      const { root, repo } = scaffoldRepo();
      const built = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          BUILD_SCRIPT,
          path.join(repo, "holds-real-pages"),
          path.join(root, "unused.csv"),
        ],
        { encoding: "utf8", cwd: root, env: inheritedEnv },
      );

      expect(built.status).not.toBe(0);
      expect(built.stderr).toContain("refusing to read a cache git does not ignore");
    });

    test("an ignored path in that repository is still allowed from outside it", () => {
      const { root, repo } = scaffoldRepo();
      const run = runFetch("repo/.cache/alumni-roster", "https://www.enactussfu.ca/team", {
        cwd: root,
      });

      expect(run.status).toBe(0);
      expect(recordedUrl(path.join(repo, ".cache/alumni-roster"), "live-team.html")).toBe(
        "https://www.enactussfu.ca/team",
      );
    });

    test("a relative path that leaves the repository is not mistaken for one inside it", () => {
      const { root, repo } = scaffoldRepo();

      // "$PWD/../outside" spells a string starting with the repository's path
      // while naming somewhere else entirely. Comparing the strings refused it
      // with a diagnosis that was simply wrong.
      const run = runFetch("../outside", "https://www.enactussfu.ca/team", { cwd: repo });

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain("refusing");
      expect(recordedUrl(path.join(root, "outside"), "live-team.html")).toBe(
        "https://www.enactussfu.ca/team",
      );
    });
  });
});

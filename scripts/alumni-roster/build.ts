/**
 * Build config/alumni/past-executives.csv from the snapshot cache.
 *
 *   scripts/alumni-roster/fetch-snapshots.sh
 *   node --experimental-strip-types scripts/alumni-roster/build.ts
 *
 * Or, with no cache and no network, bring the README's coverage report back in
 * line with the committed roster — which is all honouring a removal needs:
 *
 *   node --experimental-strip-types scripts/alumni-roster/build.ts --refresh-readme
 *
 * Every row comes from a page in the cache, and every source_url is the URL the
 * fetcher recorded in manifest.tsv when it retrieved that page — not a URL this
 * script reconstructs from a filename. Nothing is added by hand, so re-running
 * against a re-fetched cache reproduces the file.
 *
 * A source that yields nothing is reported rather than quietly skipped: a gap in
 * the record is a gap, and config/alumni/README.md lists the ones we know of.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  academicYearOfCapture,
  applyRemovals,
  capturedAcademicYear,
  coverageByYear,
  findNearDuplicates,
  mergeSightings,
  nameKey,
  parseRemovalList,
  parseRosterCsv,
  refreshCoverageClaims,
  parseSourceList,
  parseSourceRegistry,
  sourceOfCacheFile,
  parseAlumniBusinessOwners,
  parseCompetitionCoaches,
  parseNextTeam,
  parseSpotlightName,
  parseSquarespaceTeam,
  parseWixTeam,
  parseWixTeamYear,
  parseWordpressRoster,
  toCsv,
  type Confidence,
  type RosterRow,
  type Sighting,
  type Source,
} from "./parse.ts";

/**
 * Recompute what config/alumni/README.md says about the roster from the roster
 * itself, and nothing else: no cache, no registry, no network. A removal has to
 * be honourable the same day on a fresh clone with no snapshots, which is why
 * deleting the row by hand is allowed at all — so the report that describes the
 * file has to be fixable the same way.
 */
/**
 * Honouring a removal is two edits — the name onto removed.txt, the row out of
 * the roster — and only the second one takes the person out of the file that
 * ships. The first without the second leaves someone who asked to be taken off
 * a list still on it, with nothing to say so. So when the refresh reads the
 * roster it also reads the list beside it, and stops if it finds a name on both.
 *
 * It fails on that and nothing else: no list, an empty list, or a listed name
 * whose row is properly gone all pass exactly as before, silently. It reads two
 * files in one directory, so it stays as cache-free and offline as the refresh
 * it runs inside, and it adds no step to the procedure a student follows.
 */
function refuseUnfinishedRemoval(rows: RosterRow[], csvFile: string, removalPath: string): void {
  if (!existsSync(removalPath)) return;

  const removed = parseRemovalList(readFileSync(removalPath, "utf8"));
  const stillListed = rows.filter((row) => removed.has(nameKey(row.name)));
  if (!stillListed.length) return;

  console.error(
    `unfinished removal: ${stillListed.map((row) => row.name).join(", ")}\n` +
      `Named on ${removalPath}, but ${csvFile} still carries a row for each of them.\n` +
      `Deleting the row is what takes someone out of the file that ships, so the\n` +
      `removal is not done yet. Delete those rows and run this command again —\n` +
      `nothing else is needed, and no cache or network either way.`,
  );
  process.exit(1);
}

if (process.argv[2] === "--refresh-readme") {
  const csvFile = process.argv[3] ?? "config/alumni/past-executives.csv";
  const readmeFile = process.argv[4] ?? "config/alumni/README.md";

  let refreshed: string;
  let people: number;
  let coverage: ReturnType<typeof coverageByYear>;
  try {
    const rows = parseRosterCsv(readFileSync(csvFile, "utf8"));
    refuseUnfinishedRemoval(rows, csvFile, path.join(path.dirname(csvFile), "removed.txt"));
    people = rows.length;
    coverage = coverageByYear(rows);
    refreshed = refreshCoverageClaims(
      readFileSync(readmeFile, "utf8"),
      people,
      coverage,
      capturedAcademicYear(rows),
    );
  } catch (error) {
    console.error(
      `cannot refresh ${readmeFile} from ${csvFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  writeFileSync(readmeFile, refreshed);
  console.log(`people:    ${people}`);
  console.log(
    `coverage:  ${coverage.years.map(([year, n]) => `${year}=${n}`).join(", ")}` +
      (coverage.undated ? `, no year=${coverage.undated}` : ""),
  );
  console.log(`refreshed: ${readmeFile}  (${csvFile} was not touched)`);
  process.exit(0);
}

const cacheDir = process.argv[2] ?? ".cache/alumni-roster";
const outFile = process.argv[3] ?? "config/alumni/past-executives.csv";

/**
 * The same refusal the fetcher makes, at the other entry point: a cache inside
 * the repository that git does not ignore holds the role addresses, phone
 * numbers and employers the shipped file exists to leave behind, one
 * `git add -A` away from a commit that cannot be taken back. Asking git rather
 * than re-reading the ignore rules keeps one answer, not two.
 */
function refuseUnignoredCache(dir: string): void {
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (toplevel.status !== 0) return;

  const repo = toplevel.stdout.trim();
  const absolute = path.resolve(dir);
  if (absolute !== repo && !absolute.startsWith(repo + path.sep)) return;
  if (spawnSync("git", ["check-ignore", "-q", absolute], { encoding: "utf8" }).status === 0) return;

  console.error(
    `refusing to read a cache git does not ignore: ${absolute}\n` +
      `That path is inside this repository, so the raw archived pages in it — role email\n` +
      `addresses, phone numbers, employers — are one 'git add -A' away from the history\n` +
      `of a repository holding real people's records. Use the default\n` +
      `.cache/alumni-roster, add the path to .gitignore, or keep the cache outside the\n` +
      `repository.`,
  );
  process.exit(1);
}

refuseUnignoredCache(cacheDir);
const registryPath = process.argv[4] ?? fileURLToPath(new URL("sources.tsv", import.meta.url));
/** The day the cache was fetched, as the `captured_at` every row carries. */
const capturedAt = process.env.ROSTER_CAPTURED_AT ?? new Date().toISOString().slice(0, 10);

const manifestPath = path.join(cacheDir, "manifest.tsv");
if (!existsSync(manifestPath)) {
  console.error(
    `no ${manifestPath}. Run scripts/alumni-roster/fetch-snapshots.sh first — the roster\n` +
      `records the URL each page was actually fetched from, which only the fetcher knows.`,
  );
  process.exit(1);
}

const sourceUrls = new Map<string, string>();
for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
  const [file, url] = line.split("\t");
  if (file && url) sourceUrls.set(file.trim(), url.trim());
}

function loadRegistry(file: string): Source[] {
  try {
    return parseSourceRegistry(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(
      `cannot read the source registry ${file}: ${error instanceof Error ? error.message : String(error)}\n` +
        `It is the one declaration of what this roster is built from — the fetcher\n` +
        `retrieves what it lists and this build checks what it lists. There is nothing\n` +
        `to build without it.`,
    );
    process.exit(1);
  }
}

const sources = loadRegistry(registryPath);

const sightings: Sighting[] = [];
const withoutProvenance: string[] = [];
const undeclared: string[] = [];
const withoutParser = new Set<string>();
// Seeded from the registry, so a source that produced no page at all is a
// source that yielded nothing — the same case, checked by the same gate. Left
// unseeded, a source the fetcher never managed to retrieve simply never became
// a key, and its whole cohort went missing without anything noticing.
const yielded = new Map<string, number>(sources.map((source) => [source.key, 0]));
const record = (source: string, found: number) =>
  yielded.set(source, (yielded.get(source) ?? 0) + found);

const files = readdirSync(cacheDir).filter((f) => f.endsWith(".html")).sort();
const stampOf = (file: string) => /-(\d{14})/.exec(file)?.[1] ?? null;

for (const file of files) {
  const sourceUrl = sourceUrls.get(file);
  if (!sourceUrl) {
    // Provenance is the point of this file. A page with no recorded source
    // cannot produce a row, however good its content is.
    withoutProvenance.push(file);
    console.warn(`dropped (not in manifest, so no source URL): ${file}`);
    continue;
  }

  // Nothing reaches the roster from a page no declared source claims. Dropping
  // files into the cache is otherwise a way to add a source the registry — and
  // so the zero-yield gate — has never heard of.
  const source = sourceOfCacheFile(file, sources);
  if (!source) {
    undeclared.push(file);
    console.warn(`dropped (no source in ${registryPath} claims this name): ${file}`);
    continue;
  }

  const html = readFileSync(path.join(cacheDir, file), "utf8");
  const timestamp = stampOf(file);
  const captureYear = timestamp
    ? academicYearOfCapture(timestamp)
    : academicYearOfCapture(`${capturedAt.replace(/-/g, "")}000000`);

  const add = (
    entries: Array<{ name: string; role: string; year?: string }>,
    year: string,
    confidence: Confidence,
  ) => {
    for (const entry of entries) {
      sightings.push({
        name: entry.name,
        role: entry.role,
        year: entry.year ?? year,
        sourceUrl,
        capturedAt,
        confidence,
      });
    }
  };

  switch (source.key) {
    // --- club roster pages: name and role are a structured record on the page
    case "executives":
    case "program-managers":
    case "project-managers": {
      const entries = parseWordpressRoster(html);
      record(source.key, entries.length);
      add(entries, captureYear, "high");
      break;
    }

    case "the-team": {
      const entries = parseSquarespaceTeam(html);
      record(source.key, entries.length);
      add(entries, captureYear, "high");
      break;
    }

    case "team":
    case "team (live)": {
      const entries = parseNextTeam(html);
      record(source.key, entries.length);
      add(entries, captureYear, "high");
      break;
    }

    case "our-team": {
      const entries = parseWixTeam(html);
      // the Wix page declares its own year — prefer it to the capture date
      record(source.key, entries.length);
      add(entries, parseWixTeamYear(html) ?? captureYear, "high");
      break;
    }

    // --- the 2012 alumni page, the only source naming pre-2012 executives
    case "alumni": {
      const entries = parseAlumniBusinessOwners(html);
      record(source.key, entries.length);
      for (const entry of entries) {
        // "President 2004/2005" states a term. "Founded organization in 1991"
        // mentions a year inside prose — the same fact, less firmly recorded.
        const statedTerm = entry.year !== null && /^\d{4}-\d{2}$/.test(entry.year);
        sightings.push({
          name: entry.name,
          role: entry.role,
          year: entry.year ?? "",
          sourceUrl,
          capturedAt,
          confidence: statedTerm ? "high" : "medium",
        });
      }
      break;
    }

    // --- competition coaches: named by the club, but in a comma-run inside a
    //     sentence rather than as a structured roster record
    case "competition":
    case "competition (live)": {
      const entries = parseCompetitionCoaches(html);
      record(source.key, entries.length);
      add(entries, captureYear, "medium");
      break;
    }

    // --- a spotlight post names an alum in its title and states no role or term
    case "community spotlight": {
      const name = parseSpotlightName(html);
      record(source.key, name ? 1 : 0);
      if (name) {
        sightings.push({ name, role: "", year: "", sourceUrl, capturedAt, confidence: "low" });
      }
      break;
    }

    default:
      withoutParser.add(source.key);
  }
}

/**
 * The file has to state its own handling rules, because a CSV travels: it gets
 * opened in a spreadsheet, pasted into a chat, mailed to next year's exec. The
 * README beside it is the long form; this is what survives the trip.
 */
const HEADER = `# Enactus SFU past-executive and alumni roster.
#
# PRIVATE. Do not publish, share outside the External Relations team, or commit
# to a public repository. These are real people, most of them former students,
# and the club published their names to introduce a team - not to build a list.
# An alum's connection to this club is personal information about them: it sits
# outside PIPEDA's business-contact exemption and outside BC PIPA's
# contact-information carve-out, so this file carries obligations that the
# company data elsewhere in this repository does not.
#
# THIS IS A RESEARCH SEED, NOT A CONTACT LIST. Its one job is to let the pipeline
# recognise an alumni connection to a company it has already found on its own.
# Do not contact anyone because they appear here.
#
# Only what the club itself published: name, role, years. No email addresses, no
# phone numbers, no LinkedIn profile data, no employers, no personal detail.
#
# Anyone named here may ask to be removed. See config/alumni/README.md; honour it
# the same day and never ask why.
#
# Generated by scripts/alumni-roster/build.ts - edit that, not this.
`;

// A cached page the manifest does not know about is a page whose rows are
// missing from this run — most likely because a re-fetch could not re-enumerate
// its source. Overwriting the roster with a quietly smaller one is the one
// outcome worse than not writing it, so this stops before the write.
if (withoutProvenance.length) {
  console.error(
    `\n${withoutProvenance.length} cached page(s) have no source URL in ${manifestPath}, so a roster\n` +
      `built from this cache would silently be missing whatever they hold. ${outFile}\n` +
      `was left untouched. Re-run scripts/alumni-roster/fetch-snapshots.sh to record them.`,
  );
  process.exit(1);
}

if (undeclared.length) {
  console.error(
    `\n${undeclared.length} cached page(s) belong to no source in ${registryPath}.\n` +
      `A page nothing declares is a source the zero-yield gate cannot check, so ${outFile}\n` +
      `was left untouched. Declare the source with one row in the registry, or take the\n` +
      `pages out of the cache.`,
  );
  process.exit(1);
}

if (withoutParser.size) {
  console.error(
    `\n${registryPath} declares source(s) this build cannot parse: ${[...withoutParser].join(", ")}\n` +
      `Their pages were fetched and read and nothing came of them. Add the parser to\n` +
      `scripts/alumni-roster/build.ts; ${outFile} was left untouched.`,
  );
  process.exit(1);
}

// Anyone named here asked to be left out. Applied before the merge, so a
// removal survives every future rebuild instead of reappearing at the next one.
// The list is required, not optional: "no file" and "nobody asked" have to be
// distinguishable, or a deleted list quietly reinstates everyone on it.
const removalPath = path.join(path.dirname(outFile), "removed.txt");
if (!existsSync(removalPath)) {
  console.error(
    `no ${removalPath}. A removal request is honoured by that file and nothing else,\n` +
      `so the roster cannot be rebuilt without reading it. An empty list is a file with\n` +
      `no names in it, never a missing file — restore it from git and re-run.`,
  );
  process.exit(1);
}
const removed = parseRemovalList(readFileSync(removalPath, "utf8"));
const kept = applyRemovals(sightings, removed);
const suppressed = sightings.length - kept.length;

const rows = mergeSightings(kept);

const count = (level: Confidence) => rows.filter((r) => r.confidence === level).length;
const coverage = coverageByYear(rows);
console.log(`sightings: ${sightings.length}`);
console.log(
  `removed:   ${removed.size} name(s) on ${removalPath}, ${suppressed} sighting(s) suppressed`,
);
console.log(
  `people:    ${rows.length}  (high ${count("high")}, medium ${count("medium")}, low ${count("low")})`,
);
console.log(`sources:   ${[...yielded].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(
  `coverage:  ${coverage.years.map(([year, people]) => `${year}=${people}`).join(", ")}` +
    (coverage.undated ? `, no year=${coverage.undated}` : ""),
);

const nearDuplicates = findNearDuplicates(rows);
if (nearDuplicates.length) {
  console.warn(
    `\nnear-duplicate names, left unmerged because choosing a spelling would invent a name:`,
  );
  for (const [a, b] of nearDuplicates) console.warn(`  ${a}  /  ${b}`);
}

// A near-duplicate is a known property of the club's own pages. A source that
// parsed to nothing is not: it is a redesigned page taking its whole cohort with
// it, and a roster missing that cohort still looks perfectly plausible. Only the
// sources named on the list below are allowed to come back empty, and a missing
// list exempts nobody — the strictest reading, which is the safe one here.
const expectedEmptyPath = path.join(path.dirname(outFile), "expected-empty-sources.txt");
const expectedEmpty = existsSync(expectedEmptyPath)
  ? parseSourceList(readFileSync(expectedEmptyPath, "utf8"))
  : new Set<string>();

const empty = [...yielded].filter(([, found]) => found === 0).map(([source]) => source);
const unexpectedlyEmpty = empty.filter((source) => !expectedEmpty.has(source));

for (const source of empty) {
  if (expectedEmpty.has(source)) {
    console.warn(`\nsource yielded no names, and ${expectedEmptyPath} says to expect that: ${source}`);
  }
}
for (const source of expectedEmpty) {
  if (!yielded.has(source)) {
    console.warn(
      `\nstale entry on ${expectedEmptyPath}: ${registryPath} declares no source called ${source}, so it exempts nothing`,
    );
  } else if ((yielded.get(source) ?? 0) > 0) {
    console.warn(`\nstale entry on ${expectedEmptyPath}: ${source} is producing names again`);
  }
}

if (unexpectedlyEmpty.length) {
  console.error(
    `\nsource(s) that produced no names: ${unexpectedlyEmpty.join(", ")}\n` +
      `Nothing was fetched for them, or their row in ${registryPath} no longer\n` +
      `describes the pages, or the pages no longer parse — a layout the club changed\n` +
      `takes its whole cohort with it, and the smaller roster that produces looks\n` +
      `perfectly plausible. ${outFile} was left untouched. Re-run the fetcher, check the\n` +
      `registry row, fix the parser — or, if the club has retired the page for good,\n` +
      `name the source on ${expectedEmptyPath} and re-run.`,
  );
  process.exit(1);
}

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, HEADER + toCsv(rows));
console.log(`wrote:     ${outFile}`);
console.log(
  `next:      node --experimental-strip-types scripts/alumni-roster/build.ts --refresh-readme\n` +
    `           (brings the coverage report in config/alumni/README.md back in line)`,
);

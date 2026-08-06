/**
 * Build config/alumni/past-executives.csv from the snapshot cache.
 *
 *   scripts/alumni-roster/fetch-snapshots.sh
 *   node --experimental-strip-types scripts/alumni-roster/build.ts
 *
 * Every row comes from a page in the cache, and every source_url is the URL the
 * fetcher recorded in manifest.tsv when it retrieved that page — not a URL this
 * script reconstructs from a filename. Nothing is added by hand, so re-running
 * against a re-fetched cache reproduces the file.
 *
 * A source that yields nothing is reported rather than quietly skipped: a gap in
 * the record is a gap, and config/alumni/README.md lists the ones we know of.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  academicYearOfCapture,
  applyRemovals,
  coverageByYear,
  findNearDuplicates,
  mergeSightings,
  parseRemovalList,
  parseSourceList,
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
  type Sighting,
} from "./parse.ts";

const cacheDir = process.argv[2] ?? ".cache/alumni-roster";
const outFile = process.argv[3] ?? "config/alumni/past-executives.csv";
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

const sightings: Sighting[] = [];
const withoutProvenance: string[] = [];
const yielded = new Map<string, number>();
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

  // --- club roster pages: name and role are a structured record on the page
  if (file.startsWith("exec-") || file.startsWith("pm-") || file.startsWith("projectpm-")) {
    const entries = parseWordpressRoster(html);
    const kind = file.startsWith("exec-")
      ? "executives"
      : file.startsWith("pm-")
        ? "program-managers"
        : "project-managers";
    record(kind, entries.length);
    add(entries, captureYear, "high");
    continue;
  }

  if (file.startsWith("theteam-")) {
    const entries = parseSquarespaceTeam(html);
    record("the-team", entries.length);
    add(entries, captureYear, "high");
    continue;
  }

  if (file.startsWith("team-") || file === "live-team.html") {
    const entries = parseNextTeam(html);
    record(file === "live-team.html" ? "team (live)" : "team", entries.length);
    add(entries, captureYear, "high");
    continue;
  }

  if (file.startsWith("ourteam-")) {
    const entries = parseWixTeam(html);
    // the Wix page declares its own year — prefer it to the capture date
    record("our-team", entries.length);
    add(entries, parseWixTeamYear(html) ?? captureYear, "high");
    continue;
  }

  // --- the 2012 alumni page, the only source naming pre-2012 executives
  if (file.startsWith("alumni-")) {
    const entries = parseAlumniBusinessOwners(html);
    record("alumni", entries.length);
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
    continue;
  }

  // --- competition coaches: named by the club, but in a comma-run inside a
  //     sentence rather than as a structured roster record
  if (file.startsWith("competition-") || file === "live-competition.html") {
    const entries = parseCompetitionCoaches(html);
    record(file === "live-competition.html" ? "competition (live)" : "competition", entries.length);
    add(entries, captureYear, "medium");
    continue;
  }

  // --- a spotlight post names an alum in its title and states no role or term
  if (file.startsWith("spotlight-")) {
    const name = parseSpotlightName(html);
    record("community spotlight", name ? 1 : 0);
    if (name) sightings.push({ name, role: "", year: "", sourceUrl, capturedAt, confidence: "low" });
    continue;
  }

  console.warn(`skipped (no parser for this name): ${file}`);
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
    console.warn(`\nstale entry on ${expectedEmptyPath}: no source called ${source} ran at all`);
  } else if ((yielded.get(source) ?? 0) > 0) {
    console.warn(`\nstale entry on ${expectedEmptyPath}: ${source} is producing names again`);
  }
}

if (unexpectedlyEmpty.length) {
  console.error(
    `\nsource(s) that parsed to no names: ${unexpectedlyEmpty.join(", ")}\n` +
      `A page whose layout changed parses to nothing and takes its whole cohort with it,\n` +
      `and the smaller roster that produces looks perfectly plausible. ${outFile} was\n` +
      `left untouched. Fix the parser — or, if the club has retired the page for good,\n` +
      `name the source on ${expectedEmptyPath} and re-run.`,
  );
  process.exit(1);
}

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, HEADER + toCsv(rows));
console.log(`wrote:     ${outFile}`);

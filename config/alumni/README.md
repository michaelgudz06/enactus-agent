# Enactus SFU past-executive and alumni roster

`past-executives.csv` is a reconstruction of who has held a named role in Enactus
SFU — and its earlier names, ACE SFU and SIFE Simon Fraser — assembled from pages
the club itself published between 2012 and today.

**The club has no master alumni sheet.** It was asked, and it does not hold one.
That is why this file exists and why it is a reconstruction rather than an export.
Everything in it was recovered from public archives of the club's own websites.

---

## Read this before you open the file

These are real people. Most of them were students when the club published their
names, and they published them to introduce a team — not to be found later by a
prospecting tool.

- **The repository is private and must stay private.** An alum's connection to
  this club is *personal information about that person*. It falls outside
  PIPEDA's business-contact exemption (s. 4.01) and outside BC PIPA's
  contact-information carve-out, which means it does not get the lighter handling
  the company data elsewhere in this repository gets. BC PIPA also carries a
  private right of action, so a student is personally exposed if this leaks. Do
  not publish it, do not make the repository public, do not paste it into a
  shared document, and do not send it outside the External Relations team.
- **This is a research seed, never a contact list.** Its one job: when the
  pipeline independently finds a company, this file lets it *recognise* that a
  named person connected to that company also appears in the club's own history.
  It is a join key. Nobody is contacted because they are on it.
- **Only name, role and years.** No email addresses, no phone numbers, no
  LinkedIn profile data, no employers, no photos, no personal detail of any kind.
  Several source pages carry all of those. The parsers deliberately do not read
  them — see "How the privacy rule is enforced" below.
- **LinkedIn is never fetched.** The club's current team page publishes a
  LinkedIn URL for each executive. We record that the club publishes such links;
  we do not retrieve, scrape, or store anything behind them, at any scale, ever.

### If someone asks to be removed

They can. There is no threshold to meet, no form, and no reason required.

1. **Add their name to `removed.txt` in this directory**, one name per line,
   with no explanation and no other detail about them. `build.ts` drops every
   sighting of a name on that list, so the removal survives regeneration — this
   is the step that makes it permanent. Deleting the row on its own would not:
   the next person to rebuild the roster would put them straight back. The file
   itself is not optional: `build.ts` refuses to write a roster at all if
   `removed.txt` is missing, and prints how many names it read on every run,
   including zero. A list nobody is on is an empty file, never a deleted one.
2. **Delete their row from `past-executives.csv`.** Just the line. (Rebuilding
   also produces the correct file, but you do not need a working cache to honour
   a removal — that is the point.)
3. **Run the refresh, then commit all three changes that day:**

   ```bash
   node --experimental-strip-types scripts/alumni-roster/build.ts --refresh-readme
   ```

   That rewrites the coverage report under "Gaps in the record" — the only place
   in this file that counts anybody — from the CSV you just edited. The only
   other thing it reads is `removed.txt` beside it: no snapshot cache, no
   network, no archive. It takes a second on a fresh clone, it never touches the
   roster itself, and it is what keeps the tests passing so that honouring a
   removal never leaves you with a red branch to explain. Do not wait for a
   batch, a sprint, or a meeting.

   It reads the removal list to catch step 1 done without step 2: if a name on
   `removed.txt` still has a row in the CSV, the refresh refuses to run and names
   them, because adding the name without deleting the row leaves someone who
   asked to be taken off the file still in it. Delete those rows and run it
   again. It is not an extra step, only a check on the two above.
4. **Reply to them and say it is done.** One line is enough. Do not ask why, do
   not ask them to reconsider, and do not offer to keep a reduced version of
   their entry.
5. If they ask what was held about them, tell them exactly: their name, the role
   the club published, the years, and the archived page it came from. That is the
   whole record. Show them this file if it helps.

Whoever holds the External Relations portfolio owns this. If you are reading this
because you just inherited the role: this paragraph is the part of the handover
that matters most.

---

## Where it came from

Every row was parsed out of a page the club published. Nothing was taken from a
third-party directory, a data vendor, or a social network.

| Source | Retrieved via | What it gives |
|---|---|---|
| `enactussfu.com/executives/` | Wayback, 56 distinct bodies, 2012-12 → 2019-05 | The executive roster, year by year |
| `enactussfu.com/program-managers/` | Wayback, 21 distinct bodies, 2012 → 2017 | Project leads, the layer below exec |
| `enactussfu.com/project-managers/` | Wayback, 2017 → 2019 | The same page after it was renamed; the only source for project leads 2017-2019 |
| `enactussfu.com/alumni/` | Wayback, 2012-2013 captures | The chapter's founder and the pre-2012 presidents, with their terms — the only source that reaches back before 2012 |
| `enactussfu.com/…/community-spotlight-*` | Wayback, 7 posts, 2012-2013 | Alumni named in a post title, with no role and no term |
| `enactussfu.ca/our-team` | Wayback, 2023 capture | The 2022-23 executive, from the Wix-era site |
| `enactussfu.ca/the-team` | Wayback, 2023-10 → 2024-04 | The 2023-24 executive, from the Squarespace-era site |
| `enactussfu.ca/team` | Wayback (2026 captures) + live | The 2025-26 and 2026-27 executives |
| `enactussfu.ca/competition` | Wayback + live | Competition coaches, who are alumni |

The club has run four different websites since 2012 — WordPress on `enactussfu.com`
under three themes, then Wix, then Squarespace, then the current Next.js site.
Each stores its roster differently, so `parse.ts` carries one parser per era and
`parseWordpressRoster` dispatches across the three WordPress themes.

Four things on those same pages are deliberately **not** in the file:

- **Faculty advisors.** `enactussfu.com/faculty-advisors/` names SFU staff. They
  are neither past executives nor alumni, so they are out of scope for a roster
  whose purpose is recognising an *alumni* connection.
- **Competition presenters and designers.** The `/competition` page names them
  alongside the coaches. They are competing members rather than role-holders, and
  where they were also executives they are already in the file from `/team`.
- **Project team members.** The 2024 `/the-team` page lists each project's
  members under the executive cards. They are general members rather than
  role-holders — and the source runs several of the names together with no
  separator (`Ashani PereraWimelia Wong`), so splitting them would be guessing.
- **People named in blog tags.** `enactussfu.com/tag/...` names judges, speakers
  and sponsors' executives. They are third parties, not club members.

Three of these sources — `/program-managers/`, `/project-managers/` and
`/the-team` — are not in the retrieval method the `enactus-org` research
recorded. They were added because they publish exactly the same kind of record
(a student, a named club role, a year), and between them they account for a large
share of the recovered names and for the whole of 2023-24.

## How to regenerate it

```bash
scripts/alumni-roster/fetch-snapshots.sh          # populate .cache/alumni-roster
node --experimental-strip-types scripts/alumni-roster/build.ts
node --experimental-strip-types scripts/alumni-roster/build.ts --refresh-readme
```

The third line is not optional when the second one changed anything: it brings
the coverage report in this file back in line with the roster. The build prints
it as its own last line, for the same reason.

**`scripts/alumni-roster/sources.tsv` declares every source, and both scripts
read it.** The fetcher retrieves exactly the rows it lists; the build checks
every key it lists for a yield, whether or not that source produced a cached
page, and refuses a cached page whose prefix no row claims. Neither script keeps
its own copy of the list, because two lists drift and a source declared in one
place only is a source the checks below cannot see. A missing or malformed
registry stops both scripts.

**Adding a source is three things**, and the build and the tests demand all
three rather than quietly skipping any:

1. **A row in `sources.tsv`** — six tab-separated columns: key, kind
   (`archived`, `spotlight` or `live`), cache prefix, CDX pattern, URL, and the
   post filter a `spotlight` sweep matches its posts by. Write `-` in a column
   the kind does not use; an empty column is a malformed row.
2. **A parser for it in `build.ts`**, dispatched on the key. A declared source
   the build cannot parse is a hard failure, not a skip.
3. **A fixture page in `tests/alumni-roster.test.ts`**, so the test that runs
   every declared source through the build has a page for it to read.

The fetcher caches one snapshot per *unique content digest* — the Wayback CDX
index reports a digest per capture, and captures with the same digest are
byte-identical. `/executives/` has 88 archived captures but only 56 distinct
bodies, so this is 32 requests it does not make against a service that
rate-limits. It is resumable, so a page already in the cache is not re-fetched,
and a page that will not download costs that page and nothing else: the run
carries on, lists the failures at the end, and exits non-zero. Re-run to fill
them. An HTTP error is a failed download like any other — every request is made
with `curl -f`, so a 404 or a rate-limit response leaves no file in the cache
rather than a cached error page that would never be re-fetched.

It writes `manifest.tsv` recording the URL each cached file came from, and
`build.ts` **drops any cached page that is not in the manifest** rather than
guessing a URL for it. A row without real provenance is not a row. The manifest
**accumulates across runs** and is never rebuilt from scratch, because a re-run
whose archive query is rate-limited does not re-enumerate that source: throwing
the old manifest away would strip the provenance from pages already cached, and
the roster would quietly come out short. For the same reason `build.ts` **stops
without writing** if it finds a cached page the manifest does not know about, or
if a source parsed to no names at all. It leaves the committed CSV alone rather
than replacing it with a smaller one.

### When a source parses to nothing

That is the shape of the worst failure available here: the club redesigns a page,
the parser for it matches nothing, and the rebuild drops that page's whole cohort
while every remaining row still looks right. So it is a hard failure — the run
reports the source, refuses to write, and exits non-zero. Fix the parser.

**A source that produced no page at all is the same failure**, and the same gate
catches it: the build starts every source in the registry at zero, so an archive
query that was rate-limited and fetched nothing is a source that yielded nothing,
not a source that quietly went missing. Re-run the fetcher.

A page the club has genuinely retired is the one case where empty is the truth,
and it has an answer that is not "edit the build script": name the source on
**`expected-empty-sources.txt`** in this directory, one per line, `#` for a
comment, using the source key exactly as the run's `sources:` line prints it
(`competition`, `team (live)`, `program-managers`). It ships with nothing
exempted.

The list fails closed and stays honest:

- **Only the named sources are exempt.** Any other source that comes back empty
  is still a hard failure. There is no flag that turns the check off, because a
  flag is what someone reaches for at 2am and then everything is exempt.
- **An entry has to name a source the registry declares.** One that does not is
  reported as exempting nothing, so a typo cannot look like a decision.
- **A missing list is not an error**, unlike `removed.txt`. Absence means no
  source is expected to be empty, which is already the strictest reading. (The
  asymmetry is deliberate: a missing removal list could silently reinstate
  someone who asked to be forgotten, so that one has to fail loudly.)
- **Every exemption the build uses is printed**, naming the source, on the run
  that uses it. So is an entry that has gone stale — one whose source no longer
  runs, or which has started producing names again.

`.cache/alumni-roster/` is gitignored, and must stay that way: the raw pages
carry the role email addresses, phone numbers and employer detail that this file
exists to leave behind. Both scripts enforce it rather than trusting it — each
asks git, and refuses to write to or read from a cache directory inside this
repository that git does not ignore, before a page is fetched or parsed. Point
the cache somewhere else with the first argument to either script, or add that
path to `.gitignore`.

The build is deterministic apart from `captured_at`, which defaults to today. Set
`ROSTER_CAPTURED_AT=YYYY-MM-DD` to reproduce an earlier build exactly.

## The file's shape

The CSV opens with a comment block: **every line before the header starts with
`#`, and the first line that does not is the header row**, `name,role,...`. A
reader has to skip those lines — a stock CSV parser will not. Python's `csv`
module does not skip them either; filter them, or use a reader that takes a
comment character (`pandas.read_csv(..., comment="#")`). No data line can begin
with `#`, because the first column is always a person's name.

The block is there because a CSV travels: it gets opened in a spreadsheet,
pasted into a chat, mailed to next year's exec. It restates the privacy rules
and the removal promise so they arrive with the data. Whatever ends up consuming
this file, that block is part of the contract and is not to be dropped from the
generator.

Then six columns:

| Column | Meaning |
|---|---|
| `name` | As the club published it. ALL CAPS is title-cased; nothing else is changed. |
| `role` | The role label the page carried. Where one person held several, each is listed with its own years: `Director of Program Innovation (2015-16); President (2016-17)`. Empty means the source named the person but stated no role. |
| `years_active` | Academic years, `2016-17`. Consecutive years collapse to a run (`2015-16..2017-18`); a break in service is kept (`2022-23;2025-26..2026-27`). A bare `1991` is a single calendar year, because that is all the source stated. Empty means the source stated no year. |
| `source_url` | The archived (or live) URL the row was read from — one URL per role, in the same order as `role`, `\|`-separated. |
| `captured_at` | The date **we** fetched the page, one entry per role in the same order as `role` and `source_url`, `\|`-separated — repeated even where two roles came off the same page on the same day, so the three columns can always be split and zipped by index. The date the *Internet Archive* captured it is the 14-digit stamp inside `source_url`. |
| `confidence` | How firmly the name was recovered. See below. |

### What `years_active` actually means

**It is the years the person was observed on the club's published roster, not a
claim about when they held office.** The years come from the capture dates of the
snapshots naming them, mapped to the SFU academic year (a capture in August or
later belongs to the year starting then; earlier belongs to the year that started
the previous August).

That mapping is honest but not exact, and the error runs one way: **a club
website that went a year without being updated stretches a span.** If a roster
page was last edited in June 2016 and the Archive captured it again in November,
everyone on it gains a year they may not have served. Treat a two-year span as
"named on the roster across these two captures", not as a two-year term.

Three sources escape this because they state their own year, and those are exact:
the Wix page (*"MEET OUR 2022/2023 TEAM"*), the alumni page (*"President
2004/2005"*), and the competition page, whose own "Previous Years" section maps
its "2026 Regionals" block to the 2025-26 season.

### Confidence

| Level | What it means |
|---|---|
| `high` | Name **and** role read directly out of a structured roster record on a club page — a team card, a titled roster entry, a stated term. This is the great majority of the file. |
| `medium` | The club named the person, but not as a structured roster record. Competition coaches (a comma-separated run inside a sentence, under a year heading) and one alumni-page entry whose role had to be read out of prose. |
| `low` | The club named the person and nothing else. These are the "Community Spotlight" alumni: the post title gives a name, the post body is an interview we do not read, and no role or term is stated anywhere. `role` and `years_active` are empty for these, honestly. (The sweep yields one fewer row than it has posts: one of them names Anoop Aulakh, who is also on the alumni page as a president, so his row is `high` rather than `low`.) |

A person seen more than once takes the **best** confidence of their sightings:
one direct read off a roster page establishes the name, and a later weaker
sighting does not unestablish it.

**`confidence` is about recovery, not about alumni status.** Even a `high` row
only says the club published this name in this role in this year. Whether a
present-day company is *alumni-led* is a separate claim that still has to clear
`G_AFFILIATION_EVIDENCE` in the ICP spec — one tier-1 source, or two independent
tier-2/3 sources on different domains, with the literal string present in
retrieved text. This file is a candidate generator for that check, never a
substitute for it.

## How the privacy rule is enforced

By code, in `scripts/alumni-roster/parse.ts`, not by care:

- `sanitiseFragment` removes the nodes that hold contact detail — `<script>`
  (these pages hide role addresses in obfuscated JavaScript), `<noscript>`, the
  2012 theme's collapsible email panel, and the social-link list on a team card —
  *before* any text is read.
- `carriesContactDetail` rejects any candidate name or role still matching an
  address, a phone number, a URL, or the Archive's own `*protected email*`
  redaction marker. A field that fails is **dropped**, never cleaned up and kept.
- `parseAlumniBusinessOwners` reads only the first sentence of an entry, because
  the sentence after it is the alum's present-day employer.
- `parseSpotlightName` reads only the post title. The body is an interview about
  the person's career, which is exactly what this file must not collect.
- `parseSquarespaceTeam` reads `title` and `description` out of the card payload
  and nothing else. The same JSON blob carries image filenames, author IDs and
  timestamps.
- `parseNextTeam` never touches the LinkedIn `href` on the card it is reading.

`tests/alumni-roster.test.ts` asserts each of these against fixtures that keep the
contact detail the real pages carried.

## Gaps in the record

A gap is a gap. This is what the file covers, by academic year, and it is the
**only place in this README that counts anybody** — every other sentence about
the roster is written without a number, so there is no second count anywhere
that could quietly disagree with it:

```
1991      1    2012-13  14    2016-17  37    2023-24  14
2004-05   1    2013-14  28    2017-18  32    2024-25  12  ← coaches only
2008-09   1    2014-15  17    2018-19  16    2025-26  38
2009-10   1    2015-16  36    2022-23   6    2026-27  33

people 199    with no year 6    earliest 1991    latest 2026-27
years covered 16 of the 36 academic years since the chapter was founded in 1991
```

The people with no year at all are the Community Spotlight names, whose posts
state none, so they appear in no column above. A person counts once in every
year their `years_active` spans, including the years inside a `..` run, so the
columns sum to more than the number of people.

**That block is generated, not maintained.** Do not edit a number in it by hand:

```bash
node --experimental-strip-types scripts/alumni-roster/build.ts --refresh-readme
```

recomputes the whole block from the committed CSV alone — no cache, no network —
and writes it back. `tests/alumni-roster.test.ts` recomputes the same numbers and
fails if they disagree with the roster, so a stale gap report cannot survive a
review. The fix when it fails is that command.

These are the gaps we know about:

- **2019-20, 2020-21 and 2021-22 are missing entirely.** `enactussfu.com` stopped
  being captured after May 2019 and the next site's earliest capture is March
  2023. No archived page names those three cohorts. That is a real hole in the
  club's institutional memory, not a shortfall in the retrieval.
- **2024-25 has no executive roster** — every name under it is a competition
  coach. `/the-team` was last captured in April 2024 and `/team` first in January
  2026, so no roster page from that year survives.
- **2022-23 is only its executives.** The Wix page's "LEADERSHIP TEAM",
  "EVENTS TEAM", "EXTERNAL RELATIONS TEAM" and other sections rendered as photos
  with no names in the HTML, so that layer of that year is unrecoverable from it.
- **The 2025-26 coordinator layer is not in the file.** The `enactus-org`
  research read those names out of the club's Annual Report PDF (pp. 23-24). They
  are not on any club web page, so there is no page URL to cite, and a row
  without provenance is not a row. Recovering them means parsing that PDF and
  citing it, which this task did not do.
- **1992 to 2003, 2005-2007 and 2010-2011 are unrecoverable.** The 2012 alumni
  page is the only source reaching before 2012, and it names its people in an
  "Alumni Business Owners" list rather than a roster: the founder, against the
  1991 the page states in prose, and the pre-2012 presidents it lists, each with
  their term. That is the whole of the pre-2012 record — the years it covers are
  in the block above. The rest of that page, in every one of its
  55 captures, is a call to action asking alumni to write in: **no public alumni
  roster ever existed.**

## Known source inconsistencies

The club's own pages spell some names two ways. These are **reported, never
merged** — `build.ts` prints them at the end of every run — because picking which
spelling is correct would be inventing a name.

- `Tim MacDougal` / `Tim MacDougall` — the competition page uses both, in
  different years. Almost certainly one person; two rows until a human confirms.
- `Eva Yueng` on the competition page is spelled `Eva Yeung` in the `enactus-org`
  research. The file follows the club's page, which is the source.

## Not yet wired into the pipeline

Nothing reads this file. Consuming it — matching a recovered name against a
company the pipeline found, and feeding that into the `enactus_alum_led` affinity
signal — is deliberately a separate change, to be made once the qualification
layer is on `main`.

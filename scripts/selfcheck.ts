// Self-check for the two pieces of pure logic that decide what the team sees.
// Both were added to replace prompt-only guards, so they need to actually hold.
//
//   node --experimental-strip-types scripts/selfcheck.ts
//
// No test framework on purpose: these are asserts over pure functions.

import assert from "node:assert/strict";
import { requestedCount, DEFAULT_COUNT, MAX_COUNT } from "../src/lib/count.ts";
import { disqualify, provinceFromRequest, grounded, type ApolloOrg } from "../src/lib/apollo.ts";
import { salvageObjects, pluck } from "../src/lib/llm.ts";
import { nameMatchesDomain, companyKey } from "../src/lib/apollo.ts";
import { baseName, companyEmails, extractPeople, isBannedHost, pickEmail, rankUrls } from "../src/lib/firecrawl.ts";
import { classifyLocation, normalizeLocation } from "../src/lib/geocode.ts";
import { greet, lint, projectNames } from "../src/lib/email-lint.ts";
import { ENACTUS_ORG, ENACTUS_PROJECTS } from "../src/lib/enactus.ts";
import { logoUrl, monogram } from "../src/lib/logo.ts";
import { setClause } from "../src/lib/db.ts";

let checks = 0;
const eq = (actual: unknown, expected: unknown, msg: string) => {
  assert.deepEqual(actual, expected, `${msg}\n  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  checks++;
};

// ── requestedCount ────────────────────────────────────────────────────────
eq(requestedCount("give me 10 leads from Burnaby"), 10, "digits + noun");
eq(requestedCount("find 15 more sponsors near SFU"), 15, "filler word between");
eq(requestedCount("get me twenty companies in tech"), 20, "number word");
eq(requestedCount("I need three good local businesses"), 3, "two fillers");
eq(requestedCount("find 8 potential sponsors"), 8, "single filler");
eq(requestedCount("Give Me 12 LEADS"), 12, "case insensitive");

// The four phrasings that silently lost their count in production on 2026-08-15.
// Each one asked for a number and the app quietly targeted DEFAULT_COUNT instead,
// because the gap word ("construction", "engineering", "tech") was not on the
// old allowlist. These are the regression that matters.
eq(requestedCount("find 10 construction companies in Maple Ridge"), 10, "industry word between number and noun");
eq(requestedCount("give me 10 engineering firms in North Vancouver"), 10, "firms is a count noun");
eq(requestedCount("find me 10 tech companies near SFU Burnaby"), 10, "tech companies");
eq(requestedCount("find me 3 food and beverage companies in Richmond"), 3, "three-word gap");
eq(requestedCount("give me 12 local manufacturing businesses"), 12, "two gap words");
eq(requestedCount("find 8 packaging suppliers in Delta"), 8, "suppliers is a count noun");
eq(requestedCount("get me five marketing agencies downtown"), 5, "number word + gap");

// No count present -> fall back, never guess.
eq(requestedCount("find sponsors in Burnaby"), DEFAULT_COUNT, "no number");
eq(requestedCount("who should we talk to about Alara?"), DEFAULT_COUNT, "question form");

// Digits that are not counts must not be read as one.
eq(requestedCount("companies in the top 5% by revenue"), DEFAULT_COUNT, "percentage is not a count");
eq(requestedCount("sponsors open until 10 pm"), DEFAULT_COUNT, "time is not a count");
eq(requestedCount("firms founded after 2010"), DEFAULT_COUNT, "year is not a count");
// The gap is five words wide, so these are the cases holding it open. Every one
// of them puts a real count noun downstream of a number that is measuring
// something else -- widen the gap again without these and the parser starts
// answering "7" to "open 7 days a week".
eq(requestedCount("open 7 days a week local businesses"), DEFAULT_COUNT, "days is a unit, not a count");
eq(requestedCount("find sponsors within 20 km of campus that are good companies"), DEFAULT_COUNT, "km is a unit");
eq(requestedCount("we raised 500 dollars last year, find sponsors"), DEFAULT_COUNT, "dollars is a unit");
eq(requestedCount("companies with 50 employees that are local firms"), DEFAULT_COUNT, "employees is a unit");
// Four- and five-word gaps: the production prompt that ran as 6 was the first.
eq(requestedCount("find me 10 local print and coffee shops near SFU Burnaby"), 10, "four-word gap");
eq(requestedCount("get me 12 small and medium sized manufacturing businesses"), 12, "five-word gap");
eq(requestedCount("find 8 family owned local hardware stores"), 8, "four-word gap, stores");
// The unit guard checks the first word only, so a unit LATER in the sentence
// must not suppress a count that parsed correctly at the front.
eq(requestedCount("find 10 companies with 50 employees"), 10, "unit later in sentence still counts");

// Clamped both ends so one typo cannot fan out into a 500-lead run.
eq(requestedCount("give me 900 leads"), MAX_COUNT, "clamped to max");
eq(requestedCount("give me 0 leads"), 1, "clamped to min");

// ── provinceFromRequest ───────────────────────────────────────────────────
eq(provinceFromRequest("sponsors in Burnaby"), "British Columbia", "Burnaby implies BC");
eq(provinceFromRequest("companies in the Lower Mainland"), "British Columbia", "region phrase");
eq(provinceFromRequest("sponsors in Toronto"), null, "no BC hint -> no geo gate");

// ── disqualify ────────────────────────────────────────────────────────────
const org = (o: Partial<ApolloOrg>): ApolloOrg => ({
  domain: "x.com", name: null, city: null, state: null, country: null,
  employees: null, industry: null, phone: null, linkedinUrl: null, foundedYear: null, ...o,
});

// Positive evidence of wrongness -> drop. These are the four classes that came
// back in a real "10 leads from Burnaby" run.
eq(disqualify(org({ employees: 0 })), "defunct", "0 employees means gone (Mobify)");
eq(disqualify(org({ name: "Burnaby Board of Trade" })), "membership_org", "board of trade by name");

// The leak that actually happened: Apollo has no record for members.bbot.ca, so
// the org-based checks never ran and it reached the board. The candidate title
// alone must be enough.
eq(
  disqualify(null, { name: "Burnaby Board of Trade (BBOT)" }),
  "membership_org",
  "membership body caught with NO Apollo record"
);
eq(disqualify(null, { name: "Vancouver Chamber of Commerce" }), "membership_org", "chamber by name, no record");
eq(disqualify(null, { name: "Keystone Environmental Ltd." }), null, "a real company is not a membership body");
eq(disqualify(null, { name: null }), null, "no name, no record, no drop");
eq(disqualify(org({ industry: "civic & social organization" })), "membership_org", "membership by industry");
eq(
  disqualify(org({ state: "Ontario" }), { province: "British Columbia" }),
  "wrong_region",
  "national chain HQ'd elsewhere (Pizza Pizza)"
);

// Absence of evidence must NEVER drop: Apollo has poor coverage of the small
// local businesses this club most wants, so unverified has to survive.
eq(disqualify(null), null, "no Apollo record is not a disqualifier");
eq(disqualify(org({ state: null }), { province: "British Columbia" }), null, "unknown state survives");
eq(disqualify(org({ employees: null }), {}), null, "unknown headcount survives");
eq(disqualify(org({ state: "British Columbia" }), { province: "British Columbia" }), null, "in-province kept");
eq(disqualify(org({ employees: 240, state: "British Columbia", industry: "environmental services" }), { province: "British Columbia" }), null, "real local company kept");

// ── grounded ──────────────────────────────────────────────────────────────
// The one that protects the club's name: nothing about a PERSON survives
// unless the fetched page actually said it.
const EV =
  "Microserve is a Burnaby IT provider. Media contact: Dana Whitfield, Director of Marketing. " +
  "Reach the team at dana.whitfield@microserve.ca or visit our careers page. " +
  "Microserve has supported Simon Fraser University student programs since 2019.";

const g = (over: Record<string, unknown>, ev = EV, dom: string | null = "microserve.ca") =>
  grounded({ contact_name: null, contact_role: null, contact_email: null, connection_type: "none", connection_note: null, ...over }, ev, dom);

// Real, present-in-evidence data survives untouched.
eq(g({ contact_name: "Dana Whitfield" }).contact_name, "Dana Whitfield", "real name kept");
eq(g({ contact_name: "Dana Whitfield", contact_role: "Director of Marketing" }).contact_role, "Director of Marketing", "real role kept");
eq(g({ contact_email: "dana.whitfield@microserve.ca" }).contact_email, "dana.whitfield@microserve.ca", "real email kept");

// Invention is destroyed. These are the exact shapes an LLM produces.
eq(g({ contact_name: "Sarah Chen" }).contact_name, null, "invented person nulled");
eq(g({ contact_email: "info@microserve.ca" }).contact_email, null, "plausible-but-absent email nulled");
eq(g({ contact_email: "sarah.chen@microserve.ca" }).contact_email, null, "invented email on the right domain still nulled");
eq(g({ contact_email: "not-an-email" }).contact_email, null, "malformed email nulled");

// An email at someone else's domain is a mis-targeted send even if it appears.
eq(
  g({ contact_email: "hello@gmail.com" }, EV + " hello@gmail.com", "microserve.ca").contact_email,
  null,
  "off-domain email nulled even when present in evidence"
);

// A role with no verified person to attach it to is noise.
eq(g({ contact_role: "Director of Marketing" }).contact_role, null, "orphan role nulled");

// Connection chips are claims about shared history the volunteer may repeat.
eq(g({ connection_type: "ecosystem" }).connection_type, "ecosystem", "SFU tie kept when evidence says SFU");
eq(g({ connection_type: "past_sponsor", connection_note: "sponsored us in 2024" }).connection_type, "none", "past_sponsor demoted without Enactus evidence");
eq(g({ connection_type: "past_sponsor", connection_note: "sponsored us" }).connection_note, null, "demoted connection drops its note");
eq(g({ connection_type: "alum" }, "A plain company page with no university mention.").connection_type, "none", "alum demoted without SFU evidence");
eq(g({ connection_type: "past_sponsor" }, "Enactus SFU thanks Acme for sponsoring Nourish.").connection_type, "past_sponsor", "past_sponsor kept with Enactus evidence");

// ── salvageObjects ────────────────────────────────────────────────────────
// This is what stands between "the provider was slow" and "you got 0 leads".
const n = (s: string) => salvageObjects(s).length;

eq(n('{"leads":[{"company":"A"},{"company":"B"}]}'), 2, "complete body");
eq(n('[{"company":"A"},{"company":"B"}]'), 2, "bare array");

// The case that matters: the stream was cut mid-lead.
eq(n('{"leads":[{"company":"A"},{"company":"B"},{"company":"C'), 2, "truncated mid-string drops only the partial");
eq(n('{"leads":[{"company":"A"},{"comp'), 1, "truncated mid-key");
eq(n('{"leads":[{"company":"A"},'), 1, "truncated right after a comma");
eq(n('{"leads":[{"comp'), 0, "nothing finished yet");
eq(n("no json here at all"), 0, "no array at all");

// A brace inside a string must not unbalance the scan -- why_fit is free prose
// and an unescaped-looking "{" in it would otherwise eat every later lead.
eq(n('{"leads":[{"why":"uses {braces} in prose"},{"company":"B"},{"company":"C"}]}'), 3, "braces inside strings");
eq(n('{"leads":[{"why":"quote \\" then }"},{"company":"B"}]}'), 2, "escaped quote inside a string");

// Content is preserved, not just counted.
eq(
  (salvageObjects('{"leads":[{"company":"Keystone","website":"k.ca"},{"company":"Micro') as Record<string, string>[])[0],
  { company: "Keystone", website: "k.ca" },
  "salvaged object keeps its fields"
);

// pluck tolerates the two shapes the structurer actually returns.
eq(pluck({ leads: [1, 2] }, "leads"), [1, 2], "wrapped shape");
eq(pluck([1, 2], "leads"), [1, 2], "bare array shape");
eq(pluck({ results: [1] }, "leads"), [1], "single array under the wrong key");
eq(pluck({ a: 1 }, "leads"), null, "no array at all");

// ── nameMatchesDomain ─────────────────────────────────────────────────────
// Every case below is a real company/domain pair from one "10 leads from
// Burnaby" run. The false ones all shipped with the wrong website attached.
const m = nameMatchesDomain;

eq(m("Binnie", "binnie.com"), true, "exact host");
eq(m("Beedie", "beedie.ca"), true, "exact host, .ca");
eq(m("Daily Hive", "dailyhive.com"), true, "two words squashed into host");
eq(m("BCBusiness", "bcbusiness.ca"), true, "single token");

// Ten wrong-company pairs reproduced from one real run. Each one previously
// returned true, which handed the lead another company's website -- and that
// website is what the Firecrawl button scrapes for an address, so a false
// positive here is a real email to the wrong company.
eq(m("West Coast Reduction", "westjet.com"), false, "shared leading word, unrelated company");
eq(m("Delta Hotels", "deltacontrols.com"), false, "shared leading word");
eq(m("Pacific Blue Cross", "pacificcoastal.com"), false, "shared leading word");
eq(m("Coast Capital", "coastmountainbus.com"), false, "shared leading word");
eq(m("Great Little Box", "greatcanadian.com"), false, "generic leading word");
eq(m("Nature's Path", "naturesbounty.com"), false, "possessive leading word");
eq(m("Community Savings Credit Union", "unity.com"), false, "host is a substring of a name token");
eq(m("Fairmont Hotels", "ai.com"), false, "two-letter host matches nothing");
eq(m("The Bike Shop", "shop.mec.ca"), false, "subdomain is not the registrable label");
eq(m("Best Buy Canada", "bestbuyrewards-scam.com"), false, "lookalike domain");
eq(m("Great Little Box", "greatlittlebox.com"), true, "the real one still matches");

// Deliberately given up to close the ten above: when the host is a LATER word of
// the company name, there is no way to tell "City of Burnaby" -> burnaby.ca from
// "West Coast Reduction" -> westjet.com with a string test. These two leads now
// keep their card and lose their website link, which is the cheaper error.
eq(m("City of Burnaby", "burnaby.ca"), false, "given up: host is a trailing word");
eq(m("18 Wheels Warehousing & Trucking", "18wheelslogistics.com"), false, "given up: host extends the name prefix");
eq(m("Keystone Environmental", "www.keystoneenvironmental.ca"), true, "www stripped");

// The actual failures.
eq(m("Renaissance Coffee", "sfu.ca"), false, "campus vendor attached to the university's domain");
eq(m("ABC Recycling", "recyclingproductnews.com"), false, "company attached to a trade publication");
eq(m("CRUST N CRUNCH", "the-peak.ca"), false, "business attached to the student newspaper");
eq(m("Microserve", "dailyhive.com"), false, "company attached to the outlet that covered it");

// A generic word shared with a LONGER host is not a match, which is what the
// real failures looked like.
eq(m("ABC Recycling", "recyclingnews.com"), false, "generic word plus more host is not a match");

eq(m("ABC Recycling", "recycling.com"), false, "trailing-word host now rejected too");

eq(m(null, "binnie.com"), false, "no company name");
eq(m("Binnie", null), false, "no domain");

// ── firecrawl contact extraction ──────────────────────────────────────────
// The "Find contact" button writes an address onto a lead the team will email,
// so the same rule as grounded() applies: it has to come from fetched text and
// belong to the company, never be assembled or guessed.

eq(baseName("binnie.com"), "binnie", "plain host");
eq(baseName("www.keystoneenvironmental.ca"), "keystoneenvironmental", "www stripped");
eq(baseName("careers.herbaland.com"), "herbaland", "subdomain ignored");
eq(baseName("acme.co.uk"), "acme", "compound TLD");
eq(baseName("localhost"), "localhost", "single label");
eq(baseName(null), "", "no host");


// Real page text from the three sites probed on 2026-08-15.
eq(
  companyEmails("Questions? keyinfo@keystoneenvironmental.ca or call us.", "keystoneenvironmental.ca"),
  ["keyinfo@keystoneenvironmental.ca"],
  "address lifted from page text"
);

// herbaland.com publishes @herbaland.ca. Requiring an exact domain match would
// have thrown away a real contact, which is why the check is on the label.
eq(
  companyEmails("Media: pr@herbaland.ca", "herbaland.com"),
  ["pr@herbaland.ca"],
  ".ca address on a .com site is still theirs"
);

// Anything not theirs is dropped: mailing a lead's web agency or a Wix support
// box is worse than showing no address at all.
eq(companyEmails("Built by hello@somewebagency.com", "binnie.com"), [], "vendor address dropped");
eq(companyEmails("support@wixpress.com", "binnie.com"), [], "platform address dropped");
eq(companyEmails("info@binnie.com.au", "binnie.com"), ["info@binnie.com.au"], "same label, different ccTLD");
eq(companyEmails("no addresses on this page", "binnie.com"), [], "nothing to find");
eq(companyEmails("a@binnie.com A@BINNIE.COM", "binnie.com"), ["a@binnie.com"], "deduped case-insensitively");
eq(companyEmails("write to info@binnie.com.", "binnie.com"), ["info@binnie.com"], "trailing sentence period trimmed");

// Ranking: a sponsorship ask should reach the right desk, and never a robot.
eq(pickEmail(["info@x.com", "sponsorship@x.com"]), "sponsorship@x.com", "sponsorship beats info");
eq(pickEmail(["info@x.com", "marketing@x.com"]), "marketing@x.com", "marketing beats info");
eq(pickEmail(["noreply@x.com", "jane@x.com"]), "jane@x.com", "noreply skipped");

// Mowi's real contact page: eleven addresses, and the one a student club wants
// is the regional donations desk, not the media desk.
eq(
  pickEmail(["kim.dosvig@mowi.com", "media@mowi.com", "comms.canadaeast@mowi.com", "donations.canadaeast@mowi.com"]),
  "donations.canadaeast@mowi.com",
  "dotted regional mailbox still ranks by its first segment"
);
eq(pickEmail(["no-reply@x.com", "info@x.com"]), "info@x.com", "no-reply not read as the word 'no'");
eq(pickEmail(["noreply@x.com"]), "noreply@x.com", "noreply is better than nothing");
eq(pickEmail([]), null, "nothing found");

// Only ever read the company's own site. This is what makes LinkedIn and other
// social profiles unreachable from here rather than merely discouraged.
eq(
  rankUrls(["https://binnie.com/about", "https://binnie.com/contact-us"], "binnie.com"),
  ["https://binnie.com/contact-us", "https://binnie.com/about"],
  "contact page ranked above about"
);
eq(
  rankUrls(["https://www.linkedin.com/company/binnie/contact", "https://binnie.com/about"], "binnie.com"),
  ["https://binnie.com/about"],
  "off-domain URL cannot be scraped even when it looks like a contact page"
);
eq(rankUrls(["https://facebook.com/binnie"], "binnie.com"), [], "social profile dropped");

// rankUrls only keeps social profiles out because they fail to match the
// company's own base name. That inverts when the STORED website is itself the
// social profile: every linkedin.com/* link then matches. isBannedHost is
// checked before the map call so the request is never made at all -- this is
// the standing "never scrape LinkedIn" rule enforced in code, not in a prompt.
for (const h of [
  "linkedin.com",
  "www.linkedin.com",
  "ca.linkedin.com",
  "linkedin.ca",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "yelp.com",
  "crunchbase.com",
  "indeed.com",
  "glassdoor.com",
]) {
  eq(isBannedHost(h), true, `${h} is never fetched`);
}
for (const h of ["binnie.com", "herbaland.ca", "krinos.ca", "xavier.com", "linkedinsurance.com"]) {
  eq(isBannedHost(h), false, `${h} is a real company site`);
}

// ── extractPeople: who is allowed to become a named contact ───────────────
// Every case below is a real extraction from a real lead's site on 2026-08-16.
// The wrong ones matter more than the right one: a name on a card is what a
// volunteer types after "Hi", so a company or a button that reaches this far
// gets emailed by name.

const names = (md: string, host: string) =>
  extractPeople(md, host, `https://${host}/about`).map((p) => p.name);

eq(names("Sobeys Inc, President", "safeway.ca"), [], "legal entity is not a person");
eq(names("Longo Brothers Fruit — President", "longos.com"), [], "collective noun is not a person");
eq(names("See Job Openings\nGeneral Manager", "trailappliances.com"), [], "call to action is not a person");
eq(names("Bob Smith Ltd, Owner", "example.com"), [], "entity suffix rejects an otherwise-valid name");
// Anchored to the first word: it rejects instructions, not every name with a
// verb in it. (NOT_NAME separately rejects a few verbs in any position, so a
// real "Mark Read" is lost too -- a missed name, which is the safe direction.)
eq(names("Sarah Chen, Chief Executive", "example.com"), ["Sarah Chen"], "ordinary name survives the CTA guard");
eq(names("Jason Potter, President", "safeway.ca"), ["Jason Potter"], "real executive survives");
// A title has to read like a job, not like the sentence around it.
eq(
  extractPeople(
    "Jane Doe, Need a hand today? General Manager",
    "example.com",
    "https://example.com/x",
  ).map((p) => p.role),
  ["General Manager"],
  "question falls back to the matched title",
);
eq(
  extractPeople("Jane Doe, General Manager", "example.com", "https://example.com/x").map((p) => p.role),
  ["General Manager"],
  "a clean label is still published verbatim",
);

// ── companyKey: is this the same company? ─────────────────────────────────
// All four of these pairs were emitted as separate cards by real Burnaby runs.
// Two cards for one sponsor means two volunteers email it.
const same: [string, string][] = [
  ["Xenon Pharmaceuticals Inc.", "Xenon Pharmaceuticals"],
  ["Grosvenor (Burnaby FC)", "Grosvenor"],
  ["Creation Technologies", "Creation Technologies LLC"],
  ["Function Point Productivity Software Inc", "Function Point Productivity Software"],
  ["Concert Properties Ltd.", "concert properties"],
  ["DMS Mechanical Ltd.", "DMS Mechanical"],
  ["Save-On-Foods", "Save On Foods"],
  ["Nature’s Path Foods", "Natures Path Foods"],
];
for (const [a, b] of same) eq(companyKey(a), companyKey(b), `same company: ${a} = ${b}`);

// The normaliser must not over-merge. These are genuinely different sponsors,
// and collapsing them would silently hide one from the board forever.
const different: [string, string][] = [
  ["Creation Technologies", "Creative Technologies"],
  ["Pacific Blue Cross", "Pacific Blue Water"],
  ["TELUS", "TELUS International"],
  ["BC Transit", "BC Hydro"],
];
for (const [a, b] of different)
  eq(companyKey(a) === companyKey(b), false, `different companies: ${a} != ${b}`);

// A name made only of legal-suffix words must not normalise to "", or every
// such lead would dedupe against every other.
eq(companyKey("Grosvenor") !== "", true, "real name survives");
eq(companyKey("  Acme  Inc.  ") , "acme", "whitespace and suffix trimmed");

// ── classifyLocation: what is allowed onto the map ────────────────────────
// Every string below is a real value from the live `location` column (198
// non-null, 80 distinct). The column is LLM-written free text, so the map's
// honesty rests entirely on this function: anything classified 'city' or
// 'address' gets a pin, and a pin is a claim that a sponsor is THERE.
const p = (raw: string | null) => classifyLocation(raw).precision;
const q = (raw: string) => classifyLocation(raw).query;

// The 81 clean rows, and the 51 that spell the province out.
eq(p("Burnaby, BC"), "city", "clean City, PROV");
eq(p("Burnaby, British Columbia"), "city", "province spelled out");
eq(p("Burnaby, British Columbia, Canada"), "city", "spelled out plus country");
eq(p("Langley, B.C."), "city", "province with periods");
eq(q("Langley, British Columbia"), "Langley, BC, Canada", "canonical query, not the raw text");
eq(q("Vancouver, Canada"), "Vancouver, BC, Canada", "trailing country dropped, province restored");

// The 34 with no comma at all.
eq(p("Burnaby"), "city", "bare city");
eq(p("Vancouver"), "city", "bare city, no province");

// The 41 parentheticals. All commentary, and stripping it early is also what
// stops the city names hidden inside asides from being read as the location.
eq(p("Burnaby, BC (Headquarters)"), "city", "parenthetical qualifier ignored");
eq(q("Burnaby, BC (based on context of supporting Burnaby Pride)"), "Burnaby, BC, Canada", "long aside ignored");
eq(q("Surrey, BC (Headquartered in Surrey)"), "Surrey, BC, Canada", "repeated city in aside");
eq(p("Canada (Headquarters in Vancouver, BC)"), "region", "city inside an aside must NOT promote a country");
eq(p("International (with local operations in Burnaby, BC)"), "region", "same trap, other wording");
eq(p("Canada (Likely BC, based on 604 phone number)"), "region", "a guess in prose is still a country");

// The 4 street addresses.
eq(p("7442 Fraser Park Drive, Burnaby, BC V5J 5B9"), "address", "street number means address");
eq(p("26688-56 Ave, Langley, BC V4W 3X5"), "address", "hyphenated civic number");
eq(q("5318 271 Street, Aldergrove, BC V4W 3Y7"), "5318 271 Street, Aldergrove, BC V4W 3Y7", "address geocoded verbatim");

// The 13 region-level rows. These are the ones that must never get a pin --
// "Global (Swiss HQ)" on a Lower Mainland centroid is the map telling a lie.
eq(p("Global (Swiss HQ)"), "region", "global HQ is not a Lower Mainland sponsor");
eq(q("Global (Swiss HQ)"), null, "and it is never geocoded");
eq(p("Canada-wide"), "region", "hyphen must not hide the country token");
eq(p("Canada-wide (Oakville, ON HQ; strong BC presence)"), "region", "national chain stays unplaced");
eq(p("Coastal British Columbia (assumed Lower Mainland)"), "region", "an assumption is not a location");
eq(p("Ontario (with corporate giving programs; check for Lower Mainland store presence)"), "region", "province-level");
eq(p("British Columbia"), "region", "province alone");
eq(p("BC / Canada"), "region", "province or country");
eq(p("Fraser Valley, BC / National"), "region", "sub-region is not a municipality");

// Region phrases that CONTAIN a city name are the sharpest edge here: pinning
// "Greater Vancouver" (2.6M people) on Vancouver city hall is exactly the
// false precision this whole module exists to prevent.
eq(p("Greater Vancouver"), "region", "Greater Vancouver is not Vancouver");
eq(p("Metro Vancouver"), "region", "Metro Vancouver is not Vancouver");
eq(p("Vancouver Island, BC"), "region", "Vancouver Island is not Vancouver");
eq(p("Lower Mainland, BC (Vancouver)"), "region", "region name wins over a city in an aside");

// ...but the same phrase alongside a real municipality must not suppress it.
eq(q("Maple Ridge, Tri-Cities, Greater Vancouver"), "Maple Ridge, BC, Canada", "region phrase removed, city kept");
eq(q("Metrotown, Burnaby & Greater Vancouver"), "Burnaby, BC, Canada", "neighbourhood, city, region -> the city");
eq(q("Langley, BC (Lower Mainland)"), "Langley, BC, Canada", "region qualifier does not demote a city");

// Longest-first matching. "North Vancouver" contains "Vancouver", and matching
// the shorter one pins every North Van lead downtown, across an inlet.
eq(q("North Vancouver, BC"), "North Vancouver, BC, Canada", "North Vancouver is its own city");

// Out-of-province rows are real and must keep their own province, or Toronto
// and Montreal land in BC.
eq(q("Toronto, ON (Major operations in Lower Mainland)"), "Toronto, ON, Canada", "Ontario city stays in Ontario");
eq(q("Calgary, AB (with community focus in client/team locations)"), "Calgary, AB, Canada", "Alberta city");
// Two municipalities in one string is arbitrary by construction -- the longest
// name wins, because that is the rule that keeps North Vancouver off Vancouver.
// One live row does this ("Metrotown, Burnaby & Greater Vancouver") and it
// lands on Burnaby, which is right; there is no data to justify more than that.
eq(q("Montréal, QC and Burnaby, BC"), "Montreal, QC, Canada", "accents folded, longest name wins");

// Nothing at all.
eq(p(null), "none", "null location");
eq(p(""), "none", "empty location");
eq(p("   "), "none", "whitespace only");
eq(q("Greater Vancouver"), null, "unplaceable rows never carry a query");

// normalizeLocation on its own, since the route logs it.
eq(normalizeLocation("Burnaby, BC (Headquarters)"), "Burnaby, BC", "aside stripped");
eq(normalizeLocation("Burnaby, British Columbia, Canada"), "Burnaby, BC", "province collapsed, country dropped");
eq(normalizeLocation(null), "", "null normalizes to empty");


// ── email lint ────────────────────────────────────────────────────────────
// Every case below is one an adversarial reviewer actually reproduced against
// the real constants. The warning box is only worth having while it is quiet.
const FACTS = "Company: Acme\nIndustry: Packaging\nAbout: Founded in 2019, serving BC since 1936.";
const GOAL = `You are Michael, on the External Relations team at Enactus SFU.\n\n${ENACTUS_ORG}\n\n${ENACTUS_PROJECTS}`;
const PROJECT_NAMES = projectNames(ENACTUS_PROJECTS);
const lc = (body: string, recent: string[] = [], connection = "none") =>
  lint(body, { facts: FACTS, goal: GOAL, connection, recentProjects: recent, projectNames: PROJECT_NAMES });

// Numbers: the token is what the model wrote, not what the regex swallowed.
eq(lc("Since 2019, you have grown, and in BC since 1936."), [], "trailing comma and period are not part of the number");
eq(lc("We would use the $10 million Impact GIC."), ['Number "$10" is not in the facts.'], "invented dollar figure warns");
eq(lc("You run 3 plants. We ran 3 workshops."), ['Number "3" is not in the facts.'], "the same bad number warns once, not twice");

// SFU: ours is not a claim about them.
eq(lc("Second Savour is Burnaby-based, SFU-founded."), [], "our own project blurb is not a claimed tie");
eq(lc("Our SFU students would run the workshop."), [], "first-person self-reference is not a claimed tie");
eq(lc("You have collaborated with SFU Beedie students before."), ["Claims a link to SFU, but this lead has no connection on file."], "second-person SFU claim warns");
eq(lc("Your recycled aluminum lines would suit Alara."), [], "aluminum is not alumni");
eq(lc("You are an SFU alumni contact.", [], "alumni"), [], "a lead with a connection on file is exempt");

// Named programs: theirs must be in the facts, ours never is.
eq(lc("Enactus SFU runs the Renovo Program for veterans."), [], "our own project name is exempt");
eq(lc("We saw your Big Idea Grant."), ['Names "Big Idea Grant", which is not in the facts.'], "their invented grant warns");

// Project reuse across the last few emails, which is what makes them same-y.
eq(lc("Alara is a biodegradable bioplastic.", ["Alara"]), ["The last few emails also pitched Alara."], "repeat project warns");
eq(lc("Alara is a biodegradable bioplastic.", ["Nourish"]), [], "a different recent project does not warn");
eq(PROJECT_NAMES.length, 8, "all eight project names parse out of the constant");

// greet(): the model's entity greeting is replaced, never stacked.
eq(greet("Hi Coca-Cola Canada Bottling Ltd.,\n\nWe loved your work.", "Jason Potter"), "Hi Jason,\n\nWe loved your work.", "model greeting cut, first name used");
eq(greet("We loved your work.", ""), "Hi there,\n\nWe loved your work.", "no contact falls back to there");
eq(greet("Dear Sir or Madam,\nWe loved your work.", "  Sarah  Chen "), "Hi Sarah,\n\nWe loved your work.", "Dear-form cut, name trimmed");

// ── logo tile ─────────────────────────────────────────────────────────────
// 27 of the 110 real leads have website: null -- nameMatchesDomain nulls it
// whenever the model attached someone else's domain -- so the monogram is a
// primary state on ~29% of cards. And 17 of the 83 real websites are deep URLs,
// which is the case a naive split gets wrong.
const G = (h: string) => `https://www.google.com/s2/favicons?domain=${h}&sz=128`;

eq(logoUrl("https://vancity.com"), G("vancity.com"), "bare host");
eq(logoUrl("https://www.rbs.ca/about-us/corporate-social-responsibility/"), G("rbs.ca"), "deep URL keeps only the host");
eq(logoUrl("https://csr.saveonfoods.com"), G("csr.saveonfoods.com"), "subdomain kept -- still their own site");
eq(logoUrl("microserve.ca/"), G("microserve.ca"), "scheme-less value from a manually added lead");
eq(logoUrl(null), null, "null website -> monogram, which is 25% of the board");
eq(logoUrl(""), null, "empty website -> monogram");
eq(logoUrl("not a url"), null, "unparseable -> monogram, never a broken request");
eq(logoUrl("https://localhost"), null, "no dot is not a company domain");
// POST /api/leads stores `${b.website ?? null}` unvalidated, so the column holds
// whatever the model wrote. Each of these fell back to a monogram before.
eq(logoUrl("  https://vancity.com  "), G("vancity.com"), "padded value is trimmed, not treated as unparseable");
eq(logoUrl("HTTPS://vancity.com"), G("vancity.com"), "scheme match is case-insensitive");
eq(logoUrl("httpool.com"), G("httpool.com"), "a host merely starting with http is not a scheme");

// The standing "never link LinkedIn" rule, enforced at the one place that makes
// an outbound request per lead. Pinned against firecrawl's own ban list so the
// two cannot drift: anything it refuses to fetch, this refuses to illustrate.
for (const h of ["linkedin.com", "www.linkedin.com", "ca.linkedin.com", "linkedin.ca", "facebook.com", "instagram.com", "x.com", "twitter.com", "yelp.com", "crunchbase.com", "indeed.com", "glassdoor.com"]) {
  eq(isBannedHost(h) && logoUrl(`https://${h}`), null, `${h} is never a logo source`);
}
for (const h of ["binnie.com", "herbaland.ca", "linkedinsurance.com"]) {
  eq(logoUrl(`https://${h}`), G(h), `${h} is a real company site`);
}

eq(monogram("Vancity"), "V", "first letter");
eq(monogram("The Printing Edge"), "P", "leading The skipped -- T is a useless tile");
eq(monogram("  east van roasters"), "E", "trimmed and uppercased");
eq(monogram("18 Wheels Warehousing & Trucking"), "1", "a digit is a fine monogram");
eq(monogram(""), "?", "no name still renders a tile, never an empty box");

// setClause() is the allow-list every PATCH route builds its SQL from, so a
// column name reaching it from the request body is an injection. Interpolation
// is only safe while these hold.
{
  const EDITABLE = new Set(["name", "is_default"]);
  const { sets, values } = setClause(
    { name: "Cold open", is_default: true, "id = 1; drop table x --": "boom", role: "admin" },
    EDITABLE,
    { is_default: "::boolean" }
  );
  eq(sets, ["name = $1", "is_default = $2::boolean", "updated_at = now()"], "only allow-listed columns are interpolated");
  eq(values, ["Cold open", true], "values stay as $n parameters");

  const empty = setClause({ role: "admin" }, EDITABLE);
  eq(empty.sets, ["updated_at = now()"], "a body of nothing editable still writes a valid SET");
  eq(empty.values, [], "and binds nothing");
}

console.log(`selfcheck: ${checks} assertions passed`);

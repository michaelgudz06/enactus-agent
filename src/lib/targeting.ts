// Who Enactus SFU goes after, and who it does not. One file.
//
// This policy used to exist in six places and four notations: as English inside
// planPrompt(), again inside the scoring system prompt, a third time inside the
// structuring instruction, as regexes in score.ts, as an industry set plus a
// name test in apollo.ts, and as a bare inline /^(simon fraser|sfu\b)/ in the
// finalize filter. The same rule -- "no student clubs, no memberships, no
// charities, but keep museums" -- was therefore stated six times, and nothing
// stopped the six from disagreeing. They did: the carve-out for ticket-selling
// museums exists in the prompts and had no counterpart in the WRONG_SIDE regex
// for months.
//
// Everything here is one of two kinds of thing:
//
//   PROSE     fragments composed into the model prompts. Exported separately so
//             a rule appears in every prompt that needs it, worded once.
//   PATTERNS  the deterministic half of the same rules, used by score.ts,
//             apollo.ts and the finalize filter.
//
// A rule that exists in both kinds sits next to its twin here, so changing the
// club's strategy is one edit in one file and the prompt and the code cannot
// drift apart.
//
// The only import is the Enactus context block, which is plain constants. The
// .ts specifier keeps this module loadable by scripts/selfcheck.ts under
// `node --experimental-strip-types`, and so keeps score.ts loadable too.
import { ENACTUS_ORG, ENACTUS_PROJECTS, ENACTUS_VENTURES } from "./enactus.ts";

// ── Who the club is, per mode ───────────────────────────────────────────────

export const IDENTITY_SPONSOR = `You help Enactus SFU, a student social-entrepreneurship club at Simon Fraser University (Burnaby / Vancouver, BC), find local businesses willing to donate a raffle prize, gift card, product sample, or small cash gift for a student event.`;

export const IDENTITY_SALES = `You help a project manager find customers, stockists and supply partners for an Enactus SFU student venture.`;

// ── What has actually converted ─────────────────────────────────────────────
// Measured across three years of this club's own outreach. These paragraphs are
// the club's strategy; the weights in score.ts are the same strategy in
// numbers. Change one, revisit the other.

export const WHAT_CONVERTS_SPONSOR = `What actually converts, measured across three years of this club's own outreach: independent consumer-facing businesses in Metro Vancouver -- restaurants and cafes, gyms and yoga and climbing studios, escape rooms, museums and small attractions, neighbourhood retail -- of roughly 2 to 200 staff, where a single owner or store manager can approve a $25-$300 giveaway without asking anyone. Businesses whose own customers are students convert best, because what they give (a free class, a voucher, a product trial) costs them very little and wins them a regular customer who lives nearby. Promotional-products and branded-merchandise suppliers are the same shape and are badly under-used: their product is swag, so donating it is a free sample.`;

export const WHAT_CONVERTS_SALES = `The partnerships that have actually worked were independent Metro Vancouver retailers and suppliers who agreed to stock a student-made product or supply materials at cost: an independent bookstore acting as a sales channel, a neighbourhood yarn shop, an organic seed company, a local grocer. Favour owner-operated shops in the venture's own category over chains and distributors -- a named owner can say yes to a shelf trial, a buying department cannot.`;

// ── The local-branch rule ───────────────────────────────────────────────────
// Its deterministic twin is namesLocalOutlet() in score.ts, which is what stops
// a franchise being penalised for its parent's headcount.

export const LOCAL_BRANCH_RULE = `For a chain, target the SPECIFIC LOCAL BRANCH -- the Burnaby location, the Kitsilano store -- never head office. Do NOT write queries aimed at corporate social responsibility, community investment, philanthropy, or grant programs: roughly fifty attempts at large companies through that door produced not one donation.`;

export const RANK_BY_WHO_CAN_SAY_YES = `RANK BY WHO CAN SAY YES. Every sponsorship this club has ever landed was approved by one owner, franchisee or store manager acting alone, and roughly half of all past outreach went to HR and campus-recruiting contacts who converted nothing at all. Prefer a candidate whose page names an actual person -- an owner, founder, or store manager -- over an equally good company that names nobody. For a chain, prefer the specific local branch over the national brand: reaching a store has worked, reaching head office never has. Independent businesses of roughly 2 to 200 staff are the target; a large national employer contacted at corporate is not, however well known its name.`;

// ── Exclusions ──────────────────────────────────────────────────────────────
// Three wordings of one rule set, for three different jobs. They are kept
// separate rather than collapsed because each prompt needs a different amount
// of it: the planner is writing SEARCH QUERIES and needs the rule aimed at
// phrasing, the analyst is JUDGING candidates and needs the carve-out, and the
// structurer is a last gate and needs only the list.

/** For the planner: how to word queries so the wrong side never surfaces. */
export const EXCLUSIONS_FOR_QUERIES = `Only look for real businesses that could give money, product, or vouchers. NEVER target other student clubs, university clubs or associations (at SFU or elsewhere), or organizations whose "sponsorship" is actually a paid membership, paid directory listing, or a fee the club would have to pay. Word the search queries to find businesses, not clubs or memberships.`;

/** For the planner's JSON instruction: the phrasings that reliably misfire. */
export const QUERY_GUARDRAILS = ` The target is organisations that GIVE money or goods. Do not write queries that surface charities, foundations seeking donations, non-profits, or community groups looking for sponsors -- those compete with Enactus for the same donor dollars rather than funding it. Words like "non-profit", "charity" and "fundraiser" in a query reliably return the wrong side of the transaction, and words like "corporate social responsibility", "community investment" and "philanthropy" reliably return large companies that have never given this club anything.`;

/**
 * For the analyst: the full rule set, including the carve-out.
 *
 * The carve-out is the part most easily lost in a rewrite. Two museums and a
 * cinema are confirmed past sponsors, so incorporation status is the wrong
 * test and "has something to sell you" is the right one. WRONG_SIDE below is
 * deliberately matched against Apollo's structured industry only, for the same
 * reason.
 */
export const HARD_EXCLUSIONS = `HARD EXCLUSIONS — drop these candidates entirely (do not output them at all): other student clubs, university clubs, or student associations (at SFU or any school); anything that would require Enactus to PAY (paid memberships, paid directory or association listings, ticketed programs, fee-based accelerators); and charities, hospital or arts foundations, and community non-profits that RAISE money rather than give it — they are competing for the same donors, not funding Enactus. and grant-making foundations, whose money arrives through a months-long written application owned by a different team, not through sponsor outreach. Enactus is asking a business to hand over a gift card, a voucher or a product, not to join, pay, fundraise alongside, or run a grant round. IMPORTANT CARVE-OUT: a museum, gallery, theatre or attraction that SELLS ADMISSION is not in that category and must be kept -- two museums and a cinema are confirmed past sponsors, because they can donate tickets. The test is whether the organisation has something to sell you, not how it is incorporated.`;

/** For the structurer: the same list as a single closing rule. */
export const STRUCTURE_EXCLUSION_RULE = `- EXCLUDE entirely (do not output) any other student club, university club/association, or anything requiring Enactus to pay a membership/fee. Only real companies, businesses, or grant-making foundations.`;

// ── Patterns: the deterministic half of the rules above ─────────────────────
// Used by score.ts, apollo.ts and the finalize filter in agent.ts. A prompt is
// a suggestion; these are what actually hold.

/**
 * Consumer-facing categories: an allowlist of what has actually converted,
 * rather than a blocklist of what has not.
 *
 * Leading \b only, no trailing one -- these are PREFIX matches on purpose, so
 * "brewer" catches "Brewery", "museum" catches "Museums", "theat" catches both
 * spellings of theatre. A trailing \b silently breaks every one of them. The
 * short tokens that would over-match as prefixes ("spa" in "space", "toy" in
 * "Toyota", "pet" in "petroleum") are pinned with an explicit boundary instead.
 */
export const STOREFRONT =
  /\b(restaurant|food|beverage|caf[eé]|coffee|baker|brewer|distiller|grocer|retail|apparel|clothing|footwear|fitness|gym\b|yoga|climbing|wellness|spa\b|day spa|salon|beauty|cosmetic|entertainment|recreation|sporting goods|sports\b|leisure|hospitality|hotel|tourism|museum|theat|bookstore|books\b|toys?\b|pets?\b|florist|flower|furniture|consumer)/i;

/**
 * Wrong side of the transaction: these raise money, they do not sponsor.
 *
 * Prefix matches for the same reason as above ("universit" must catch
 * "universities"). Museums are deliberately absent -- the Museum of Vancouver
 * and the Maritime Museum are both confirmed sponsors, and they would be caught
 * by a naive "non-profit" rule. That absence IS the carve-out in
 * HARD_EXCLUSIONS above; the two must stay in step.
 */
export const WRONG_SIDE =
  /\b(government|municipal|city of|public administration|higher education|universit|college|school district|non.?profit|charit|\bngo\b)/i;

/**
 * Organisations that raise their own funds, matched by NAME as well as industry.
 *
 * Deliberately BROADER than WRONG_SIDE above, and deliberately used for a
 * different decision -- which is why both live here rather than one being
 * folded into the other.
 *
 * WRONG_SIDE is a -50 scoring penalty, so it is matched against Apollo's dull
 * structured industry only: "we partner with local non-profits" is a sentence a
 * perfectly good sponsor puts on its About page, and a penalty that size cannot
 * be allowed to fire on model-written prose.
 *
 * This one decides only whether an already-approved lead's outreach may ask for
 * MONEY. Getting it wrong costs a softer ask, not a deleted lead, so it can
 * afford to match the company NAME and to catch the societies, councils,
 * associations and foundations WRONG_SIDE leaves alone. Burnaby Arts Council is
 * quoted in its own draft as "grant-receiving and grant-giving" and then asked
 * for money; that is the failure this exists to stop.
 *
 * Known limit, inherited: this is a name/industry regex at draft time. The real
 * fix is disqualifying these upstream, where MEMBERSHIP_NAME already sits.
 */
export const RAISES_OWN_FUNDS =
  /non-?profit|society|council|association|foundation|charit/i;

/** Does this lead raise its own funds, and so should never be asked for cash? */
export function raisesOwnFunds(
  company: string | null | undefined,
  industry: string | null | undefined
): boolean {
  return RAISES_OWN_FUNDS.test(`${company ?? ""} ${industry ?? ""}`);
}

/**
 * Promotional-products suppliers: their product IS branded merchandise, so
 * donating it is a free sample shown to a room of future buyers. Structurally
 * the best fit in the whole history and only one was ever asked -- the
 * under-used shape named in WHAT_CONVERTS_SPONSOR above.
 */
export const PROMO_SUPPLIER =
  /(promotional product|promotional apparel|promo product|branded merchandise|branded apparel|corporate gift|screen print|screenprint|embroider|print shop|signage|trophies)/i;

/**
 * Membership bodies by name: chambers, boards of trade, BIAs, trade
 * associations. Enactus would be paying these to join.
 *
 * Usable without an Apollo record, which is the point: a real run leaked
 * "Burnaby Board of Trade (BBOT)" onto the board because Apollo has no record
 * for its members.bbot.ca subdomain, so the org-based check never ran.
 */
export const MEMBERSHIP_NAME =
  /\b(board of trade|chamber of commerce|business improvement (association|area)|trade association)\b/i;

/** Apollo's own industry label for the same class of organisation. */
export const MEMBERSHIP_INDUSTRIES = new Set(["civic & social organization"]);

/**
 * The club itself.
 *
 * A run returned "Simon Fraser University" as a sponsor prospect for its own
 * student club. Kept here rather than inline in the filter so it reads as what
 * it is -- a targeting rule -- and so the next one has somewhere to go.
 */
export const OWN_ORGANISATION = /^(simon fraser|sfu\b)/i;

/** Is this candidate the university the club belongs to? */
export function isOwnOrganisation(name: string | null | undefined): boolean {
  return Boolean(name && OWN_ORGANISATION.test(name.trim()));
}

/** Name test for membership bodies, usable without an Apollo record. */
export function isMembershipName(name: string | null | undefined): boolean {
  return Boolean(name && MEMBERSHIP_NAME.test(name));
}

// ── Composed prompts ────────────────────────────────────────────────────────
// The three prompts the pipeline sends, assembled from the fragments above.
// They live here rather than in agent.ts so that a rule is written once and
// every prompt that needs it gets the same words. scripts/intent-cases.mjs
// reads planPrompt() out of this file.

/** The planner's system prompt: turn a request into search queries. */
export function planPrompt(mode: "sponsor" | "sales"): string {
  if (mode === "sales") {
    return `${IDENTITY_SALES} Turn their request into effective web-search queries and a crisp ideal-customer description.

${WHAT_CONVERTS_SALES}`;
  }
  return `${IDENTITY_SPONSOR}

${WHAT_CONVERTS_SPONSOR}

${LOCAL_BRANCH_RULE}

Turn the user's request into effective web-search queries and a crisp ideal-sponsor description.

${EXCLUSIONS_FOR_QUERIES}`;
}

/**
 * The analyst's system prompt, shared by the reasoning and structuring stages.
 *
 * Both stages get the same rules on purpose: the structurer is the last gate
 * before the board, and a rule the reasoner applied but the structurer never
 * saw is a rule that stops holding the moment reasoning is cut short.
 */
export function analystSystemPrompt(mode: "sponsor" | "sales"): string {
  if (mode === "sales") {
    return `You are a sales-lead analyst. Assess each candidate organization as a potential CUSTOMER, STOCKIST or SUPPLY PARTNER for the user's product. Prefer independent owner-operated retailers and suppliers in the product's own category -- the partnerships that have worked were a shelf trial agreed by a shop owner, not a listing won from a buying department -- and prefer a candidate whose page names an actual person over an equally good one that names nobody.

${ENACTUS_VENTURES}`;
  }
  return `You are a sponsorship-lead analyst for Enactus SFU. Assess each candidate organization as a potential SPONSOR. Detect any Simon Fraser University (SFU) or Enactus alumni connection, or past-sponsor / SFU-ecosystem tie, strictly from the provided text.

${ENACTUS_ORG}

${ENACTUS_PROJECTS}

For each strong sponsor, identify which specific Enactus SFU project best matches their industry or values, so outreach can pitch that project.

${HARD_EXCLUSIONS}

${RANK_BY_WHO_CAN_SAY_YES}`;
}

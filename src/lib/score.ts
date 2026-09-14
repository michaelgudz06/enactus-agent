// How good is this lead? One integer, computed here, never emitted by a model.
//
// Every weight below is derived from the club's own outreach history (525
// companies contacted, 557 sends, 43 replies, 16 confirmed sponsors). The
// numbers were set by hand from those measurements rather than fitted: sixteen
// wins cannot support fitting fifty features, and the strongest raw correlation
// in that data is an artefact -- rows with research notes reply at 39% vs 3%,
// but the notes were written AFTER the reply arrived ("4x tickets", "meeting
// mid Sept"). Anything learned from post-outcome fields is hindsight, so only
// features knowable BEFORE the first email are allowed to score.
//
// One rule here is not a measured lift and is marked as such: the outlet
// exemption exists to undo a data artefact (Apollo reporting a parent company's
// headcount for one franchise location), not to encode an observed conversion
// rate. Two others were REMOVED after the backtest contradicted the story they
// were built on -- see the branch-address comment in contactPoints, which is
// the cautionary tale worth reading before adding a weight.
//
// Two passes, because the inputs arrive at two different times:
//   1. agent run  -- company, size, industry, location, prior relationship
//   2. enrichment -- who the contact is, once findContactFor() has looked
// Pass 2 carries the strongest signals in the whole dataset, and they are
// simply unknowable at run time: Exa returns pages about companies, not staff
// directories, and grounded() correctly refuses to invent a person. So a lead
// is scored when it lands and re-scored when a contact is found.

// .ts specifier on purpose: scripts/selfcheck.ts loads this module under
// `node --experimental-strip-types`, which resolves only explicit extensions.
import { PROMO_SUPPLIER, STOREFRONT, WRONG_SIDE } from "./targeting.ts";

export type ScoreFacts = {
  company?: string | null;
  industry?: string | null;
  description?: string | null;
  location?: string | null;
  employees?: number | null;
  connectionType?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  contactEmail?: string | null;
};

export type ScoreResult = { score: number; reasons: string[] };

// Weights. Change these, then re-run the backtest -- one at a time, or you will
// not know which one moved the result. +/-10 reorders the middle of the list;
// +/-30 changes who makes the cut at all.
export const WEIGHTS = {
  localWithContact: 45, // the intersection -- see below
  priorRelationship: 35, // 6 of 18 retention attempts landed vs 7.7% cold
  personalEmail: 25, // first.last@ replies 21.9% vs 6.9%
  namedContact: 20, // a named human replies 15.7% vs 5.5%
  // manager@ / gm@ / owner@. Deliberately identical to personalEmail: only 4
  // such addresses were ever written to, so the data cannot say whether a
  // manager's desk beats a named person. Split out anyway because it used to be
  // scored as a first name -- the right answer for the wrong reason, and one
  // regex edit away from silently becoming a front desk.
  decisionInbox: 25,
  storefront: 20, // all 16 confirmed sponsors are consumer-facing
  promoSupplier: 20, // Promosapien gave $522, the second largest ever
  rightSize: 15, // every confirmed sponsor fits 2-200 staff
  sfuTie: 15,
  hrContact: -30, // half of all past effort, zero conversions
  genericInbox: -35, // info@ replies 2.8% vs 10.7%
  enterprise: -40, // ~50 enterprise attempts, none converted
  wrongSide: -50, // they receive money, they do not give it
} as const;

// STOREFRONT, WRONG_SIDE and PROMO_SUPPLIER now live in src/lib/targeting.ts,
// alongside the prompt wording that states the same rules to the model. They
// were duplicated here and in three prompts, and the prompt half of the museum
// carve-out drifted out of step with the regex half for months.
//
// A LinkedIn URL on the row was worth 1.68x in the history, but the leads table
// has no column for one, so it is not scored. Add the field first if it matters.

const BC = /\b(british columbia|b\.?c\.?|vancouver|burnaby|surrey|richmond|coquitlam|langley|delta|new westminster|north shore|lower mainland|metro vancouver|fraser valley|port moody|maple ridge|white rock|tsawwassen|ladner|pitt meadows)\b/i;



// Neighbourhood and municipality names as they appear inside a MAILBOX or an
// outlet's name, where punctuation and spacing are unreliable. The text is
// squashed to bare letters first, so "bc.portcoquitlam", "coquitlam-store" and
// "Popeyes Burnaby/Coquitlam" all match the same token. Bare "delta" is
// deliberately absent: delta@ is far more likely to be the airline.
const BRANCH_PLACE =
  /(vancouver|eastvan|northvan|westvan|burnaby|surrey|richmond|coquitlam|portmoody|langley|newwest|kitsilano|gastown|yaletown|brentwood|metrotown|cloverdale|kerrisdale|brewerydistrict|kensington|fleetwood|queensborough|edmonds|whiterock|mapleridge|pittmeadows|tsawwassen|ladner|lonsdale|steveston|guildford|willowbrook|lougheed|oakridge)/;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");


const HR_ROLE = /(\bhuman resources|\bhr\b|\brecruit|\btalent|\bpeople (and|&) culture|\bpeople operations|\bcampus)/i;

// Not a person, but still someone who can approve a $25 gift card without
// asking anyone. Modo Yoga -- the clearest retention win in the data -- came in
// at manager@. Kept separate from isPersonalEmail, which used to score these as
// a first name and got the right answer for the wrong reason.
const DECISION_INBOX = /^(manager|gm|owner|franchise|proprietor|store)/i;

const GENERIC_INBOX = /^(info|hello|contact|admin|office|general|inquiries|inquiry|enquiries|enquiry|team|support|sales|reception|mail|hi|ask|help|service|bookings?|orders?|feedback|marketing|partnerships?)$/i;

const has = (re: RegExp, v: string | null | undefined) => Boolean(v && re.test(v));

/** The local part of an email, lowercased. "" when there is no usable address. */
export function localPart(email: string | null | undefined): string {
  const at = (email ?? "").trim().toLowerCase().indexOf("@");
  return at > 0 ? (email as string).trim().toLowerCase().slice(0, at) : "";
}

export function isGenericInbox(email: string | null | undefined): boolean {
  const lp = localPart(email);
  return Boolean(lp) && GENERIC_INBOX.test(lp);
}

/**
 * A mailbox named after a neighbourhood: vancouver@, brentwood@,
 * coquitlam-store@, bc.portcoquitlam@. It means the message reached one shop
 * rather than a head office, which is the difference between the franchises
 * that sponsored (Popeyes Burnaby/Coquitlam, Old Spaghetti Factory, Browns
 * Socialhouse, Safeway) and the ~50 national brands contacted at corporate
 * that never gave anything.
 */
export function isBranchAddress(email: string | null | undefined): boolean {
  const lp = localPart(email);
  return Boolean(lp) && BRANCH_PLACE.test(squash(lp));
}

/** manager@, gm@, owner@ -- a decision maker's desk, not a person and not a front desk. */
export function isDecisionInbox(email: string | null | undefined): boolean {
  const lp = localPart(email);
  return Boolean(lp) && DECISION_INBOX.test(lp);
}

/**
 * Does this name a specific Lower Mainland outlet rather than the brand above
 * it? "Popeyes Burnaby/Coquitlam" and "Oxygen Yoga & Fitness Kensington" both
 * do; "Popeyes" alone does not.
 */
export function namesLocalOutlet(text: string | null | undefined): boolean {
  if (!text) return false;
  return BC.test(text) || BRANCH_PLACE.test(squash(text));
}

/**
 * first.last@ / first_last@ / first-last@ -- the shape that replied at 21.9%.
 * A bare first name (louise@, jonny@) counts too: three confirmed sponsors were
 * reached at exactly that, and it is still a person rather than a front desk.
 */
export function isPersonalEmail(email: string | null | undefined): boolean {
  const lp = localPart(email);
  // Test the pattern against the local part directly. Calling isGenericInbox(lp)
  // here looks right and silently does nothing: it takes a full address, finds
  // no "@" in a bare local part, and returns false for every generic inbox.
  if (!lp || GENERIC_INBOX.test(lp)) return false;
  return /^[a-z]+[._-][a-z]+$/.test(lp) || /^[a-z]{3,}$/.test(lp);
}

/**
 * The half of the score that depends on WHO the contact is. Split out because
 * these fields arrive in pass 2, long after the rest: pass 2 adds
 * contactPoints(after) - contactPoints(before), which is exactly the full score
 * for the new contact state without needing to re-fetch Apollo for a headcount
 * it already scored once. Depends only on location and the three contact
 * fields, so the subtraction is always well defined.
 */
export function contactPoints(f: ScoreFacts): ScoreResult {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, why: string) => {
    score += points;
    reasons.push(`${points > 0 ? "+" : ""}${points} ${why}`);
  };

  const named = Boolean((f.contactName ?? "").trim());

  // The one interaction that matters. Fifteen local Metro Vancouver businesses
  // contacted at info@ addresses returned nothing; every confirmed sponsor was
  // local AND had a named person. Neither half converts on its own, so this is
  // one condition rather than two independent bonuses.
  if (has(BC, f.location) && named) add(WEIGHTS.localWithContact, "local business with a named contact");
  if (named) add(WEIGHTS.namedContact, "named contact");
  if (named && has(HR_ROLE, f.contactRole)) add(WEIGHTS.hrContact, "contact is HR/recruiting");

  // One ladder, most specific first. A branch mailbox has to be tested before
  // isPersonalEmail, which reads "vancouver" as a first name and scores a
  // storefront address as a human being.
  if (f.contactEmail) {
    if (isBranchAddress(f.contactEmail)) {
      // Zero, deliberately. The first version of this rule paid +40 on the
      // story that franchises convert -- they do, but not here: the 24 branch
      // addresses in the club's history replied at 4.2% against a 7.7%
      // baseline and converted nothing, because the franchises that said yes
      // were reached at a franchisee's own address, which namedContact and
      // personalEmail already score. All this branch has to do is stop the
      // address being counted as a person.
    } else if (isDecisionInbox(f.contactEmail)) add(WEIGHTS.decisionInbox, "manager/owner inbox");
    else if (isGenericInbox(f.contactEmail)) add(WEIGHTS.genericInbox, "generic inbox");
    else if (isPersonalEmail(f.contactEmail)) add(WEIGHTS.personalEmail, "personal email");
  }

  return { score, reasons };
}

/** The half that is knowable the moment the agent finds the company. */
export function companyPoints(f: ScoreFacts): ScoreResult {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, why: string) => {
    score += points;
    reasons.push(`${points > 0 ? "+" : ""}${points} ${why}`);
  };

  if (f.connectionType === "past_sponsor") add(WEIGHTS.priorRelationship, "prior relationship");
  else if (f.connectionType === "alum" || f.connectionType === "ecosystem") add(WEIGHTS.sfuTie, "SFU/Enactus tie");

  // Apollo's industry is coarse and often absent, so the description -- written
  // from the company's own page -- is matched too. Without it the single
  // biggest positive company signal simply never fires on a thin record.
  const what = `${f.industry ?? ""} ${f.description ?? ""}`.trim();
  if (has(STOREFRONT, what)) add(WEIGHTS.storefront, "consumer-facing storefront");
  if (has(PROMO_SUPPLIER, what)) add(WEIGHTS.promoSupplier, "promotional-products supplier");

  // Absence of an Apollo record scores nothing either way -- a 429 or an
  // exhausted credit is indistinguishable from a genuine no-record, so it must
  // never look like evidence against the company.
  if (typeof f.employees === "number") {
    if (f.employees >= 2 && f.employees <= 200) add(WEIGHTS.rightSize, "2-200 staff");
    // Apollo resolves a franchise to its parent domain, so every Popeyes
    // location inherits corporate headcount. Four of the ~20 confirmed sponsors
    // are outlets of national brands; penalising them for their parent's size
    // is the rubric marking its own winners down. A name that carries the
    // neighbourhood is the evidence that this row is the shop, not the brand.
    else if (f.employees > 1000 && !namesLocalOutlet(f.company)) add(WEIGHTS.enterprise, "enterprise headcount");
  }

  // Industry only, unlike the two bonuses above. This is a -50 penalty and the
  // description is model-written prose: "we partner with local non-profits" is
  // a sentence a perfectly good sponsor puts on its About page, and matching it
  // here would delete that lead. Apollo's structured field is the stricter,
  // duller source, which is what a penalty this size needs.
  if (has(WRONG_SIDE, f.industry)) add(WEIGHTS.wrongSide, "receives funding rather than gives it");

  return { score, reasons };
}

export function scoreLead(f: ScoreFacts): ScoreResult {
  const c = companyPoints(f);
  const p = contactPoints(f);
  return { score: c.score + p.score, reasons: [...c.reasons, ...p.reasons] };
}

/**
 * The board sorts board_order ASCENDING, so a better lead needs a SMALLER
 * number. Negating the score is the whole trick; it also leaves manual drag
 * ordering working, because a human dragging a card just overwrites this.
 */
export function boardOrderFor(score: number): number {
  return -score;
}

// Team scoreboard maths. No imports on purpose, so scripts/selfcheck.ts can
// pin every rule here without a database, a network call or a test framework.
//
// The route's job is to fetch rows; this file's job is to decide what they
// mean. Keeping the two apart is what makes "does a Sunday evening email count
// toward this week" answerable in an assertion rather than by staring at SQL.

export type ScoreKind = "email" | "dm" | "reply" | "contact" | "win";

export interface ScoreEvent {
  actor: string | null;
  kind: ScoreKind;
  /** ISO timestamp. Rows without one are dropped: an event with no date cannot be put in a week. */
  at: string | null;
}

export interface Counts {
  emails: number;
  dms: number;
  replies: number;
  contacts: number;
  wins: number;
}

export interface MemberScore {
  key: string;
  name: string;
  week: Counts;
  month: Counts;
  all: Counts;
  /** Replies divided by messages sent, all time. null until anything has been sent. */
  replyRate: number | null;
  achievements: string[];
  firstAt: string | null;
  lastAt: string | null;
}

export interface Scoreboard {
  members: MemberScore[];
  team: Counts;
  weekStart: string;
  monthKey: string;
}

// The club is in Burnaby. Bucketing in UTC would file Sunday-evening work under
// next week for eight months of the year and seven for the other four, because
// the offset changes with daylight saving. Intl knows the rules; a hardcoded
// -0800 does not.
const TZ = "America/Vancouver";

/**
 * The civil date ("2026-08-23") an instant fell on in Vancouver.
 *
 * en-CA formats as YYYY-MM-DD, which is the one locale that gives a sortable
 * string without reassembling parts by hand.
 */
export function civilDate(iso: string, tz: string = TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** "2026-08-23" -> "2026-08". */
export function monthOf(civil: string): string {
  return civil.slice(0, 7);
}

/**
 * The Monday on or before a civil date, as "2026-08-17".
 *
 * A Monday start rather than ISO week numbers: "week of Aug 17" is a thing a
 * volunteer can check against their own memory, and "2026-W34" is not. It also
 * sidesteps the week-53 and early-January edge cases entirely.
 *
 * Date.UTC is safe here because the input is already a civil date -- the
 * timezone question was settled by civilDate before this ever runs.
 */
export function weekStartOf(civil: string): string {
  const [y, m, d] = civil.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  // getUTCDay is 0 for Sunday, so Sunday belongs to the Monday six days back,
  // not to the one the next morning.
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * 86400000).toISOString().slice(0, 10);
}

/**
 * Group key for a person's name.
 *
 * The login box takes free text and the same person has already logged in as
 * both "michael" and "Michael", which on a naive GROUP BY is two people with
 * half the work each. Case and surrounding space are noise; anything else is
 * deliberately left alone, because "Michael G" and "Michael" really might be
 * two volunteers and this is not the place to guess.
 */
export function actorKey(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

const zero = (): Counts => ({ emails: 0, dms: 0, replies: 0, contacts: 0, wins: 0 });

const FIELD: Record<ScoreKind, keyof Counts> = {
  email: "emails",
  dm: "dms",
  reply: "replies",
  contact: "contacts",
  win: "wins",
};

function add(c: Counts, kind: ScoreKind) {
  c[FIELD[kind]] += 1;
}

interface Rule {
  id: string;
  label: string;
  hint: string;
  earned: (m: MemberScore, all: MemberScore[]) => boolean;
}

/**
 * All-time only, and every one of them is a fact about work that happened --
 * no streaks, no participation badges. A board with three real sends on it
 * would make a streak counter into a lie the moment anyone read it.
 */
export const ACHIEVEMENTS: Rule[] = [
  {
    id: "first-send",
    label: "First Send",
    hint: "Sent the first message on the board",
    earned: (m, all) => !!m.firstAt && all.every((o) => !o.firstAt || o.firstAt >= m.firstAt!),
  },
  { id: "sent-10", label: "Ten Out", hint: "10 messages sent", earned: (m) => sent(m.all) >= 10 },
  { id: "sent-50", label: "Fifty Out", hint: "50 messages sent", earned: (m) => sent(m.all) >= 50 },
  { id: "sent-100", label: "Century", hint: "100 messages sent", earned: (m) => sent(m.all) >= 100 },
  { id: "first-reply", label: "First Reply", hint: "Got a sponsor to write back", earned: (m) => m.all.replies >= 1 },
  { id: "reply-10", label: "Conversationalist", hint: "10 replies earned", earned: (m) => m.all.replies >= 10 },
  {
    id: "sourcer",
    label: "Sourcer",
    hint: "25 contacts found by hand",
    earned: (m) => m.all.contacts >= 25,
  },
  { id: "closer", label: "Closer", hint: "Closed a sponsorship", earned: (m) => m.all.wins >= 1 },
  {
    id: "hat-trick",
    label: "Hat Trick",
    hint: "Closed three sponsorships",
    earned: (m) => m.all.wins >= 3,
  },
];

/** Messages sent on either channel. A DM is the same work as an email. */
export function sent(c: Counts): number {
  return c.emails + c.dms;
}

/**
 * Fold raw events into per-member weekly, monthly and all-time counts.
 *
 * `now` is a parameter rather than read from the clock so the week and month
 * boundaries are testable, and so a request rendered at 23:59 cannot disagree
 * with the numbers it is rendering.
 */
export function buildScoreboard(events: ScoreEvent[], now: string): Scoreboard {
  const today = civilDate(now);
  const thisWeek = weekStartOf(today);
  const thisMonth = monthOf(today);

  const byKey = new Map<string, MemberScore>();
  // Display name is whichever spelling that person used most often, ties going
  // to the one seen first. Picking the longest would promote a typo; picking
  // the newest would rename someone every time a volunteer shift-slipped once.
  const spellings = new Map<string, Map<string, number>>();
  const team = zero();

  for (const e of events) {
    if (!e.at) continue;
    const key = actorKey(e.actor);
    // Unattributed work is real work, but it belongs to nobody and putting it
    // under a blank row invites someone to claim it.
    if (!key) {
      add(team, e.kind);
      continue;
    }

    let m = byKey.get(key);
    if (!m) {
      m = {
        key,
        name: (e.actor ?? "").trim(),
        week: zero(),
        month: zero(),
        all: zero(),
        replyRate: null,
        achievements: [],
        firstAt: null,
        lastAt: null,
      };
      byKey.set(key, m);
      spellings.set(key, new Map());
    }
    const seen = spellings.get(key)!;
    const raw = (e.actor ?? "").trim();
    seen.set(raw, (seen.get(raw) ?? 0) + 1);

    const civil = civilDate(e.at);
    add(m.all, e.kind);
    add(team, e.kind);
    if (monthOf(civil) === thisMonth) add(m.month, e.kind);
    if (weekStartOf(civil) === thisWeek) add(m.week, e.kind);

    if (!m.firstAt || e.at < m.firstAt) m.firstAt = e.at;
    if (!m.lastAt || e.at > m.lastAt) m.lastAt = e.at;
  }

  const members = [...byKey.values()];
  for (const m of members) {
    let best = m.name;
    let top = -1;
    for (const [raw, n] of spellings.get(m.key)!) {
      if (n > top) {
        top = n;
        best = raw;
      }
    }
    m.name = best;
    const out = sent(m.all);
    m.replyRate = out > 0 ? m.all.replies / out : null;
  }
  for (const m of members) {
    m.achievements = ACHIEVEMENTS.filter((a) => a.earned(m, members)).map((a) => a.id);
  }

  // Sorted by the week first, because the scoreboard's job is to show what is
  // happening now. All-time breaks ties so a quiet week does not shuffle the
  // order of people who have done very different amounts of work.
  members.sort(
    (a, b) =>
      sent(b.week) + b.week.replies + b.week.contacts - (sent(a.week) + a.week.replies + a.week.contacts) ||
      sent(b.all) + b.all.replies + b.all.contacts - (sent(a.all) + a.all.replies + a.all.contacts) ||
      a.name.localeCompare(b.name)
  );

  return { members, team, weekStart: thisWeek, monthKey: thisMonth };
}

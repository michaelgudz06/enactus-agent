// Slack announcements for closed sponsorships.
//
// An incoming webhook rather than a bot token: it is one URL in an env var, it
// posts to exactly one channel, and it cannot read anything. A bot token would
// mean an app, scopes, an install flow and a secret with far more reach than
// "say a sentence in #general" needs.

const WEBHOOK = () => process.env.SLACK_WEBHOOK_URL ?? "";

export function hasSlack(): boolean {
  return WEBHOOK().startsWith("https://hooks.slack.com/");
}

export interface Win {
  company: string;
  owner: string | null;
  amount: number | null;
  wonType: string | null;
  what: string | null;
}

// Slack renders a lone * or _ as formatting, so a company called *Bloom* would
// come out bolded and a link would autolink. mrkdwn only ever needs these three
// escaped; everything else is literal.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The message body, separated from the posting so it can be read without a
 * webhook and asserted without a network call.
 */
export function winMessage(win: Win): string {
  const who = win.owner?.trim() || "the External team";
  const kind = win.wonType === "in_kind" ? "in-kind sponsorship" : "sponsorship";
  const value =
    win.wonType === "in_kind"
      ? win.what?.trim()
        ? ` — ${esc(win.what.trim())}`
        : ""
      : win.amount != null
        ? ` — $${win.amount.toLocaleString("en-CA")} CAD`
        : "";
  return `:tada: *${esc(who)}* just landed an ${kind} from *${esc(win.company)}*${value}`;
}

/**
 * Post a win. Never throws: an announcement is the least important thing
 * happening at the moment a sponsorship closes, and a Slack outage must not be
 * able to fail the drag that closed it.
 */
export async function announceWin(win: Win): Promise<boolean> {
  if (!hasSlack()) return false;
  try {
    const res = await fetch(WEBHOOK(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: winMessage(win) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error("slack announce failed:", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("slack announce failed:", (e as Error).message);
    return false;
  }
}

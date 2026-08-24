// The club's shared Google account.
//
// One mailbox for the whole External Relations team rather than a connection
// per volunteer: a reply has to land somewhere that outlives the person who
// sent the email, and this team turns over completely every year. That is also
// why the refresh token lives in `enactus_mailbox` rather than in a cookie --
// a cookie is per-browser, which is precisely the property a shared mailbox
// must not have.

import { db } from "./db";

// gmail.compose covers both drafting and sending; there is no narrower
// send-only scope short of gmail.modify, which would also grant deleting mail.
//
// gmail.readonly is what reply detection needs, and it is a RESTRICTED scope:
// until Google verifies the app, the consent screen shows an "unverified app"
// warning and is capped at 100 users. Both scopes are requested together on
// purpose -- adding readonly later would force everyone through consent a
// second time, and there is only one account to click through here.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

export interface Mailbox {
  email: string;
  refresh_token: string;
  connected_by_name: string | null;
  connected_at: string | null;
  last_synced_at: string | null;
}

export function hasGoogleConfig(): boolean {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return Boolean(id && secret && !id.startsWith("REPLACE") && !secret.startsWith("REPLACE"));
}

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: SCOPES,
    // Both are required to be handed a refresh token, and `prompt=consent`
    // specifically: Google returns one only on the FIRST consent otherwise, so
    // reconnecting an already-authorised account would yield an access token
    // that expires in an hour and nothing to renew it with.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function exchangeCode(code: string): Promise<{ access_token: string; refresh_token?: string }> {
  return tokenRequest({ code, redirect_uri: process.env.GOOGLE_REDIRECT_URI!, grant_type: "authorization_code" });
}

/** Whose mailbox the code we just exchanged actually belongs to. */
export async function profileEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Could not read the Google account address.");
  const d = (await res.json()) as { emailAddress?: string };
  if (!d.emailAddress) throw new Error("Google returned no address for this account.");
  return d.emailAddress;
}

export async function saveMailbox(email: string, refreshToken: string, byName: string): Promise<void> {
  await db()`
    insert into enactus_mailbox (id, email, refresh_token, connected_by_name, connected_at)
    values (true, ${email}, ${refreshToken}, ${byName}, now())
    on conflict (id) do update
      set email = excluded.email,
          refresh_token = excluded.refresh_token,
          connected_by_name = excluded.connected_by_name,
          connected_at = now()`;
}

/** The connected mailbox, or null when nobody has connected one yet. */
export async function mailbox(): Promise<Mailbox | null> {
  const rows = (await db()`
    select email, refresh_token, connected_by_name, connected_at, last_synced_at
      from enactus_mailbox where id = true`) as Mailbox[];
  return rows[0] ?? null;
}

/**
 * A usable access token for the club mailbox.
 *
 * Minted fresh from the stored refresh token on every call rather than cached.
 * ponytail: one extra round-trip to Google per send, which is nothing beside
 * the send itself; add a cache only if something starts sending in bulk, and
 * note that a serverless instance is the wrong place to keep one anyway.
 *
 * Returns null when no mailbox is connected, because that is a "go connect it"
 * answer for the UI rather than an error. A refresh that FAILS does throw --
 * that means the token was revoked and somebody has to reconnect.
 */
export async function clubAccessToken(): Promise<{ token: string; email: string } | null> {
  const box = await mailbox();
  if (!box) return null;
  const d = await tokenRequest({ refresh_token: box.refresh_token, grant_type: "refresh_token" });
  if (!d.access_token) throw new Error("Google refused to refresh the club mailbox token. Reconnect it in Settings.");
  return { token: d.access_token, email: box.email };
}

// Header values are joined with CRLF below, so a newline inside one ends the
// header and starts another. `to` and `subject` originate from lead data the
// model wrote, which makes this a trust boundary: an address containing
// "\r\nBcc:" would add recipients to a message about to go out.
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * One RFC 2822 message, base64url encoded the way the Gmail API wants it.
 *
 * Shared by the draft and send paths on purpose: they must not be able to
 * disagree about header escaping, or the guard above would hold on the path
 * nobody uses and not on the path that actually delivers mail.
 */
function buildMime(to: string, subject: string, body: string, verb: string): string {
  const cleanTo = headerSafe(to);
  if (!EMAIL_RE.test(cleanTo)) throw new Error(`Refusing to ${verb}: "${to}" is not a valid email address.`);
  const mime = [
    `To: ${cleanTo}`,
    `Subject: ${headerSafe(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(mime).toString("base64url");
}

async function gmailPost(accessToken: string, path: string, payload: unknown, what: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Gmail ${what} failed: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function createDraft(accessToken: string, to: string, subject: string, body: string): Promise<string> {
  const raw = buildMime(to, subject, body, "draft");
  const d = await gmailPost(accessToken, "drafts", { message: { raw } }, "draft");
  return d.id as string;
}

/**
 * Send, for real, right now. There is no unsend and no callback.
 *
 * threadId is returned and stored by the caller because reply detection walks
 * it later, and it cannot be recovered afterwards without searching the whole
 * mailbox for a message we already know we sent.
 */
export async function sendMessage(
  accessToken: string,
  to: string,
  subject: string,
  body: string
): Promise<{ id: string; threadId: string }> {
  const raw = buildMime(to, subject, body, "send");
  const d = await gmailPost(accessToken, "messages/send", { raw }, "send");
  return { id: String(d.id), threadId: String(d.threadId) };
}

/**
 * Did anyone other than us write in this thread?
 *
 * format=metadata with a single header keeps the payload to a few hundred bytes
 * per thread -- the alternative pulls every message body in the conversation
 * back over the wire to answer a yes/no question.
 *
 * Returns the timestamp of the first inbound message, or null. Only the first
 * matters: "they replied" is a fact with one date, and a thread that ran for
 * three weeks should not read as three weeks of replies.
 */
export async function firstReplyAt(
  accessToken: string,
  threadId: string,
  clubEmail: string
): Promise<string | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}` +
      `?format=metadata&metadataHeaders=From`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
  );
  // A 404 means the thread was deleted in Gmail. That is not an error worth
  // failing a sync over, and retrying it every run forever is worse.
  if (!res.ok) return null;
  const d = (await res.json()) as {
    messages?: { internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }[];
  };
  const mine = clubEmail.toLowerCase();
  for (const m of d.messages ?? []) {
    const from = m.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    // The From header is "Name <addr>", and an alias or a plus-address is still
    // us. Matching on the address being present anywhere in the header is the
    // cheap version and errs toward "not a reply", which is the safe direction:
    // an uncounted reply is a missing number, a miscounted one is a wrong one.
    if (from.toLowerCase().includes(mine)) continue;
    if (!m.internalDate) continue;
    return new Date(Number(m.internalDate)).toISOString();
  }
  return null;
}

/** Stamped after a sync so the page can say when it last looked. */
export async function touchSynced(): Promise<void> {
  await db()`update enactus_mailbox set last_synced_at = now() where id = true`;
}

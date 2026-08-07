import crypto from "crypto";

// Per-browser Gmail connection. Each teammate connects their own Google account.
// Tokens live in a signed, httpOnly cookie (never exposed to JS).

const SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
export const GMAIL_COOKIE = "gmail_tokens";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expiry: number; // epoch ms
}

export function hasGoogleConfig(): boolean {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return Boolean(id && secret && !id.startsWith("REPLACE") && !secret.startsWith("REPLACE"));
}

export function signCookie(data: unknown): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function readCookie<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  if (crypto.createHmac("sha256", SECRET).update(payload).digest("hex") !== sig) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<GmailTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return { access_token: d.access_token, refresh_token: d.refresh_token, expiry: Date.now() + (d.expires_in ?? 3600) * 1000 };
}

export async function ensureAccessToken(tokens: GmailTokens): Promise<GmailTokens> {
  if (tokens.expiry > Date.now() + 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error("Gmail session expired. Reconnect Gmail.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("Could not refresh Gmail token. Reconnect Gmail.");
  const d = await res.json();
  return { access_token: d.access_token, refresh_token: tokens.refresh_token, expiry: Date.now() + (d.expires_in ?? 3600) * 1000 };
}

// A MIME header ends at the first CRLF, so a newline inside a header value is a
// new header: a recipient carrying "\r\nBcc: someone@example.com" would add a
// recipient to a draft a human later presses send on. Every value interpolated
// into a header is folded to spaces first, here rather than at the call sites,
// because the builder is the one place all of them pass through.
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * `from` is the club's @sfu.ca inbox, and it is only ever passed when one is
 * actually configured -- a placeholder in a MIME header would be a malformed
 * message, not a hint. Gmail honours it only if that address is a verified
 * send-as alias on the connected account, which is a one-time setup step in
 * Gmail itself and is documented in the README.
 *
 * Still a draft. There is no send path here, and there must not be one.
 */
export async function createDraft(
  accessToken: string,
  message: { to: string; subject: string; body: string; from?: string }
): Promise<string> {
  const { to, subject, body, from } = message;
  const mime = [
    ...(from ? [`From: ${headerValue(from)}`] : []),
    `To: ${headerValue(to)}`,
    `Subject: ${headerValue(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
  const raw = Buffer.from(mime).toString("base64url");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!res.ok) throw new Error(`Gmail draft failed: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d.id as string;
}

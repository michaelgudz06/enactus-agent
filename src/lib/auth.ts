import { cookies } from "next/headers";
import crypto from "crypto";

// Lightweight shared-password auth. One team password gates the whole app.
// A signed cookie carries only the user's chosen display name (for attribution).
// No PII, no external auth provider, no SMTP.

const COOKIE = "enactus_session";
const SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

export interface Session {
  name: string;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

export function makeToken(name: string): string {
  const payload = Buffer.from(JSON.stringify({ name, t: Date.now() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.name !== "string") return null;
    return { name: data.name };
  } catch {
    return null;
  }
}

export function checkPassword(input: string): boolean {
  const expected = process.env.APP_TEAM_PASSWORD || "";
  if (!expected) return false;
  // constant-time compare
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const COOKIE_NAME = COOKIE;

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifyToken(store.get(COOKIE)?.value);
}

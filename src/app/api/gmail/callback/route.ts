import { cookies } from "next/headers";
import { getSession, readCookie } from "@/lib/auth";
import { exchangeCode, profileEmail, saveMailbox } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const base = () => process.env.APP_URL || "http://localhost:3000";
const back = (q: string) => Response.redirect(new URL(`/settings?mailbox=${q}`, base()));

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const session = await getSession();
  if (!session) return Response.redirect(new URL("/login", base()));

  const store = await cookies();
  const saved = readCookie<{ state: string }>(store.get("gmail_state")?.value);
  if (!code || !state || !saved || saved.state !== state) return back("error");

  try {
    const tokens = await exchangeCode(code);
    // No refresh token means this account had already consented and Google
    // handed back an access token that dies in an hour with nothing to renew
    // it. Storing that would give a mailbox that works until lunchtime and
    // then fails on a send. Revoking access at
    // myaccount.google.com/permissions and reconnecting is the fix.
    if (!tokens.refresh_token) return back("norefresh");

    const email = await profileEmail(tokens.access_token);
    await saveMailbox(email, tokens.refresh_token, session.name);
    store.delete("gmail_state");
    return back("connected");
  } catch (e) {
    console.error("mailbox connect failed:", (e as Error).message);
    return back("error");
  }
}

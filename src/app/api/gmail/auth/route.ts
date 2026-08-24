import { cookies } from "next/headers";
import { getSession, signCookie } from "@/lib/auth";
import { authUrl, hasGoogleConfig } from "@/lib/gmail";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.redirect(new URL("/login", process.env.APP_URL || "http://localhost:3000"));
  if (!hasGoogleConfig()) {
    return new Response(
      "Google is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to connect the club mailbox. Until then, use ‘Open in Gmail’ and send by hand.",
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("gmail_state", signCookie({ state }), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return Response.redirect(authUrl(state));
}

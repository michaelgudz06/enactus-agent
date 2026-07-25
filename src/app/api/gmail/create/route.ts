import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { createDraft, ensureAccessToken, hasGoogleConfig, readCookie, signCookie, GmailTokens, GMAIL_COOKIE } from "@/lib/gmail";
import { supabaseAdmin, DRAFTS, hasServiceKey } from "@/lib/supabase";
import { sanitizeEmail } from "@/lib/sanitize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (!hasGoogleConfig()) {
    return Response.json(
      { error: "Gmail draft creation turns on once the Google client secret is added (step 5). Use ‘Open in Gmail’ for now." },
      { status: 501 }
    );
  }

  const store = await cookies();
  const tokens = readCookie<GmailTokens>(store.get(GMAIL_COOKIE)?.value);
  if (!tokens) {
    return Response.json({ error: "connect", canConnect: true }, { status: 428 });
  }

  const { to, subject, body, leadId } = await req.json().catch(() => ({}));
  if (!to) return Response.json({ error: "Recipient email is required." }, { status: 400 });

  try {
    const fresh = await ensureAccessToken(tokens);
    if (fresh.access_token !== tokens.access_token) {
      store.set(GMAIL_COOKIE, signCookie(fresh), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 60 });
    }
    const draftId = await createDraft(fresh.access_token, to, sanitizeEmail(subject || ""), sanitizeEmail(body || ""));
    if (leadId && hasServiceKey()) {
      await supabaseAdmin.from(DRAFTS).update({ gmail_draft_id: draftId, status: "created_in_gmail" }).eq("lead_id", leadId);
    }
    return Response.json({ ok: true, draftId });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

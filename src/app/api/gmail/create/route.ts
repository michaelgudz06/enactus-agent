import { cookies } from "next/headers";
import { getSession, readCookie, signCookie } from "@/lib/auth";
import { createDraft, ensureAccessToken, hasGoogleConfig, GmailTokens, GMAIL_COOKIE } from "@/lib/gmail";
import { db, hasDatabaseUrl } from "@/lib/db";
import { stripEmDashes } from "@/lib/sanitize";

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

  const { to, subject, body, leadId, rowId } = await req.json().catch(() => ({}));
  if (!to) return Response.json({ error: "Recipient email is required." }, { status: 400 });

  // A dead refresh token is a reconnect, not a 500: only 428 makes the UI offer
  // the Connect button, so an expired session that fell through here left the
  // user with a generic error and no way out.
  let fresh: GmailTokens;
  try {
    fresh = await ensureAccessToken(tokens);
  } catch {
    return Response.json({ error: "connect", canConnect: true }, { status: 428 });
  }

  try {
    if (fresh.access_token !== tokens.access_token) {
      store.set(GMAIL_COOKIE, signCookie(fresh), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 60 });
    }
    const draftId = await createDraft(fresh.access_token, to, stripEmDashes(subject || ""), stripEmDashes(body || ""));
    // Stamp the one draft row this send came from. Keyed on lead_id it branded
    // every draft that lead ever had (one lead has six) with the same Gmail id.
    //
    // The Gmail draft exists by now, so a failed stamp is a bookkeeping miss.
    // Reported as a 500 it read as "nothing happened" and the user clicked
    // again, which is how you end up with two drafts of the same email.
    try {
      if (rowId && hasDatabaseUrl()) {
        await db()`update enactus_email_drafts
                   set gmail_draft_id = ${draftId}, status = 'created_in_gmail'
                   where id = ${rowId}`;
      } else if (leadId && hasDatabaseUrl()) {
        await db()`update enactus_email_drafts
                   set gmail_draft_id = ${draftId}, status = 'created_in_gmail'
                   where id = (select id from enactus_email_drafts where lead_id = ${leadId} order by created_at desc limit 1)`;
      }
    } catch (e) {
      console.error("gmail stamp failed:", (e as Error).message);
    }
    return Response.json({ ok: true, draftId });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { clubAccessToken, createDraft, hasGoogleConfig, sendMessage } from "@/lib/gmail";
import { stripEmDashes } from "@/lib/sanitize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Draft and send are one route rather than two because everything either of
// them does apart from the single Gmail call -- authorise, mint a token,
// recognise a revoked one, stamp the row, advance the card, write the timeline
// entry -- is identical, and a second copy is a second place for the two to
// drift about what "sent" means.
type Mode = "draft" | "send";

export const POST = route(async (session, req: Request) => {
  if (!hasGoogleConfig()) {
    return Response.json(
      { error: "Google is not configured yet. Use ‘Open in Gmail’ and send by hand." },
      { status: 501 }
    );
  }

  const b = await req.json().catch(() => ({}));
  const mode: Mode = b?.mode === "send" ? "send" : "draft";
  const to = typeof b?.to === "string" ? b.to.trim() : "";
  const { leadId, rowId } = b ?? {};
  if (!to) return Response.json({ error: "Recipient email is required." }, { status: 400 });

  // Sending twice is the one mistake with no undo, and a double click, a retry
  // after a slow response, or a refetched tab can all cause it. The row already
  // records the outcome, so it is the cheapest possible interlock: an email
  // that went out stays gone out, and the second attempt reports the first
  // rather than delivering a duplicate.
  if (mode === "send" && rowId) {
    const [existing] = (await db()`
      select status, sent_at from enactus_email_drafts where id = ${rowId}`) as
      { status: string | null; sent_at: string | null }[];
    if (existing?.status === "sent") {
      return Response.json({ ok: true, alreadySent: true, sentAt: existing.sent_at });
    }
  }

  // A revoked or expired refresh token has to reach the UI as "reconnect", not
  // as a 500: only 428 makes the Connect button appear, and without it the user
  // gets a generic error and no way out of it.
  let club: Awaited<ReturnType<typeof clubAccessToken>>;
  try {
    club = await clubAccessToken();
  } catch {
    return Response.json({ error: "connect", canConnect: true }, { status: 428 });
  }
  if (!club) return Response.json({ error: "connect", canConnect: true }, { status: 428 });

  const subject = stripEmDashes(String(b?.subject ?? ""));
  const body = stripEmDashes(String(b?.body ?? ""));

  let draftId: string | null = null;
  let thread: { id: string; threadId: string } | null = null;
  try {
    if (mode === "send") thread = await sendMessage(club.token, to, subject, body);
    else draftId = await createDraft(club.token, to, subject, body);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  // Past this line the mail has left. Every write below is bookkeeping, so a
  // failure is a log line and never a 500 -- reported as an error it reads as
  // "nothing happened" and the user clicks again, which is exactly how you end
  // up sending the same email twice.
  let moved = false;
  try {
    // Which draft row this stamps, resolved once. rowId targets this exact
    // draft; the leadId fallback takes the newest email row for the lead,
    // because keyed on lead_id alone the stamp branded every draft that lead
    // ever had (one has six).
    let targetId: string | null = typeof rowId === "string" ? rowId : null;
    if (!targetId && leadId) {
      const [row] = (await db()`
        select id from enactus_email_drafts
         where lead_id = ${leadId} and channel = 'email'
         order by created_at desc limit 1`) as { id: string }[];
      targetId = row?.id ?? null;
    }
    if (targetId && mode === "send") {
      await db()`update enactus_email_drafts
                    set status = 'sent', sent_at = now(), sent_by_name = ${session.name},
                        to_email = ${to}, gmail_thread_id = ${thread!.threadId},
                        gmail_message_id = ${thread!.id}
                  where id = ${targetId}`;
    } else if (targetId) {
      await db()`update enactus_email_drafts
                    set gmail_draft_id = ${draftId}, status = 'created_in_gmail', to_email = ${to}
                  where id = ${targetId}`;
    }

    // Creating a draft used to be the last thing this app could watch happen,
    // because the send occurred in Gmail where there is no callback. Sending
    // from here closes that gap: the stage move now follows a real send rather
    // than an intention to send. Guarded on the stage so a follow-up to a lead
    // already in conversation cannot drag it backwards.
    if (leadId) {
      const advanced = await db()`
        update enactus_leads set status = 'outreach_sent'
         where id = ${leadId} and status in ('prospects', 'researched')
         returning id`;
      moved = advanced.length > 0;
      const note = mode === "send" ? `Email sent to ${to}` : `Gmail draft created for ${to}`;
      const meta = mode === "send"
        ? { to, threadId: thread!.threadId, messageId: thread!.id, from: club.email }
        : { to, draftId };
      await db()`
        insert into enactus_lead_activity (lead_id, kind, body, meta, actor_name)
        values (${leadId}, 'email', ${note}, ${JSON.stringify(meta)}::jsonb, ${session.name})`;
      if (moved) {
        await db()`
          insert into enactus_lead_activity (lead_id, kind, meta, actor_name)
          values (${leadId}, 'status_change',
                  ${JSON.stringify({ to: "outreach_sent", via: mode === "send" ? "sent" : "gmail_draft" })}::jsonb,
                  ${session.name})`;
      }
    }
  } catch (e) {
    console.error("gmail stamp failed:", (e as Error).message);
  }

  return Response.json({ ok: true, mode, draftId, threadId: thread?.threadId ?? null, from: club.email, moved });
});

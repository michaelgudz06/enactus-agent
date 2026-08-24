import { route } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// status_change and contact_found are written by other routes, never by a
// client, so the composer can only ever post the human kinds. 'linkedin' is
// here rather than in the Gmail route because nothing automated happens: the
// platform cannot send a LinkedIn message, so a person clicking "Mark as sent"
// after pasting it IS the event, and this is the endpoint for a human saying
// what they did.
const KINDS = new Set(["note", "call", "email", "linkedin"]);

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_session, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  const activities = await db()`
    select * from enactus_lead_activity where lead_id = ${id}
    order by created_at desc`;
  return Response.json({ activities });
});

export const POST = route(async (session, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const kind = KINDS.has(b?.kind) ? (b.kind as string) : "note";
  // Capped the way the draft route caps copy: a textarea will happily post a
  // megabyte, and nothing downstream reads past a paragraph.
  const body = String(b?.body ?? "").trim().slice(0, 4000);
  if (!body) return Response.json({ error: "body required" }, { status: 400 });

  // actor_name is read off the signed session cookie and never off the body:
  // the whole point of the log is who touched this sponsor, so it must not be
  // something a caller can claim. meta is left to its default for the same
  // reason -- only the routes that write system rows have anything true to
  // put in it, so there is no client-supplied jsonb to store or trust.
  const [activity] = await db()`
    insert into enactus_lead_activity (lead_id, kind, body, actor_name)
    values (${id}, ${kind}, ${body}, ${session.name})
    returning *`;

  // A sent LinkedIn message is outreach, and has to move the card and close out
  // its draft row exactly as a sent email does -- otherwise the same work
  // counts on one channel and vanishes on the other.
  let moved = false;
  if (kind === "linkedin") {
    try {
      await db()`
        update enactus_email_drafts
           set status = 'sent', sent_at = now(), sent_by_name = ${session.name}
         where id = (select id from enactus_email_drafts
                      where lead_id = ${id} and channel = 'linkedin'
                      order by created_at desc limit 1)`;
      const advanced = await db()`
        update enactus_leads set status = 'outreach_sent'
         where id = ${id} and status in ('prospects', 'researched')
         returning id`;
      moved = advanced.length > 0;
      if (moved) {
        await db()`
          insert into enactus_lead_activity (lead_id, kind, meta, actor_name)
          values (${id}, 'status_change',
                  ${JSON.stringify({ to: "outreach_sent", via: "linkedin" })}::jsonb,
                  ${session.name})`;
      }
    } catch (e) {
      // The message really was sent and the timeline already says so. Losing
      // the stage move is worth a log line, never a failed request.
      console.error("linkedin stamp failed:", (e as Error).message);
    }
  }

  return Response.json({ activity, moved });
});

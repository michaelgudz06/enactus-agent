import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { clubAccessToken, firstReplyAt, touchSynced } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One HTTP round-trip per thread. 25 of them fits comfortably; the whole
// function budget on Hobby is 60s.
export const maxDuration = 60;

// ponytail: 25 threads a click, oldest unanswered first. A cron would be
// tidier, but Hobby crons run once a day and this is a button someone presses
// when they want to know -- raise the cap or add a cron if the board ever
// carries more sent mail than a click can cover.
const BATCH = 25;

// Checking a thread we already know replied costs a request and can change
// nothing, so replied_at is the natural cursor: once stamped, that row is done
// forever.
export const POST = route(async () => {
  let club: Awaited<ReturnType<typeof clubAccessToken>>;
  try {
    club = await clubAccessToken();
  } catch {
    return Response.json({ error: "connect", canConnect: true }, { status: 428 });
  }
  if (!club) return Response.json({ error: "connect", canConnect: true }, { status: 428 });

  const rows = (await db()`
    select id, lead_id, gmail_thread_id, sent_by_name
      from enactus_email_drafts
     where status = 'sent' and replied_at is null and gmail_thread_id is not null
     order by sent_at asc
     limit ${BATCH}`) as
    { id: string; lead_id: string; gmail_thread_id: string; sent_by_name: string | null }[];

  let found = 0;
  for (const r of rows) {
    // One bad thread must not end the sweep: the next row may be the reply
    // someone is waiting to see.
    try {
      const at = await firstReplyAt(club.token, r.gmail_thread_id, club.email);
      if (!at) continue;
      await db()`update enactus_email_drafts set replied_at = ${at} where id = ${r.id}`;
      found++;
      // Credited to whoever sent it, which is what the scoreboard counts. A
      // reply is not something the person who ran the sync earned.
      await db()`
        insert into enactus_lead_activity (lead_id, kind, body, actor_name)
        values (${r.lead_id}, 'reply', 'Sponsor replied', ${r.sent_by_name})`;
    } catch (e) {
      console.error("reply check failed:", (e as Error).message);
    }
  }

  try {
    await touchSynced();
  } catch (e) {
    console.error("sync stamp failed:", (e as Error).message);
  }
  return Response.json({ checked: rows.length, found, more: rows.length === BATCH });
});

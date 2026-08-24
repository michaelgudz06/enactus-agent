import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildScoreboard, type ScoreEvent } from "@/lib/scoreboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Four sources, one shape. The SQL only fetches; every decision about weeks,
// spellings and badges lives in lib/scoreboard.ts, where it can be asserted
// without a database.
//
// One union rather than four round-trips: these tables are hundreds of rows,
// not millions, and a scoreboard that reads the whole history is simpler than
// one that maintains a running total nobody can recompute.
export const GET = route(async () => {
  const rows = (await db()`
    select sent_by_name as actor,
           case when channel = 'linkedin' then 'dm' else 'email' end as kind,
           sent_at as at
      from enactus_email_drafts
     where status = 'sent' and sent_at is not null

    union all

    select sent_by_name, 'reply', replied_at
      from enactus_email_drafts
     where replied_at is not null

    -- 'contact_added' only. 'contact_found' is the agent's Firecrawl lookup,
    -- and the ask was explicitly for what people do outside the agent.
    union all
    select actor_name, 'contact', created_at
      from enactus_lead_activity
     where kind = 'contact_added'

    union all
    select owner_name, 'win', closed_at
      from enactus_leads
     where status = 'closed_won' and closed_at is not null
  `) as ScoreEvent[];

  const [box] = (await db()`select last_synced_at from enactus_mailbox where id = true`) as
    { last_synced_at: string | null }[];

  return Response.json({
    ...buildScoreboard(rows, new Date().toISOString()),
    lastSyncedAt: box?.last_synced_at ?? null,
  });
});

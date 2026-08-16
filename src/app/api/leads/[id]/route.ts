import { after } from "next/server";
import { route } from "@/lib/auth";
import { db, setClause } from "@/lib/db";
import { findContactFor } from "@/lib/contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The drag returns immediately; the contact lookup that follows it runs in
// after() and needs the headroom of a scrape, not of a single UPDATE.
export const maxDuration = 30;

const EDITABLE = new Set([
  "company", "website", "industry", "description", "contact_name", "contact_role",
  "contact_email", "location", "connection_type", "connection_note", "sponsorship_type",
  "why_fit", "status", "board_order",
]);

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (session, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const { sets, values } = setClause(b, EDITABLE, { sponsorship_type: "::text[]" });
  values.push(id);

  // "from" is only knowable before the write, and only worth a round-trip
  // when this patch actually carries a status.
  const from = "status" in b
    ? (await db()`select status from enactus_leads where id = ${id}`)[0]?.status
    : undefined;

  const rows = await db().query(
    `update enactus_leads set ${sets.join(", ")} where id = $${values.length} returning *`,
    values
  );
  if (!rows.length) return Response.json({ error: "Lead not found" }, { status: 404 });

  if (from !== undefined && from !== rows[0].status) {
    // The move is the user's action and has already committed. Losing its
    // timeline entry is worth a log line, never a failed drag.
    try {
      await db()`
        insert into enactus_lead_activity (lead_id, kind, meta, actor_name)
        values (${id}, 'status_change',
                ${JSON.stringify({ from, to: rows[0].status })}::jsonb, ${session.name})`;
    } catch (e) {
      console.error("activity persist failed:", (e as Error).message);
    }

    // Moving a lead off the prospects column is the moment someone decided to
    // contact it, and the only moment worth spending scrape credits on.
    //
    // after(), not a bare floating promise: the drag has to land instantly,
    // but a promise left running past the response gets frozen with the
    // function on Vercel and the write silently never happens. The result
    // goes straight onto the row the board re-reads, so the card fills in on
    // its own.
    if (from === "prospects" && rows[0].status !== "prospects" && !rows[0].contact_email) {
      after(async () => {
        try {
          await findContactFor(id, session.name);
        } catch (e) {
          console.error("auto contact lookup failed:", (e as Error).message);
        }
      });
    }
  }

  return Response.json({ lead: rows[0] });
});

export const DELETE = route(async (_session, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  await db()`delete from enactus_leads where id = ${id}`;
  return Response.json({ ok: true });
});

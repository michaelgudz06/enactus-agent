import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { Mode } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_session, req: Request) => {
  const mode = new URL(req.url).searchParams.get("mode");
  const sql = db();
  // last_activity_at is derived, not stored: the newest of the row's own
  // updated_at and its newest timeline entry. Computing it here rather than
  // keeping a column means no write path has to remember to touch it, and
  // Postgres GREATEST already ignores the null from a lead with no activity.
  // It is what the follow-up chips measure silence against.
  const leads =
    mode === "sponsor" || mode === "sales"
      ? await sql`select l.*, greatest(l.updated_at,
                    (select max(a.created_at) from enactus_lead_activity a where a.lead_id = l.id)
                  ) as last_activity_at
                  from enactus_leads l where l.mode = ${mode}
                  order by l.board_order asc, l.created_at desc`
      : await sql`select l.*, greatest(l.updated_at,
                    (select max(a.created_at) from enactus_lead_activity a where a.lead_id = l.id)
                  ) as last_activity_at
                  from enactus_leads l
                  order by l.board_order asc, l.created_at desc`;
  return Response.json({ leads });
}, { leads: [] });

export const POST = route(async (session, req: Request) => {
  const b = await req.json().catch(() => ({}));
  const mode: Mode = b.mode === "sales" ? "sales" : "sponsor";

  const [lead] = await db()`
    insert into enactus_leads (
      company, website, industry, description, contact_name, contact_role,
      contact_email, location, connection_type, sponsorship_type, why_fit,
      status, mode, created_by_name
    ) values (
      ${String(b.company ?? "").trim() || "New lead"},
      ${b.website ?? null},
      ${b.industry ?? null},
      ${b.description ?? null},
      ${b.contact_name ?? null},
      ${b.contact_role ?? null},
      ${b.contact_email ?? null},
      ${b.location ?? null},
      ${b.connection_type ?? "none"},
      ${Array.isArray(b.sponsorship_type) ? b.sponsorship_type : []}::text[],
      ${b.why_fit ?? null},
      ${b.status ?? "prospects"},
      ${mode},
      ${session.name}
    )
    returning *`;
  return Response.json({ lead });
});

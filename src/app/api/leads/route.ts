import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { Mode } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_session, req: Request) => {
  const mode = new URL(req.url).searchParams.get("mode");
  const sql = db();
  const leads =
    mode === "sponsor" || mode === "sales"
      ? await sql`select * from enactus_leads where mode = ${mode}
                  order by board_order asc, created_at desc`
      : await sql`select * from enactus_leads
                  order by board_order asc, created_at desc`;
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

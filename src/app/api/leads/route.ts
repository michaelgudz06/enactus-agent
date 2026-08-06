import { getSession } from "@/lib/auth";
import { supabaseAdmin, LEADS, hasServiceKey } from "@/lib/supabase";
import { Mode } from "@/lib/types";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ leads: [], warning: "SUPABASE_SERVICE_ROLE_KEY missing" });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  let q = supabaseAdmin.from(LEADS).select("*").order("board_order", { ascending: true }).order("created_at", { ascending: false });
  if (mode === "sponsor" || mode === "sales") q = q.eq("mode", mode);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ leads: data ?? [] });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, { status: 400 });

  const b = await req.json().catch(() => ({}));
  const mode: Mode = b.mode === "sales" ? "sales" : "sponsor";
  const row = {
    company: String(b.company ?? "").trim() || "New lead",
    website: b.website ?? null,
    industry: b.industry ?? null,
    description: b.description ?? null,
    contact_name: b.contact_name ?? null,
    contact_role: b.contact_role ?? null,
    contact_email: b.contact_email ?? null,
    location: b.location ?? null,
    connection_type: b.connection_type ?? "none",
    sponsorship_type: Array.isArray(b.sponsorship_type) ? b.sponsorship_type : [],
    why_fit: b.why_fit ?? null,
    status: b.status ?? "prospects",
    mode,
    created_by_name: session.name,
  };
  const { data, error } = await supabaseAdmin.from(LEADS).insert(row).select("*").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const attribution = await logActivity({
    actor: session.name,
    action: "lead_created",
    subject: "lead",
    subjectId: (data as { id?: string } | null)?.id ?? null,
    detail: { company: row.company, mode, via: "manual" },
  });

  return Response.json({ lead: data, ...(attribution.error ? { attributionError: attribution.error } : {}) });
}

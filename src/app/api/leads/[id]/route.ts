import { getSession } from "@/lib/auth";
import { supabaseAdmin, LEADS, hasServiceKey } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDITABLE = new Set([
  "company", "website", "industry", "description", "contact_name", "contact_role",
  "contact_email", "location", "connection_type", "connection_note", "sponsorship_type",
  "fit_score", "why_fit", "status", "board_order",
]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, { status: 400 });
  const { id } = await params;

  const b = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(b)) if (EDITABLE.has(k)) patch[k] = v;

  const { data, error } = await supabaseAdmin.from(LEADS).update(patch).eq("id", id).select("*").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ lead: data });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, { status: 400 });
  const { id } = await params;
  const { error } = await supabaseAdmin.from(LEADS).delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

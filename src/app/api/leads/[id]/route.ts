import { getSession } from "@/lib/auth";
import { supabaseAdmin, LEADS, hasServiceKey } from "@/lib/supabase";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDITABLE = new Set([
  "company", "website", "industry", "description", "contact_name", "contact_role",
  "contact_email", "location", "connection_type", "connection_note", "sponsorship_type",
  "fit_score", "why_fit", "status", "board_order",
  // A human who has corrected the record can clear the note explaining what the
  // model got wrong; without this the warning outlives the problem.
  "contact_email_status", "website_status",
]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, { status: 400 });
  const { id } = await params;

  const b = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const edited: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!EDITABLE.has(k)) continue;
    patch[k] = v;
    edited.push(k);
  }

  const { data, error } = await supabaseAdmin.from(LEADS).update(patch).eq("id", id).select("*").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Which fields changed, never what they changed to: a `contact_email` value
  // is the lead's business contact detail and has no business in an audit line.
  const attribution = await logActivity({
    actor: session.name,
    action: "lead_updated",
    subject: "lead",
    subjectId: id,
    detail: { fields: edited.join(",") },
  });

  return Response.json({ lead: data, ...(attribution.error ? { attributionError: attribution.error } : {}) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, { status: 400 });
  const { id } = await params;
  const { error } = await supabaseAdmin.from(LEADS).delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // The row is gone, so this line is the only remaining record that it existed
  // and who removed it.
  const attribution = await logActivity({
    actor: session.name,
    action: "lead_deleted",
    subject: "lead",
    subjectId: id,
  });

  return Response.json({ ok: true, ...(attribution.error ? { attributionError: attribution.error } : {}) });
}

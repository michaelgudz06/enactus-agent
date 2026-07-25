import { getSession } from "@/lib/auth";
import { supabaseAdmin, SEARCHES, hasServiceKey } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ searches: [] });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  let q = supabaseAdmin.from(SEARCHES).select("*").order("created_at", { ascending: false }).limit(20);
  if (mode === "sponsor" || mode === "sales") q = q.eq("mode", mode);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ searches: data ?? [] });
}

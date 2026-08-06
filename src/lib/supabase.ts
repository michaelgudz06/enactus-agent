import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase access using the service-role key. The client is created
// lazily on first use (never at module load) so production builds don't need
// runtime env vars present during the build step.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set");
  _client = createClient(url, serviceKey ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// Proxy keeps existing call sites (`supabaseAdmin.from(...)`) working while
// deferring client creation until the first property access at runtime.
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getClient() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

export const LEADS = "enactus_leads";
export const SEARCHES = "enactus_searches";
export const DRAFTS = "enactus_email_drafts";
/** Append-only ledger of paid API calls, behind the monthly cap. */
export const SPEND = "enactus_api_spend";
/** Append-only attribution: who was signed in when an action happened. */
export const ACTIVITY = "enactus_activity_log";

export function hasServiceKey() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(serviceKey && !serviceKey.startsWith("REPLACE"));
}

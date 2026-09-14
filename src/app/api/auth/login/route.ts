import { cookies } from "next/headers";
import { checkPassword, makeToken, COOKIE_NAME } from "@/lib/auth";
import { canonicalName } from "@/lib/people";
import { db, hasDatabaseUrl } from "@/lib/db";

/**
 * The names this team has already attributed work to, most recent first.
 *
 * Read only AFTER the password check. /login is the one page anyone on the
 * internet can load, and the team's names are not something to hand out before
 * the password -- the login page makes the same argument about why it uses
 * localStorage rather than asking the server for a list.
 *
 * Never throws: an unreachable database costs the spelling, not the sign-in.
 */
async function knownNames(): Promise<string[]> {
  if (!hasDatabaseUrl()) return [];
  try {
    const rows = (await db()`
      select created_by_name, max(created_at) as last_seen
        from enactus_leads
       where created_by_name is not null and btrim(created_by_name) <> ''
       group by created_by_name
       order by last_seen desc
       limit 50`) as { created_by_name: string }[];
    return (rows ?? []).map((r) => r.created_by_name);
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  const { password, name } = await req.json().catch(() => ({}));
  if (!checkPassword(String(password ?? ""))) {
    return Response.json({ error: "Incorrect team password." }, { status: 401 });
  }
  // Settle on the spelling the team already uses, so signing in from a new
  // phone does not add a third "michael" to the board's owner filter.
  const displayName = canonicalName(String(name ?? ""), await knownNames()) || "Team member";
  const store = await cookies();
  store.set(COOKIE_NAME, makeToken(displayName), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true, name: displayName });
}

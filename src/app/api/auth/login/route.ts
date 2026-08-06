import { cookies } from "next/headers";
import { checkPassword, makeToken, COOKIE_NAME } from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export async function POST(req: Request) {
  const { password, name } = await req.json().catch(() => ({}));
  if (!checkPassword(String(password ?? ""))) {
    // Nothing is recorded for a failed attempt. The only thing there is to
    // record is the password that was tried, and that never enters a log.
    return Response.json({ error: "Incorrect team password." }, { status: 401 });
  }
  const displayName = String(name ?? "").trim().slice(0, 40) || "Team member";
  // The name only. Not the password, not the token this hands back.
  await logActivity({ actor: displayName, action: "signed_in", subject: "session" });
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

import { route } from "@/lib/auth";
import { hasGoogleConfig, mailbox } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Status only. The refresh token itself never leaves the server -- the page
// needs to know whether a mailbox is connected and which one, nothing else.
export const GET = route(async () => {
  const box = await mailbox();
  return Response.json({
    configured: hasGoogleConfig(),
    mailbox: box
      ? {
          email: box.email,
          connected_by_name: box.connected_by_name,
          connected_at: box.connected_at,
        }
      : null,
  });
});

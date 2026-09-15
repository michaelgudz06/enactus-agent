import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import type { SearchRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The columns of SearchRow, named explicitly rather than `select *`.
//
// enactus_searches is now the run log, not just "what was typed", and three of
// the columns it grew have no business reaching a browser: `params` carries the
// whole RunTrace (every query and every candidate domain of every run), `error`
// carries a verbatim provider exception, and `resume_state` carries a parked
// candidate pool -- up to a couple of dozen pages of scraped site text. A
// `select *` on a table that is still growing columns ships each new one to the
// client by default, which is the wrong default for a diagnostic table.
//
// A constant, never anything from the request, so it is safe to interpolate.
const COLUMNS = "id, prompt, normalized, mode, result_count, created_by_name, created_at";

export const GET = route(async (_session, req: Request) => {
  const mode = new URL(req.url).searchParams.get("mode");
  // kind = 'leads' only. Answer turns are logged in this table too now, and
  // without the filter "Recent searches" starts offering the volunteer "hi" and
  // "thanks!" as searches to re-run.
  const scoped = mode === "sponsor" || mode === "sales";
  const rows = await db().query(
    `select ${COLUMNS} from enactus_searches
      where kind = 'leads'${scoped ? " and mode = $1" : ""}
      order by created_at desc limit 20`,
    scoped ? [mode] : []
  );
  return Response.json({ searches: rows as unknown as SearchRow[] });
}, { searches: [] });

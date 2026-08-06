import { getSession } from "@/lib/auth";
import { supabaseAdmin, LEADS, DRAFTS, hasServiceKey } from "@/lib/supabase";
import { chatJSON } from "@/lib/llm";
import { sanitizeEmail } from "@/lib/sanitize";
import { Lead } from "@/lib/types";
import { ENACTUS_PROJECTS } from "@/lib/enactus";
import { ValueDefect, defectMessage, describeValue, readEnvelope, reviewFields } from "@/lib/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Checked field by field, on the same contract the plan and the leads use. A
// subject that came back as the wrong type used to reach sanitizeEmail as a
// non-string and throw out of the handler, so the request failed with an opaque
// 500 and the body a human could have sent went with it.
const DRAFT_PROPERTIES: Record<string, Record<string, unknown>> = {
  subject: { type: "string" },
  body: { type: "string" },
};

// A field that is a string and still says nothing costs the human the same
// thing a wrong-typed one does: the subject below is the code's, not the
// model's, and nobody may read it as something the model wrote.
const EMPTY_DRAFT_DETAIL: Record<string, string> = {
  subject: "the model wrote no subject line, so this draft carries a generated one",
  body: "the model wrote no body, so this draft is yours to write",
};

const STYLE = `Write outreach emails that sound like a real person wrote them.
Hard rules:
- NEVER use em dashes or en dashes. Use short sentences, commas, or periods instead.
- Be concise and brief. 90 to 150 words for the body. No filler, no corporate fluff.
- Exactly one clear call to action (usually asking for a 15 minute chat).
- Warm and specific, reference the concrete reason this company is a fit.
- Plain text, no markdown. Sign off as the sender's name placeholder [Your Name], Enactus SFU.`;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!hasServiceKey()) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, { status: 400 });

  const { leadId } = await req.json().catch(() => ({}));
  if (!leadId) return Response.json({ error: "leadId required" }, { status: 400 });

  const { data: lead, error } = await supabaseAdmin.from(LEADS).select("*").eq("id", leadId).single();
  if (error || !lead) return Response.json({ error: "Lead not found" }, { status: 404 });
  const l = lead as Lead;

  const isSales = l.mode === "sales";
  const goal = isSales
    ? `You are a project manager reaching out to a potential customer to introduce your product and ask for a short intro call.`
    : `You are ${session.name}, on the External Relations team at Enactus SFU (a student social-entrepreneurship club at Simon Fraser University). You are asking this company to support Enactus SFU with sponsorship (monetary and/or in-kind).\n\n${ENACTUS_PROJECTS}\n\nGround the email in ONE specific Enactus SFU project that best fits this company (use the "Why they fit" note if it names one). Mention that project by name and why it aligns with them, rather than pitching Enactus generically.`;

  const facts = [
    `Company: ${l.company}`,
    l.contact_name ? `Contact: ${l.contact_name}${l.contact_role ? `, ${l.contact_role}` : ""}` : "",
    l.industry ? `Industry: ${l.industry}` : "",
    l.location ? `Location: ${l.location}` : "",
    l.description ? `About: ${l.description}` : "",
    l.connection_type && l.connection_type !== "none" ? `Connection: ${l.connection_type}${l.connection_note ? ` (${l.connection_note})` : ""}` : "",
    l.why_fit ? `Why they fit: ${l.why_fit}` : "",
    l.sponsorship_type?.length ? `Angle: ${l.sponsorship_type.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  let out: unknown;
  try {
    out = await chatJSON<unknown>(
      [
        { role: "system", content: `${goal}\n\n${STYLE}\n\nRespond ONLY as JSON: {"subject": string, "body": string}` },
        { role: "user", content: `Draft a first-touch outreach email to this lead.\n\n${facts}` },
      ],
      { maxTokens: 700 }
    );
  } catch (e) {
    return Response.json({ error: `Draft failed: ${(e as Error).message}` }, { status: 500 });
  }

  // A malformed subject costs the subject, never the body beside it.
  const defects: ValueDefect[] = [];
  // A draft wrapped in a list of one is still a draft. Anything else carries no
  // single draft to keep, so it is a real stop.
  const raw = readEnvelope(out, l.company, "draft", defects);
  if (!raw) {
    return Response.json({ error: `The model did not return a draft: got ${describeValue(out)}` }, { status: 502 });
  }

  reviewFields(l.company, raw, DRAFT_PROPERTIES, defects);

  for (const [field, detail] of Object.entries(EMPTY_DRAFT_DETAIL)) {
    const value = raw[field];
    if (typeof value === "string" && value.trim()) continue;
    if (defects.some((d) => d.field === field)) continue;
    defects.push({ subject: l.company, field, detail, action: "ignored" });
  }

  const subject = sanitizeEmail(typeof raw.subject === "string" && raw.subject.trim() ? raw.subject : `Enactus SFU x ${l.company}`);
  const body = sanitizeEmail(typeof raw.body === "string" ? raw.body : "");
  const notes = defects.map((d) => defectMessage(d, "draft"));

  const { data: draft } = await supabaseAdmin
    .from(DRAFTS)
    .insert({ lead_id: l.id, subject, body, status: "draft", created_by_name: session.name })
    .select("*")
    .single();

  return Response.json({ subject, body, notes, draftId: draft?.id ?? null, to: l.contact_email });
}

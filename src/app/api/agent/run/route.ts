import { getSession } from "@/lib/auth";
import { runAgent, resumeAgent } from "@/lib/agent";
import { AgentEvent, Mode } from "@/lib/types";
import { hasLLMKey } from "@/lib/llm";
import { hasExaKey } from "@/lib/exa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby plan caps functions at 60s. A run that cannot reason properly in what
// discovery left it parks its candidates and closes with a `continue` event;
// the client POSTs the runId straight back and this route picks it up with a
// whole budget of its own. See src/lib/resume.ts.
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (!hasLLMKey()) return Response.json({ error: "OPENROUTER_API_KEY missing." }, { status: 400 });
  if (!hasExaKey()) return Response.json({ error: "EXA_API_KEY missing." }, { status: 400 });

  const body = await req.json().catch(() => ({}));

  // Resuming a handed-off run. It carries no prompt: everything it needs was
  // settled, paid for and stored by the invocation that handed it off.
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (runId) return streamEvents((emit) => resumeAgent(runId, emit));

  const prompt = String(body.prompt ?? "").trim();
  const mode: Mode = body.mode === "sales" ? "sales" : "sponsor";
  const answers = body.answers ? String(body.answers) : undefined;
  const skipClarify = Boolean(body.skipClarify);
  if (!prompt) return Response.json({ error: "Prompt is required." }, { status: 400 });

  return streamEvents((emit) =>
    runAgent({ prompt, mode, answers, skipClarify, userName: session.name }, emit)
  );
}

/**
 * Run something that emits agent events, as an NDJSON stream.
 *
 * Shared by a new run and a resumed one so the two cannot drift on framing,
 * headers or error handling -- from the client's side a resume is the same
 * stream arriving in a second response.
 */
function streamEvents(work: (emit: (e: AgentEvent) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          // controller closed
        }
      };
      try {
        await work(emit);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

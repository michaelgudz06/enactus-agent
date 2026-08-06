"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowUp, Brain, History, Lightbulb, CircleDashed, CheckCircle2, AlertTriangle } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { AgentEvent, Lead, SearchRow } from "@/lib/types";
import LeadCard from "@/components/LeadCard";
import EmailModal from "@/components/EmailModal";

interface Step { step: string; message: string; }

const EXAMPLES_SPONSOR = [
  "Catering & food companies in Burnaby that could sponsor student events",
  "SFU alumni-founded tech startups in Vancouver open to giving back",
  "Credit unions and banks in the Lower Mainland with community grant programs",
];
const EXAMPLES_SALES = [
  "Mid-size Vancouver construction firms that might need project management software",
  "Burnaby manufacturing companies expanding their operations this year",
  "BC startups that recently raised funding and are hiring ops roles",
];

export default function AgentPage() {
  const { mode, name } = useApp();
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [reasoning, setReasoning] = useState("");
  const [similar, setSimilar] = useState<{ message: string; suggestion: string } | null>(null);
  const [clarify, setClarify] = useState<string[] | null>(null);
  const [answers, setAnswers] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(0);
  const [history, setHistory] = useState<SearchRow[]>([]);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);
  const reasonRef = useRef<HTMLDivElement>(null);

  const examples = mode === "sales" ? EXAMPLES_SALES : EXAMPLES_SPONSOR;

  useEffect(() => {
    fetch(`/api/searches?mode=${mode}`).then((r) => r.json()).then((d) => setHistory(d.searches || [])).catch(() => {});
  }, [mode, done]);

  useEffect(() => {
    if (reasonRef.current) reasonRef.current.scrollTop = reasonRef.current.scrollHeight;
  }, [reasoning]);

  async function run(withAnswers?: string) {
    setRunning(true);
    setError("");
    setSteps([]);
    setReasoning("");
    setSimilar(null);
    setClarify(null);
    setLeads([]);
    setDone(false);

    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, mode, answers: withAnswers, skipClarify: Boolean(withAnswers) }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done: rdone, value } = await reader.read();
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: AgentEvent;
          try { ev = JSON.parse(line); } catch { continue; }
          handleEvent(ev);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function handleEvent(ev: AgentEvent) {
    switch (ev.type) {
      case "status": setSteps((s) => [...s, { step: ev.step, message: ev.message }]); break;
      case "reasoning": setReasoning((r) => r + ev.text); break;
      case "similar": setSimilar({ message: ev.message, suggestion: ev.suggestion }); break;
      case "clarify": setClarify(ev.questions); break;
      case "lead": setLeads((l) => [...l, ev.lead]); break;
      case "done": setSaved(ev.saved); setDone(true); break;
      case "error": setError(ev.message); break;
    }
  }

  const showWorkspace = running || steps.length > 0 || leads.length > 0 || error || clarify;

  return (
    <div className="max-w-6xl mx-auto px-5 py-6">
      {/* Prompt */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={18} style={{ color: "var(--gold)" }} />
          <h1 className="text-lg font-bold">Find sponsors</h1>
        </div>
        <p className="text-sm mb-3 ml-7" style={{ color: "var(--muted)" }}>
          Describe the kind of sponsor you want. The agent finds real Lower Mainland companies, checks for SFU ties, matches each to an Enactus project, and adds them to your board.
        </p>

        <div className="rounded-2xl border p-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && !running) run(); }}
            placeholder={mode === "sales" ? "Describe the customers you want to find…" : "Describe the sponsors you want to find…"}
            rows={3}
            className="w-full bg-transparent outline-none text-sm resize-none px-1"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>⌘/Ctrl + Enter to run</span>
            <button
              onClick={() => run()}
              disabled={running || !prompt.trim()}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-black disabled:opacity-50"
              style={{ background: "var(--gold)" }}
            >
              {running ? "Running…" : "Run agent"} <ArrowUp size={15} />
            </button>
          </div>
        </div>

        {!showWorkspace && (
          <div className="mt-3 flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="text-xs px-3 py-1.5 rounded-full border text-left"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Workspace */}
      {showWorkspace && (
        <div className="grid lg:grid-cols-[1fr_340px] gap-5">
          {/* Results */}
          <div className="order-2 lg:order-1">
            {similar && (
              <div className="mb-3 rounded-xl border p-3 flex gap-2.5 animate-in" style={{ background: "rgba(245,200,66,.08)", borderColor: "rgba(245,200,66,.35)" }}>
                <History size={16} style={{ color: "var(--gold)" }} className="shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div style={{ color: "var(--text)" }}>{similar.message}</div>
                  <div className="mt-1 flex items-start gap-1" style={{ color: "var(--muted)" }}>
                    <Lightbulb size={13} className="shrink-0 mt-0.5" style={{ color: "var(--gold)" }} /> {similar.suggestion}
                  </div>
                </div>
              </div>
            )}

            {clarify && (
              <div className="mb-3 rounded-xl border p-4 animate-in" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <div className="text-sm font-semibold mb-2">A couple quick questions to sharpen the search</div>
                <ul className="text-xs space-y-1 mb-3" style={{ color: "var(--muted)" }}>
                  {clarify.map((q, i) => <li key={i}>• {q}</li>)}
                </ul>
                <textarea
                  value={answers}
                  onChange={(e) => setAnswers(e.target.value)}
                  rows={2}
                  placeholder="Type your answers here…"
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none border mb-2"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                />
                <button onClick={() => run(answers)} disabled={running} className="px-3 py-2 rounded-lg text-xs font-semibold text-black" style={{ background: "var(--gold)" }}>
                  Continue with answers
                </button>
              </div>
            )}

            {error && (
              <div className="mb-3 rounded-xl border p-3 flex gap-2 text-xs" style={{ background: "rgba(230,57,70,.08)", borderColor: "rgba(230,57,70,.35)", color: "var(--text)" }}>
                <AlertTriangle size={15} style={{ color: "var(--accent)" }} className="shrink-0 mt-0.5" /> {error}
              </div>
            )}

            {leads.length > 0 && (
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold">{leads.length} lead{leads.length !== 1 ? "s" : ""} found</div>
                {done && saved === leads.length && (
                  <a href="/board" className="text-xs" style={{ color: "var(--gold)" }}>Added to Prospects → View board</a>
                )}
                {done && saved < leads.length && (
                  <span className="text-xs" style={{ color: "var(--faint)" }}>
                    {saved > 0 ? `Only ${saved} of ${leads.length} reached the board` : "Not saved to the board"}
                  </span>
                )}
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              {leads.map((l) => <LeadCard key={l.id} lead={l} onEmail={setEmailLead} />)}
            </div>

            {running && leads.length === 0 && !clarify && (
              <div className="grid sm:grid-cols-2 gap-3">
                {[0, 1].map((i) => <div key={i} className="h-40 rounded-xl shimmer" />)}
              </div>
            )}

            {done && leads.length === 0 && !clarify && !error && (
              <div className="rounded-xl border p-4 text-sm animate-in" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <div className="font-semibold mb-1">No sponsors matched this one.</div>
                <div style={{ color: "var(--muted)" }}>
                  This often happens when a search surfaces student clubs or membership groups, which the agent skips on purpose. Try naming a concrete business type or industry, for example “credit unions with community grants”, “catering companies in Burnaby”, or “sustainable packaging companies”.
                </div>
              </div>
            )}
          </div>

          {/* Activity + reasoning rail */}
          <div className="order-1 lg:order-2">
            <div className="rounded-xl border p-4 lg:sticky lg:top-20" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center gap-2 mb-3">
                <Brain size={15} style={{ color: "var(--gold)" }} />
                <span className="text-sm font-semibold">Agent activity</span>
              </div>

              <div className="space-y-2.5 mb-3">
                {steps.map((s, i) => {
                  const isLast = i === steps.length - 1 && running;
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs animate-in">
                      {isLast ? <CircleDashed size={14} className="shrink-0 mt-0.5 dot-pulse" style={{ color: "var(--gold)" }} /> : <CheckCircle2 size={14} className="shrink-0 mt-0.5" style={{ color: "var(--green)" }} />}
                      <span style={{ color: isLast ? "var(--text)" : "var(--muted)" }}>{s.message}</span>
                    </div>
                  );
                })}
                {steps.length === 0 && running && <div className="text-xs" style={{ color: "var(--muted)" }}>Starting…</div>}
              </div>

              {reasoning && (
                <div>
                  <div className="text-[11px] font-medium mb-1.5 flex items-center gap-1" style={{ color: "var(--faint)" }}>
                    <Brain size={12} /> DeepSeek R1 reasoning
                  </div>
                  <div ref={reasonRef} className="text-[11px] leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto reason-scroll p-2.5 rounded-lg" style={{ background: "var(--bg)", color: "var(--muted)" }}>
                    {reasoning}
                    {running && <span className="dot-pulse">▋</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Recent searches */}
      {!showWorkspace && history.length > 0 && (
        <div className="mt-8">
          <div className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <History size={13} /> Recent searches
          </div>
          <div className="space-y-1.5">
            {history.slice(0, 6).map((h) => (
              <button key={h.id} onClick={() => setPrompt(h.prompt)} className="w-full text-left text-xs px-3 py-2 rounded-lg border flex items-center justify-between" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <span className="truncate" style={{ color: "var(--text)" }}>{h.prompt}</span>
                <span className="shrink-0 ml-3" style={{ color: "var(--faint)" }}>{h.result_count} leads · {h.created_by_name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {emailLead && <EmailModal lead={emailLead} onClose={() => setEmailLead(null)} />}
    </div>
  );
}

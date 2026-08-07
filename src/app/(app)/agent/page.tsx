"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, ArrowUp, Brain, History, Lightbulb, CircleDashed, CheckCircle2, AlertTriangle, Square } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { useRunControls, useRunState } from "@/components/RunProvider";
import { runHasWorkspace } from "@/lib/run-store";
import { Lead, SearchRow } from "@/lib/types";
import LeadCard from "@/components/LeadCard";
import EmailModal from "@/components/EmailModal";

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

/**
 * This page renders the run; it does not own it. Everything about the run in
 * flight lives in the provider mounted at the `(app)` layout, so leaving for the
 * board and coming back re-reads the same state rather than starting from a
 * blank form.
 */
export default function AgentPage() {
  const { mode } = useApp();
  const run = useRunState();
  const controls = useRunControls();
  const { draft, answers, running, steps, reasoning, similar, clarify, leads, error, done, saved, cancelled } = run;

  // Local to this page: neither belongs to the run, and neither has to survive
  // the trip to the board.
  const [history, setHistory] = useState<SearchRow[]>([]);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);
  const [notice, setNotice] = useState("");
  const reasonRef = useRef<HTMLDivElement>(null);

  const examples = mode === "sales" ? EXAMPLES_SALES : EXAMPLES_SPONSOR;

  useEffect(() => {
    fetch(`/api/searches?mode=${mode}`).then((r) => r.json()).then((d) => setHistory(d.searches || [])).catch(() => {});
  }, [mode, done]);

  useEffect(() => {
    if (reasonRef.current) reasonRef.current.scrollTop = reasonRef.current.scrollHeight;
  }, [reasoning]);

  // A refusal describes the run that was in flight when it was refused. Once
  // that run ends the Run button works again, so leaving "a search is already
  // running" on screen would tell the student the opposite of the truth. A
  // refusal made while nothing was running — an empty prompt — is untouched,
  // because `running` did not change.
  useEffect(() => {
    if (!running) setNotice("");
  }, [running]);

  // The provider is the gate on a second run, not this handler: it refuses
  // synchronously and says why, and the reason is shown rather than swallowed.
  function start(withAnswers?: string) {
    const outcome = controls.start({ prompt: draft, mode, answers: withAnswers });
    setNotice(outcome.started ? "" : outcome.reason);
  }

  function stop() {
    setNotice("");
    controls.cancel();
  }

  const showWorkspace = runHasWorkspace(run);

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
            value={draft}
            onChange={(e) => controls.setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(); }}
            placeholder={mode === "sales" ? "Describe the customers you want to find…" : "Describe the sponsors you want to find…"}
            rows={3}
            className="w-full bg-transparent outline-none text-sm resize-none px-1"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>
              {running ? "Keep browsing — this keeps running if you switch to the board" : "⌘/Ctrl + Enter to run"}
            </span>
            <div className="flex items-center gap-2">
              {running && (
                <button
                  onClick={stop}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border"
                  style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                >
                  <Square size={13} /> Stop
                </button>
              )}
              <button
                onClick={() => start()}
                disabled={running || !draft.trim()}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-black disabled:opacity-50"
                style={{ background: "var(--gold)" }}
              >
                {running ? "Running…" : "Run agent"} <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </div>

        {notice && (
          <div className="mt-2 text-xs rounded-lg px-3 py-2 border" style={{ background: "rgba(245,200,66,.08)", borderColor: "rgba(245,200,66,.35)", color: "var(--text)" }}>
            {notice}
          </div>
        )}

        {!showWorkspace && (
          <div className="mt-3 flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => controls.setDraft(ex)}
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
                  onChange={(e) => controls.setAnswers(e.target.value)}
                  rows={2}
                  placeholder="Type your answers here…"
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none border mb-2"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                />
                <button onClick={() => start(answers)} disabled={running} className="px-3 py-2 rounded-lg text-xs font-semibold text-black" style={{ background: "var(--gold)" }}>
                  Continue with answers
                </button>
              </div>
            )}

            {error && (
              <div className="mb-3 rounded-xl border p-3 flex gap-2 text-xs" style={{ background: "rgba(230,57,70,.08)", borderColor: "rgba(230,57,70,.35)", color: "var(--text)" }}>
                <AlertTriangle size={15} style={{ color: "var(--accent)" }} className="shrink-0 mt-0.5" /> {error}
              </div>
            )}

            {/* A stopped run keeps the leads it already found: they were written
                to the board as they were found, not at the end. */}
            {cancelled && (
              <div className="mb-3 rounded-xl border p-3 text-xs" style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}>
                Search stopped. {leads.length > 0 ? `The ${leads.length} lead${leads.length !== 1 ? "s" : ""} found so far ${leads.length === 1 ? "was" : "were"} already saved to the board.` : "Nothing had been found yet."}
              </div>
            )}

            {leads.length > 0 && (
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold">{leads.length} lead{leads.length !== 1 ? "s" : ""} found</div>
                {done && saved === leads.length && (
                  <Link href="/board" className="text-xs" style={{ color: "var(--gold)" }}>Added to Prospects → View board</Link>
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
                    <Brain size={12} /> Analyst reasoning
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
              <button key={h.id} onClick={() => controls.setDraft(h.prompt)} className="w-full text-left text-xs px-3 py-2 rounded-lg border flex items-center justify-between" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
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

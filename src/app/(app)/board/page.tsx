"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, RefreshCw } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { useRunActivity } from "@/components/RunProvider";
import { Lead, Mode, Status, STATUS_COLUMNS } from "@/lib/types";
import LeadCard from "@/components/LeadCard";
import EmailModal from "@/components/EmailModal";

/** One read of `/api/leads`, tagged with the mode and the ticket it was read for. */
type LeadsResult = { ticket: number; mode: Mode; leads: Lead[]; warning?: string };

/**
 * A read the student asked for — the mode effect's read, or Refresh — against
 * one the run asked for by finding a lead. Only the second is held back by a
 * mutation in flight, because only it arrives at a moment nobody chose.
 */
export type ReadKind = "auto" | "manual";

/**
 * Every read of the board takes a ticket, and only the newest ticket may write
 * what is on screen. A read that a later one superseded — a mode switch, or a
 * second Refresh — is dropped rather than landing as the wrong mode's leads.
 * One sequence covers every path that reads, so the rule cannot drift apart
 * between them, and it compares tickets rather than modes captured in a
 * closure, which would be the mode of the render that started the read rather
 * than the current one.
 *
 * The same sequence also orders reads against the optimistic mutations — a drag
 * between columns, a delete — because that is the same question and may not
 * grow a second mechanism beside this one. `moveTo`/`del` write the new state
 * on screen and only then await the server, so an automatic read overlapping
 * that window carries pre-mutation rows: applying it would snap a dragged card
 * back or resurrect a deleted one. Such a read is refused, and recorded as owed
 * so the lead that triggered it still reaches the board once the mutation
 * settles — a refusal that dropped it would trade a visible snap-back for an
 * invisible missing lead.
 */
export type ReadSequence = {
  /** Take the newest ticket, superseding every read still in flight. */
  start: (kind?: ReadKind) => number;
  /** The ordering half of the rule: is this the newest read? */
  isCurrent: (ticket: number) => boolean;
  /** The whole rule, and the only gate `applyLeads` asks. */
  mayApply: (ticket: number) => boolean;
  /** Supersede every read in flight without starting one. */
  abandon: () => void;
  /** Open the window in which an optimistic mutation is unconfirmed; the
   *  returned function closes it. */
  beginMutation: () => () => void;
  /** Whether a refused automatic read is now owed, and may be run again. */
  takeOwed: () => boolean;
};

export function createReadSequence(): ReadSequence {
  let current = 0;
  let currentKind: ReadKind = "manual";
  // Ticks on both ends of every mutation, so "did a mutation open or close
  // while this read was in flight?" is one comparison rather than a history.
  let mutationTick = 0;
  let startedAt = 0;
  let mutating = 0;
  let owed = false;

  return {
    start: (kind = "manual") => {
      current += 1;
      currentKind = kind;
      startedAt = mutationTick;
      return current;
    },
    isCurrent: (ticket) => ticket === current,
    mayApply: (ticket) => {
      if (ticket !== current) return false;
      if (currentKind === "manual") return true;
      if (mutating === 0 && mutationTick === startedAt) return true;
      owed = true;
      return false;
    },
    abandon: () => { current += 1; },
    beginMutation: () => {
      mutating += 1;
      mutationTick += 1;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        mutating -= 1;
        mutationTick += 1;
      };
    },
    takeOwed: () => {
      if (!owed || mutating > 0) return false;
      owed = false;
      return true;
    },
  };
}

/**
 * The board is loading while the leads on screen are not the ones the current
 * mode asked for, or while a refresh is in flight. That is a fact about this
 * render, so it is derived here rather than announced by an effect a commit
 * later — which is what `setLoading(true)` inside the mount effect was doing.
 */
export function boardIsLoading(mode: Mode, loadedMode: Mode | null, refreshing: boolean) {
  return refreshing || loadedMode !== mode;
}

export default function BoardPage() {
  const { mode } = useApp();
  // A run started on the agent view keeps streaming while the board is on
  // screen, because it is owned by the `(app)` layout rather than that page.
  // This is the board's cheap view of it: three primitives, so a run streaming
  // reasoning tokens does not re-render every lead card on the board.
  const activity = useRunActivity();
  const [leads, setLeads] = useState<Lead[]>([]);
  // The mode `leads` was read for; null until the first read lands.
  const [loadedMode, setLoadedMode] = useState<Mode | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);
  const [warning, setWarning] = useState("");
  const [reads] = useState(createReadSequence);
  // Bumped when the sequence says a refused automatic read is owed. It is a
  // dependency of the read effect rather than a read of its own, so the owed
  // read is issued by the same effect, for the mode on screen now — a re-read
  // fired from inside a mutation would carry the mode of the render that
  // started it and could leave the board loading a mode it had left.
  const [owedRead, setOwedRead] = useState(0);

  const loading = boardIsLoading(mode, loadedMode, refreshing);

  const readLeads = useCallback(async (kind: ReadKind): Promise<LeadsResult> => {
    const ticket = reads.start(kind);
    const res = await fetch(`/api/leads?mode=${mode}`);
    const data = await res.json();
    return { ticket, mode, leads: data.leads || [], warning: data.warning };
  }, [mode, reads]);

  const settleMutation = useCallback((settle: () => void) => {
    settle();
    if (reads.takeOwed()) setOwedRead((n) => n + 1);
  }, [reads]);

  // Reading and applying are separate so a refused response can be dropped:
  // it would otherwise land as the wrong mode's leads and leave the board
  // reading as loading forever, or as pre-mutation rows over a drag the student
  // can still see. Every caller applies through here, so the effect, Refresh
  // and the run's own ticks are held to the one rule.
  const applyLeads = useCallback((result: LeadsResult) => {
    if (!reads.mayApply(result.ticket)) {
      // Refused by a mutation that has already settled: nothing else is coming
      // to release the debt, so run the owed read from here.
      if (reads.takeOwed()) setOwedRead((n) => n + 1);
      return;
    }
    setLeads(result.leads);
    if (result.warning) setWarning(result.warning);
    setLoadedMode(result.mode);
  }, [reads]);

  // `leadSignal` ticks once per lead the run has already tried to write, so the
  // board reads again and the student watches leads land while the search is
  // still going. It goes through the same ticket sequence as every other read,
  // which is what stops a tick mid-flight from landing out of order or over an
  // unsettled drag.
  useEffect(() => {
    readLeads("auto").then(applyLeads);
    return () => reads.abandon();
  }, [readLeads, applyLeads, reads, activity.leadSignal, owedRead]);

  async function refresh() {
    setRefreshing(true);
    // A superseded refresh drops its leads but is still no longer refreshing;
    // leaving the flag set would wedge the board as loading just as badly.
    applyLeads(await readLeads("manual"));
    setRefreshing(false);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      [l.company, l.industry, l.description, l.why_fit, l.contact_name].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }, [leads, query]);

  const byStatus = useMemo(() => {
    const map: Record<Status, Lead[]> = { prospects: [], researched: [], outreach_sent: [], in_conversation: [], closed_won: [] };
    for (const l of filtered) (map[l.status] ?? map.prospects).push(l);
    return map;
  }, [filtered]);

  // The optimistic write happens first and the server confirms it after, so the
  // mutation is declared to the sequence for exactly that window — in a
  // `finally`, so a request that throws still closes it rather than holding
  // every later lead off the board.
  async function moveTo(id: string, status: Status) {
    const prev = leads;
    const settle = reads.beginMutation();
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, status } : l)));
    try {
      const res = await fetch(`/api/leads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) setLeads(prev);
    } finally {
      settleMutation(settle);
    }
  }

  async function del(id: string) {
    const prev = leads;
    const settle = reads.beginMutation();
    setLeads((ls) => ls.filter((l) => l.id !== id));
    try {
      const res = await fetch(`/api/leads/${id}`, { method: "DELETE" });
      if (!res.ok) setLeads(prev);
    } finally {
      settleMutation(settle);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 border w-full max-w-xs" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <Search size={14} style={{ color: "var(--faint)" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads…" className="bg-transparent outline-none text-sm w-full" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: "var(--faint)" }}>{filtered.length} {filtered.length === 1 ? "lead" : "leads"}</span>
          <button onClick={refresh} className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }} title="Refresh">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {activity.running && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2 flex items-center gap-2 border" style={{ background: "rgba(245,200,66,.08)", borderColor: "rgba(245,200,66,.35)", color: "var(--text)" }}>
          <span className="dot-pulse" style={{ color: "var(--gold)" }}>●</span>
          The agent is still searching{activity.found > 0 ? ` — ${activity.found} lead${activity.found !== 1 ? "s" : ""} so far` : ""}. New leads appear here as they are saved.
        </div>
      )}

      {warning && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(230,57,70,.1)", color: "var(--text)" }}>
          {warning} — leads can’t load until the Supabase service-role key is added to the environment.
        </div>
      )}

      {/* Not while a run is going: the banner above already says what is
          happening, and "your pipeline is empty" would contradict it. */}
      {!loading && !warning && !activity.running && leads.length === 0 && (
        <div className="mx-5 mt-4 rounded-xl border p-4 flex items-center gap-3 animate-in" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <span className="text-xl">🎯</span>
          <div className="text-sm">
            <div className="font-semibold">Your pipeline is empty.</div>
            <div style={{ color: "var(--muted)" }}>
              Head to the{" "}
              <Link href="/agent" className="font-medium" style={{ color: "var(--gold)" }}>Agent</Link>{" "}
              tab and describe the sponsors you want. Found leads land here in Prospects, and you drag them across the stages as you go.
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-3 p-5 min-h-full" style={{ minWidth: "max-content" }}>
          {STATUS_COLUMNS.map((col) => {
            const items = byStatus[col.id] || [];
            const isOver = overCol === col.id;
            return (
              <div
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
                onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
                onDrop={() => { if (dragId) moveTo(dragId, col.id); setDragId(null); setOverCol(null); }}
                className="w-[300px] shrink-0 rounded-2xl border flex flex-col transition-colors"
                style={{ background: isOver ? "var(--surface2)" : "var(--surface)", borderColor: isOver ? col.color : "var(--border)" }}
              >
                <div className="flex items-center justify-between px-3.5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                    <span className="text-sm font-semibold">{col.emoji} {col.label}</span>
                  </div>
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--muted)" }}>{items.length}</span>
                </div>
                <div className="flex-1 p-2.5 space-y-2.5 overflow-y-auto" style={{ maxHeight: "calc(100vh - 190px)" }}>
                  {loading ? (
                    <>
                      <div className="h-32 rounded-xl shimmer" />
                      <div className="h-32 rounded-xl shimmer" />
                    </>
                  ) : items.length === 0 ? (
                    <div className="text-xs text-center py-8" style={{ color: "var(--faint)" }}>Drop leads here</div>
                  ) : (
                    items.map((l) => (
                      <LeadCard
                        key={l.id}
                        lead={l}
                        draggable
                        onDragStart={() => setDragId(l.id)}
                        onEmail={setEmailLead}
                        onDelete={del}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {emailLead && <EmailModal lead={emailLead} onClose={() => setEmailLead(null)} />}
    </div>
  );
}

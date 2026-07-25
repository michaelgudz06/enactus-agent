"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { Lead, Status, STATUS_COLUMNS } from "@/lib/types";
import LeadCard from "@/components/LeadCard";
import EmailModal from "@/components/EmailModal";

export default function BoardPage() {
  const { mode } = useApp();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);
  const [warning, setWarning] = useState("");

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/leads?mode=${mode}`);
    const data = await res.json();
    setLeads(data.leads || []);
    if (data.warning) setWarning(data.warning);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [mode]);

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

  async function moveTo(id: string, status: Status) {
    const prev = leads;
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, status } : l)));
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) setLeads(prev);
  }

  async function del(id: string) {
    const prev = leads;
    setLeads((ls) => ls.filter((l) => l.id !== id));
    const res = await fetch(`/api/leads/${id}`, { method: "DELETE" });
    if (!res.ok) setLeads(prev);
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
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }} title="Refresh">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {warning && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(230,57,70,.1)", color: "var(--text)" }}>
          {warning} — leads can’t load until the Supabase service-role key is added to the environment.
        </div>
      )}

      {!loading && !warning && leads.length === 0 && (
        <div className="mx-5 mt-4 rounded-xl border p-4 flex items-center gap-3 animate-in" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <span className="text-xl">🎯</span>
          <div className="text-sm">
            <div className="font-semibold">Your pipeline is empty.</div>
            <div style={{ color: "var(--muted)" }}>
              Head to the{" "}
              <a href="/agent" className="font-medium" style={{ color: "var(--gold)" }}>Agent</a>{" "}
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

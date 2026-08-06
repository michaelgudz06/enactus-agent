"use client";

import { useEffect, useState, useCallback } from "react";
import { X, RefreshCw, Copy, Check, Mail, Send } from "lucide-react";
import { Lead } from "@/lib/types";

/**
 * One draft the route returned, tagged with the lead it was drafted for. A
 * malformed `notes` costs `notes` and nothing else, which is the same rule the
 * draft route applies to model output.
 */
export type DraftResult =
  | { leadId: string; ok: true; subject: string; body: string; notes: string[]; to: string | null }
  | { leadId: string; ok: false; error: string };

export async function requestDraft(leadId: string): Promise<DraftResult> {
  try {
    const res = await fetch("/api/email/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to draft");
    return {
      leadId,
      ok: true,
      subject: data.subject,
      body: data.body,
      notes: Array.isArray(data.notes) ? data.notes : [],
      to: data.to || null,
    };
  } catch (e) {
    return { leadId, ok: false, error: (e as Error).message };
  }
}

/**
 * The modal is loading until the draft on screen is the one this lead asked
 * for, or while a regenerate is in flight. Deriving it from the lead the draft
 * belongs to is what the mount effect's `setLoading(true)` stood in for, and it
 * keeps the skeleton up when the modal is handed a different lead.
 */
export function draftIsLoading(leadId: string, draftedFor: string | null, regenerating: boolean) {
  return regenerating || draftedFor !== leadId;
}

export default function EmailModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  // The lead the draft on screen was fetched for; null until the first one
  // lands. A failed draft still counts: the error belongs to that lead.
  const [draftedFor, setDraftedFor] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState<string | null>(lead.contact_email);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [gmailMsg, setGmailMsg] = useState("");
  // What the draft lost on the way here. A field the model sent in the wrong
  // type costs that field, and saying so beats a draft that is quietly thinner
  // than it looks.
  const [notes, setNotes] = useState<string[]>([]);

  const loading = draftIsLoading(lead.id, draftedFor, regenerating);

  const applyDraft = useCallback((result: DraftResult) => {
    if (result.ok) {
      setSubject(result.subject);
      setBody(result.body);
      setNotes(result.notes);
      if (result.to) setTo(result.to);
      setError("");
    } else {
      setError(result.error);
    }
    setDraftedFor(result.leadId);
  }, []);

  useEffect(() => {
    let live = true;
    requestDraft(lead.id).then((result) => { if (live) applyDraft(result); });
    return () => { live = false; };
  }, [lead.id, applyDraft]);

  async function regenerate() {
    setRegenerating(true);
    setError("");
    setNotes([]);
    applyDraft(await requestDraft(lead.id));
    setRegenerating(false);
  }

  function copy() {
    navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function openInGmail() {
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || "")}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
  }

  async function createGmailDraft() {
    setGmailMsg("");
    try {
      const res = await fetch("/api/gmail/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body, leadId: lead.id }),
      });
      const data = await res.json();
      if (res.status === 428) {
        // needs Gmail connection
        window.location.href = "/api/gmail/auth";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed");
      setGmailMsg("Draft created in your Gmail. Open Gmail to review and send.");
    } catch (e) {
      setGmailMsg((e as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }} onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl border animate-in max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b sticky top-0" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div>
            <div className="font-semibold text-sm">Draft outreach · {lead.company}</div>
            <div className="text-xs" style={{ color: "var(--faint)" }}>Human, concise, one clear ask. No em dashes.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>To</label>
            <input
              value={to || ""}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@company.com"
              className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border"
              style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
            />
          </div>

          {loading ? (
            <div className="space-y-2 py-4">
              <div className="h-4 rounded shimmer w-1/2" />
              <div className="h-24 rounded shimmer" />
            </div>
          ) : error ? (
            <p className="text-sm" style={{ color: "var(--accent)" }}>{error}</p>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Subject</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border font-medium"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                />
              </div>
              <div>
                <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Body</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={10}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border leading-relaxed resize-y"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                />
              </div>
              {notes.length > 0 && (
                <ul className="text-xs space-y-1" style={{ color: "var(--muted)" }}>
                  {notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {gmailMsg && <p className="text-xs" style={{ color: "var(--green)" }}>{gmailMsg}</p>}
        </div>

        <div className="flex items-center gap-2 px-5 py-3.5 border-t flex-wrap" style={{ borderColor: "var(--border)" }}>
          <button onClick={regenerate} disabled={loading} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: "var(--surface3)", color: "var(--text)" }}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Regenerate
          </button>
          <button onClick={copy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium" style={{ background: "var(--surface3)", color: "var(--text)" }}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={openInGmail} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium" style={{ background: "var(--surface3)", color: "var(--text)" }}>
            <Mail size={13} /> Open in Gmail
          </button>
          <button onClick={createGmailDraft} className="ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-black" style={{ background: "var(--gold)" }}>
            <Send size={13} /> Create Gmail draft
          </button>
        </div>
      </div>
    </div>
  );
}

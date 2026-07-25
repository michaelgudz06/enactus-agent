"use client";

import { useEffect, useState, useCallback } from "react";
import { X, RefreshCw, Copy, Check, Mail, Send } from "lucide-react";
import { Lead } from "@/lib/types";

export default function EmailModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState<string | null>(lead.contact_email);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [gmailMsg, setGmailMsg] = useState("");

  const generate = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/email/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: lead.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to draft");
      setSubject(data.subject);
      setBody(data.body);
      if (data.to) setTo(data.to);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    generate();
  }, [generate]);

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
            </>
          )}

          {gmailMsg && <p className="text-xs" style={{ color: "var(--green)" }}>{gmailMsg}</p>}
        </div>

        <div className="flex items-center gap-2 px-5 py-3.5 border-t flex-wrap" style={{ borderColor: "var(--border)" }}>
          <button onClick={generate} disabled={loading} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: "var(--surface3)", color: "var(--text)" }}>
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

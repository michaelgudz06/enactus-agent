"use client";

import { useState } from "react";
import { Mail, Trash2, ChevronDown, ExternalLink, Brain } from "lucide-react";
import { Lead } from "@/lib/types";
import ConnectionChip from "./ConnectionChip";

export default function LeadCard({
  lead,
  onEmail,
  onDelete,
  draggable,
  onDragStart,
}: {
  lead: Lead;
  onEmail?: (lead: Lead) => void;
  onDelete?: (id: string) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  const [showReason, setShowReason] = useState(false);

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className="rounded-xl border p-3 card-hover animate-in"
      style={{ background: "var(--surface2)", borderColor: "var(--border)", cursor: draggable ? "grab" : "default" }}
    >
      <div className="font-semibold text-sm leading-tight truncate">{lead.company}</div>
      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        {lead.industry && (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--muted)" }}>
            {lead.industry}
          </span>
        )}
        {lead.location && <span className="text-[10px]" style={{ color: "var(--faint)" }}>{lead.location}</span>}
      </div>

      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <ConnectionChip type={lead.connection_type} />
        {lead.sponsorship_type?.map((t) => (
          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--blue)" }}>
            {t === "in_kind" ? "in-kind" : t === "monetary" ? "monetary" : t}
          </span>
        ))}
      </div>

      {lead.description && (
        <p className="mt-2 text-xs leading-relaxed line-clamp-3" style={{ color: "var(--muted)" }}>
          {lead.description}
        </p>
      )}

      {lead.why_fit && (
        <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text)" }}>
          <span style={{ color: "var(--gold)" }}>Why: </span>
          {lead.why_fit}
        </p>
      )}

      {(lead.contact_name || lead.contact_email || lead.contact_email_status) && (
        <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          {lead.contact_name && <div className="font-medium" style={{ color: "var(--text)" }}>{lead.contact_name}{lead.contact_role ? <span style={{ color: "var(--faint)" }}> · {lead.contact_role}</span> : null}</div>}
          {lead.contact_email && <div className="truncate">{lead.contact_email}</div>}
          {!lead.contact_email && lead.contact_email_status && (
            <div className="truncate" style={{ color: "var(--faint)" }} title={lead.contact_email_status}>
              ⚠ {lead.contact_email_status}
            </div>
          )}
        </div>
      )}

      {lead.website_status && (
        <div className="mt-2 text-xs truncate" style={{ color: "var(--faint)" }} title={lead.website_status}>
          ⚠ {lead.website_status}
        </div>
      )}

      {lead.reasoning && (
        <div className="mt-2">
          <button onClick={() => setShowReason((s) => !s)} className="flex items-center gap-1 text-[11px] font-medium" style={{ color: "var(--faint)" }}>
            <Brain size={12} /> Why we chose {lead.company.length > 18 ? "this company" : lead.company} <ChevronDown size={12} className={showReason ? "rotate-180" : ""} />
          </button>
          {showReason && (
            <p className="mt-1.5 text-[11px] leading-relaxed max-h-56 overflow-y-auto reason-scroll p-2.5 rounded" style={{ background: "var(--bg)", color: "var(--muted)" }}>
              {lead.reasoning}
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {onEmail && (
          <button
            onClick={() => onEmail(lead)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            <Mail size={13} /> Draft email
          </button>
        )}
        {lead.sources?.[0]?.url && (
          <a href={lead.sources[0].url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg" style={{ color: "var(--muted)", background: "var(--surface3)" }}>
            <ExternalLink size={12} /> Source
          </a>
        )}
        {onDelete && (
          <button onClick={() => onDelete(lead.id)} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--faint)" }} title="Delete">
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

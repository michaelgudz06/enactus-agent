export type Mode = "sponsor" | "sales";

export type Status =
  | "prospects"
  | "researched"
  | "outreach_sent"
  | "in_conversation"
  | "closed_won";

export type ConnectionType = "alum" | "past_sponsor" | "ecosystem" | "none";

export interface Lead {
  id: string;
  company: string;
  website: string | null;
  industry: string | null;
  description: string | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  location: string | null;
  connection_type: ConnectionType;
  connection_note: string | null;
  sponsorship_type: string[];
  fit_score: number | null;
  why_fit: string | null;
  reasoning: string | null;
  sources: { url: string; title?: string }[];
  status: Status;
  mode: Mode;
  board_order: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchRow {
  id: string;
  prompt: string;
  normalized: string | null;
  mode: Mode;
  result_count: number;
  created_by_name: string | null;
  created_at: string;
}

export interface EmailDraft {
  id: string;
  lead_id: string;
  subject: string | null;
  body: string | null;
  gmail_draft_id: string | null;
  status: "draft" | "created_in_gmail" | "sent";
  created_by_name: string | null;
  created_at: string;
}

export const STATUS_COLUMNS: { id: Status; label: string; color: string }[] = [
  { id: "prospects", label: "Prospects", color: "#818cf8" },
  { id: "researched", label: "Researched", color: "#f59e0b" },
  { id: "outreach_sent", label: "Outreach Sent", color: "#38bdf8" },
  { id: "in_conversation", label: "In Conversation", color: "#34d399" },
  { id: "closed_won", label: "Closed / Won", color: "#f87171" },
];

export const CONNECTION_META: Record<ConnectionType, { label: string; color: string }> = {
  alum: { label: "SFU Alum", color: "#c4b5fd" },
  past_sponsor: { label: "Past Sponsor", color: "#F5C842" },
  ecosystem: { label: "SFU Ecosystem", color: "#34d399" },
  none: { label: "New Lead", color: "#9aa1ac" },
};

// Streaming event contract between the agent route and the client.
export type AgentEvent =
  | { type: "status"; step: string; message: string }
  | { type: "reasoning"; text: string }
  | { type: "similar"; message: string; suggestion: string; pastPrompt: string }
  | { type: "clarify"; questions: string[] }
  | { type: "lead"; lead: Lead }
  | { type: "done"; count: number; searchId: string | null }
  | { type: "error"; message: string };

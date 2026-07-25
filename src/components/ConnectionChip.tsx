import { CONNECTION_META, ConnectionType } from "@/lib/types";

export default function ConnectionChip({ type }: { type: ConnectionType }) {
  if (!type || type === "none") return null;
  const m = CONNECTION_META[type];
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
      style={{ background: `${m.color}22`, color: m.color }}
    >
      {m.icon} {m.label}
    </span>
  );
}

export function fitColor(score: number | null): string {
  if (score == null) return "var(--faint)";
  if (score >= 80) return "var(--green)";
  if (score >= 60) return "var(--gold)";
  if (score >= 40) return "#f59e0b";
  return "var(--faint)";
}

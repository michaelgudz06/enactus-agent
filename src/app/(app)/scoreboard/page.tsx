"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trophy, Mail, MessageSquare, Reply, UserPlus, Handshake } from "lucide-react";
import { ACHIEVEMENTS, sent, type Counts, type Scoreboard } from "@/lib/scoreboard";

type Range = "week" | "month" | "all";

const RANGES: { id: Range; label: string }[] = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

// Order matters: this is the order the columns appear in, and the order the
// team was asked to be measured on.
const COLUMNS: { key: keyof Counts; label: string; icon: typeof Mail }[] = [
  { key: "emails", label: "Emails", icon: Mail },
  { key: "dms", label: "DMs", icon: MessageSquare },
  { key: "replies", label: "Replies", icon: Reply },
  { key: "contacts", label: "Contacts", icon: UserPlus },
  { key: "wins", label: "Wins", icon: Handshake },
];

const BADGE = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

function niceDate(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

export default function ScoreboardPage() {
  const [data, setData] = useState<(Scoreboard & { lastSyncedAt: string | null }) | null>(null);
  const [range, setRange] = useState<Range>("week");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/scoreboard");
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const d = await res.json().catch(() => null);
      if (d && !d.error) setData(d);
      else setNotice(d?.error ?? "Could not load the scoreboard.");
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Replies are the one number nothing in the app can observe on its own: they
  // arrive in Gmail. A button rather than a poll, because every click costs
  // Gmail requests and nobody needs a live count of an inbox.
  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setNotice("");
    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });
      if (res.status === 428) {
        setNotice("The club mailbox is not connected. Connect it in Settings first.");
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setNotice(
        d.checked === 0
          ? "Nothing sent yet, so there is nothing to check."
          : `Checked ${d.checked} thread${d.checked === 1 ? "" : "s"}, found ${d.found} new repl${d.found === 1 ? "y" : "ies"}.${d.more ? " More to go — run it again." : ""}`
      );
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const members = data?.members ?? [];
  const pick = (c: { week: Counts; month: Counts; all: Counts }) =>
    range === "week" ? c.week : range === "month" ? c.month : c.all;
  const total = (m: (typeof members)[number]) => {
    const c = pick(m);
    return sent(c) + c.replies + c.contacts;
  };
  const leader = Math.max(1, ...members.map(total));

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <div>
          <h1 className="text-sm font-semibold">Scoreboard</h1>
          <p className="text-xs" style={{ color: "var(--faint)" }}>
            {data
              ? `Week of ${niceDate(data.weekStart)} · everything here was done by a person, not the agent.`
              : "Everything here was done by a person, not the agent."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={sync}
            disabled={syncing}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--surface3)", color: "var(--text)" }}
          >
            {syncing ? "Checking…" : "Check for replies"}
          </button>
          <button
            onClick={() => {
              setLoading(true);
              load();
            }}
            className="p-1.5 rounded-lg hover:bg-[var(--surface3)]"
            style={{ color: "var(--muted)" }}
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2" style={{ background: "var(--surface2)", color: "var(--text)" }}>
          {notice}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: "var(--surface2)" }}>
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium"
                style={
                  range === r.id
                    ? { background: "var(--surface)", color: "var(--text)" }
                    : { color: "var(--muted)" }
                }
              >
                {r.label}
              </button>
            ))}
          </div>
          {data && (
            <span className="text-xs" style={{ color: "var(--faint)" }}>
              Team: {sent(data.team)} sent · {data.team.replies} replies · {data.team.contacts} contacts ·{" "}
              {data.team.wins} wins
              {data.lastSyncedAt
                ? ` · replies last checked ${new Date(data.lastSyncedAt).toLocaleString()}`
                : " · replies never checked"}
            </span>
          )}
        </div>

        {loading ? (
          <div className="space-y-2">
            <div className="h-14 rounded-xl shimmer" />
            <div className="h-14 rounded-xl shimmer" />
          </div>
        ) : members.length === 0 ? (
          // An empty scoreboard is the honest answer, not a bug. Nothing has
          // been sent from the board yet, so there is nothing to count.
          <div className="rounded-xl border border-dashed p-6 text-center" style={{ borderColor: "var(--border)" }}>
            <Trophy size={20} className="mx-auto mb-2" style={{ color: "var(--faint)" }} />
            <p className="text-sm font-medium">Nothing counted yet</p>
            <p className="mt-1 text-xs mx-auto max-w-md" style={{ color: "var(--muted)" }}>
              Sending a message from a lead, adding a contact by hand, or closing a sponsorship puts you here. The
              agent&apos;s own work is deliberately not counted — this measures people.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {members.map((m, i) => {
              const c = pick(m);
              return (
                <div
                  key={m.key}
                  className="rounded-xl border p-3.5 animate-in"
                  style={{ background: "var(--surface)", borderColor: "var(--border)" }}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="grid place-items-center w-7 h-7 rounded-lg text-xs font-bold shrink-0"
                        style={
                          i === 0 && total(m) > 0
                            ? { background: "var(--gold)", color: "#000" }
                            : { background: "var(--surface3)", color: "var(--muted)" }
                        }
                      >
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{m.name}</div>
                        <div className="text-xs" style={{ color: "var(--faint)" }}>
                          {m.replyRate === null
                            ? "no messages sent yet"
                            : `${Math.round(m.replyRate * 100)}% reply rate all time`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      {COLUMNS.map((col) => {
                        const Icon = col.icon;
                        return (
                          <div key={col.key} className="text-center min-w-[3rem]">
                            <div className="text-base font-semibold tabular-nums">{c[col.key]}</div>
                            <div className="flex items-center justify-center gap-1 text-[10px]" style={{ color: "var(--faint)" }}>
                              <Icon size={10} /> {col.label}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Relative to the leader, not to a target nobody set. A bar
                      against an invented quota reads as failure by default. */}
                  <div className="mt-2.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--surface3)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${Math.round((total(m) / leader) * 100)}%`, background: "var(--gold)" }}
                    />
                  </div>

                  {m.achievements.length > 0 && (
                    <div className="mt-2.5 flex gap-1.5 flex-wrap">
                      {m.achievements.map((id) => {
                        const a = BADGE.get(id);
                        if (!a) return null;
                        return (
                          <span
                            key={id}
                            title={a.hint}
                            className="px-2 py-0.5 rounded-full text-[10px] font-medium border"
                            style={{ borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}
                          >
                            {a.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-xl border p-3.5 text-xs" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div className="font-semibold mb-2">Achievements</div>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {ACHIEVEMENTS.map((a) => (
              <div key={a.id} style={{ color: "var(--muted)" }}>
                <span style={{ color: "var(--text)" }}>{a.label}</span> — {a.hint}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

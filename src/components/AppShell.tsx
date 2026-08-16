"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Sparkles, LayoutGrid, LogOut } from "lucide-react";
import { Mode } from "@/lib/types";

interface Ctx {
  mode: Mode;
  name: string;
}
const AppCtx = createContext<Ctx>({ mode: "sponsor", name: "" });
export const useApp = () => useContext(AppCtx);

export default function AppShell({ name, children }: { name: string; children: React.ReactNode }) {
  // Sponsor-focused: the tool is geared entirely toward sponsorship outreach for
  // VP External. (Sales mode still exists in the backend and can be re-enabled.)
  const mode: Mode = "sponsor";
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const tabs = [
    { href: "/agent", label: "Agent", icon: Sparkles },
    { href: "/board", label: "Board", icon: LayoutGrid },
  ];

  return (
    <AppCtx.Provider value={{ mode, name }}>
      {/* h-screen, not min-h-screen: both pages scroll inside themselves (the
          chat transcript, the board's columns), so the shell has to be exactly
          the viewport for `flex-1 min-h-0` below to resolve to a real height. */}
      <div className="h-screen flex flex-col">
        <header
          className="sticky top-0 z-50 flex items-center justify-between px-5 py-3 border-b"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2.5">
              <span className="inline-block w-1 h-6 rounded" style={{ background: "var(--gold)" }} />
              <span className="font-black tracking-widest text-sm" style={{ color: "var(--gold)" }}>
                ENACTUS SFU
              </span>
            </div>
            <nav className="flex items-center gap-1">
              {tabs.map((t) => {
                const active = pathname === t.href;
                const Icon = t.icon;
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                    style={{
                      background: active ? "var(--surface3)" : "transparent",
                      color: active ? "var(--text)" : "var(--muted)",
                    }}
                  >
                    <Icon size={15} />
                    {t.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full" style={{ background: "var(--surface2)", color: "var(--muted)" }}>
              Sponsorship pipeline
            </span>
            <div className="hidden sm:flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
              <span className="grid place-items-center w-6 h-6 rounded-full text-black text-[11px] font-bold" style={{ background: "var(--gold)" }}>
                {name.charAt(0).toUpperCase()}
              </span>
              {name}
            </div>
            <button onClick={logout} title="Log out" className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }}>
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="flex-1 min-h-0">{children}</main>
      </div>
    </AppCtx.Provider>
  );
}

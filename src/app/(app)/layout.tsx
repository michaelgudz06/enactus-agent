import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AppShell from "@/components/AppShell";
import RunProvider from "@/components/RunProvider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // RunProvider wraps both `agent` and `board`, and this layout does not
  // re-render when navigating between them — so a run started on the agent view
  // keeps streaming while the student watches the board fill up.
  return (
    <RunProvider>
      <AppShell name={session.name}>{children}</AppShell>
    </RunProvider>
  );
}

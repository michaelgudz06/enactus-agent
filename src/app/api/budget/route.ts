import { getSession } from "@/lib/auth";
import { budgetStatus, toCad } from "@/lib/budget";
import { runCostEstimateUsd } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What is left of the month, before anyone spends it. A student should be able
// to see the number rather than discover it by being refused mid-run.
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  // Priced from the same estimate the pre-flight gate uses, so the count on
  // screen and the point the agent refuses are the same number.
  const runCostUsd = runCostEstimateUsd();
  const status = await budgetStatus(runCostUsd);
  return Response.json({ ...status, runCostCad: Number(toCad(runCostUsd).toFixed(4)) });
}

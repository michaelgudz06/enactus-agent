// The one line about the budget a student reads before pressing run.
//
// It lives here rather than in the page it is rendered from: an App Router page
// module may only export what Next.js recognises, so a helper exported beside
// the component is a build error waiting to happen. Plain wording in a plain
// module is also testable without a browser.

/** What `/api/budget` reports. `null` while it is loading or if it failed. */
export interface Budget {
  monthLabel: string;
  capCad: number;
  spentCad: number;
  remainingCad: number;
  runsRemaining: number;
  persisted: boolean;
  error: string | null;
  ledgerWriteError: string | null;
}

/**
 * The budget line, in the words a student needs.
 *
 * A budget that could not be read says so rather than showing a number nobody
 * should act on, and the run button stays enabled either way -- the server holds
 * the cap, and a UI that blocks on its own guess would be a guard that fires
 * early.
 *
 * A ledger that cannot be written is the same unknown one step later: the spend
 * happened, the row did not, and the number on screen is only what this server
 * has counted since it started. Saying so is the point -- a figure that looks
 * like a live cap and is not is the failure this app's rules exist to prevent.
 */
export function budgetLine(budget: Budget): string {
  if (budget.error) return `Monthly API budget: could not be read. ${budget.error}`;
  const spend = `$${budget.spentCad.toFixed(2)} of $${budget.capCad.toFixed(2)} CAD used in ${budget.monthLabel}`;
  const line =
    budget.runsRemaining < 1
      ? `${spend}. Not enough left for another run. It resets at the start of next month.`
      : `${spend}, about ${budget.runsRemaining} run${budget.runsRemaining === 1 ? "" : "s"} left`;
  if (!budget.ledgerWriteError) return line;
  return (
    `${line}${line.endsWith(".") ? "" : "."} Spend is not being recorded: ${budget.ledgerWriteError}. ` +
    `This counts only what this server has spent since it started, so the cap is not being held across restarts.`
  );
}

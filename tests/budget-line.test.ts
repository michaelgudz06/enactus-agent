import { describe, test, expect } from "vitest";
import { budgetLine } from "@/lib/budget-line";

// What a student reads before pressing run. Kept a plain function in a plain
// module so the wording is testable without a browser, and so the page it is
// rendered from exports only what Next.js expects a page to export.

function status(over: Partial<Parameters<typeof budgetLine>[0]> = {}) {
  return {
    monthLabel: "August 2026",
    capCad: 20,
    spentCad: 3.4,
    remainingCad: 16.6,
    runsRemaining: 415,
    persisted: true,
    error: null,
    ledgerWriteError: null,
    ...over,
  };
}

describe("the budget is observable before a run", () => {
  test("shows the spend, the cap, the month and how many runs are left", () => {
    expect(budgetLine(status())).toBe("$3.40 of $20.00 CAD used in August 2026, about 415 runs left");
  });

  test("says run, not runs, when there is one left", () => {
    expect(budgetLine(status({ runsRemaining: 1 }))).toContain("about 1 run left");
  });

  // The number a student needs when the answer is no is what to do about it.
  test("says plainly when there is not enough left for another run", () => {
    const line = budgetLine(status({ spentCad: 19.99, remainingCad: 0.01, runsRemaining: 0 }));

    expect(line).toContain("Not enough left for another run");
    expect(line).toContain("resets at the start of next month");
  });

  // A budget that could not be read must not show a number anybody acts on.
  test("reports an unreadable budget rather than showing zero spent", () => {
    const line = budgetLine(status({ error: "connection reset", spentCad: 0, remainingCad: 0 }));

    expect(line).toContain("could not be read");
    expect(line).toContain("connection reset");
    expect(line).not.toContain("$0.00 of");
  });

  // Charges that never reach the table die with the process, so the figure on
  // screen is not a cap being held. It must not read as one.
  test("says when spend is not being recorded, alongside the figure it still has", () => {
    const line = budgetLine(status({ ledgerWriteError: 'column "requests" does not exist', persisted: false }));

    expect(line).toContain("$3.40 of $20.00 CAD used in August 2026");
    expect(line).toContain("not being recorded");
    expect(line).toContain('column "requests" does not exist');
    expect(line).toContain("not being held across restarts");
  });

  test("does not run two sentences together when the run count is already a full stop", () => {
    const line = budgetLine(status({ runsRemaining: 0, ledgerWriteError: "permission denied", persisted: false }));

    expect(line).not.toContain("..");
    expect(line).toContain("Not enough left for another run");
    expect(line).toContain("permission denied");
  });
});

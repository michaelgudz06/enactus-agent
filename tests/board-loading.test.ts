import { describe, test, expect } from "vitest";
import { boardIsLoading } from "@/app/(app)/board/page";

// The board used to announce loading from an effect: `setLoading(true)` ran
// after the render that switched mode, so the board showed the previous mode's
// leads for one commit first. The state is now derived from which mode the
// leads on screen were read for.

describe("boardIsLoading", () => {
  test("is loading before the first read lands", () => {
    expect(boardIsLoading("sponsor", null, false)).toBe(true);
  });

  test("stops loading once the leads on screen are this mode's", () => {
    expect(boardIsLoading("sponsor", "sponsor", false)).toBe(false);
  });

  test("a mode switch reads as loading in the same render, not a commit later", () => {
    expect(boardIsLoading("sales", "sponsor", false)).toBe(true);
  });

  test("a refresh of the mode already on screen reads as loading", () => {
    expect(boardIsLoading("sponsor", "sponsor", true)).toBe(true);
  });
});

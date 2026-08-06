import { describe, test, expect } from "vitest";
import { boardIsLoading, createReadSequence } from "@/app/(app)/board/page";

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

// Deriving loading from the mode the leads were read for makes a late response
// worse than stale: it would set `loadedMode` back to the mode it was read for
// and wedge the board as loading forever. One ticket sequence decides which
// response may write, on every path that reads — the mount effect and Refresh.

describe("createReadSequence", () => {
  test("the newest read is the one that may write", () => {
    const reads = createReadSequence();
    const ticket = reads.start();
    expect(reads.isCurrent(ticket)).toBe(true);
  });

  test("a read a later one superseded may never write, however late it lands", () => {
    const reads = createReadSequence();
    const first = reads.start();
    const second = reads.start();
    expect(reads.isCurrent(first)).toBe(false);
    expect(reads.isCurrent(second)).toBe(true);
    // the superseded read landing does not make it current again
    expect(reads.isCurrent(first)).toBe(false);
  });

  test("abandon supersedes a read in flight without starting one", () => {
    const reads = createReadSequence();
    const inFlight = reads.start();
    reads.abandon();
    expect(reads.isCurrent(inFlight)).toBe(false);
  });
});

describe("a refresh superseded by a mode switch", () => {
  test("is dropped by the same rule as the effect's read, and leaves the board loading only until the newer read lands", () => {
    const reads = createReadSequence();
    // Refresh clicked in sponsor mode, response still in flight.
    const refresh = reads.start();
    // Mode switches to sales: the effect tears down and reads again.
    reads.abandon();
    const modeSwitch = reads.start();

    expect(reads.isCurrent(modeSwitch)).toBe(true);
    expect(reads.isCurrent(refresh)).toBe(false);

    // The sales read lands first and owns `loadedMode`; the refresh lands after
    // and is dropped, but still clears `refreshing` — so the board settles.
    expect(boardIsLoading("sales", "sales", false)).toBe(false);
    // Had the refresh been allowed to write, `loadedMode` would be "sponsor"
    // and nothing would read again.
    expect(boardIsLoading("sales", "sponsor", false)).toBe(true);
  });
});

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

// The run writes each lead as it finds it and ticks a signal, so the board
// reads again while the student is looking at it. That put an automatic read
// on top of the optimistic drag/delete window for the first time: `moveTo` and
// `del` show the new state and only then await the server, so a read that
// overlapped carries pre-mutation rows. The same sequence decides both, because
// it is the same question — which response may write what is on screen.

describe("an automatic read against an optimistic mutation", () => {
  test("with nothing in flight it writes, exactly as a manual read does", () => {
    const reads = createReadSequence();
    expect(reads.mayApply(reads.start("auto"))).toBe(true);
  });

  test("is refused while a drag is unconfirmed, so the card does not snap back", () => {
    const reads = createReadSequence();
    const settle = reads.beginMutation();
    const auto = reads.start("auto");

    expect(reads.isCurrent(auto)).toBe(true);
    expect(reads.mayApply(auto)).toBe(false);
    // Not owed yet: the mutation still in flight is what will release it.
    expect(reads.takeOwed()).toBe(false);

    settle();
    expect(reads.takeOwed()).toBe(true);
    // The debt is paid once.
    expect(reads.takeOwed()).toBe(false);
  });

  test("is refused when the mutation settled while it was still in flight, and is owed there and then", () => {
    const reads = createReadSequence();
    const settle = reads.beginMutation();
    const auto = reads.start("auto");
    // The PATCH answers before the read does; the read still left before the
    // server knew about it, so its rows are pre-mutation.
    settle();

    expect(reads.mayApply(auto)).toBe(false);
    expect(reads.takeOwed()).toBe(true);
  });

  test("is refused when a mutation opened after it left", () => {
    const reads = createReadSequence();
    const auto = reads.start("auto");
    const settle = reads.beginMutation();

    expect(reads.mayApply(auto)).toBe(false);
    settle();
    expect(reads.takeOwed()).toBe(true);
  });

  test("owes only one read once the last of several mutations settles", () => {
    const reads = createReadSequence();
    const first = reads.beginMutation();
    const second = reads.beginMutation();
    expect(reads.mayApply(reads.start("auto"))).toBe(false);

    first();
    expect(reads.takeOwed()).toBe(false);
    second();
    expect(reads.takeOwed()).toBe(true);
  });

  test("Refresh and the mode read are unchanged by a mutation in flight", () => {
    const reads = createReadSequence();
    reads.beginMutation();
    const manual = reads.start();

    expect(reads.mayApply(manual)).toBe(true);
    expect(reads.takeOwed()).toBe(false);
  });

  test("a refused read is still refused if a later read superseded it", () => {
    const reads = createReadSequence();
    reads.beginMutation();
    const stale = reads.start("auto");
    reads.start("auto");

    expect(reads.mayApply(stale)).toBe(false);
  });
});

/**
 * The board's wiring, small enough to run in a test: read, apply, and the two
 * mutations, held to the same sequence the component holds them to. The debt is
 * paid by the read effect, which is why an owed read is counted here rather than
 * issued inline.
 */
function boardWiring() {
  const reads = createReadSequence();
  let leads: string[] = [];
  let owedReads = 0;

  const read = (kind: "auto" | "manual", server: string[]) => ({ ticket: reads.start(kind), server });
  const apply = (result: { ticket: number; server: string[] }) => {
    if (!reads.mayApply(result.ticket)) {
      if (reads.takeOwed()) owedReads += 1;
      return;
    }
    leads = result.server;
  };
  const mutate = (optimistic: string[]) => {
    const settle = reads.beginMutation();
    leads = optimistic;
    return () => {
      settle();
      if (reads.takeOwed()) owedReads += 1;
    };
  };

  return {
    read,
    apply,
    mutate,
    onScreen: () => leads,
    owedReads: () => owedReads,
  };
}

describe("the board while the run is still finding leads", () => {
  test("a lead's read landing mid-drag leaves the dragged card where the student put it", () => {
    const board = boardWiring();
    board.apply(board.read("manual", ["a:prospects"]));

    // The student drags a card; the PATCH has not answered yet.
    const settle = board.mutate(["a:researched"]);
    // A lead lands, the board reads, and the server still says `prospects`.
    board.apply(board.read("auto", ["a:prospects", "b:prospects"]));

    expect(board.onScreen()).toEqual(["a:researched"]);
    settle();
  });

  test("the lead that arrived during the drag reaches the board once it settles", () => {
    const board = boardWiring();
    board.apply(board.read("manual", ["a:prospects"]));

    const settle = board.mutate(["a:researched"]);
    board.apply(board.read("auto", ["a:prospects", "b:prospects"]));
    expect(board.owedReads()).toBe(0);

    settle();
    // The effect runs the owed read, which now sees the confirmed move.
    expect(board.owedReads()).toBe(1);
    board.apply(board.read("auto", ["a:researched", "b:prospects"]));
    expect(board.onScreen()).toEqual(["a:researched", "b:prospects"]);
  });

  test("a deleted lead does not come back from a read that overlapped the delete", () => {
    const board = boardWiring();
    board.apply(board.read("manual", ["a:prospects", "b:prospects"]));

    const settle = board.mutate(["b:prospects"]);
    board.apply(board.read("auto", ["a:prospects", "b:prospects", "c:prospects"]));
    expect(board.onScreen()).toEqual(["b:prospects"]);

    settle();
    expect(board.owedReads()).toBe(1);
    board.apply(board.read("auto", ["b:prospects", "c:prospects"]));
    expect(board.onScreen()).toEqual(["b:prospects", "c:prospects"]);
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

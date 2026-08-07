import { describe, test, expect } from "vitest";
import {
  ALREADY_RUNNING,
  applyEvent,
  createRunStore,
  initialRunState,
  RunState,
  runHasWorkspace,
  runSavedToBoard,
} from "@/lib/run-store";
import { AgentEvent, Lead } from "@/lib/types";

// The run used to live in `useState` on the agent page, so navigating to the
// board unmounted the page and took the reader loop with it. It now lives in a
// store owned by the `(app)` layout. These tests are about that ownership:
// a subscriber coming and going is all a client-side navigation is, and it must
// not touch the run.

function lead(id: string, company: string): Lead {
  return {
    id,
    company,
    website: null,
    website_status: null,
    industry: null,
    description: null,
    contact_name: null,
    contact_role: null,
    contact_email: null,
    contact_email_status: null,
    location: null,
    connection_type: "none",
    connection_note: null,
    sponsorship_type: [],
    fit_score: null,
    why_fit: null,
    reasoning: null,
    sources: [],
    status: "prospects",
    mode: "sponsor",
    board_order: 0,
    created_by_name: null,
    created_at: "",
    updated_at: "",
  };
}

/**
 * A response whose body is fed one NDJSON line at a time, so a test can hold a
 * run open across a simulated navigation and push more events afterwards.
 */
function scriptedRun() {
  const enc = new TextEncoder();
  let push!: (line: string) => void;
  let finish!: () => void;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => {
        try {
          controller.enqueue(enc.encode(line + "\n"));
        } catch {
          // closed
        }
      };
      finish = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
    cancel() {
      cancelled = true;
    },
  });

  const fetchImpl = (async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } })) as unknown as typeof fetch;

  return {
    fetchImpl,
    emit: (ev: AgentEvent) => push(JSON.stringify(ev)),
    raw: (line: string) => push(line),
    finish: () => finish(),
    wasCancelled: () => cancelled,
  };
}

/** Let the store's reader loop drain what has been pushed so far. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("applyEvent", () => {
  test("accumulates steps, reasoning and leads", () => {
    let s = initialRunState;
    s = applyEvent(s, { type: "status", step: "understand", message: "Planning" });
    s = applyEvent(s, { type: "reasoning", text: "Bur" });
    s = applyEvent(s, { type: "reasoning", text: "naby" });
    s = applyEvent(s, { type: "lead", lead: lead("a", "Bakery") });

    expect(s.steps).toEqual([{ step: "understand", message: "Planning" }]);
    expect(s.reasoning).toBe("Burnaby");
    expect(s.leads.map((l) => l.company)).toEqual(["Bakery"]);
  });

  test("`done` records what the database accepted, not what was found", () => {
    let s = applyEvent(initialRunState, { type: "lead", lead: lead("a", "Bakery") });
    s = applyEvent(s, { type: "lead", lead: lead("b", "Roasters") });
    s = applyEvent(s, { type: "done", count: 2, saved: 1, searchId: null });

    expect(s.done).toBe(true);
    expect(s.saved).toBe(1);
    expect(s.leads).toHaveLength(2);
  });

  test("an error annotates the run and never discards leads already persisted", () => {
    let s = applyEvent(initialRunState, { type: "lead", lead: lead("a", "Bakery") });
    s = applyEvent(s, { type: "error", message: "1 of 1 lead could not be written" });

    expect(s.error).toContain("could not be written");
    expect(s.leads).toHaveLength(1);
  });

  test("an event shape this build does not know costs nothing", () => {
    const s = applyEvent(initialRunState, { type: "invented" } as unknown as AgentEvent);
    expect(s).toBe(initialRunState);
  });

  test("leadSignal ticks on a lead and on done, and nothing else", () => {
    let s = applyEvent(initialRunState, { type: "status", step: "discover", message: "Searching" });
    expect(s.leadSignal).toBe(0);
    s = applyEvent(s, { type: "reasoning", text: "…" });
    expect(s.leadSignal).toBe(0);
    s = applyEvent(s, { type: "lead", lead: lead("a", "Bakery") });
    expect(s.leadSignal).toBe(1);
    s = applyEvent(s, { type: "done", count: 1, saved: 1, searchId: null });
    expect(s.leadSignal).toBe(2);
  });
});

describe("runHasWorkspace", () => {
  test("a fresh state shows the empty composer", () => {
    expect(runHasWorkspace(initialRunState)).toBe(false);
  });

  // This is requirement 1 in state form: coming back to the agent page mid-run
  // renders the workspace, not a blank form.
  test("a run in progress shows the workspace even before its first step", () => {
    expect(runHasWorkspace({ ...initialRunState, running: true })).toBe(true);
  });

  test("a finished run still shows what it produced", () => {
    const finished: RunState = { ...initialRunState, done: true, steps: [{ step: "done", message: "Done" }] };
    expect(runHasWorkspace(finished)).toBe(true);
  });

  // The workspace is the only place the "Search stopped" banner renders, so a
  // run stopped before it had anything to show has to keep it. Otherwise the
  // page falls back to the example chips and Stop reads as having done nothing.
  test("a run stopped before its first event still shows the workspace", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);
    await settle();

    store.cancel();
    const state = store.getState();

    expect(state.running).toBe(false);
    expect(state.cancelled).toBe(true);
    expect(state.steps).toHaveLength(0);
    expect(state.leads).toHaveLength(0);
    expect(state.error).toBe("");
    expect(runHasWorkspace(state)).toBe(true);
  });

  test("starting again clears the stop, so the banner belongs to one run only", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const first = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!first.started) throw new Error(first.reason);
    await settle();
    store.cancel();
    expect(store.getState().cancelled).toBe(true);

    const second = store.start({ prompt: "credit unions", mode: "sponsor" });
    expect(second.started).toBe(true);
    expect(store.getState().cancelled).toBe(false);
    store.cancel();
  });
});

// The board's banner says leads "appear here as they are saved", so its number
// has to be leads that were saved. A `lead` event is emitted whether or not the
// insert succeeded; the failure arrives as a `persist` status immediately
// before that lead, which is the only thing in the stream that says so — and it
// is emitted by code, not by the model.

describe("how many of the run's leads are on the board", () => {
  const persistFailed = (company: string): AgentEvent => ({
    type: "status",
    step: "persist",
    message: `${company} was NOT saved to the board: column "connection_note" does not exist`,
  });

  test("counts every lead when the database accepted them all", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });
    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    script.emit({ type: "lead", lead: lead("b", "Roasters") });
    await settle();

    expect(runSavedToBoard(store.getState())).toBe(2);
    store.cancel();
  });

  test("a lead the database rejected is not counted as on the board", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });
    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    await settle();
    expect(runSavedToBoard(store.getState())).toBe(1);

    script.emit(persistFailed("Roasters"));
    script.emit({ type: "lead", lead: lead("b", "Roasters") });
    await settle();

    expect(store.getState().leads).toHaveLength(2);
    expect(store.getState().persistFailures).toBe(1);
    expect(runSavedToBoard(store.getState())).toBe(1);
    store.cancel();
  });

  test("never reads as less than nothing when the first lead is the one that failed", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });
    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    // The failure is emitted before its lead, so this is the window in which a
    // plain subtraction would show -1.
    script.emit(persistFailed("Bakery"));
    await settle();
    expect(runSavedToBoard(store.getState())).toBe(0);

    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    await settle();
    expect(runSavedToBoard(store.getState())).toBe(0);
    store.cancel();
  });

  test("a status step that is not a persist failure costs the board nothing", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });
    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    script.emit({ type: "status", step: "research", message: "Analyzing fit" });
    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    await settle();

    expect(runSavedToBoard(store.getState())).toBe(1);
    store.cancel();
  });

  test("agrees with the count the finished run reports", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });
    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    script.emit(persistFailed("Roasters"));
    script.emit({ type: "lead", lead: lead("b", "Roasters") });
    script.emit({ type: "lead", lead: lead("c", "Cannery") });
    await settle();
    const whileRunning = runSavedToBoard(store.getState());

    script.emit({ type: "done", count: 3, saved: 2, searchId: null });
    script.finish();
    await outcome.finished;

    expect(whileRunning).toBe(2);
    expect(runSavedToBoard(store.getState())).toBe(store.getState().saved);
    expect(runSavedToBoard(store.getState())).toBe(2);
  });

  test("a second run counts from nothing, not from the last run's failures", async () => {
    const first = scriptedRun();
    const second = scriptedRun();
    const scripts = [first, second];
    let call = 0;
    const store = createRunStore({
      fetchImpl: ((...args: Parameters<typeof fetch>) =>
        scripts[call++].fetchImpl(...args)) as unknown as typeof fetch,
    });
    const one = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!one.started) throw new Error(one.reason);

    first.emit(persistFailed("Bakery"));
    first.emit({ type: "lead", lead: lead("a", "Bakery") });
    await settle();
    store.cancel();
    expect(store.getState().persistFailures).toBe(1);

    const two = store.start({ prompt: "credit unions", mode: "sponsor" });
    expect(two.started).toBe(true);
    expect(store.getState().persistFailures).toBe(0);

    second.emit({ type: "lead", lead: lead("b", "Roasters") });
    await settle();
    expect(runSavedToBoard(store.getState())).toBe(1);
    store.cancel();
  });
});

describe("a run surviving a navigation away and back", () => {
  test("keeps reading and accumulating while nothing is subscribed", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    // The agent page is mounted and subscribed.
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });

    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    expect(outcome.started).toBe(true);

    script.emit({ type: "status", step: "understand", message: "Planning searches" });
    script.emit({ type: "reasoning", text: "Looking at catering…" });
    await settle();

    expect(store.getState().steps).toHaveLength(1);
    const beforeNavigation = notifications;

    // Navigate to the board: the agent page unmounts and unsubscribes. Under the
    // old design this is where the reader was dropped and the run was lost.
    unsubscribe();

    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    script.emit({ type: "status", step: "research", message: "Analyzing fit" });
    script.emit({ type: "reasoning", text: " and bakeries" });
    await settle();

    // Navigate back: a new subscriber reads the state the run has been building
    // the whole time.
    store.subscribe(() => {});
    const state = store.getState();

    expect(state.running).toBe(true);
    expect(state.steps.map((s) => s.message)).toEqual(["Planning searches", "Analyzing fit"]);
    expect(state.reasoning).toBe("Looking at catering… and bakeries");
    expect(state.leads.map((l) => l.company)).toEqual(["Bakery"]);
    expect(runHasWorkspace(state)).toBe(true);
    // The unsubscribed listener stopped hearing about it, as it must.
    expect(notifications).toBe(beforeNavigation);
  });

  test("finishes normally after the navigation, and the board is told to read again", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const unsubscribe = store.subscribe(() => {});
    const outcome = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    unsubscribe();
    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    script.emit({ type: "done", count: 1, saved: 1, searchId: "s1" });
    script.finish();
    await outcome.finished;

    const state = store.getState();
    expect(state.running).toBe(false);
    expect(state.done).toBe(true);
    expect(state.saved).toBe(1);
    // Two ticks: the lead, then done. The board reads `/api/leads` on each.
    expect(state.leadSignal).toBe(2);
  });

  test("the composer draft survives the navigation too", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    store.setDraft("credit unions with community grants");
    const outcome = store.start({ prompt: store.getState().draft, mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);
    await settle();

    expect(store.getState().draft).toBe("credit unions with community grants");
  });
});

// The decision: a second run while one is in flight is REFUSED. Two readers
// writing into one state is the data-mixing bug this codebase has been repaired
// for before, and aborting the first fetch would not stop the server-side run
// anyway — it would only orphan it.
describe("starting a second run while one is in flight", () => {
  test("is refused, and says so", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const first = store.start({ prompt: "catering in Burnaby", mode: "sponsor" });
    expect(first.started).toBe(true);

    script.emit({ type: "status", step: "understand", message: "Planning searches" });
    await settle();

    const second = store.start({ prompt: "credit unions", mode: "sponsor" });
    expect(second.started).toBe(false);
    if (second.started) throw new Error("expected a refusal");
    expect(second.reason).toBe(ALREADY_RUNNING);

    // The refusal changed nothing: the run in flight still owns the state.
    const state = store.getState();
    expect(state.running).toBe(true);
    expect(state.steps.map((s) => s.message)).toEqual(["Planning searches"]);
  });

  test("two clicks in the same tick cannot both start a reader", () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const a = store.start({ prompt: "catering", mode: "sponsor" });
    const b = store.start({ prompt: "catering", mode: "sponsor" });

    expect(a.started).toBe(true);
    expect(b.started).toBe(false);
  });

  test("an empty prompt is refused rather than sent", () => {
    const store = createRunStore({
      fetchImpl: (() => {
        throw new Error("must not reach the network");
      }) as unknown as typeof fetch,
    });
    const outcome = store.start({ prompt: "   ", mode: "sponsor" });
    expect(outcome.started).toBe(false);
  });

  test("is allowed once the first run has finished, and starts clean", async () => {
    const first = scriptedRun();
    const store = createRunStore({ fetchImpl: first.fetchImpl });

    const a = store.start({ prompt: "catering", mode: "sponsor" });
    if (!a.started) throw new Error("expected a start");
    first.emit({ type: "status", step: "understand", message: "Planning searches" });
    first.emit({ type: "lead", lead: lead("a", "Bakery") });
    first.emit({ type: "done", count: 1, saved: 1, searchId: null });
    first.finish();
    await a.finished;

    const b = store.start({ prompt: "credit unions", mode: "sponsor" });
    expect(b.started).toBe(true);

    const state = store.getState();
    expect(state.steps).toEqual([]);
    expect(state.leads).toEqual([]);
    expect(state.reasoning).toBe("");
    expect(state.done).toBe(false);
    expect(state.saved).toBe(0);
    // The board's counter is monotonic across runs: resetting it could repeat a
    // value the board had already reacted to and the refresh would not fire.
    expect(state.leadSignal).toBe(2);
  });
});

describe("stopping a run", () => {
  test("ends it, and nothing the superseded reader delivers afterwards may land", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const outcome = store.start({ prompt: "catering", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    await settle();

    store.cancel();
    expect(store.getState().running).toBe(false);
    expect(store.getState().cancelled).toBe(true);

    // A chunk already buffered when the abort landed is still delivered by the
    // stream; it belongs to a superseded run and must be dropped.
    script.emit({ type: "lead", lead: lead("b", "Roasters") });
    script.emit({ type: "done", count: 2, saved: 2, searchId: null });
    await settle();
    await outcome.finished;

    const state = store.getState();
    expect(state.leads.map((l) => l.company)).toEqual(["Bakery"]);
    expect(state.done).toBe(false);
    expect(state.running).toBe(false);
    // Cancelling is not a failure, so it is not reported as one.
    expect(state.error).toBe("");
    // The leads already found were persisted as they were found; stopping does
    // not take them off the board or off the screen.
    expect(state.leads).toHaveLength(1);
  });

  test("actually closes the response body rather than leaving it draining", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const outcome = store.start({ prompt: "catering", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);
    await settle();

    store.cancel();
    await outcome.finished;

    expect(script.wasCancelled()).toBe(true);
  });

  test("frees the slot, so the next run may start", async () => {
    const first = scriptedRun();
    const store = createRunStore({ fetchImpl: first.fetchImpl });

    const a = store.start({ prompt: "catering", mode: "sponsor" });
    if (!a.started) throw new Error("expected a start");
    await settle();
    store.cancel();
    await a.finished;

    const b = store.start({ prompt: "credit unions", mode: "sponsor" });
    expect(b.started).toBe(true);
    expect(store.getState().cancelled).toBe(false);
  });

  test("does nothing when no run is in flight", () => {
    const store = createRunStore({ fetchImpl: (() => { throw new Error("unused"); }) as unknown as typeof fetch });
    store.cancel();
    expect(store.getState()).toBe(initialRunState);
  });
});

describe("a malformed stream", () => {
  test("costs the line it arrived on and nothing beside it", async () => {
    const script = scriptedRun();
    const store = createRunStore({ fetchImpl: script.fetchImpl });

    const outcome = store.start({ prompt: "catering", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    script.emit({ type: "status", step: "understand", message: "Planning searches" });
    script.raw("{ not json");
    script.emit({ type: "lead", lead: lead("a", "Bakery") });
    script.finish();
    await outcome.finished;

    const state = store.getState();
    expect(state.steps).toHaveLength(1);
    expect(state.leads.map((l) => l.company)).toEqual(["Bakery"]);
    expect(state.error).toBe("");
  });

  test("an event split across two chunks is still read whole", async () => {
    const enc = new TextEncoder();
    let push!: (chunk: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (chunk) => c.enqueue(enc.encode(chunk));
        close = () => c.close();
      },
    });
    const store = createRunStore({
      fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    });

    const outcome = store.start({ prompt: "catering", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);

    const line = JSON.stringify({ type: "status", step: "discover", message: "Searching the web" });
    push(line.slice(0, 12));
    await settle();
    push(line.slice(12) + "\n");
    close();
    await outcome.finished;

    expect(store.getState().steps).toEqual([{ step: "discover", message: "Searching the web" }]);
  });
});

describe("a request that never streams", () => {
  test("reports the route's own error and ends the run", async () => {
    const store = createRunStore({
      fetchImpl: (async () =>
        Response.json({ error: "EXA_API_KEY missing." }, { status: 400 })) as unknown as typeof fetch,
    });

    const outcome = store.start({ prompt: "catering", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);
    await outcome.finished;

    const state = store.getState();
    expect(state.error).toBe("EXA_API_KEY missing.");
    expect(state.running).toBe(false);
  });

  test("a network failure is reported rather than leaving the page spinning", async () => {
    const store = createRunStore({
      fetchImpl: (async () => {
        throw new Error("Failed to fetch");
      }) as unknown as typeof fetch,
    });

    const outcome = store.start({ prompt: "catering", mode: "sponsor" });
    if (!outcome.started) throw new Error(outcome.reason);
    await outcome.finished;

    expect(store.getState().error).toBe("Failed to fetch");
    expect(store.getState().running).toBe(false);
  });
});

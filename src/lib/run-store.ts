import { AgentEvent, Lead, Mode } from "@/lib/types";

/**
 * The agent run, owned by something longer-lived than the page that started it.
 *
 * A run is a `fetch` to `/api/agent/run` whose body is read line by line. When
 * every piece of that lived in `useState` on the agent page, navigating to the
 * board unmounted the page, dropped the reader, and lost the run. The store here
 * owns the fetch, the reader loop and the accumulated state; React subscribes to
 * it. A subscriber coming and going — which is all a client-side navigation is —
 * cannot affect the run, because the run does not hold a reference to one.
 *
 * This is deliberately framework-free: no React import, so the property that
 * matters ("the run outlives its subscribers") is testable without a renderer.
 *
 * What it is NOT: durable. The run executes inside the browser's own HTTP
 * request, so a refresh, a closed tab or a lost connection still ends it. Making
 * it survive those needs a job queue or a worker outliving the request, which is
 * a different and much larger change.
 */

export interface RunStep {
  step: string;
  message: string;
}

export interface RunState {
  /** What is typed in the composer. Held here so returning to the agent page is
   *  not a blank form, exactly as the progress must not be blank. */
  draft: string;
  /** Answers typed against the clarifying questions, kept for the same reason. */
  answers: string;
  running: boolean;
  steps: RunStep[];
  reasoning: string;
  similar: { message: string; suggestion: string } | null;
  clarify: string[] | null;
  leads: Lead[];
  error: string;
  done: boolean;
  /** How many leads the database actually accepted, from the `done` event. */
  saved: number;
  /** Set when the user stopped the run rather than it finishing. */
  cancelled: boolean;
  /**
   * Ticks whenever a lead may have reached the database. The board watches this
   * rather than the whole run state, so a run streaming reasoning tokens does
   * not re-render a board full of leads dozens of times a second. Monotonic
   * across runs on purpose: a counter that reset could repeat a value the board
   * had already reacted to, and the refresh would not fire.
   */
  leadSignal: number;
}

export const initialRunState: RunState = {
  draft: "",
  answers: "",
  running: false,
  steps: [],
  reasoning: "",
  similar: null,
  clarify: null,
  leads: [],
  error: "",
  done: false,
  saved: 0,
  cancelled: false,
  leadSignal: 0,
};

/**
 * One event from the stream applied to the state. Total by construction: an
 * event shape this build does not know costs nothing rather than ending the run,
 * which is the same rule the rest of the pipeline reads model output under.
 */
export function applyEvent(state: RunState, ev: AgentEvent): RunState {
  switch (ev.type) {
    case "status":
      return { ...state, steps: [...state.steps, { step: ev.step, message: ev.message }] };
    case "reasoning":
      return { ...state, reasoning: state.reasoning + ev.text };
    case "similar":
      return { ...state, similar: { message: ev.message, suggestion: ev.suggestion } };
    case "clarify":
      return { ...state, clarify: ev.questions };
    // A lead is emitted after `persistLead` has already tried to write it, so
    // this is the earliest honest moment to tell the board to read again.
    case "lead":
      return { ...state, leads: [...state.leads, ev.lead], leadSignal: state.leadSignal + 1 };
    case "done":
      return { ...state, saved: ev.saved, done: true, leadSignal: state.leadSignal + 1 };
    // An error annotates the run; it never discards the steps and leads already
    // accumulated, because those leads are persisted rows, not a draft.
    case "error":
      return { ...state, error: ev.message };
    default:
      return state;
  }
}

/**
 * Whether the agent page should show the run workspace rather than the empty
 * composer. Derived from the state alone, so coming back to the page mid-run
 * shows the run in progress instead of a blank form.
 *
 * `cancelled` counts even with nothing else to show: a run stopped before its
 * first event has no steps and no leads, and the workspace is the only place
 * the "Search stopped" banner can render — without it, Stop would look like it
 * had done nothing at all.
 */
export function runHasWorkspace(state: RunState): boolean {
  return (
    state.running ||
    state.cancelled ||
    state.steps.length > 0 ||
    state.leads.length > 0 ||
    state.error !== "" ||
    state.clarify !== null
  );
}

export interface RunInput {
  prompt: string;
  mode: Mode;
  answers?: string;
}

/**
 * `finished` resolves when the run's reader loop has ended, whatever ended it.
 * It never rejects; a failure is reported on `state.error` like any other.
 */
export type StartOutcome =
  | { started: true; finished: Promise<void> }
  | { started: false; reason: string };

export const ALREADY_RUNNING =
  "A search is already running. Stop it before starting another.";
export const NOTHING_TO_RUN =
  "Describe the sponsors you want before running the agent.";

export interface RunStore {
  getState: () => RunState;
  subscribe: (listener: () => void) => () => void;
  /**
   * Synchronous on purpose. The check that refuses a second run and the write
   * that claims the slot happen with no await between them, so two clicks in one
   * tick cannot both start a reader.
   */
  start: (input: RunInput) => StartOutcome;
  cancel: () => void;
  setDraft: (value: string) => void;
  setAnswers: (value: string) => void;
}

/**
 * A second run while one is in flight is REFUSED, not queued and not swapped in.
 *
 * Two readers writing into one state is the data-mixing bug this codebase has
 * been repaired for before, and replacing the first run would not even stop it:
 * aborting the fetch ends the browser's half of the conversation, but
 * `runAgent` is already executing on the server and keeps going — so "replace"
 * would orphan a run that is still spending the club's Exa and OpenRouter budget
 * while telling the student it had been cancelled. Refusing is the honest
 * reading, and Stop makes the refusal actionable instead of a dead end.
 */
export function createRunStore(options: { fetchImpl?: typeof fetch } = {}): RunStore {
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));

  let state: RunState = initialRunState;
  const listeners = new Set<() => void>();

  // Every run takes a ticket, and only the newest ticket may write. Cancelling
  // takes a ticket without starting a run, so a reader still draining a buffered
  // chunk after the abort cannot land its events. Same rule the board reads
  // `/api/leads` under.
  let ticket = 0;
  let inFlight: AbortController | null = null;

  const isCurrent = (id: number) => id === ticket;

  function setState(next: RunState) {
    if (next === state) return;
    state = next;
    // A copy: a listener that unsubscribes while being notified — a page
    // unmounting mid-run — must not skip the listeners after it.
    for (const listener of [...listeners]) listener();
  }

  async function drive(id: number, input: RunInput, signal: AbortSignal): Promise<void> {
    try {
      const res = await doFetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: input.prompt,
          mode: input.mode,
          answers: input.answers,
          skipClarify: Boolean(input.answers),
        }),
        signal,
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      // Cancelling the reader as well as the fetch, rather than trusting the
      // signal to reach the body: this is the call that actually closes the
      // stream and lets the read in flight resolve, so a stopped run unwinds
      // here instead of sitting on a read that never returns.
      const release = () => { void reader.cancel().catch(() => {}); };
      if (signal.aborted) release();
      else signal.addEventListener("abort", release, { once: true });

      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isCurrent(id)) return;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: AgentEvent;
          // A line that is not JSON costs that line and nothing else.
          try {
            ev = JSON.parse(line) as AgentEvent;
          } catch {
            continue;
          }
          if (!isCurrent(id)) return;
          setState(applyEvent(state, ev));
        }
      }
    } catch (e) {
      // An abort we asked for is not a failure, and the run it belonged to has
      // already been superseded, so it may not write.
      if (!isCurrent(id)) return;
      setState({ ...state, error: (e as Error).message });
    } finally {
      if (isCurrent(id)) {
        inFlight = null;
        setState({ ...state, running: false });
      }
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start(input) {
      if (state.running) return { started: false, reason: ALREADY_RUNNING };
      if (!input.prompt.trim()) return { started: false, reason: NOTHING_TO_RUN };

      ticket += 1;
      const id = ticket;
      const controller = new AbortController();
      inFlight = controller;

      // Everything the previous run accumulated is cleared here and nowhere
      // else, so there is one place that decides what a new run starts from.
      // `draft`, `answers` and `leadSignal` deliberately survive.
      setState({
        ...state,
        running: true,
        steps: [],
        reasoning: "",
        similar: null,
        clarify: null,
        leads: [],
        error: "",
        done: false,
        saved: 0,
        cancelled: false,
      });

      return { started: true, finished: drive(id, input, controller.signal) };
    },

    cancel() {
      if (!state.running) return;
      // Take the ticket first: from here the reader in flight is superseded and
      // can no longer write, whether or not the abort has reached it yet.
      ticket += 1;
      inFlight?.abort();
      inFlight = null;
      setState({ ...state, running: false, cancelled: true });
    },

    setDraft(value) {
      setState({ ...state, draft: value });
    },

    setAnswers(value) {
      setState({ ...state, answers: value });
    },
  };
}

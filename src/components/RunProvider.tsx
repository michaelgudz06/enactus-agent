"use client";

import { createContext, useContext, useMemo, useState, useSyncExternalStore } from "react";
import {
  ALREADY_RUNNING,
  createRunStore,
  initialRunState,
  RunInput,
  RunState,
  StartOutcome,
} from "@/lib/run-store";

/**
 * Mounted by `src/app/(app)/layout.tsx`, which wraps both the agent view and the
 * board. Layouts do not re-render on navigation between the routes below them,
 * so this component — and the run store it holds — stays mounted while the
 * student moves between the two. That is the whole mechanism: the run is owned
 * one level above the page that starts it.
 */

export interface RunControls {
  start: (input: RunInput) => StartOutcome;
  cancel: () => void;
  setDraft: (value: string) => void;
  setAnswers: (value: string) => void;
}

/**
 * The board's view of the run. Two primitives rather than the whole state: the
 * reasoning stream writes state dozens of times a second, and a board full of
 * lead cards must not re-render on every token. This value only changes when one
 * of the two changes, so it does not.
 *
 * No count of any kind is published here, deliberately. Every number a run in
 * flight can offer is an upper bound — `runSavedToBoard` says so itself — and a
 * consumer given one will render it as fact. The authoritative count arrives on
 * the `done` event as `RunState.saved`, which the agent view reads from the full
 * state; a mid-run consumer gets the signal to re-read the database instead.
 */
export interface RunActivity {
  running: boolean;
  /** Ticks when a lead may have reached the database; the board reads again. */
  leadSignal: number;
}

const OUTSIDE_PROVIDER = "The agent run provider is not mounted.";

const RunStateContext = createContext<RunState>(initialRunState);
const RunActivityContext = createContext<RunActivity>({ running: false, leadSignal: 0 });
const RunControlsContext = createContext<RunControls>({
  // Refusing out loud rather than doing nothing: a page rendered outside the
  // provider would otherwise have a Run button that silently did nothing.
  start: () => ({ started: false, reason: OUTSIDE_PROVIDER }),
  cancel: () => {},
  setDraft: () => {},
  setAnswers: () => {},
});

/** The full run state. For the agent view, which renders all of it. */
export const useRunState = () => useContext(RunStateContext);
/** The board's cheap view of the run. */
export const useRunActivity = () => useContext(RunActivityContext);
export const useRunControls = () => useContext(RunControlsContext);

export { ALREADY_RUNNING };

export default function RunProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createRunStore);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const controls = useMemo<RunControls>(
    () => ({
      start: store.start,
      cancel: store.cancel,
      setDraft: store.setDraft,
      setAnswers: store.setAnswers,
    }),
    [store]
  );

  const activity = useMemo<RunActivity>(
    () => ({
      running: state.running,
      leadSignal: state.leadSignal,
    }),
    [state.running, state.leadSignal]
  );

  // `children` is created by the layout, which does not re-render, so React
  // reuses that element and the subtree only re-renders where it reads one of
  // these contexts.
  return (
    <RunControlsContext.Provider value={controls}>
      <RunActivityContext.Provider value={activity}>
        <RunStateContext.Provider value={state}>{children}</RunStateContext.Provider>
      </RunActivityContext.Provider>
    </RunControlsContext.Provider>
  );
}

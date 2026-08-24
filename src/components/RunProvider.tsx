"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AgentEvent, Lead, Mode } from "@/lib/types";
import { applyEvent, newTurn, RunTurn, takeLines } from "@/lib/run-events";

/**
 * The agent run, owned one level above the page that starts it.
 *
 * Every piece of run state used to live in `useState` on the agent page, so
 * navigating to the board unmounted the page and took the reader loop with it --
 * the run died the moment you went to look at the leads it was producing. This
 * component is mounted by `src/app/(app)/layout.tsx`, which wraps both routes.
 * Layouts do not re-render when navigating between the routes below them, so the
 * run and its reader stay alive while the student moves between the two.
 *
 * What this is NOT: durable. The fetch is the browser's own request, so a
 * refresh, a closed tab or a dropped connection still ends it. Surviving those
 * needs a job that outlives the request, which is a much larger change. The
 * server-side run does keep going either way -- `runAgent` writes each lead to
 * the board as it goes, so leads already found are on the board regardless.
 */

export type Turn = RunTurn<Lead>;

interface RunCtx {
  turns: Turn[];
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  prompt: string;
  setPrompt: (v: string) => void;
  running: boolean;
  /** True once a run has been started in this session, for the board's refresh. */
  leadSignal: number;
  send: (text: string, mode: Mode, awaitingAnswers: boolean) => void;
  /** Re-run the last search for a fresh batch. The board-domain exclusion in
   *  agent.ts is what makes an identical prompt return different companies. */
  more: (mode: Mode) => void;
  /** Run `more` back to back until it stops paying, or until stop() is called. */
  chain: (mode: Mode) => void;
  stop: () => void;
  /** Skip the clarifying questions and search on what was already typed. */
  skip: (mode: Mode) => void;
  /** True while chain() is mid-sequence, including between rounds. */
  chaining: boolean;
  /** Which round chain() is on, 1-based, for the button label. */
  round: number;
  /** Is there a finished search to continue from? */
  canContinue: boolean;
}

/** One click of "Keep going" is at most this many 60s runs. */
export const MAX_ROUNDS = 5;

const Ctx = createContext<RunCtx | null>(null);

export function useRun(): RunCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRun must be used inside RunProvider");
  return v;
}

export default function RunProvider({ children }: { children: React.ReactNode }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [leadSignal, setLeadSignal] = useState(0);

  // The search the agent is working on. Clarifying answers are a reply in the
  // transcript, but the API still needs the question they answer.
  const askedRef = useRef("");
  // Read synchronously by send() so two clicks in one tick cannot both start a
  // reader; `running` alone is a render behind and would let the second through.
  const busy = useRef(false);
  // chain() state. chainRef guards re-entry the same way busy does for run():
  // `chaining` is a render behind, so two fast clicks would both start a loop.
  const chainRef = useRef(false);
  const stopRef = useRef(false);
  const [chaining, setChaining] = useState(false);
  const [round, setRound] = useState(0);

  const run = useCallback(async (mode: Mode, answers?: string, forceSkip?: boolean): Promise<number> => {
    busy.current = true;
    setRunning(true);
    // Counted here rather than read off `turns` afterwards: chain() needs to
    // know whether THIS round produced anything, and the state update is a
    // render behind by the time the loop would look.
    let produced = 0;
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: askedRef.current, mode, answers, skipClarify: Boolean(answers) || Boolean(forceSkip) }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { lines, rest } = takeLines(buf);
        buf = rest;
        for (const line of lines) {
          let ev: AgentEvent;
          // A line that is not JSON costs that line and nothing else.
          try { ev = JSON.parse(line) as AgentEvent; } catch { continue; }
          setTurns((ts) => applyEvent(ts, ev));
          // A lead is emitted after the insert has been attempted, so this is
          // the earliest honest moment to tell the board to read again.
          if (ev.type === "lead") produced++;
          if (ev.type === "lead" || ev.type === "done") setLeadSignal((n) => n + 1);
        }
      }
    } catch (e) {
      setTurns((ts) => applyEvent(ts, { type: "error", message: (e as Error).message }));
    } finally {
      busy.current = false;
      setRunning(false);
    }
    return produced;
  }, []);

  const send = useCallback((text: string, mode: Mode, awaitingAnswers: boolean) => {
    const t = text.trim();
    if (!t || busy.current) return;
    setPrompt("");
    setTurns((ts) => [...ts, newTurn<Lead>(t)]);
    if (awaitingAnswers) void run(mode, t);
    else { askedRef.current = t; void run(mode); }
  }, [run]);

  // Every continuation below re-sends the ORIGINAL prompt with skipClarify on.
  // Without the skip, round two can be met with the same clarifying questions
  // the user already answered, which ends the sequence instead of extending it.
  const again = useCallback((mode: Mode) => {
    setTurns((ts) => [...ts, newTurn<Lead>(askedRef.current)]);
    return run(mode, undefined, true);
  }, [run]);

  const more = useCallback((mode: Mode) => {
    if (!askedRef.current || busy.current) return;
    void again(mode);
  }, [again]);

  const skip = useCallback((mode: Mode) => {
    if (!askedRef.current || busy.current) return;
    void again(mode);
  }, [again]);

  // Rounds run one after another, never concurrently: each is its own 60s
  // function and they share the same board, so two in flight would discover
  // the same companies and race to insert them.
  const chain = useCallback(async (mode: Mode) => {
    if (!askedRef.current || busy.current || chainRef.current) return;
    chainRef.current = true;
    stopRef.current = false;
    setChaining(true);
    try {
      for (let i = 0; i < MAX_ROUNDS; i++) {
        if (stopRef.current) break;
        setRound(i + 1);
        // A round that adds nothing means the exclusion list has caught up with
        // what these queries can reach. Four more rounds of that is four
        // minutes and real money spent re-reading pages we already rejected.
        if ((await again(mode)) === 0) break;
      }
    } finally {
      chainRef.current = false;
      stopRef.current = false;
      setChaining(false);
      setRound(0);
    }
  }, [again]);

  const stop = useCallback(() => { stopRef.current = true; }, []);

  return (
    <Ctx.Provider value={{
      turns, setTurns, prompt, setPrompt, running, leadSignal, send,
      more, chain, stop, skip, chaining, round,
      canContinue: Boolean(askedRef.current),
    }}>
      {children}
    </Ctx.Provider>
  );
}

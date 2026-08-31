// Race-safe observation of one Herdr-hosted Pi child.
//
// A correlated semantic sidecar is the only success signal. Herdr agent/pane
// disappearance without that signal is an explicit failure after a short grace
// window, allowing the child bridge's final atomic rename to win close races.
import { readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import { updateDurableChildLocation } from "./durable-state.ts";
import type { AgentInfo, PaneInfo } from "./herdr/client.ts";
import type { HerdrPaneEvent } from "./herdr/events.ts";
import { boundOutcomeText } from "./outcome.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  paneId: string;
  terminalId?: string;
  liveAgentName: string;
  startTime: number;
  sessionFile: string;
  durableStateDir?: string;
  interactive: boolean;
  autoExit: boolean;
  abortController?: AbortController;
}

export type UnsignaledExitReason =
  | "agent-disappeared"
  | "pane-disappeared"
  | "pane-closed";

/**
 * Terminal outcomes. `sessionFile` is optional for migration compatibility
 * with launch failures constructed outside the watcher; watchSubagent always
 * supplies it because its child session is known.
 */
export type SubagentOutcome =
  | { kind: "completed"; summary: string; exitCode: 0; sessionFile?: string }
  | { kind: "ping"; name: string; message: string; sessionFile?: string }
  | {
      kind: "unsignaled-exit";
      reason: UnsignaledExitReason;
      summary: string | null;
      sessionFile?: string;
    }
  | {
      kind: "launch-failed";
      error: string;
      paneId?: string;
      exitCode?: number;
      heldOpen?: boolean;
      sessionFile?: string;
    }
  | { kind: "cancelled"; sessionFile?: string };

export interface WatcherDeps {
  client: {
    agentGet(target: string): Promise<AgentInfo | null>;
    paneGet(paneId: string): Promise<PaneInfo | null>;
  };
  stream: {
    watch(paneId: string, listener: (ev: HerdrPaneEvent) => void): () => void;
    onReconcile(cb: () => void): () => void;
  };
  /** Pane snapshot for reconcile sweeps; SubagentRuntime shares one per burst. */
  listPanes: () => Promise<PaneInfo[]>;
  signal: AbortSignal;
  pollIntervalMs?: number;
  /** Delay before classifying disappearance, giving a final sidecar rename time to arrive. */
  unsignaledGraceMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_UNSIGNALED_GRACE_MS = 100;

type ExitSignal =
  | { version: 1; subagentId: string; type: "done" }
  | { version: 1; subagentId: string; type: "ping"; name: string; message: string };

function isExitSignal(value: unknown, subagentId: string): value is ExitSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  if (signal.version !== 1 || signal.subagentId !== subagentId) return false;
  if (signal.type === "done") return true;
  return (
    signal.type === "ping" &&
    typeof signal.name === "string" &&
    typeof signal.message === "string"
  );
}

export function watchSubagent(
  running: RunningSubagent,
  deps: WatcherDeps,
): Promise<SubagentOutcome> {
  return new Promise((resolve) => {
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const unsignaledGraceMs = deps.unsignaledGraceMs ?? DEFAULT_UNSIGNALED_GRACE_MS;
    const exitFile = `${running.sessionFile}.exit`;

    let done = false;
    let unsignaledTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingReason: UnsignaledExitReason | null = null;
    const cleanups: Array<() => void> = [];

    function finish(outcome: SubagentOutcome): void {
      if (done) return;
      done = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // Observation teardown is best-effort after the outcome is fixed.
        }
      }
      resolve({ ...outcome, sessionFile: running.sessionFile });
    }

    if (deps.signal.aborted) {
      finish({ kind: "cancelled" });
      return;
    }

    function readSummary(): string | null {
      try {
        const entries = getNewEntries(running.sessionFile, 0);
        const summary = findLastAssistantMessage(entries);
        return summary == null ? null : boundOutcomeText(summary).text;
      } catch {
        return null;
      }
    }

    function readExitSignal(): ExitSignal | null {
      try {
        const candidate: unknown = JSON.parse(readFileSync(exitFile, "utf8"));
        return isExitSignal(candidate, running.id) ? candidate : null;
      } catch {
        return null;
      }
    }

    function settleSemantic(): boolean {
      if (done) return true;
      const signal = readExitSignal();
      if (!signal) return false;
      if (signal.type === "done") {
        finish({
          kind: "completed",
          summary: readSummary() ?? "Sub-agent exited without output",
          exitCode: 0,
        });
      } else {
        finish({
          kind: "ping",
          name: signal.name,
          message: boundOutcomeText(signal.message).text,
        });
      }
      return true;
    }

    function scheduleUnsignaled(reason: UnsignaledExitReason): void {
      if (done || settleSemantic()) return;
      if (unsignaledTimer) return;
      pendingReason = reason;
      unsignaledTimer = setTimeout(() => {
        unsignaledTimer = null;
        if (done || settleSemantic()) return;
        finish({
          kind: "unsignaled-exit",
          reason: pendingReason ?? reason,
          summary: readSummary(),
        });
      }, unsignaledGraceMs);
    }
    cleanups.push(() => {
      if (unsignaledTimer) clearTimeout(unsignaledTimer);
    });

    function persistLocation(): void {
      if (!running.durableStateDir) return;
      try {
        updateDurableChildLocation(
          running.durableStateDir,
          running.id,
          running.paneId,
          running.terminalId,
        );
      } catch {
        // A later identity reconciliation can retry the durable refresh.
      }
    }

    let unwatchPane = () => {};
    function watchCurrentPane(): void {
      unwatchPane();
      unwatchPane = deps.stream.watch(running.paneId, handlePaneEvent);
    }
    function handlePaneEvent(event: HerdrPaneEvent): void {
      if (event.event === "pane_moved") {
        if (running.terminalId && event.terminalId && running.terminalId !== event.terminalId) {
          return;
        }
        running.paneId = event.nextPaneId;
        running.terminalId = event.terminalId ?? running.terminalId;
        persistLocation();
        watchCurrentPane();
        return;
      }
      const reason =
        event.event === "pane_closed"
          ? "pane-closed"
          : event.event === "pane_agent_released"
            ? "agent-disappeared"
            : "pane-disappeared";
      scheduleUnsignaled(reason);
    }
    watchCurrentPane();
    cleanups.push(() => unwatchPane());

    let fsWatcher: FSWatcher | null = null;
    try {
      const sidecarName = basename(exitFile);
      fsWatcher = fsWatch(dirname(running.sessionFile), (_eventType, filename) => {
        if (filename == null || filename === sidecarName) settleSemantic();
      });
      fsWatcher.on("error", () => {});
      cleanups.push(() => fsWatcher?.close());
    } catch {
      // The poll below covers a session directory that does not exist yet.
    }

    async function checkGone(list: boolean): Promise<void> {
      try {
        const agent = await deps.client.agentGet(running.liveAgentName);
        if (agent === null) {
          scheduleUnsignaled("agent-disappeared");
          return;
        }
        const sameTerminal =
          Boolean(running.terminalId) && agent.terminalId === running.terminalId;
        if (agent.paneId !== running.paneId && sameTerminal) {
          running.paneId = agent.paneId;
          persistLocation();
          watchCurrentPane();
        }
        const paneGone = list
          ? !(await deps.listPanes()).some((pane) => pane.pane_id === running.paneId)
          : (await deps.client.paneGet(running.paneId)) === null;
        if (paneGone) scheduleUnsignaled("pane-disappeared");
      } catch {
        // Herdr may reconnect; the next poll/reconcile will retry.
      }
    }

    const pollTimer = setInterval(() => {
      if (done || settleSemantic()) return;
      void checkGone(false);
    }, pollIntervalMs);
    pollTimer.unref?.();
    cleanups.push(() => clearInterval(pollTimer));

    const offReconcile = deps.stream.onReconcile(() => {
      if (!done) void checkGone(true);
    });
    cleanups.push(offReconcile);

    const onAbort = () => finish({ kind: "cancelled" });
    deps.signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => deps.signal.removeEventListener("abort", onAbort));

    queueMicrotask(() => settleSemantic());
  });
}

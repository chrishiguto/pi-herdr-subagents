// Subagent runtime — the single lifecycle owner for herdr-hosted Pi children.
//
// Layout/session planning stays in launch.ts; everything after a plan exists
// lives here: launch execution (readiness probe → materialize artifacts →
// pane → agent start), durable record tracking, watcher arming, outcome→steer
// delivery, reload recovery, inspection, interruption, and shutdown.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  hasMatchingActiveChildIdentity,
  inspectActiveChildren,
  type ActiveChildSnapshot,
} from "./active-children.ts";
import { consumeContextUsageSidecar } from "./context-usage.ts";
import {
  classifyDurableRecord,
  DURABLE_STATE_VERSION,
  finalizeReportedChild,
  readDurableRecords,
  recoverDurableChildren,
  removeDurableRecord,
  writeDurableRecord,
  type DurableChildRecord,
  type RecoveryDecision,
} from "./durable-state.ts";
import type { AgentStartResult, HerdrClient } from "./herdr/client.ts";
import { probeHerdrReadiness } from "./herdr/compatibility.ts";
import { lifecycleFlags, lifecycleModeOf } from "./launch-policy.ts";
import type { LaunchPlan, ResumeLaunchPlan } from "./launch.ts";
import { buildOutcomeMessage } from "./messages.ts";
import { appendChildTranscriptMarker, publishSubagentActivity } from "./runtime-events.ts";
import {
  acquireSessionLock,
  releaseSessionLock,
  type SessionLock,
} from "./session-claim.ts";
import { findLastAssistantMessage, getNewEntries, seedSubagentSessionFile } from "./session.ts";
import { chooseChildPlacement } from "./topology.ts";
import type {
  RunningSubagent,
  SubagentOutcome,
  WatcherDeps,
  watchSubagent,
} from "./watcher.ts";

type Watcher = typeof watchSubagent;

// ── launch execution ────────────────────────────────────────────────────────

export class ChildLaunchError extends Error {
  readonly stage: "readiness" | "materialize" | "pane" | "agent";
  readonly code?: string;
  readonly cleanupConfirmed?: boolean;

  constructor(
    stage: "readiness" | "materialize" | "pane" | "agent",
    message: string,
    options?: { cause?: unknown; code?: string; cleanupConfirmed?: boolean },
  ) {
    super(message, options);
    this.name = "ChildLaunchError";
    this.stage = stage;
    this.code = options?.code;
    this.cleanupConfirmed = options?.cleanupConfirmed;
  }
}

export async function launchNativePiChild(
  client: HerdrClient,
  plan: LaunchPlan | ResumeLaunchPlan,
  hooks: {
    afterPaneCreated?: (paneId: string) => void;
    afterAgentStarted?: (started: AgentStartResult) => void;
  } = {},
): Promise<AgentStartResult> {
  const readiness = await probeHerdrReadiness(() => client.ping());
  if (!readiness.ready) {
    throw new ChildLaunchError("readiness", readiness.error, { code: readiness.reason });
  }

  try {
    mkdirSync(dirname(plan.sessionFile), { recursive: true });
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, "utf8");
    }
    if ("seedSession" in plan && plan.seedSession) {
      seedSubagentSessionFile(plan.seedSession);
    }
  } catch (error) {
    throw new ChildLaunchError("materialize", "Failed to prepare child session artifacts.", {
      cause: error,
    });
  }

  let paneId: string | null = null;
  try {
    const layout = await client.paneLayout(plan.paneSplit.sourcePaneId);
    const placement = chooseChildPlacement(layout, plan.paneSplit.sourcePaneId);
    const pane =
      placement.kind === "tab"
        ? await client.tabCreate({
            workspaceId: layout.workspace_id,
            cwd: plan.paneSplit.cwd,
            env: plan.paneSplit.env,
          })
        : await client.paneSplit({
            ...plan.paneSplit,
            direction: placement.direction,
          });
    paneId = pane.pane_id;
  } catch (error) {
    throw new ChildLaunchError("pane", "Failed to create the child Herdr pane.", { cause: error });
  }
  if (!paneId) throw new ChildLaunchError("pane", "Herdr returned an empty child pane id.");
  const createdPaneId = paneId;

  try {
    hooks.afterPaneCreated?.(createdPaneId);
    const started = await client.agentStart({
      ...plan.agentStart,
      paneId: createdPaneId,
    });
    const liveAgentName = started.name || plan.agentStart.liveAgentName;
    const normalized = { ...started, name: liveAgentName };
    hooks.afterAgentStarted?.(normalized);
    await client.paneReportMetadata(normalized.paneId, {
      title: plan.name,
      displayAgent: plan.name,
    }).catch(() => {});
    for (const prompt of plan.initialPrompts) {
      await client.agentPrompt(liveAgentName, prompt);
    }
    return normalized;
  } catch (error) {
    let cleanupConfirmed = false;
    try {
      await client.paneClose(createdPaneId);
      cleanupConfirmed = true;
    } catch {
      // Preserve the durable launch record so recovery can find an agent whose
      // prompt failed after startup and whose pane could not be closed.
    }
    throw new ChildLaunchError("agent", "Failed to start or prompt the child Pi session.", {
      cause: error,
      cleanupConfirmed,
    });
  }
}

export interface TrackedChildIdentity {
  name: string;
  task: string;
  agent?: string;
}

async function launchTrackedChild(
  client: HerdrClient,
  plan: LaunchPlan | ResumeLaunchPlan,
  identity: TrackedChildIdentity,
  durableStateDir: string,
  lockPath: string,
): Promise<RunningSubagent> {
  let record: DurableChildRecord | null = null;
  try {
    const started = await launchNativePiChild(client, plan, {
      afterPaneCreated(paneId) {
        record = {
          version: DURABLE_STATE_VERSION,
          id: plan.id,
          ...identity,
          paneId,
          liveAgentName: plan.agentStart.liveAgentName,
          sessionFile: plan.sessionFile,
          lifecycleMode: lifecycleModeOf(plan),
          resumeLockPath: lockPath,
          createdAt: new Date().toISOString(),
        };
        writeDurableRecord(durableStateDir, record);
      },
      afterAgentStarted(startedAgent) {
        if (!record) throw new Error("Durable launch record was not initialized.");
        record = {
          ...record,
          liveAgentName: startedAgent.name,
          paneId: startedAgent.paneId,
          terminalId: startedAgent.terminalId ?? record.terminalId,
        };
        writeDurableRecord(durableStateDir, record);
      },
    });

    return {
      id: plan.id,
      ...identity,
      paneId: started.paneId,
      terminalId: started.terminalId,
      liveAgentName: started.name,
      startTime: Date.now(),
      sessionFile: plan.sessionFile,
      durableStateDir,
      interactive: plan.interactive,
      autoExit: plan.autoExit,
      resumeLockPath: lockPath,
    };
  } catch (error) {
    // If the launcher confirmed pane cleanup there is nothing left to recover:
    // drop the record and the session lock together. Otherwise both stay so
    // the next recovery pass can find the possibly-live child — a session
    // whose child may still be running must remain claimed.
    const recoverable =
      record !== null &&
      !(error instanceof ChildLaunchError && error.cleanupConfirmed === true);
    if (!recoverable) {
      if (record) removeDurableRecord(durableStateDir, plan.id);
      releaseSessionLock(lockPath);
    }
    throw error;
  }
}

export function describeChildLaunchError(error: unknown): { message: string; code: string } {
  const cause = error instanceof ChildLaunchError ? error.cause : error;
  const message = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return {
    message,
    code: error instanceof ChildLaunchError && error.code ? error.code : message,
  };
}

// ── lifecycle runtime ───────────────────────────────────────────────────────

export interface SubagentRuntimeOptions {
  getClient(): HerdrClient;
  getWatcher(): Watcher;
  getStream(): WatcherDeps["stream"];
  /**
   * The owning generation's abort signal. A runtime lives and dies with one
   * session generation: aborting the signal cancels its watchers, and a
   * replacement generation constructs a fresh runtime rather than sharing
   * this one's state.
   */
  signal: AbortSignal;
  /** Tags this module generation's activity events (see runtime-events.ts). */
  runtimeOwner: string;
}

export type SessionClaimResult =
  | { ok: true; lockPath: string; releaseReservation(): void }
  | { ok: false; code: string; message: string };

export type RuntimeInterruptResult =
  | { ok: true; child: RunningSubagent }
  | { ok: false; reason: "missing" | "ambiguous" | "stale" | "transport"; message: string; child?: RunningSubagent };

function safeGetNewEntries(sessionFile: string, afterLine: number) {
  try {
    return getNewEntries(sessionFile, afterLine);
  } catch {
    return [];
  }
}

function runningFromDurableRecord(
  record: DurableChildRecord,
  durableStateDir: string,
): RunningSubagent {
  return {
    id: record.id,
    name: record.name,
    task: record.task,
    agent: record.agent,
    paneId: record.paneId,
    terminalId: record.terminalId,
    liveAgentName: record.liveAgentName,
    startTime: Date.parse(record.createdAt) || Date.now(),
    sessionFile: record.sessionFile,
    durableStateDir,
    ...lifecycleFlags(record.lifecycleMode),
    resumeLockPath: record.resumeLockPath,
  };
}

export function createSubagentRuntime(options: SubagentRuntimeOptions) {
  const running = new Map<string, RunningSubagent>();
  const reservedSessions = new Set<string>();
  let eventBus: ExtensionAPI["events"] | undefined;
  let reconcilePanes: Promise<Awaited<ReturnType<HerdrClient["paneList"]>>> | null = null;

  /** Pane snapshot shared per reconcile burst across concurrent watchers. */
  function listPanes() {
    if (!reconcilePanes) {
      reconcilePanes = options.getClient().sessionSnapshot().then((snapshot) => snapshot.panes).finally(() => {
        setImmediate(() => {
          reconcilePanes = null;
        });
      });
    }
    return reconcilePanes;
  }

  function publish(child: RunningSubagent, active: boolean): void {
    if (!eventBus) return;
    publishSubagentActivity(eventBus, child.id, options.runtimeOwner, active);
  }

  /**
   * Herdr panes run a shell; `agent start` merely types `pi` into it, so the
   * pane outlives the child Pi. After the watcher settles, wait until Herdr
   * reports the agent released (pane event or identity poll) before closing
   * the shell pane, so Pi can flush ctx.shutdown() without a guessed delay.
   */
  async function closeSettledPane(paneId: string, liveAgentName: string): Promise<void> {
    const client = options.getClient();
    const stream = options.getStream();
    let confirmedReleased = false;

    await new Promise<void>((resolve) => {
      let done = false;
      let cleanup = () => {};
      const finish = (released: boolean) => {
        if (done) return;
        done = true;
        if (released) confirmedReleased = true;
        cleanup();
        resolve();
      };
      const unwatch = stream.watch(paneId, (event) => {
        if (event.event !== "pane_moved") finish(true);
      });
      const checkReleased = async () => {
        try {
          const agent = await client.agentGet(liveAgentName);
          if (!agent || agent.paneId !== paneId) finish(true);
        } catch {
          // Herdr may be momentarily unreachable; the next poll retries.
        }
      };
      const poll = setInterval(() => void checkReleased(), 1_000);
      poll.unref?.();
      const timeout = setTimeout(() => finish(false), 15_000);
      timeout.unref?.();
      cleanup = () => {
        clearInterval(poll);
        clearTimeout(timeout);
        unwatch();
      };
      void checkReleased();
    });

    // The timeout only bounds the wait; never close a pane still owned by the
    // named agent. A later recovery generation can retry safely.
    if (!confirmedReleased) {
      const agent = await client.agentGet(liveAgentName).catch(() => undefined);
      if (agent !== null) return;
    }
    client.paneClose(paneId).catch(() => {});
  }

  function arm(
    pi: ExtensionAPI,
    child: RunningSubagent,
    mapOutcome?: (outcome: SubagentOutcome) => SubagentOutcome,
  ): void {
    eventBus = pi.events;
    const generationSignal = options.signal;
    const watcherAbort = new AbortController();
    child.abortController = watcherAbort;

    const onGenerationAbort = () => watcherAbort.abort();
    generationSignal.addEventListener("abort", onGenerationAbort, { once: true });
    if (generationSignal.aborted) watcherAbort.abort();

    running.set(child.id, child);
    publish(child, true);

    void options
      .getWatcher()(child, {
        client: options.getClient(),
        stream: options.getStream(),
        listPanes,
        signal: watcherAbort.signal,
      })
      .then((outcome) => {
        running.delete(child.id);
        publish(child, false);
        // Cancelled means generation abort/reload: keep the durable record so
        // the next runtime generation can recover the child.
        if (outcome.kind === "cancelled") return;

        void closeSettledPane(child.paneId, child.liveAgentName);

        const contextUsage = consumeContextUsageSidecar(child.sessionFile, child.id);
        const message = buildOutcomeMessage(
          child,
          mapOutcome ? mapOutcome(outcome) : outcome,
          { contextUsage },
        );
        if (!message) return;

        // Preserve the launch acknowledgement before a very fast terminal steer.
        setImmediate(() => {
          if (generationSignal.aborted) {
            appendChildTranscriptMarker(pi, "retained", child, {
              outcome: outcome.kind,
              reason: "generation-replaced-before-delivery",
            });
            return;
          }
          try {
            pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
          } catch {
            appendChildTranscriptMarker(pi, "retained", child, {
              outcome: outcome.kind,
              reason: "delivery-failed",
            });
            // The durable record remains; the next recovery pass redelivers.
            return;
          }
          appendChildTranscriptMarker(pi, "reported", child, { outcome: outcome.kind });

          if (!child.durableStateDir) return;
          try {
            finalizeReportedChild(child.durableStateDir, child.id, child.sessionFile);
            releaseSessionLock(child.resumeLockPath);
          } catch {
            // At-least-once: a leftover record just redelivers on the next pass.
          }
        });
      })
      .catch((error: unknown) => {
        running.delete(child.id);
        publish(child, false);
        try {
          const detail = error instanceof Error ? error.message : String(error);
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: `Sub-agent "${child.name}" error: ${detail}`,
              display: true,
              details: { name: child.name, task: child.task, error: detail },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch {
          // The active durable record remains available to the next runtime.
        }
      })
      .finally(() => {
        generationSignal.removeEventListener("abort", onGenerationAbort);
      });
  }

  /** Probe agent liveness, failing CLOSED: transport errors propagate. */
  async function isAgentActiveStrict(liveAgentName: string): Promise<boolean> {
    return (await options.getClient().agentGet(liveAgentName)) !== null;
  }

  function sessionLockFor(plan: { id: string; agentStart: { liveAgentName: string } }): SessionLock {
    return {
      version: 1,
      id: plan.id,
      liveAgentName: plan.agentStart.liveAgentName,
      createdAt: new Date().toISOString(),
    };
  }

  async function launch(
    pi: ExtensionAPI,
    plan: LaunchPlan | ResumeLaunchPlan,
    identity: TrackedChildIdentity,
    durableStateDir: string,
    opts: {
      /** A session lock already claimed by the caller (resume). */
      lockPath?: string;
      mapOutcome?: (outcome: SubagentOutcome) => SubagentOutcome;
    } = {},
  ): Promise<RunningSubagent> {
    // Initial launches claim the session too, so a live child denies resumes
    // from any Pi process for its whole lifecycle.
    let lockPath = opts.lockPath;
    if (!lockPath) {
      mkdirSync(dirname(plan.sessionFile), { recursive: true });
      const acquired = await acquireSessionLock(
        plan.sessionFile,
        sessionLockFor(plan),
        isAgentActiveStrict,
      ).catch(() => null);
      if (!acquired) {
        throw new ChildLaunchError("materialize", "Failed to claim the child session file.", {
          code: "session locked",
        });
      }
      lockPath = acquired;
    }

    const child = await launchTrackedChild(
      options.getClient(),
      plan,
      identity,
      durableStateDir,
      lockPath,
    );
    appendChildTranscriptMarker(pi, "running", child, {
      paneId: child.paneId,
      terminalId: child.terminalId,
      liveAgentName: child.liveAgentName,
    });
    arm(pi, child, opts.mapOutcome);
    return child;
  }

  /**
   * Deliver a gone child's honest unsignaled-exit steer, then finalize its
   * durable record and lock. Returns false (record untouched) when delivery
   * failed — at-least-once means the record must survive to redeliver.
   */
  function deliverGoneChild(
    pi: ExtensionAPI,
    decision: Extract<RecoveryDecision, { kind: "gone" }>,
    durableStateDir: string,
  ): boolean {
    const child = runningFromDurableRecord(decision.record, durableStateDir);

    // The agent is gone; a leftover shell pane observes nothing — close it.
    if (decision.closePane) {
      options.getClient().paneClose(decision.record.paneId).catch(() => {});
    }

    const outcome: SubagentOutcome = {
      kind: "unsignaled-exit",
      reason: "agent-disappeared",
      summary: findLastAssistantMessage(
        safeGetNewEntries(decision.record.sessionFile, 0),
      ),
      sessionFile: decision.record.sessionFile,
    };

    const message = buildOutcomeMessage(child, outcome);
    if (!message) return true;
    try {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    } catch {
      // The durable record remains; the next recovery pass redelivers.
      return false;
    }
    try {
      finalizeReportedChild(durableStateDir, decision.record.id, decision.record.sessionFile);
      releaseSessionLock(decision.record.resumeLockPath);
    } catch {
      // At-least-once: a leftover record just redelivers on the next pass.
    }
    return true;
  }

  async function recover(pi: ExtensionAPI, durableStateDir: string): Promise<void> {
    eventBus = pi.events;
    const decisions = await recoverDurableChildren(durableStateDir, options.getClient());

    for (const decision of decisions) {
      if (decision.kind === "reattach") {
        arm(pi, runningFromDurableRecord(decision.record, durableStateDir));
        continue;
      }
      deliverGoneChild(pi, decision, durableStateDir);
    }
  }

  /**
   * Establish resume exclusivity: in-process reservation, matching durable
   * records classified (active or undelivered ones refuse; gone ones are
   * honestly reported first), then the cross-process session lock. All
   * liveness probes fail closed. On refusal the reservation is already
   * released; on success the caller must releaseReservation() when the
   * launch attempt ends.
   */
  async function claimSessionForResume(
    pi: ExtensionAPI,
    sessionPath: string,
    durableStateDir: string,
    plan: { id: string; agentStart: { liveAgentName: string } },
  ): Promise<SessionClaimResult> {
    const releaseReservation = reserveSession(sessionPath);
    if (!releaseReservation) {
      return {
        ok: false,
        code: "session active",
        message: `session is already active: ${sessionPath}`,
      };
    }
    const refuse = (code: string, message: string) => {
      releaseReservation();
      return { ok: false as const, code, message };
    };

    try {
      const matching = readDurableRecords(durableStateDir).filter(
        (record) => record.sessionFile === sessionPath,
      );
      for (const record of matching) {
        const decision = await classifyDurableRecord(record, options.getClient());
        if (decision.kind === "reattach") {
          return decision.via === "sidecar"
            ? refuse(
                "undelivered result",
                `session has an undelivered result: ${sessionPath}`,
              )
            : refuse("child active", `session has an active child: ${sessionPath}`);
        }
        if (!deliverGoneChild(pi, decision, durableStateDir)) {
          return refuse(
            "undelivered result",
            `could not deliver the pending result for ${sessionPath}; try again`,
          );
        }
      }

      const lockPath = await acquireSessionLock(
        sessionPath,
        sessionLockFor(plan),
        isAgentActiveStrict,
      );
      if (!lockPath) {
        return refuse(
          "session locked",
          `session is already claimed by another process: ${sessionPath}`,
        );
      }
      return { ok: true, lockPath, releaseReservation };
    } catch (error) {
      return refuse(
        "herdr unreachable",
        `could not verify session exclusivity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function inspect(now = Date.now()): Promise<ActiveChildSnapshot[]> {
    return inspectActiveChildren(
      running.values(),
      (liveAgentName) => options.getClient().agentGet(liveAgentName),
      now,
    );
  }

  function resolveTarget(params: { id?: string; name?: string }): RuntimeInterruptResult {
    const requestedId = params.id?.trim();
    if (requestedId) {
      const child = running.get(requestedId);
      return child
        ? { ok: true, child }
        : { ok: false, reason: "missing", message: `No running subagent with id "${requestedId}".` };
    }

    const requestedName = params.name?.trim();
    if (!requestedName) {
      return { ok: false, reason: "missing", message: "Provide a running subagent id or exact display name." };
    }
    const matches = [...running.values()].filter((child) => child.name === requestedName);
    if (matches.length === 1) return { ok: true, child: matches[0] };
    if (matches.length === 0) {
      return { ok: false, reason: "missing", message: `No running subagent named "${requestedName}".` };
    }
    const candidates = matches.map((child) => `${child.name} [${child.id}]`).join(", ");
    return {
      ok: false,
      reason: "ambiguous",
      message: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
    };
  }

  async function interrupt(params: { id?: string; name?: string }): Promise<RuntimeInterruptResult> {
    const resolved = resolveTarget(params);
    if (!resolved.ok) return resolved;
    const child = resolved.child;
    try {
      const agent = await options.getClient().agentGet(child.liveAgentName);
      if (!agent || !hasMatchingActiveChildIdentity(child, agent)) {
        return {
          ok: false,
          reason: "stale",
          child,
          message: `Subagent "${child.name}" is no longer active in Herdr.`,
        };
      }
      await options.getClient().agentSendKeys(child.liveAgentName, ["esc"]);
      return { ok: true, child };
    } catch (error) {
      return {
        ok: false,
        reason: "transport",
        child,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function reserveSession(sessionFile: string): (() => void) | null {
    if (
      reservedSessions.has(sessionFile) ||
      [...running.values()].some((child) => child.sessionFile === sessionFile)
    ) {
      return null;
    }
    reservedSessions.add(sessionFile);
    return () => reservedSessions.delete(sessionFile);
  }

  function shutdown(): void {
    for (const child of running.values()) {
      child.abortController?.abort();
      publish(child, false);
    }
    running.clear();
  }

  return {
    running,
    launch,
    recover,
    claimSessionForResume,
    inspect,
    resolveTarget,
    interrupt,
    reserveSession,
    shutdown,
  };
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

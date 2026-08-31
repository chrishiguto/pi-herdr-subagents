/**
 * pi-herdr-subagents — interactive subagent orchestration built natively on herdr.
 *
 * Extension entry: activation guard, tool registration, outcome→steer wiring,
 * live status widget above the editor, /subagent + /iterate commands.
 *
 * Activation: inside herdr (HERDR_ENV=1 + pane id + socket path) the real
 * tools register at load; outside herdr, setup-hint stubs register instead so
 * the model gets a clear answer rather than a missing tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { hasMatchingActiveChildIdentity } from "./active-children.ts";
import { getAgentConfigDir, loadAgentDefaults } from "./agents.ts";
import { createHerdrClient, type HerdrClient } from "./herdr/client.ts";
import { probeHerdrReadiness } from "./herdr/compatibility.ts";
import { createHerdrEventStream } from "./herdr/events.ts";
import { readExitSidecar } from "./child-protocol.ts";
import { contextUsagePath } from "./context-usage.ts";
import { readDurableRecords, removeDurableRecord } from "./durable-state.ts";
import { buildLaunchPlan, buildResumeLaunchPlan, resolveResumeLifecycle } from "./launch.ts";
import { launchPolicyPath, readLaunchPolicy } from "./launch-policy.ts";
import { formatElapsed, renderSubagentPing, renderSubagentResult } from "./messages.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import { createSubagentRuntime, describeChildLaunchError } from "./runtime.ts";
import { acquireResumeLock, releaseResumeLock } from "./resume-lock.ts";
import { attachStatusWidget } from "./status-widget-controller.ts";
import {
  InterruptParamsSchema,
  ListParamsSchema,
  ResumeParamsSchema,
  SubagentParamsSchema,
  type InterruptParams,
  type InterruptToolDetails,
  type ListedChildDetails,
  type ListToolDetails,
  type ResumeParams,
  type ResumeToolDetails,
  type SpawnToolDetails,
  type SubagentParams,
} from "./tool-contracts.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type SubagentOutcome,
  type WatcherDeps,
} from "./watcher.ts";

// ── runtime generation ownership ───────────────────────────────────────────
// A Pi process can replace sessions without re-importing extensions. Each
// session therefore gets a fresh generation, while /reload replaces the module
// owner for this exact extension source. Scoping by source identity prevents a
// second installed copy from silently aborting this copy's children.

const sourceUrl = new URL(import.meta.url);
sourceUrl.search = "";
sourceUrl.hash = "";
const OWNER_KEY = Symbol.for(`pi-herdr-subagents/runtime-owner/${sourceUrl.href}`);

/** Tags this module generation's activity events (see src/runtime-events.ts). */
const runtimeOwner = `runtime-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;

interface RuntimeGenerationOwner {
  controller: AbortController;
  stream: WatcherStream | null;
  replace(): void;
  stop(): void;
}

function createRuntimeGenerationOwner(): RuntimeGenerationOwner {
  const owner: RuntimeGenerationOwner = {
    controller: new AbortController(),
    stream: null,
    replace() {
      owner.stop();
      owner.controller = new AbortController();
    },
    stop() {
      owner.controller.abort();
      owner.stream?.close();
      owner.stream = null;
    },
  };
  return owner;
}

const previousOwner = (globalThis as any)[OWNER_KEY] as RuntimeGenerationOwner | undefined;
previousOwner?.stop();
const generationOwner = createRuntimeGenerationOwner();
(globalThis as any)[OWNER_KEY] = generationOwner;

function getModuleAbortSignal(): AbortSignal {
  return generationOwner.controller.signal;
}

// ── injectable runtime deps (unit-test seam) ────────────────────────────────

type WatcherStream = WatcherDeps["stream"] & { close(): void };

interface RuntimeDeps {
  client: HerdrClient;
  watch: typeof watchSubagent;
  createStream: (socketPath: string, signal: AbortSignal) => WatcherStream;
}

function defaultDeps(): RuntimeDeps {
  return {
    client: createHerdrClient(),
    watch: watchSubagent,
    createStream: (socketPath, signal) => createHerdrEventStream({ socketPath, signal }),
  };
}

let deps: RuntimeDeps = defaultDeps();

/**
 * One shared HerdrEventStream per pi process (PLAN.md Key Decision #8),
 * created lazily on first spawn — no persistent socket while zero subagents
 * have ever run. Closed with its owning session generation.
 */
function getEventStream(): WatcherStream {
  if (!generationOwner.stream) {
    generationOwner.stream = deps.createStream(
      process.env.HERDR_SOCKET_PATH ?? "",
      getModuleAbortSignal(),
    );
  }
  return generationOwner.stream;
}

// ── shared module state ─────────────────────────────────────────────────────

const subagentRuntime = createSubagentRuntime({
  getClient: () => deps.client,
  getWatcher: () => deps.watch,
  getStream: getEventStream,
  getModuleSignal: getModuleAbortSignal,
  runtimeOwner,
});

export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

// Status widget lifecycle: attached per session in session_start, detached in
// session_shutdown. Mount/unmount and tick teardown are event- and framework-
// driven (see src/status-widget-controller.ts) — no per-launch hooks needed.
let detachStatusWidget: (() => void) | null = null;

// ── watcher arming + outcome→steer wiring ───────────────────────────────────

async function recoverChildren(
  pi: ExtensionAPI,
  ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } },
): Promise<void> {
  const durableStateDir = getDurableStateDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
  await subagentRuntime.recover(pi, durableStateDir);
}

const SUBAGENT_DESCRIPTION =
  "Spawn a sub-agent in a dedicated herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate, assume, or summarize results after calling this tool. " +
  "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.";

// ── setup-hint stubs (outside herdr) ────────────────────────────────────────

const SETUP_HINT =
  "Subagents require pi to run inside a herdr pane (https://herdr.dev/docs/quick-start/). " +
  "Start herdr in your terminal, open a pane, and run pi there — herdr injects HERDR_ENV, " +
  "HERDR_PANE_ID, and HERDR_SOCKET_PATH into every pane, which this extension needs to " +
  "launch and observe subagents. Install Herdr >=0.8.2 <0.9 (protocol 20) and restart Pi inside it.";

const SPAWN_TOOL_NAMES = ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"];

function registerSetupHintStubs(pi: ExtensionAPI, shouldRegister: (name: string) => boolean): void {
  for (const name of SPAWN_TOOL_NAMES) {
    if (!shouldRegister(name)) continue;
    pi.registerTool({
      name,
      label: "Subagents (setup required)",
      description: SETUP_HINT,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute() {
        return {
          content: [{ type: "text", text: SETUP_HINT }],
          details: { error: "not in herdr" },
        };
      },
    });
  }
}

// ── subagent spawn ──────────────────────────────────────────────────────────

function errorResult(text: string, error: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error },
  };
}

function getDurableStateDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId, "herdr-subagents-state");
}

async function executeSubagentSpawn(
  pi: ExtensionAPI,
  params: SubagentParams,
  ctx: {
    cwd: string;
    sessionManager: {
      getSessionFile(): string | null | undefined;
      getSessionId(): string;
      getSessionDir(): string;
      getLeafId(): string | null;
    };
    modelRegistry: {
      getAvailable(): Array<{ provider: string; id: string }>;
    };
  },
) {
  // Prevent self-spawning (e.g. planner spawning another planner)
  const currentAgent = process.env.PI_SUBAGENT_AGENT;
  if (params.agent && currentAgent && params.agent === currentAgent) {
    return errorResult(
      `You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
        `You were spawned to do this work yourself. Complete the task directly.`,
      "self-spawn blocked",
    );
  }

  const agentDefs = params.agent ? loadAgentDefaults(params.agent, ctx.cwd) : null;
  if (params.agent && !agentDefs) {
    const projectPath = join(ctx.cwd, ".pi", "agents", `${params.agent}.md`);
    const globalPath = join(getAgentConfigDir(), "agents", `${params.agent}.md`);
    return errorResult(
      `Agent "${params.agent}" not found. Searched ${projectPath} and ${globalPath}.`,
      "agent not found",
    );
  }

  const isModelAvailable = (reference: string): boolean => {
    const matches = ctx.modelRegistry.getAvailable().filter(
      (model) =>
        `${model.provider}/${model.id}` === reference ||
        (!reference.includes("/") && model.id === reference),
    );
    return matches.length === 1;
  };

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    return errorResult(
      "Error: no session file. Start pi with a persistent session to use subagents.",
      "no session file",
    );
  }

  let plan;
  try {
    plan = buildLaunchPlan(params, agentDefs, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile,
      parentLeafId: ctx.sessionManager.getLeafId(),
      parentCwd: ctx.cwd,
      env: process.env,
      isModelAvailable,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Invalid subagent launch request: ${message}`, message);
  }

  const durableStateDir = getDurableStateDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
  let running: RunningSubagent;
  try {
    running = await subagentRuntime.launch(
      pi,
      plan,
      { name: params.name, task: params.task, agent: params.agent },
      durableStateDir,
    );
  } catch (error: any) {
    const { message, code } = describeChildLaunchError(error);
    return errorResult(
      `Failed to launch Pi child for "${params.name}": ${message}`,
      code,
    );
  }
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Sub-agent "${params.name}" launched and is now running in the background. ` +
          `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
          `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
          `Until then, move on to other work or tell the user you're waiting.`,
      },
    ],
    details: {
      id: running.id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      paneId: running.paneId,
      sessionFile: running.sessionFile,
      liveAgentName: running.liveAgentName,
      contextMode: plan.seedSession.mode,
      workflow: params.workflow,
      status: "started",
    },
  };
}

function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: SUBAGENT_DESCRIPTION,
    promptSnippet: "Launch a background Pi child; its result is delivered automatically.",
    parameters: SubagentParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentSpawn(pi, params, ctx as any);
    },

    renderCall(args, theme) {
      const partialArgs = args as Record<string, unknown>;
      const name =
        typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
      const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
      const agent =
        typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
      const cwdHint =
        typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
      let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

      // Show a one-line task preview. renderCall is called repeatedly as the
      // LLM generates tool arguments, so args.task grows token by token.
      if (task) {
        const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) {
          text += "\n" + theme.fg("toolOutput", preview);
        }
        const totalLines = task.split("\n").length;
        if (totalLines > 1) {
          text += theme.fg("muted", ` (${totalLines} lines)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as Partial<SpawnToolDetails>;
      const name = details.name ?? "(unnamed)";

      if (details.status === "started") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — started"),
          0,
          0,
        );
      }

      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagent_resume ─────────────────────────────────────────────────────────

function safeGetNewEntries(sessionFile: string, afterLine: number) {
  try {
    return getNewEntries(sessionFile, afterLine);
  } catch {
    return [];
  }
}

/**
 * Re-scope a resumed subagent's outcome summary to entries added AFTER the
 * resume launch (ported reference behavior): the pre-existing conversation
 * must not masquerade as new output. Launch failures and pings pass through
 * untouched — their payloads are already truthful.
 */
function resolveResumeOutcome(
  outcome: SubagentOutcome,
  sessionPath: string,
  entryCountBefore: number,
): SubagentOutcome {
  const newSummary = () =>
    findLastAssistantMessage(safeGetNewEntries(sessionPath, entryCountBefore));

  switch (outcome.kind) {
    case "completed":
      return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
    case "unsignaled-exit":
      return { ...outcome, summary: newSummary() };
    default:
      return outcome;
  }
}

const RESUME_DESCRIPTION =
  "Resume a previous sub-agent session in a new herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
  "Use when a sub-agent was cancelled or needs follow-up work.";

async function executeSubagentResume(
  pi: ExtensionAPI,
  params: ResumeParams,
  ctx: {
    cwd: string;
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
  },
) {
  params = { ...params, sessionPath: resolve(ctx.cwd, params.sessionPath) };
  if (!existsSync(params.sessionPath)) {
    return errorResult(
      `Error: session file not found: ${params.sessionPath}`,
      "session not found",
    );
  }

  const releaseReservation = subagentRuntime.reserveSession(params.sessionPath);
  if (!releaseReservation) {
    return errorResult(
      `Error: session is already active: ${params.sessionPath}`,
      "session active",
    );
  }

  // Record entry count before resuming so we can extract only new messages.
  const entryCountBefore = safeGetNewEntries(params.sessionPath, 0).length;
  const durableStateDir = getDurableStateDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
  for (const record of readDurableRecords(durableStateDir).filter(
    (candidate) => candidate.sessionFile === params.sessionPath,
  )) {
    const hasPendingSignal = readExitSidecar(record.sessionFile, record.id) !== null;
    const activeAgent = await deps.client.agentGet(record.liveAgentName).catch(() => null);
    if (
      hasPendingSignal ||
      (activeAgent !== null && hasMatchingActiveChildIdentity(record, activeAgent))
    ) {
      releaseReservation();
      return errorResult(
        `Error: session has an active child or an undelivered result: ${params.sessionPath}`,
        "session active",
      );
    }
    removeDurableRecord(durableStateDir, record.id);
  }

  // Reapply the persisted launch policy; a corrupt policy file must refuse
  // the resume rather than relaunch the child with degraded restrictions.
  const policyRead = readLaunchPolicy(params.sessionPath);
  if (policyRead.kind === "corrupt") {
    releaseReservation();
    return errorResult(
      `Error: the persisted launch policy for this session is unreadable or invalid; ` +
        `refusing to resume without its restrictions. Repair or delete ` +
        `${launchPolicyPath(params.sessionPath)} to proceed.`,
      "corrupt launch policy",
    );
  }

  let plan;
  try {
    plan = buildResumeLaunchPlan(params, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentCwd: ctx.cwd,
      env: process.env,
      resumePolicy: policyRead.kind === "ok" ? policyRead.policy : null,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    releaseReservation();
    return errorResult(`Failed to plan resume launch: ${message}`, message);
  }

  const lockPath = await acquireResumeLock(
    params.sessionPath,
    {
      version: 1,
      id: plan.id,
      liveAgentName: plan.agentStart.liveAgentName,
      createdAt: new Date().toISOString(),
    },
    async (liveAgentName) => (await deps.client.agentGet(liveAgentName).catch(() => null)) !== null,
  );
  if (!lockPath) {
    releaseReservation();
    return errorResult(
      `Error: session is already being resumed: ${params.sessionPath}`,
      "session active",
    );
  }
  plan.resumeLockPath = lockPath;

  // Stale-sidecar cleanup happens only after both in-process and cross-process
  // exclusivity have been established.
  rmSync(`${params.sessionPath}.exit`, { force: true });
  rmSync(contextUsagePath(params.sessionPath), { force: true });

  let running: RunningSubagent;
  try {
    running = await subagentRuntime.launch(
      pi,
      plan,
      { name: plan.name, task: params.message ?? "resumed session" },
      durableStateDir,
      (outcome) => resolveResumeOutcome(outcome, params.sessionPath, entryCountBefore),
    );
  } catch (error: any) {
    releaseResumeLock(lockPath);
    const { message, code } = describeChildLaunchError(error);
    return errorResult(
      `Failed to launch Pi child for "${plan.name}": ${message}`,
      code,
    );
  } finally {
    releaseReservation();
  }
  return {
    content: [{ type: "text" as const, text: `Session "${plan.name}" resumed.` }],
    details: {
      id: running.id,
      name: plan.name,
      paneId: running.paneId,
      sessionPath: params.sessionPath,
      liveAgentName: running.liveAgentName,
      status: "started",
    },
  };
}

function registerResumeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description: RESUME_DESCRIPTION,
    promptSnippet: "Resume a child session; its result is delivered automatically.",
    parameters: ResumeParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentResume(pi, params, ctx as any);
    },

    renderCall(args, theme) {
      const name = (args as any).name ?? "Resume";
      return new Text(
        "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as Partial<ResumeToolDetails>;
      const name = details.name ?? "Resume";

      if (details.status === "started") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — resumed"),
          0,
          0,
        );
      }

      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagent_interrupt ──────────────────────────────────────────────────────

async function handleSubagentInterrupt(params: InterruptParams): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: InterruptToolDetails;
}> {
  const resolved = await subagentRuntime.interrupt(params);
  if (!resolved.ok) {
    if (resolved.reason === "missing" || resolved.reason === "ambiguous" || resolved.reason === "stale") {
      return errorResult(resolved.message, resolved.message);
    }
    const running = resolved.child;
    const message = running
      ? `Failed to send Escape to subagent "${running.name}" via herdr: ${resolved.message}`
      : `Failed to interrupt subagent via herdr: ${resolved.message}`;
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: resolved.message, id: running?.id, name: running?.name },
    };
  }

  const running = resolved.child;
  return {
    content: [
      { type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
    ],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

const INTERRUPT_DESCRIPTION =
  "Send Escape to the active turn of a currently running subagent. " +
  "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
  "and does not emit a subagent_result solely because of this request.";

function registerInterruptTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description: INTERRUPT_DESCRIPTION,
    promptSnippet: "Interrupt the active turn of a named running child.",
    parameters: InterruptParamsSchema,

    async execute(_toolCallId, params) {
      return handleSubagentInterrupt(params);
    },

    renderCall(args, theme) {
      const target = (args as any).id ? `${(args as any).id}` : ((args as any).name ?? "(unknown)");
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(target)) +
          theme.fg("dim", " — interrupt turn"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as InterruptToolDetails;
      if (details.status === "interrupt_requested") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
            theme.fg("dim", " — interrupt requested"),
          0,
          0,
        );
      }

      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagents_list ──────────────────────────────────────────────────────────

const LIST_DESCRIPTION =
  "List currently active subagents after reconciling them with Herdr. " +
  "Reports each child's identifier, name, current state, elapsed time, and session reference.";

function registerListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description: LIST_DESCRIPTION,
    promptSnippet: "List active child sessions and their current Herdr state.",
    parameters: ListParamsSchema,

    async execute() {
      const active = await subagentRuntime.inspect();

      if (active.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No active subagents." }],
          details: { children: [] },
        };
      }

      const lines = active.map(
        (child) =>
          `• ${child.id} — ${child.name} — ${child.state} — ${formatElapsed(child.elapsedSeconds)}` +
          `\n  Session: ${child.sessionFile}`,
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { children: active },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as Partial<ListToolDetails>;
      const children = details.children ?? [];
      if (children.length === 0) {
        return new Text(theme.fg("dim", "No active subagents."), 0, 0);
      }
      const lines = children.map(
        (child: ListedChildDetails) =>
          `  ${theme.fg("toolTitle", theme.bold(child.name))}` +
          theme.fg(
            "dim",
            ` [${child.id}] — ${child.state} — ${formatElapsed(child.elapsedSeconds)} — ${child.sessionFile}`,
          ),
      );
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

// ── commands ────────────────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
  // /iterate — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, ctx) => {
      const task =
        args.trim() ||
        "Continue the current task with the user in this interactive child pane; call subagent_done when the iteration is complete.";
      const result = await executeSubagentSpawn(
        pi,
        { name: "Iterate", task, contextMode: "fork", interactive: true },
        ctx,
      );
      const error = (result.details as { error?: string }).error;
      ctx.ui.notify(error ? result.content[0].text : 'Sub-agent "Iterate" launched.', error ? "error" : "info");
    },
  });

  // /subagent — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName, ctx.cwd);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const result = await executeSubagentSpawn(
        pi,
        { agent: agentName, name: displayName, task: taskText },
        ctx,
      );
      const error = (result.details as { error?: string }).error;
      ctx.ui.notify(error ? result.content[0].text : `Sub-agent "${displayName}" launched.`, error ? "error" : "info");
    },
  });
}

// ── extension entry ─────────────────────────────────────────────────────────

export function registerOrchestrator(pi: ExtensionAPI): void {
  const inHerdr = isInsideHerdr();

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const shouldRegister = (name: string) => !deniedTools.has(name);

  if (inHerdr) {
    if (shouldRegister("subagent")) registerSubagentTool(pi);
    if (shouldRegister("subagent_resume")) registerResumeTool(pi);
    if (shouldRegister("subagent_interrupt")) registerInterruptTool(pi);
    if (shouldRegister("subagents_list")) registerListTool(pi);
    if (shouldRegister("subagent")) registerCommands(pi);
  } else {
    registerSetupHintStubs(pi, shouldRegister);
  }

  pi.on("session_start", (_event, ctx) => {
    if (!inHerdr) return;

    generationOwner.replace();
    detachStatusWidget?.();
    detachStatusWidget = attachStatusWidget(pi.events, ctx, subagentRuntime);

    // Socket reachability check (async; visible notify on failure).
    void probeHerdrReadiness(() => deps.client.ping()).then((readiness) => {
      if (!readiness.ready) {
        ctx.ui.notify(`herdr-subagents: ${readiness.error}`, "warning");
        return;
      }
      void recoverChildren(pi, ctx).catch((error) => {
        ctx.ui.notify(
          `herdr-subagents: failed to recover active children: ${error?.message ?? String(error)}`,
          "warning",
        );
      });
    });
  });

  pi.on("session_shutdown", () => {
    detachStatusWidget?.();
    detachStatusWidget = null;
    subagentRuntime.shutdown();
    generationOwner.stop();
  });

  // Steer message renderers (registered regardless of activation so past
  // session entries still render outside herdr).
  pi.registerMessageRenderer("subagent_result", (message, options, theme) =>
    renderSubagentResult(message as any, options, theme as any),
  );
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) =>
    renderSubagentPing(message as any, options, theme as any),
  );
}

// ── test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
  isInsideHerdr,
  runningSubagents: subagentRuntime.running,
  resolveTarget: subagentRuntime.resolveTarget,
  resolveResumeLifecycle,
  resolveResumeOutcome,
  recoverChildren,
  getDurableStateDir,
  setDeps(overrides: Partial<RuntimeDeps>): void {
    deps = { ...deps, ...overrides };
  },
  reset(): void {
    deps = defaultDeps();
    subagentRuntime.shutdown();
    generationOwner.replace();
  },
};

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
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getAgentConfigDir, loadAgentDefaults } from "../../src/agents.ts";
import { createHerdrClient, type HerdrClient } from "../../src/herdr/client.ts";
import { registerHerdrAgentState } from "../../src/herdr/agent-state.ts";
import { probeHerdrReadiness } from "../../src/herdr/compatibility.ts";
import { createHerdrEventStream } from "../../src/herdr/events.ts";
import { contextUsagePath } from "../../src/context-usage.ts";
import {
  buildLaunchPlan,
  buildResumeLaunchPlan,
  resolveResumeLaunchBehavior,
} from "../../src/launch.ts";
import { formatElapsed, renderSubagentPing, renderSubagentResult } from "../../src/messages.ts";
import { findLastAssistantMessage, getNewEntries } from "../../src/session.ts";
import { createSubagentRuntime, describeChildLaunchError } from "../../src/runtime.ts";
import { attachStatusWidget } from "../../src/status-widget-controller.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type SubagentOutcome,
  type WatcherDeps,
} from "../../src/watcher.ts";

// ── /reload safety ──────────────────────────────────────────────────────────
// /reload re-imports this file, giving fresh module-level state, but closures
// from the old module keep running. Abort the previous module's controllers and
// close its event stream on re-import (pattern from the reference, issue #5).

const ABORT_KEY = Symbol.for("pi-herdr-subagents/abort-controller");
const STREAM_KEY = Symbol.for("pi-herdr-subagents/event-stream");

/** Tags this module generation's activity events (see src/runtime-events.ts). */
const runtimeOwner = `runtime-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;

{
  const prevAbort = (globalThis as any)[ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[ABORT_KEY] = new AbortController();

  const prevStream = (globalThis as any)[STREAM_KEY] as { close(): void } | undefined;
  if (prevStream) prevStream.close();
  (globalThis as any)[STREAM_KEY] = null;
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[ABORT_KEY] as AbortController).signal;
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
 * have ever run. Closed via the module AbortController on /reload + shutdown.
 */
function getEventStream(): WatcherStream {
  let stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
  if (!stream) {
    stream = deps.createStream(process.env.HERDR_SOCKET_PATH ?? "", getModuleAbortSignal());
    (globalThis as any)[STREAM_KEY] = stream;
  }
  return stream;
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

// ── tool parameter schema (ported, minus Claude-only resumeSessionId) ───────

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  thinking: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
  ),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Child tool allowlist; completion and help tools are always retained.",
    }),
  ),
  allowNestedDelegation: Type.Optional(
    Type.Boolean({ description: "Whether the child may use subagent delegation lifecycle tools." }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  contextMode: Type.Optional(
    StringEnum(["standalone", "lineage-only", "fork"] as const, {
      description:
        "Child conversation context: standalone is blank, lineage-only links a blank child (default), and fork snapshots the active parent branch.",
    }),
  ),
  workflow: Type.Optional(
    Type.Union([
      Type.Object({ kind: Type.Literal("skill"), name: Type.String() }),
      Type.Object({ kind: Type.Literal("prompt"), name: Type.String() }),
    ], {
      description: "Portable Pi skill or prompt template to expand in the child before its first model request.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
    }),
  ),
});

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
  params: Static<typeof SubagentParams>,
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

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (params.agent && !agentDefs) {
    const projectPath = join(process.cwd(), ".pi", "agents", `${params.agent}.md`);
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
    parameters: SubagentParams,

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
      const details = result.details as any;
      const name = details?.name ?? "(unnamed)";

      if (details?.status === "started") {
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
  params: { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
  ctx: {
    cwd: string;
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
  },
) {
  if (!existsSync(params.sessionPath)) {
    return errorResult(
      `Error: session file not found: ${params.sessionPath}`,
      "session not found",
    );
  }

  // Record entry count before resuming so we can extract only new messages.
  const entryCountBefore = safeGetNewEntries(params.sessionPath, 0).length;

  let plan;
  try {
    plan = buildResumeLaunchPlan(params, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentCwd: ctx.cwd,
      env: process.env,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to plan resume launch: ${message}`, message);
  }


  // Stale-sidecar belt & braces: completion signals from the previous run
  // would resolve the new watcher instantly.
  rmSync(`${params.sessionPath}.exit`, { force: true });
  rmSync(contextUsagePath(params.sessionPath), { force: true });

  const durableStateDir = getDurableStateDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
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
    const { message, code } = describeChildLaunchError(error);
    return errorResult(
      `Failed to launch Pi child for "${plan.name}": ${message}`,
      code,
    );
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
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
      name: Type.Optional(
        Type.String({ description: "Display name for the herdr pane. Default: 'Resume'" }),
      ),
      message: Type.Optional(
        Type.String({
          description: "Optional message to send after resuming (e.g. follow-up instructions)",
        }),
      ),
      autoExit: Type.Optional(
        Type.Boolean({
          description:
            "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
        }),
      ),
    }),

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
      const details = result.details as any;
      const name = details?.name ?? "Resume";

      if (details?.status === "started") {
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

interface InterruptToolDetails {
  error?: string;
  id?: string;
  name?: string;
  status?: "interrupt_requested";
}

async function handleSubagentInterrupt(params: { id?: string; name?: string }): Promise<{
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
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
      name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
    }),

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
      const details = result.details as any;
      if (details?.status === "interrupt_requested") {
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
    parameters: Type.Object({}),

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
      const details = result.details as any;
      const children = details?.children ?? [];
      if (children.length === 0) {
        return new Text(theme.fg("dim", "No active subagents."), 0, 0);
      }
      const lines = children.map(
        (child: any) =>
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

      const defs = loadAgentDefaults(agentName);
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

export default function herdrSubagents(pi: ExtensionAPI) {
  const inHerdr = isInsideHerdr();

  // Herdr's official `herdr-agent-state.ts` integration is ported into this
  // package and composed here. It remains an internal module, so Pi lists only
  // herdr-subagents as the loaded extension.
  registerHerdrAgentState(pi);

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
    registerCommands(pi);
  } else {
    registerSetupHintStubs(pi, shouldRegister);
  }

  pi.on("session_start", (_event, ctx) => {
    if (!inHerdr) return;

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
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
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
  resolveResumeLaunchBehavior,
  resolveResumeOutcome,
  recoverChildren,
  getDurableStateDir,
  setDeps(overrides: Partial<RuntimeDeps>): void {
    deps = { ...deps, ...overrides };
  },
  reset(): void {
    deps = defaultDeps();
    subagentRuntime.shutdown();
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
    (globalThis as any)[ABORT_KEY] = new AbortController();
  },
};

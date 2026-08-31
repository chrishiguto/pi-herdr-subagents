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
import { Type } from "typebox";
import { join } from "node:path";

import { getAgentConfigDir, loadAgentDefaults } from "./agents.ts";
import { parseDeniedTools } from "./child-protocol.ts";
import { createHerdrClient, type HerdrClient } from "./herdr/client.ts";
import { probeHerdrReadiness } from "./herdr/compatibility.ts";
import { createHerdrEventStream } from "./herdr/events.ts";
import { getDurableStateDir } from "./durable-state.ts";
import { buildLaunchPlan, resolveResumeLifecycle } from "./launch.ts";
import { formatElapsed, renderSubagentPing, renderSubagentResult } from "./messages.ts";
import { registerResumeTool, resolveResumeOutcome } from "./resume.ts";
import {
  createSubagentRuntime,
  describeChildLaunchError,
  type SubagentRuntime,
} from "./runtime.ts";
import { attachStatusWidget } from "./status-widget-controller.ts";
import {
  errorResult,
  InterruptParamsSchema,
  ListParamsSchema,
  SubagentParamsSchema,
  type InterruptParams,
  type InterruptToolDetails,
  type ListToolDetails,
  type SpawnToolDetails,
  type SubagentParams,
} from "./tool-contracts.ts";
import {
  renderAckResult,
  renderListResult,
  renderSpawnCall,
  renderToolTitle,
} from "./tool-renderers.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type WatcherDeps,
} from "./watcher.ts";

// ── runtime generation ownership ───────────────────────────────────────────
// A Pi process can replace sessions without re-importing extensions. Each
// session gets a fresh generation that OWNS its runtime instance — running
// map, reservations, event stream, abort signal — so no state ever needs to
// guard against another generation. /reload replaces the module owner for
// this exact extension source; scoping by source identity prevents a second
// installed copy from silently aborting this copy's children.

const sourceUrl = new URL(import.meta.url);
sourceUrl.search = "";
sourceUrl.hash = "";
const OWNER_KEY = Symbol.for(`pi-herdr-subagents/runtime-owner/${sourceUrl.href}`);

/** Tags this module generation's activity events (see src/runtime-events.ts). */
const runtimeOwner = `runtime-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;

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

interface RuntimeGeneration {
  controller: AbortController;
  stream: WatcherStream | null;
  runtime: SubagentRuntime;
}

function createGeneration(): RuntimeGeneration {
  const controller = new AbortController();
  const generation = { controller, stream: null } as RuntimeGeneration;
  generation.runtime = createSubagentRuntime({
    getClient: () => deps.client,
    getWatcher: () => deps.watch,
    // One shared HerdrEventStream per generation (PLAN.md Key Decision #8),
    // created lazily on first spawn — no persistent socket while zero
    // subagents have ever run. Closed with its owning generation.
    getStream: () => {
      if (!generation.stream) {
        generation.stream = deps.createStream(
          process.env.HERDR_SOCKET_PATH ?? "",
          controller.signal,
        );
      }
      return generation.stream;
    },
    signal: controller.signal,
    runtimeOwner,
  });
  return generation;
}

interface RuntimeGenerationOwner {
  current: RuntimeGeneration;
  replace(): void;
  stop(): void;
}

function createRuntimeGenerationOwner(): RuntimeGenerationOwner {
  const owner: RuntimeGenerationOwner = {
    current: createGeneration(),
    replace() {
      owner.stop();
      owner.current = createGeneration();
    },
    stop() {
      owner.current.runtime.shutdown();
      owner.current.controller.abort();
      owner.current.stream?.close();
      owner.current.stream = null;
    },
  };
  return owner;
}

const previousOwner = (globalThis as any)[OWNER_KEY] as RuntimeGenerationOwner | undefined;
previousOwner?.stop();
const generationOwner = createRuntimeGenerationOwner();
(globalThis as any)[OWNER_KEY] = generationOwner;

/** The live generation's runtime. Tool closures must resolve this per call. */
function runtime(): SubagentRuntime {
  return generationOwner.current.runtime;
}

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
  await runtime().recover(pi, durableStateDir);
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
    running = await runtime().launch(
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
      return renderSpawnCall(args, theme);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as Partial<SpawnToolDetails>;
      return renderAckResult(result, theme, {
        acknowledged: details.status === "started",
        name: details.name ?? "(unnamed)",
        suffix: "started",
      });
    },
  });
}

// ── subagent_interrupt ──────────────────────────────────────────────────────

async function handleSubagentInterrupt(params: InterruptParams): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: InterruptToolDetails;
}> {
  const resolved = await runtime().interrupt(params);
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
      const params = args as InterruptParams;
      return renderToolTitle(theme, params.id ?? params.name ?? "(unknown)", "interrupt turn");
    },

    renderResult(result, _opts, theme) {
      const details = result.details as InterruptToolDetails;
      return renderAckResult(result, theme, {
        acknowledged: details.status === "interrupt_requested",
        name: details.name ?? details.id ?? "subagent",
        suffix: "interrupt requested",
      });
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
      const active = await runtime().inspect();

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
      return renderListResult(details.children ?? [], theme);
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
  const deniedTools = new Set(parseDeniedTools(process.env.PI_DENY_TOOLS));
  const shouldRegister = (name: string) => !deniedTools.has(name);

  if (inHerdr) {
    if (shouldRegister("subagent")) registerSubagentTool(pi);
    if (shouldRegister("subagent_resume")) registerResumeTool(pi, { runtime });
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
    detachStatusWidget = attachStatusWidget(pi.events, ctx, runtime());

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
  get runningSubagents() {
    return runtime().running;
  },
  resolveTarget: (params: { id?: string; name?: string }) => runtime().resolveTarget(params),
  resolveResumeLifecycle,
  resolveResumeOutcome,
  recoverChildren,
  getDurableStateDir,
  setDeps(overrides: Partial<RuntimeDeps>): void {
    deps = { ...deps, ...overrides };
  },
  reset(): void {
    deps = defaultDeps();
    generationOwner.replace();
  },
};

// LaunchPlan builder — agent defs + tool params → artifacts + native Herdr Pi launch.
//
// Pure planning module: no herdr calls, no subprocesses. extensions/herdr-subagents/index.ts executes the
// plan (write plan.files, seed plan.seedSession, client.agentStart(plan.agentStart)).
// Planning is side-effect free. Herdr owns canonical Pi executable resolution;
// the executor materializes files/session directories only after compatibility
// has been checked, then splits a shell pane and starts Pi with `agent start`.
//
// buildSubagentToolAllowlist / buildPiPromptArgs and artifact
// conventions ported from pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/{index.ts,cmux.ts} @ fix/launch-verify-retry.
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentDefaults,
  getAgentConfigDir,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
} from "./agents.ts";
import { makeLiveAgentName } from "./herdr/client.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChildThinkingLevel = (typeof THINKING_LEVELS)[number];

export type WorkflowRef =
  | { kind: "skill"; name: string }
  | { kind: "prompt"; name: string };

/**
 * Compile a portable workflow reference into the child's first prompt. The
 * command is not pre-validated against the child's catalog: a missing skill or
 * prompt fails visibly inside the child, and the failure comes back as an
 * honest steer with the session path.
 */
export function compileWorkflowPrompt(workflow: WorkflowRef, task: string): string {
  const commandName = workflow.kind === "skill" ? `skill:${workflow.name}` : workflow.name;
  return `/${commandName} ${task}`;
}

/** `subagent` tool params consulted by launch planning. */
export interface SubagentLaunchParams {
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  contextMode?: "standalone" | "lineage-only" | "fork";
  /** Portable Pi skill/prompt reference, expanded inside the child before its first model request. */
  workflow?: WorkflowRef;
  model?: string;
  thinking?: ChildThinkingLevel;
  tools?: string[] | string;
  allowNestedDelegation?: boolean;
  skills?: string;
  systemPrompt?: string;
  interactive?: boolean;
}

export interface LaunchPlanContext {
  /** Orchestrator session directory (ctx.sessionManager.getSessionDir()). */
  sessionDir: string;
  /** Orchestrator session id (artifact dir key). */
  sessionId: string;
  /** Orchestrator session file (fork/lineage seeding source). */
  parentSessionFile: string;
  /** Active orchestrator branch leaf captured at launch time. */
  parentLeafId?: string | null;
  /** Orchestrator process cwd (ctx.cwd). */
  parentCwd: string;
  /** Environment snapshot — normally process.env. Injectable test seam. */
  env: Record<string, string | undefined>;
  /** Validate against Pi's live model registry before any pane is created. */
  isModelAvailable?: (model: string) => boolean;
  /** Deterministic seams for tests. */
  now?: Date;
  id?: string;
  /** Override the child extension path (default: <package root>/subagent-done.ts). */
  subagentDonePath?: string;
}

export interface LaunchPlan {
  id: string;
  name: string;
  task: string;
  agent?: string;
  /** Effective working directory for the child (param > agent def > orchestrator cwd). */
  effectiveCwd: string;
  /** Deterministic child session file path. */
  sessionFile: string;
  taskArtifactFile: string | null;
  syspromptFile: string | null;
  /** Files the executor must write (mkdir -p dirname first). */
  files: Array<{ path: string; content: string }>;
  /** Session snapshot the executor must materialize before launch. */
  seedSession: {
    mode: "standalone" | "lineage-only" | "fork";
    parentSessionFile: string;
    parentLeafId?: string | null;
    childSessionFile: string;
    childCwd: string;
  };
  /**
   * Placement request for the child pane. The launcher owns the topology
   * decision (split direction or background tab) from the live Herdr layout;
   * planning only fixes the source pane, cwd, and environment.
   */
  paneSplit: {
    sourcePaneId: string;
    cwd: string;
    env: Record<string, string>;
  };
  /** Arguments for HerdrClient.agentStart(), before the created pane id is known. */
  agentStart: {
    liveAgentName: string;
    argv: string[];
  };
  /** First user inputs submitted after Herdr reports the child Pi ready. */
  initialPrompts: string[];
  interactive: boolean;
  autoExit: boolean;
}

/** Absolute path to the package root (src/ → package). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── runtime policy (validated params ?? agentDefs ?? defaults) ──────────────

export interface ResolvedRuntimePolicy {
  cwd: string;
  model?: string;
  thinking?: ChildThinkingLevel;
  tools?: string[];
  allowNestedDelegation: boolean;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;

/**
 * Effective child working directory: request > agent definition > parent cwd.
 * A relative request cwd resolves against the orchestrator's cwd; a relative
 * agent-definition cwd resolves against the user's agent config directory.
 */
function resolveChildCwd(
  request: Pick<SubagentLaunchParams, "cwd">,
  agentDefs: AgentDefaults | null,
  parentCwd: string,
): string {
  const rawCwd = request.cwd ?? agentDefs?.cwd;
  if (!rawCwd) return parentCwd;
  if (rawCwd.startsWith("/")) return rawCwd;
  return join(request.cwd ? parentCwd : getAgentConfigDir(), rawCwd);
}

function normalizeTools(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : value.split(",");
  const tools = values.map((tool) => tool.trim()).filter(Boolean);
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool)) {
      throw new Error(`Invalid tool name "${tool}" in child tool allowlist.`);
    }
  }
  return [...new Set(tools)];
}

export function resolveRuntimePolicy(
  request: Pick<
    SubagentLaunchParams,
    "cwd" | "model" | "thinking" | "tools" | "allowNestedDelegation"
  >,
  agentDefs: AgentDefaults | null,
  ctx: { parentCwd: string; isModelAvailable?: (model: string) => boolean },
): ResolvedRuntimePolicy {
  const cwd = resolveChildCwd(request, agentDefs, ctx.parentCwd);

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${cwd}`);
  }

  const rawModel = request.model ?? agentDefs?.model;
  const model = rawModel?.trim();
  if (rawModel !== undefined && !model) {
    throw new Error("Model override must not be empty.");
  }
  if (model && ctx.isModelAvailable && !ctx.isModelAvailable(model)) {
    throw new Error(`Model "${model}" is not available in the current Pi model registry.`);
  }

  const rawThinking = request.thinking ?? agentDefs?.thinking;
  if (
    rawThinking !== undefined &&
    !(THINKING_LEVELS as readonly string[]).includes(rawThinking)
  ) {
    throw new Error(
      `Invalid thinking level "${rawThinking}". Expected one of: ${THINKING_LEVELS.join(", ")}.`,
    );
  }

  const tools = normalizeTools(request.tools ?? agentDefs?.tools);
  if (
    request.allowNestedDelegation !== undefined &&
    typeof request.allowNestedDelegation !== "boolean"
  ) {
    throw new Error("allowNestedDelegation must be a boolean.");
  }

  return {
    cwd,
    model,
    thinking: rawThinking as ChildThinkingLevel | undefined,
    tools,
    allowNestedDelegation: request.allowNestedDelegation ?? agentDefs?.spawning ?? true,
  };
}

function requireSourcePaneId(env: Record<string, string | undefined>): string {
  const paneId = env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error(
      "HERDR_PANE_ID is not set — subagent launches require Pi to run inside a Herdr pane.",
    );
  }
  return paneId;
}

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
export function buildSubagentToolAllowlist(effectiveTools?: string[]): string | null {
  if (effectiveTools === undefined) return null;
  const allow = new Set(effectiveTools);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }
  return [...allow].join(",");
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/** Artifact dir convention shared with pi-interactive-subagents: <sessionDir>/artifacts/<session-id>/ */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/** Ported safe-name normalization for artifact file names. */
function safeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

function defaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

export function buildLaunchPlan(
  params: SubagentLaunchParams,
  agentDefs: AgentDefaults | null,
  ctx: LaunchPlanContext,
): LaunchPlan {
  if (agentDefs?.cli && agentDefs.cli !== "pi") {
    throw new Error(
      `Agent "${params.agent ?? params.name}" uses cli: ${agentDefs.cli}, which is ` +
        "not supported by herdr-subagents (pi children only).",
    );
  }

  const runtimePolicy = resolveRuntimePolicy(params, agentDefs, {
    parentCwd: ctx.parentCwd,
    isModelAvailable: ctx.isModelAvailable,
  });

  const env = ctx.env;
  const now = ctx.now ?? new Date();
  const id = ctx.id ?? Math.random().toString(16).slice(2, 10);

  const effectiveModel = runtimePolicy.model;
  const effectiveTools = runtimePolicy.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = runtimePolicy.thinking;
  const interactive = resolveEffectiveInteractive(params, agentDefs);
  const autoExit = interactive ? false : agentDefs ? (agentDefs.autoExit ?? false) : true;

  const artifactDir = getArtifactDir(ctx.sessionDir, ctx.sessionId);
  const targetCwd = runtimePolicy.cwd;
  const childSessionDir = defaultSessionDirFor(targetCwd, getAgentConfigDir());

  // Deterministic child session file path — each launch knows exactly which
  // file is its child's, eliminating races between concurrent spawns.
  const sessionTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const sessionFile = join(childSessionDir, `${sessionTimestamp}_${uuid}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  const seedSession = {
    mode: launchBehavior.seededSessionMode,
    parentSessionFile: ctx.parentSessionFile,
    parentLeafId: ctx.parentLeafId,
    childSessionFile: sessionFile,
    childCwd: targetCwd,
  };

  // ── Task message (wrapper instructions only for blank-session modes) ──
  const modeHint = autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = Boolean(systemPromptMode && identity);
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = launchBehavior.inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const files: Array<{ path: string; content: string }> = [];
  const artifactTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = safeName(params.name);

  // Herdr supplies the canonical Pi executable; this plan contains only Pi's
  // native arguments.
  const piArgv: string[] = ["--session", sessionFile];

  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "subagent-done.ts");
  piArgv.push("-e", subagentDonePath);

  if (effectiveModel) {
    piArgv.push("--model", effectiveModel);
  }
  if (effectiveThinking) {
    piArgv.push("--thinking", effectiveThinking);
  }

  // System prompt via file — pi's --system-prompt/--append-system-prompt
  // auto-detect file paths, avoiding shell escaping issues with multiline content.
  let syspromptFile: string | null = null;
  if (identityInSystemPrompt && identity) {
    syspromptFile = join(artifactDir, "context", `${name}-sysprompt-${artifactTimestamp}.md`);
    files.push({ path: syspromptFile, content: identity });
    piArgv.push(
      systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      syspromptFile,
    );
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    piArgv.push("--tools", toolAllowlist);
  }

  // Workflow prompts must begin with `/` inside the child so Pi expands them
  // before the first model request. Plain tasks retain artifact-backed handoff
  // for blank sessions and direct delivery for forks.
  let taskArtifactFile: string | null = null;
  let initialPrompts: string[];
  if (params.workflow) {
    initialPrompts = [compileWorkflowPrompt(params.workflow, params.task)];
  } else {
    let taskArg: string;
    if (launchBehavior.taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      taskArtifactFile = join(artifactDir, "context", `${name}-${artifactTimestamp}.md`);
      files.push({ path: taskArtifactFile, content: fullTask });
      taskArg = `@${taskArtifactFile}`;
    }
    initialPrompts = buildPiPromptArgs({
      effectiveSkills,
      taskDelivery: launchBehavior.taskDelivery,
      taskArg,
    });
  }
  const piStartupArgv = [...piArgv];

  // ── Curated env exports (never a full env dump) ──
  const childEnv: Record<string, string> = {};
  if (env.PATH) childEnv.PATH = env.PATH;
  // Children keep the user's global agent directory (never <cwd>/.pi/agent):
  // Pi discovers project resources from <cwd>/.pi on its own, and pointing
  // PI_CODING_AGENT_DIR at the project would isolate credentials and globally
  // installed integrations such as Herdr's official Pi lifecycle reporter.
  if (env.PI_CODING_AGENT_DIR) {
    childEnv.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  }
  const denySet = resolveDenyTools(agentDefs, runtimePolicy.allowNestedDelegation);
  if (denySet.size > 0) {
    childEnv.PI_DENY_TOOLS = [...denySet].join(",");
  }
  childEnv.PI_SUBAGENT_NAME = params.name;
  if (params.agent) {
    childEnv.PI_SUBAGENT_AGENT = params.agent;
  }
  if (autoExit) {
    childEnv.PI_SUBAGENT_AUTO_EXIT = "1";
  }
  if (interactive) {
    childEnv.PI_SUBAGENT_INTERACTIVE = "1";
  }
  childEnv.PI_SUBAGENT_SESSION = sessionFile;
  childEnv.PI_SUBAGENT_ID = id;

  return {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    effectiveCwd: targetCwd,
    sessionFile,
    taskArtifactFile,
    syspromptFile,
    files,
    seedSession,
    paneSplit: {
      sourcePaneId: requireSourcePaneId(env),
      cwd: targetCwd,
      env: childEnv,
    },
    agentStart: {
      liveAgentName: makeLiveAgentName(params.name, id),
      argv: piStartupArgv,
    },
    initialPrompts,
    interactive,
    autoExit,
  };
}

// ── resume launches ─────────────────────────────────────────────────────────

export interface ResumeLaunchParams {
  sessionPath: string;
  name?: string;
  message?: string;
  autoExit?: boolean;
}

/**
 * Ported from pi-interactive-subagents: resumed sessions default to
 * autonomous follow-up work (auto-exit, non-interactive); explicit
 * autoExit: false yields an interactive resumed session.
 */
export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean;
  interactive: boolean;
} {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export interface ResumeLaunchPlan {
  id: string;
  name: string;
  /** The existing child session file being resumed. */
  sessionFile: string;
  resumeMessageFile: string | null;
  /** Files the executor must write (mkdir -p dirname first). */
  files: Array<{ path: string; content: string }>;
  paneSplit: {
    sourcePaneId: string;
    cwd: string;
    env: Record<string, string>;
  };
  agentStart: {
    liveAgentName: string;
    argv: string[];
  };
  initialPrompts: string[];
  interactive: boolean;
  autoExit: boolean;
}

/**
 * Plan a resume launch: pi --session <existing path> -e subagent-done.ts,
 * plus an optional @<artifact> follow-up message. The pane runs in the
 * orchestrator's cwd and Herdr supplies the canonical Pi executable.
 *
 * NOTE: the executor must remove <sessionPath>.exit before launching; a stale
 * semantic signal from the previous run would complete the new watcher.
 */
export function buildResumeLaunchPlan(
  params: ResumeLaunchParams,
  ctx: LaunchPlanContext,
): ResumeLaunchPlan {
  const env = ctx.env;
  const now = ctx.now ?? new Date();
  const id = ctx.id ?? Math.random().toString(16).slice(2, 10);
  const displayName = params.name ?? "Resume";
  const { autoExit, interactive } = resolveResumeLaunchBehavior(params);

  const artifactDir = getArtifactDir(ctx.sessionDir, ctx.sessionId);
  const artifactTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = safeName(displayName);
  const files: Array<{ path: string; content: string }> = [];

  // ── Pi argv ──
  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "subagent-done.ts");
  const piArgv: string[] = ["--session", params.sessionPath, "-e", subagentDonePath];

  let resumeMessageFile: string | null = null;
  if (params.message) {
    resumeMessageFile = join(artifactDir, "subagent-resume", `${name}-${artifactTimestamp}.md`);
    files.push({ path: resumeMessageFile, content: params.message });
  }
  const initialPrompts = resumeMessageFile ? [`@${resumeMessageFile}`] : [];
  const piStartupArgv = [...piArgv];

  // ── Curated env exports (never a full env dump) ──
  const childEnv: Record<string, string> = {};
  if (env.PATH) childEnv.PATH = env.PATH;
  if (env.PI_CODING_AGENT_DIR) {
    childEnv.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  }
  childEnv.PI_SUBAGENT_NAME = displayName;
  if (autoExit) {
    childEnv.PI_SUBAGENT_AUTO_EXIT = "1";
  }
  if (interactive) {
    childEnv.PI_SUBAGENT_INTERACTIVE = "1";
  }
  childEnv.PI_SUBAGENT_SESSION = params.sessionPath;
  childEnv.PI_SUBAGENT_ID = id;
  return {
    id,
    name: displayName,
    sessionFile: params.sessionPath,
    resumeMessageFile,
    files,
    paneSplit: {
      sourcePaneId: requireSourcePaneId(env),
      cwd: ctx.parentCwd,
      env: childEnv,
    },
    agentStart: {
      liveAgentName: makeLiveAgentName(displayName, id),
      argv: piStartupArgv,
    },
    initialPrompts,
    interactive,
    autoExit,
  };
}

// Agent-definition parsing, discovery, and launch-behavior resolution.
//
// Ported near-verbatim from pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/index.ts @ fix/launch-verify-retry — this module is the
// frontmatter compatibility contract (PROJECT-BRIEF.md hard requirement 2): both
// extensions read the same ~/.pi/agent/agents/*.md files during the transition
// period, so field semantics must match exactly. Read-only consumption; the regex
// line parser is intentionally kept (compat trumps elegance — no YAML lib).
//
// Adaptations vs the reference:
// - No bundled `package` source in runtime discovery; role definitions remain user-owned.
// - Params typed as a plain interface instead of the extension's typebox schema.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { SubagentParams } from "./tool-contracts.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

/** The public request fields consulted by agent-definition resolution. */
export type SubagentSpawnParams = Pick<
  SubagentParams,
  | "name"
  | "task"
  | "agent"
  | "cwd"
  | "model"
  | "thinking"
  | "tools"
  | "allowNestedDelegation"
  | "contextMode"
  | "interactive"
>;

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

/** Tools that are gated by `spawning: false` */
export const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(
  agentDefs: AgentDefaults | null,
  allowNestedDelegation?: boolean,
): Set<string> {
  const denied = new Set<string>();
  // An explicit request policy overrides the legacy agent-definition switch.
  if (
    allowNestedDelegation === false ||
    (allowNestedDelegation == null && agentDefs?.spawning === false)
  ) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs?.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

export function resolveEffectiveSessionMode(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.contextMode) return params.contextMode;
  return agentDefs?.sessionMode ?? "lineage-only";
}

export function resolveLaunchBehavior(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * A bare launch is the generic autonomous path. Interactive callers such as
 * `/iterate` opt in explicitly instead of changing the default lifecycle.
 */
export function resolveEffectiveInteractive(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  if (!agentDefs) return false;
  return !(agentDefs?.autoExit ?? false);
}

export function loadAgentDefaults(
  agentName: string,
  projectCwd: string = process.cwd(),
): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(projectCwd, ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

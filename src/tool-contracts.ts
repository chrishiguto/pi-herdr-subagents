// Public tool contracts: TypeBox schemas (the LLM-facing request surface) and
// the typed `details` payloads each tool returns. Descriptions double as model
// prompts — keep them contract-rich, not stubs.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const SubagentParamsSchema = Type.Object({
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
    Type.Union(
      [
        Type.Object({ kind: Type.Literal("skill"), name: Type.String() }),
        Type.Object({ kind: Type.Literal("prompt"), name: Type.String() }),
      ],
      {
        description:
          "Portable Pi skill or prompt template to expand in the child before its first model request.",
      },
    ),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
    }),
  ),
});
export type SubagentParams = Static<typeof SubagentParamsSchema>;

export const ResumeParamsSchema = Type.Object({
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
});
export type ResumeParams = Static<typeof ResumeParamsSchema>;

export const InterruptParamsSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
  name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
});
export type InterruptParams = Static<typeof InterruptParamsSchema>;

export const ListParamsSchema = Type.Object({});

// ── tool result details ─────────────────────────────────────────────────────
// Every tool resolves to either its success payload or `{ error }`; renderers
// narrow on `status`/`error` instead of casting to `any`.

export interface ErrorDetails {
  error: string;
}

export interface SpawnToolDetails {
  id: string;
  name: string;
  task: string;
  agent?: string;
  paneId: string;
  sessionFile: string;
  liveAgentName: string;
  contextMode: "standalone" | "lineage-only" | "fork";
  workflow?: SubagentParams["workflow"];
  status: "started";
}

export interface ResumeToolDetails {
  id: string;
  name: string;
  paneId: string;
  sessionPath: string;
  liveAgentName: string;
  status: "started";
}

export interface InterruptToolDetails {
  error?: string;
  id?: string;
  name?: string;
  status?: "interrupt_requested";
}

export interface ListedChildDetails {
  id: string;
  name: string;
  state: string;
  elapsedSeconds: number;
  sessionFile: string;
}

export interface ListToolDetails {
  children: ListedChildDetails[];
}

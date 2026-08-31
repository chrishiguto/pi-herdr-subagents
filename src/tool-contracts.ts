import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const SubagentParamsSchema = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(Type.String({ description: "Optional user-owned agent definition name" })),
  systemPrompt: Type.Optional(Type.String({ description: "Appended role instructions" })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills override" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Child tool allowlist" })),
  allowNestedDelegation: Type.Optional(Type.Boolean({ description: "Allow nested delegation" })),
  cwd: Type.Optional(Type.String({ description: "Child working directory" })),
  contextMode: Type.Optional(StringEnum(["standalone", "lineage-only", "fork"] as const)),
  workflow: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal("skill"), name: Type.String() }),
    Type.Object({ kind: Type.Literal("prompt"), name: Type.String() }),
  ])),
  interactive: Type.Optional(Type.Boolean({ description: "Run as a user-driven child" })),
});
export type SubagentParams = Static<typeof SubagentParamsSchema>;

export const ResumeParamsSchema = Type.Object({
  sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
  name: Type.Optional(Type.String({ description: "Display name for the Herdr pane" })),
  message: Type.Optional(Type.String({ description: "Follow-up message" })),
  autoExit: Type.Optional(Type.Boolean({ description: "Override resumed lifecycle" })),
});
export type ResumeParams = Static<typeof ResumeParamsSchema>;

export const InterruptParamsSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
  name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
});
export type InterruptParams = Static<typeof InterruptParamsSchema>;

export const ListParamsSchema = Type.Object({});

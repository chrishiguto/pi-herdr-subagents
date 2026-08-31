// The single owner of a child's persisted launch policy: the lifecycle model,
// the sidecar path, and the serialize/validate pair. Written once at initial
// launch, reapplied verbatim on resume — never rewritten with derived values.
import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChildThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The three-state child lifecycle. `interactive` and `auto-exit` are the
 * request-surface flags, but two booleans admit an impossible fourth state, so
 * everything persisted (durable records, launch policy) stores this enum:
 * - autonomous: exits by itself after settling cleanly;
 * - interactive: the user drives the pane; stays open until closed;
 * - manual: non-interactive, but exits only via subagent_done.
 */
export const LIFECYCLE_MODES = ["autonomous", "interactive", "manual"] as const;
export type LifecycleMode = (typeof LIFECYCLE_MODES)[number];

export function lifecycleModeOf(flags: { interactive: boolean; autoExit: boolean }): LifecycleMode {
  return flags.interactive ? "interactive" : flags.autoExit ? "autonomous" : "manual";
}

export function lifecycleFlags(mode: LifecycleMode): { interactive: boolean; autoExit: boolean } {
  return { interactive: mode === "interactive", autoExit: mode === "autonomous" };
}

export const LaunchPolicySchema = Type.Object({
  version: Type.Literal(2),
  cwd: Type.String(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  tools: Type.Optional(Type.Array(Type.String())),
  allowNestedDelegation: Type.Boolean(),
  denyTools: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  lifecycleMode: StringEnum(LIFECYCLE_MODES),
});
export type LaunchPolicy = Static<typeof LaunchPolicySchema>;

export function launchPolicyPath(sessionFile: string): string {
  return `${sessionFile}.herdr-launch-policy.json`;
}

export function serializeLaunchPolicy(policy: LaunchPolicy): string {
  return `${JSON.stringify(policy)}\n`;
}

export type LaunchPolicyRead =
  /** A valid policy (v1 files are migrated in memory, never rewritten). */
  | { kind: "ok"; policy: LaunchPolicy }
  /** No policy sidecar: a session predating policy persistence. */
  | { kind: "absent" }
  /** A sidecar exists but is unreadable or invalid — callers must refuse
      rather than resume the child with silently degraded restrictions. */
  | { kind: "corrupt" };

/** Version 1 persisted the two lifecycle booleans; fold them into the enum. */
function migrateV1(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v1 = value as Record<string, unknown>;
  if (v1.version !== 1 || typeof v1.interactive !== "boolean" || typeof v1.autoExit !== "boolean") {
    return value;
  }
  const { interactive, autoExit, ...rest } = v1;
  return {
    ...rest,
    version: 2,
    lifecycleMode: lifecycleModeOf({ interactive, autoExit }),
  };
}

export function readLaunchPolicy(sessionFile: string): LaunchPolicyRead {
  let raw: string;
  try {
    raw = readFileSync(launchPolicyPath(sessionFile), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "corrupt" };
  }
  try {
    const value = migrateV1(JSON.parse(raw));
    return Check(LaunchPolicySchema, value) ? { kind: "ok", policy: value } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

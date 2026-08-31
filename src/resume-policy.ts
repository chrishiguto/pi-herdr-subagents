import { readFileSync } from "node:fs";
import type { ChildThinkingLevel, PersistedLaunchPolicy } from "./launch.ts";

const THINKING = new Set<ChildThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export function readPersistedLaunchPolicy(sessionFile: string): PersistedLaunchPolicy | null {
  try {
    const value = JSON.parse(
      readFileSync(`${sessionFile}.herdr-launch-policy.json`, "utf8"),
    ) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      typeof value.cwd !== "string" ||
      typeof value.allowNestedDelegation !== "boolean" ||
      typeof value.interactive !== "boolean" ||
      typeof value.autoExit !== "boolean" ||
      (value.model !== undefined && typeof value.model !== "string") ||
      (value.thinking !== undefined &&
        (typeof value.thinking !== "string" || !THINKING.has(value.thinking as ChildThinkingLevel))) ||
      (value.tools !== undefined &&
        (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string"))) ||
      (value.denyTools !== undefined && typeof value.denyTools !== "string") ||
      (value.agent !== undefined && typeof value.agent !== "string")
    ) {
      return null;
    }
    return value as unknown as PersistedLaunchPolicy;
  } catch {
    return null;
  }
}

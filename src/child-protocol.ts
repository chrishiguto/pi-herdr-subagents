// Versioned, correlated handshake between child Pi processes and their parent runtime.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const CHILD_PROTOCOL_VERSION = 1 as const;
const SAFE_SUBAGENT_ID = /^[A-Za-z0-9_-]+$/;

/** The correlation pair every semantic sidecar is keyed by. */
export interface ChildCorrelation {
  sessionFile: string;
  subagentId: string;
}

/** The full env contract a parent hands its child. */
export interface ChildIdentity extends ChildCorrelation {
  /** PI_SUBAGENT_NAME — display name; empty when the parent set none. */
  name: string;
  /** PI_SUBAGENT_AGENT — agent-definition name; empty for generic children. */
  agent: string;
  interactive: boolean;
  autoExit: boolean;
}

export type ExitSidecarData =
  | { type: "done" }
  | { type: "ping"; name: string; message: string };

export type ExitSidecar =
  | { version: typeof CHILD_PROTOCOL_VERSION; subagentId: string; type: "done" }
  | {
      version: typeof CHILD_PROTOCOL_VERSION;
      subagentId: string;
      type: "ping";
      name: string;
      message: string;
    };

/** Parse the PI_DENY_TOOLS list (set by the parent from launch policy). */
export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Parse the child identity as one contract: both key fields are absent, or both are valid. */
export function parseChildIdentity(
  env: Record<string, string | undefined> = process.env,
): ChildIdentity | null {
  const sessionFile = env.PI_SUBAGENT_SESSION?.trim();
  const subagentId = env.PI_SUBAGENT_ID?.trim();
  if (!sessionFile && !subagentId) return null;
  if (!sessionFile) throw new Error("PI_SUBAGENT_SESSION is required in a subagent process.");
  if (!subagentId || !SAFE_SUBAGENT_ID.test(subagentId)) {
    throw new Error("PI_SUBAGENT_ID must contain only letters, digits, _ or -.");
  }
  const interactive = env.PI_SUBAGENT_INTERACTIVE === "1";
  return {
    sessionFile,
    subagentId,
    name: env.PI_SUBAGENT_NAME ?? "",
    agent: env.PI_SUBAGENT_AGENT ?? "",
    interactive,
    autoExit: env.PI_SUBAGENT_AUTO_EXIT === "1" && !interactive,
  };
}

export function exitSidecarPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

export function writeExitSidecar(identity: ChildCorrelation, data: ExitSidecarData): void {
  const payload: ExitSidecar =
    data.type === "done"
      ? {
          version: CHILD_PROTOCOL_VERSION,
          subagentId: identity.subagentId,
          type: "done",
        }
      : {
          version: CHILD_PROTOCOL_VERSION,
          subagentId: identity.subagentId,
          type: "ping",
          name: data.name,
          message: data.message,
        };
  const target = exitSidecarPath(identity.sessionFile);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(payload));
  renameSync(temporary, target);
}

export function readExitSidecar(sessionFile: string, subagentId: string): ExitSidecar | null {
  try {
    const value: unknown = JSON.parse(readFileSync(exitSidecarPath(sessionFile), "utf8"));
    if (!value || typeof value !== "object") return null;
    const signal = value as Record<string, unknown>;
    if (
      signal.version !== CHILD_PROTOCOL_VERSION ||
      signal.subagentId !== subagentId ||
      !SAFE_SUBAGENT_ID.test(subagentId)
    ) {
      return null;
    }
    if (signal.type === "done") {
      return { version: CHILD_PROTOCOL_VERSION, subagentId, type: "done" };
    }
    if (
      signal.type === "ping" &&
      typeof signal.name === "string" &&
      typeof signal.message === "string"
    ) {
      return {
        version: CHILD_PROTOCOL_VERSION,
        subagentId,
        type: "ping",
        name: signal.name,
        message: signal.message,
      };
    }
    return null;
  } catch {
    return null;
  }
}

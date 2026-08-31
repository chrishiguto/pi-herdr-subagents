/**
 * HerdrClient — typed request/response wrapper over the `herdr` CLI.
 *
 * The ONLY module that shells out to herdr for request/response operations.
 * Event subscription lives in ./events.ts (raw socket); waits/polling belong
 * to the watcher, not here.
 *
 * Envelope parsing pattern adapted from pi-herdr (ogulcancelik/pi-extensions, MIT).
 */
import { execFile } from "node:child_process";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

import type { PaneLayout } from "../topology.ts";

export interface PaneInfo {
  pane_id: string;
  terminal_id?: string;
  workspace_id?: string;
  tab_id?: string;
  focused?: boolean;
  agent_status?: string;
  [key: string]: unknown;
}

export interface AgentStartResult {
  name: string;
  kind: "pi";
  paneId: string;
  terminalId?: string;
}

export interface AgentInfo {
  name: string;
  kind: string;
  paneId: string;
  terminalId?: string;
  status?: string;
}

export interface PingResult {
  ok: boolean;
  version?: string | null;
  protocol?: number | null;
}

export interface HerdrClient {
  sessionSnapshot(): Promise<{ panes: PaneInfo[] }>;
  paneLayout(paneId: string): Promise<PaneLayout & { workspace_id?: string }>;
  paneSplit(p: {
    /** Omit to split the calling pane via `--current`. */
    sourcePaneId?: string;
    cwd: string;
    direction: "right" | "down";
    /** Curated child environment; callers must not pass an ambient env dump. */
    env?: Record<string, string>;
  }): Promise<PaneInfo>;
  tabCreate(p: {
    workspaceId?: string;
    cwd: string;
    env?: Record<string, string>;
  }): Promise<PaneInfo>;
  agentStart(p: {
    /** Must match Herdr's unique live-agent name grammar. */
    liveAgentName: string;
    /** Existing shell pane created by paneSplit(). */
    paneId: string;
    /** Native Pi arguments; Herdr supplies the canonical `pi` executable. */
    argv: string[];
  }): Promise<AgentStartResult>;
  agentPrompt(target: string, prompt: string): Promise<void>;
  agentGet(target: string): Promise<AgentInfo | null>;
  paneGet(paneId: string): Promise<PaneInfo | null>;
  paneList(): Promise<PaneInfo[]>;
  paneClose(paneId: string): Promise<void>;
  paneReportMetadata(paneId: string, metadata: { title?: string; displayAgent?: string }): Promise<void>;
  agentSendKeys(target: string, keys: string[]): Promise<void>;
  ping(): Promise<PingResult>;
}

/** Herdr 0.8 live-agent names: lowercase, leading letter, at most 32 bytes. */
const LIVE_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const UNIQUE_SUFFIX = /^[a-z0-9][a-z0-9_-]{0,15}$/;

/**
 * Convert a display label plus a caller-owned unique launch id into a valid
 * Herdr live-agent name. The suffix is preserved verbatim so uniqueness does
 * not depend on the human-readable portion, which may be truncated.
 */
export function makeLiveAgentName(displayName: string, uniqueSuffix: string): string {
  if (!UNIQUE_SUFFIX.test(uniqueSuffix)) {
    throw new Error(
      "Herdr live-agent unique suffix must be 1-16 lowercase letters, digits, underscores, or hyphens.",
    );
  }

  let stem = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!/^[a-z]/.test(stem)) stem = `agent-${stem}`;

  const maxStemLength = 31 - uniqueSuffix.length;
  stem = stem.slice(0, maxStemLength).replace(/[-_]+$/g, "") || "agent";
  const name = `${stem}-${uniqueSuffix}`;
  if (!LIVE_AGENT_NAME.test(name)) {
    throw new Error(`Could not build a valid Herdr live-agent name from ${JSON.stringify(displayName)}.`);
  }
  return name;
}

interface HerdrJsonEnvelope {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export class HerdrError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

function parseEnvelope(output: string): HerdrJsonEnvelope | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as HerdrJsonEnvelope;
  } catch {
    return null;
  }
}

function extractError(output: string): { code?: string; message: string } | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const envelope = parseEnvelope(trimmed);
  if (envelope?.error) {
    return {
      code: envelope.error.code,
      message: envelope.error.message || envelope.error.code || trimmed,
    };
  }
  if (envelope) return null; // valid JSON but not an error envelope
  return { message: trimmed }; // raw non-JSON text (e.g. stderr)
}

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { signal: opts?.signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      let code = 0;
      let stderrText = stderr ?? "";
      if (error) {
        const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        code = typeof errCode === "number" ? errCode : 1;
        // Spawn failures (ENOENT etc.) produce no stderr; surface the error message.
        if (!stderrText.trim() && !(stdout ?? "").trim()) stderrText = error.message;
      }
      resolve({ stdout: stdout ?? "", stderr: stderrText, code });
    });
  });

export function createHerdrClient(opts?: { exec?: ExecFn; bin?: string }): HerdrClient {
  const exec = opts?.exec ?? defaultExec;

  function resolveBin(): string {
    return opts?.bin ?? process.env.HERDR_BIN ?? "herdr";
  }

  async function execHerdr(args: string[], signal?: AbortSignal) {
    const result = await exec(resolveBin(), args, { signal });
    if (result.code !== 0) {
      const err =
        extractError(result.stdout) ??
        extractError(result.stderr) ?? {
          message: `herdr ${args.join(" ")} failed with exit code ${result.code}`,
        };
      throw new HerdrError(
        err.code ? `${err.code}: ${err.message}` : err.message,
        err.code,
      );
    }
    return result;
  }

  async function execHerdrJson<T extends Record<string, unknown>>(
    args: string[],
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await execHerdr(args, signal);
    const stdout = result.stdout.trim();
    if (!stdout) {
      throw new HerdrError(`Expected JSON output from herdr ${args.join(" ")}`);
    }
    const envelope = parseEnvelope(stdout);
    if (!envelope) {
      throw new HerdrError(`Failed to parse JSON from herdr ${args.join(" ")}: ${stdout}`);
    }
    if (envelope.error) {
      throw new HerdrError(
        envelope.error.code
          ? `${envelope.error.code}: ${envelope.error.message || envelope.error.code}`
          : envelope.error.message || `herdr ${args.join(" ")} failed`,
        envelope.error.code,
      );
    }
    return (envelope.result ?? {}) as T;
  }

  return {
    async sessionSnapshot() {
      const result = await execHerdrJson<{ snapshot?: { panes?: PaneInfo[] } }>([
        "api",
        "snapshot",
      ]);
      if (!result.snapshot?.panes) {
        throw new HerdrError(`herdr api snapshot returned no panes: ${JSON.stringify(result)}`);
      }
      return { panes: result.snapshot.panes };
    },

    async paneLayout(paneId) {
      const result = await execHerdrJson<{ layout?: PaneLayout & { workspace_id?: string } }>([
        "pane",
        "layout",
        "--pane",
        paneId,
      ]);
      if (!result.layout?.panes) {
        throw new HerdrError(`herdr pane layout returned no layout: ${JSON.stringify(result)}`);
      }
      return result.layout;
    },

    async paneSplit(p) {
      const args = ["pane", "split"];
      if (p.sourcePaneId) args.push("--pane", p.sourcePaneId);
      else args.push("--current");
      args.push("--direction", p.direction, "--cwd", p.cwd);
      for (const [key, value] of Object.entries(p.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      args.push("--no-focus");

      const result = await execHerdrJson<{ pane?: PaneInfo }>(args);
      if (!result.pane?.pane_id) {
        throw new HerdrError(`herdr pane split returned no pane id: ${JSON.stringify(result)}`);
      }
      return result.pane;
    },

    async tabCreate(p) {
      const args = ["tab", "create"];
      if (p.workspaceId) args.push("--workspace", p.workspaceId);
      args.push("--cwd", p.cwd);
      for (const [key, value] of Object.entries(p.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      args.push("--no-focus");
      const result = await execHerdrJson<{ root_pane?: PaneInfo }>(args);
      if (!result.root_pane?.pane_id) {
        throw new HerdrError(`herdr tab create returned no root pane: ${JSON.stringify(result)}`);
      }
      return result.root_pane;
    },

    async agentStart(p) {
      if (!LIVE_AGENT_NAME.test(p.liveAgentName)) {
        throw new HerdrError(
          `Invalid Herdr live-agent name ${JSON.stringify(p.liveAgentName)}; ` +
            "expected [a-z][a-z0-9_-]{0,31}.",
        );
      }

      const args = [
        "agent",
        "start",
        p.liveAgentName,
        "--kind",
        "pi",
        "--pane",
        p.paneId,
        "--",
        ...p.argv,
      ];

      const result = await execHerdrJson<{ agent?: Record<string, unknown> }>(args);
      const agent = result.agent as
        | { name?: string; pane_id?: string; terminal_id?: string }
        | undefined;
      if (!agent?.pane_id) {
        throw new HerdrError(`herdr agent start returned no pane id: ${JSON.stringify(result)}`);
      }
      return {
        name: agent.name ?? p.liveAgentName,
        kind: "pi",
        paneId: agent.pane_id,
        terminalId: agent.terminal_id,
      };
    },

    async agentPrompt(target, prompt) {
      await execHerdrJson(["agent", "prompt", target, prompt]);
    },

    async agentGet(target) {
      try {
        const result = await execHerdrJson<{ agent?: Record<string, unknown> }>([
          "agent",
          "get",
          target,
        ]);
        const agent = result.agent;
        if (!agent || typeof agent.pane_id !== "string" || typeof agent.name !== "string") {
          throw new HerdrError(`herdr agent get returned an invalid agent: ${JSON.stringify(result)}`);
        }
        return {
          name: agent.name,
          // Protocol 20 reports the recognized agent kind in the `agent` field.
          kind: typeof agent.agent === "string" ? agent.agent : "",
          paneId: agent.pane_id,
          terminalId: typeof agent.terminal_id === "string" ? agent.terminal_id : undefined,
          status: typeof agent.agent_status === "string" ? agent.agent_status : undefined,
        };
      } catch (error) {
        if (error instanceof HerdrError && error.code === "agent_not_found") return null;
        throw error;
      }
    },

    async paneGet(paneId) {
      try {
        const result = await execHerdrJson<{ pane?: PaneInfo }>(["pane", "get", paneId]);
        return result.pane ?? null;
      } catch (error) {
        if (error instanceof HerdrError && error.code === "pane_not_found") return null;
        throw error;
      }
    },

    async paneList() {
      const result = await execHerdrJson<{ panes?: PaneInfo[] }>(["pane", "list"]);
      return result.panes ?? [];
    },

    async paneClose(paneId) {
      await execHerdrJson(["pane", "close", paneId]);
    },

    async paneReportMetadata(paneId, metadata) {
      const args = ["pane", "report-metadata", paneId, "--source", "pi-herdr-subagents"];
      if (metadata.title) args.push("--title", metadata.title);
      if (metadata.displayAgent) args.push("--display-agent", metadata.displayAgent);
      await execHerdr(args);
    },

    async agentSendKeys(target, keys) {
      // Herdr >=0.8.2 supports sending key combos through the live-agent target,
      // avoiding stale pane IDs after moves.
      await execHerdr(["agent", "send-keys", target, ...keys]);
    },

    async ping() {
      // `herdr status server --json` exits 0 whether or not a server is running
      // and prints a plain JSON object (not an id/result envelope).
      const result = await execHerdr(["status", "server", "--json"]);
      const stdout = result.stdout.trim();
      let status: { running?: boolean; version?: string | null; protocol?: number | null };
      try {
        status = JSON.parse(stdout) as typeof status;
      } catch {
        throw new HerdrError(`Failed to parse herdr status output: ${stdout}`);
      }
      return { ok: status.running === true, version: status.version, protocol: status.protocol };
    },
  };
}

/**
 * Extension loaded into every subagent child pi (via `-e <this file>`).
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Provides a `caller_ping` tool to ask the parent orchestrator for help
 *
 * Ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/subagent-done.ts @ fix/launch-verify-retry, with the
 * activity recorder stripped (stall detection is discarded in this design —
 * herdr's pane.exited gives truthful lifecycle instead).
 *
 * The `.exit` sidecar written here is a cross-extension contract: the
 * orchestrator's watcher (src/watcher.ts) classifies completion from exactly
 * these shapes — {"type":"done"} and {"type":"ping","name":...,"message":...}.
 * Keep this file dependency-light: it loads into EVERY child.
 */
import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renameSync, writeFileSync } from "node:fs";

import { writeContextUsageSidecar } from "./src/context-usage.ts";
import { createSubagentActivityTracker } from "./src/runtime-events.ts";

/**
 * Whether the run that just ended completed normally. Auto-exit is decided by
 * turn completion, not by who initiated the turn: Escape/abort and API errors
 * leave the session open for inspection, retry, or another prompt.
 */
export function shouldAutoExitOnAgentEnd(messages: any[] | undefined): boolean {
  if (messages) {
    // A turn that ends at a user message produced no assistant reply — the
    // request errored / is retrying. This happens on resumed sessions whose
    // first request times out (verified live, pi 0.80.3): agent_end fires
    // while pi is "Retrying (1/3)"; walking backwards would find the
    // PREVIOUS conversation's assistant and shut pi down mid-retry.
    const last = messages[messages.length - 1];
    if (last?.role === "user") return false;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        // Don't auto-exit on errors (timeouts, connection failures) — let pi retry.
        // Only exit on clean completions (stop, toolUse) or explicit abort.
        return msg.stopReason !== "aborted" && msg.stopReason !== "error";
      }
    }
  }

  return true;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export type ExitSidecarData =
  | { type: "done" }
  | { type: "ping"; name: string; message: string };

/**
 * Write the completion sidecar the orchestrator's watcher classifies from.
 * Byte-shape must match pi-interactive-subagents exactly (key order included):
 *   {"type":"done"}
 *   {"type":"ping","name":"...","message":"..."}
 */
export function writeExitSidecar(
  sessionFile: string,
  subagentId: string,
  data: ExitSidecarData,
): void {
  const payload =
    data.type === "done"
      ? { version: 1 as const, subagentId, type: "done" as const }
      : { version: 1 as const, subagentId, type: "ping" as const, name: data.name, message: data.message };
  const target = `${sessionFile}.exit`;
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(payload));
  renameSync(temporary, target);
}

export default function (pi: ExtensionAPI) {
  const nestedActivity = createSubagentActivityTracker(pi.events);
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const interactive = process.env.PI_SUBAGENT_INTERACTIVE === "1";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1" && !interactive;
  const subagentId = process.env.PI_SUBAGENT_ID ?? "";

  function renderWidget(ctx: { ui: { setWidget: Function } }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let contextUsageWritten = false;
  let terminalSignalWritten = false;
  let latestRunCompletedNormally = false;

  function snapshotContextUsage(
    ctx: { getContextUsage?: () => ContextUsage | null | undefined },
    fallback = false,
  ): void {
    if (contextUsageWritten) return;

    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const id = process.env.PI_SUBAGENT_ID;
    if (!sessionFile || !id) return;

    let usage: ContextUsage | null | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      return;
    }
    if (usage == null) return;

    try {
      contextUsageWritten = writeContextUsageSidecar(sessionFile, id, usage, {
        overwrite: !fallback,
      });
    } catch {
      // Telemetry is best-effort and must never prevent terminal signaling.
    }
  }

  // Show widget on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx);
  });

  pi.on("agent_end", (event) => {
    if (terminalSignalWritten) return;
    const messages = (event as any).messages as any[] | undefined;
    // agent_end describes the low-level run but is not a safe shutdown point:
    // Pi may still retry, compact, or process a queued follow-up.
    latestRunCompletedNormally = shouldAutoExitOnAgentEnd(messages);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // A subagent can itself act as an orchestrator. Exiting its pi process
    // would abort the nested watchers, so their eventual results would have no
    // live session to steer. Stay open until every nested child has settled.
    if (
      terminalSignalWritten ||
      !autoExit ||
      !latestRunCompletedNormally ||
      !ctx.isIdle() ||
      nestedActivity.count() > 0
    ) {
      return;
    }

    // Pi has no retry, compaction, or queued continuation left. Publish the
    // semantic completion before shutting down so the parent can recover it.
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      snapshotContextUsage(ctx);
      writeExitSidecar(sessionFile, subagentId, { type: "done" });
    }
    ctx.shutdown();
  });

  // Pi exposes session_shutdown for user closes, child auto/tool shutdown, and
  // extension/runtime unload. It does not provide a reason that lets us
  // distinguish a clean user exit from a parent extension reload; writing a
  // semantic sidecar here would turn recoverable reload gaps into false
  // completions. Keep shutdown unsignaled and let the parent report the honest
  // unsignaled-exit disposition while preserving the resumable session path.
  // Do not overwrite a snapshot already published by another terminal path.
  pi.on("session_shutdown", (_event, ctx) => {
    snapshotContextUsage(ctx, true);
    nestedActivity.close();
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
          "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }
      const message = params.message.trim();
      if (!message) {
        throw new Error("caller_ping requires a clear, non-empty help question.");
      }

      snapshotContextUsage(ctx);
      writeExitSidecar(sessionFile, subagentId, {
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message,
      });
      terminalSignalWritten = true;

      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Ping sent. Session will exit and parent will be notified." },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        snapshotContextUsage(ctx);
        writeExitSidecar(sessionFile, subagentId, { type: "done" });
        terminalSignalWritten = true;
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}

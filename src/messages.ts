// Steer message builders + renderers — SubagentOutcome → subagent_result /
// subagent_ping payloads (PLAN.md Key Decision #10).
//
// Presentation helpers and the Box/Text renderers are ported from
// pi-interactive-subagents (MIT, HazAT) pi-extension/subagents/index.ts
// @ fix/launch-verify-retry, adapted for herdr panes and the outcome kinds
// of src/watcher.ts. The customType strings "subagent_result" and
// "subagent_ping" are load-bearing — downstream tooling and session greps
// rely on them; do not rename.
//
// Refinement over the reference (plan §10): unsignaled exits still deliver the
// last assistant message from the child session file (written incrementally) +
// the session path so the orchestrator can resume.
//
// Tool descriptions/promptSnippets are NOT here (Task 10) — outcome→message only.
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import type { ContextUsageSnapshot } from "./context-usage.ts";
import { boundOutcomeText } from "./outcome.ts";
import type { RunningSubagent, SubagentOutcome } from "./watcher.ts";

export interface SubagentSteerMessage {
  customType: "subagent_result" | "subagent_ping";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function sessionRef(sessionFile: string | undefined): string {
  return sessionFile ? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}` : "";
}

function contextUsageLine(usage: ContextUsageSnapshot | null | undefined): string {
  if (usage?.tokens == null || usage.percent == null || usage.contextWindow <= 0) return "";

  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  return (
    `\n\nContext: ${usage.tokens.toLocaleString("en-US")}/${usage.contextWindow.toLocaleString("en-US")} tokens ` +
    `(${usage.percent}% used, ${remaining.toLocaleString("en-US")} remaining).`
  );
}

/** Ported: completed/failed presentation with Session:/Resume: block. */
export function resolveResultPresentation(
  result: { exitCode: number; elapsed: number; summary: string; sessionFile?: string },
  name: string,
): string {
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef(result.sessionFile)}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef(result.sessionFile)}`;
}

/**
 * Convert a terminal SubagentOutcome into a steer message payload for
 * pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" }).
 * Returns null for "cancelled" (orchestrator shutdown/interrupt — no steer).
 */
export function buildOutcomeMessage(
  running: RunningSubagent,
  outcome: SubagentOutcome,
  opts?: { now?: () => number; contextUsage?: ContextUsageSnapshot | null },
): SubagentSteerMessage | null {
  const now = opts?.now ?? Date.now;
  const elapsed = Math.max(0, Math.floor((now() - running.startTime) / 1000));
  const usageSuffix = contextUsageLine(opts?.contextUsage);
  const outcomeSessionFile = outcome.sessionFile ?? running.sessionFile;

  function boundedDetails(value: string): {
    text: string;
    metadata: { outputTruncated?: true; originalChars?: number };
  } {
    const bounded = boundOutcomeText(value);
    return {
      text: bounded.text,
      metadata: bounded.truncated
        ? { outputTruncated: true, originalChars: bounded.originalChars }
        : {},
    };
  }

  const baseDetails: Record<string, unknown> = {
    name: running.name,
    task: running.task,
    agent: running.agent,
    elapsed,
    sessionFile: outcomeSessionFile,
    paneId: running.paneId,
    disposition: outcome.kind,
    ...(opts?.contextUsage ? { contextUsage: opts.contextUsage } : {}),
  };

  switch (outcome.kind) {
    case "cancelled":
      return null;

    case "ping": {
      const message = boundedDetails(outcome.message);
      return {
        customType: "subagent_ping",
        content:
          `Sub-agent "${outcome.name}" needs help (${formatElapsed(elapsed)}):\n\n` +
          `${message.text}${sessionRef(outcomeSessionFile)}${usageSuffix}`,
        display: true,
        details: {
          ...baseDetails,
          name: outcome.name,
          message: message.text,
          ...message.metadata,
        },
      };
    }

    case "completed": {
      const summary = boundedDetails(outcome.summary);
      return {
        customType: "subagent_result",
        content:
          resolveResultPresentation(
            { exitCode: 0, elapsed, summary: summary.text, sessionFile: outcomeSessionFile },
            running.name,
          ) + usageSuffix,
        display: true,
        details: {
          ...baseDetails,
          exitCode: 0,
          summary: summary.text,
          ...summary.metadata,
        },
      };
    }

    case "launch-failed": {
      const error = boundedDetails(outcome.error);
      const lines = [
        `Sub-agent "${running.name}" failed to launch.`,
        "",
        error.text,
        `Pane: ${outcome.paneId ?? running.paneId} (herdr)`,
      ];
      if (outcome.exitCode != null) lines[0] += ` Exit code: ${outcome.exitCode}.`;
      return {
        customType: "subagent_result",
        content: lines.join("\n") + sessionRef(outcomeSessionFile) + usageSuffix,
        display: true,
        details: {
          ...baseDetails,
          ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}),
          error: "launch-failed",
          launchError: error.text,
          ...error.metadata,
        },
      };
    }

    case "unsignaled-exit": {
      const summary = boundedDetails(outcome.summary ?? "No assistant output captured.");
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" ended without a completion signal ` +
          `(${outcome.reason}; herdr pane ${running.paneId}) — last message:\n\n` +
          `${summary.text}${sessionRef(outcomeSessionFile)}${usageSuffix}`,
        display: true,
        details: {
          ...baseDetails,
          error: "unsignaled-exit",
          reason: outcome.reason,
          summary: outcome.summary == null ? null : summary.text,
          ...summary.metadata,
        },
      };
    }
  }
}

// ── renderers (register via pi.registerMessageRenderer in extensions/herdr-subagents/index.ts) ──────

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};
type RenderOptions = { expanded: boolean };
type RenderedMessage = { invalidate(): void; render(width: number): string[] } | undefined;
type SteerLike = { content?: unknown; details?: unknown };

/** keyHint needs pi's initialized theme; fall back to plain text headless (unit tests). */
function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "expand for more";
  }
}

function statusText(disposition: string | undefined, exitCode: number): string {
  switch (disposition) {
    case "completed":
      return "completed";
    case "launch-failed":
      return "failed to launch";
    case "unsignaled-exit":
      return "ended without completion signal";
    default:
      return exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
  }
}

/** Renderer for `subagent_result` steer messages. */
export function renderSubagentResult(
  message: SteerLike,
  options: RenderOptions,
  theme: Theme,
): RenderedMessage {
  const details = message.details as Record<string, any> | undefined;
  if (!details) return undefined;

  return {
    invalidate() {},
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const exitCode = typeof details.exitCode === "number" ? details.exitCode : 1;
      const disposition = typeof details.disposition === "string" ? details.disposition : undefined;
      const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
      const ok =
        disposition === "completed" || (disposition === undefined && exitCode === 0);
      const bgFn = ok
        ? (text: string) => theme.bg("toolSuccessBg", text)
        : (text: string) => theme.bg("toolErrorBg", text);
      const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const status = statusText(disposition, exitCode);
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;

      // Prefer the structured summary; fall back to the content with the
      // Session:/Resume: block and leading label stripped (ported regexes).
      const rawContent = typeof message.content === "string" ? message.content : "";
      const summary =
        typeof details.summary === "string"
          ? details.summary
          : rawContent
              .replace(/\n\nSession: .+\nResume: .+$/, "")
              .replace(/^Sub-agent "[^"]*" [^\n]*\n\n/, "");

      const contentLines = [header];
      const usageLine = contextUsageLine(details.contextUsage).trim();
      if (usageLine) contentLines.push(theme.fg("dim", usageLine));

      if (options.expanded) {
        if (summary) {
          for (const line of summary.split("\n")) {
            contentLines.push(line.slice(0, width - 6));
          }
        }
        if (details.sessionFile) {
          contentLines.push("");
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
        }
      } else {
        if (summary) {
          const previewLines = summary.split("\n").slice(0, 5);
          for (const line of previewLines) {
            contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
          }
          const totalLines = summary.split("\n").length;
          if (totalLines > 5) {
            contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
          }
        }
        contentLines.push(theme.fg("muted", expandHint()));
      }

      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

/** Renderer for `subagent_ping` steer messages. */
export function renderSubagentPing(
  message: SteerLike,
  options: RenderOptions,
  theme: Theme,
): RenderedMessage {
  const details = message.details as Record<string, any> | undefined;
  if (!details) return undefined;

  return {
    invalidate() {},
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
      const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

      const icon = theme.fg("accent", "?");
      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

      const contentLines = [header];
      const usageLine = contextUsageLine(details.contextUsage).trim();
      if (usageLine) contentLines.push(theme.fg("dim", usageLine));

      if (options.expanded) {
        contentLines.push("");
        contentLines.push(details.message ?? "");
        if (details.sessionFile) {
          contentLines.push("");
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
        }
      } else {
        const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
        contentLines.push(theme.fg("dim", preview));
        contentLines.push(theme.fg("muted", expandHint()));
      }

      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

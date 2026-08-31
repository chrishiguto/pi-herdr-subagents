// Pure TUI presentation for the orchestrator tools. Nothing here touches
// orchestration state — each tool registration stays schema + executor, and
// the shared shapes live in one place instead of four copies.
import { Text } from "@earendil-works/pi-tui";

import { formatElapsed } from "./messages.ts";
import type { ListedChildDetails } from "./tool-contracts.ts";

/** The theme surface these renderers rely on (structural view of pi-tui's). */
export interface ToolTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ToolResultLike {
  content: Array<{ type: string; text?: string }>;
}

/** "▸ Name — suffix" title line. */
export function renderToolTitle(theme: ToolTheme, name: string, suffix: string): Text {
  return new Text(
    theme.fg("accent", "▸") +
      " " +
      theme.fg("toolTitle", theme.bold(name)) +
      theme.fg("dim", ` — ${suffix}`),
    0,
    0,
  );
}

/** Accent title when the tool acknowledged, dim message text otherwise. */
export function renderAckResult(
  result: ToolResultLike,
  theme: ToolTheme,
  opts: { acknowledged: boolean; name: string; suffix: string },
): Text {
  if (opts.acknowledged) return renderToolTitle(theme, opts.name, opts.suffix);
  const first = result.content[0];
  const text = first?.type === "text" ? (first.text ?? "") : "";
  return new Text(theme.fg("dim", text), 0, 0);
}

/** Spawn call line with a one-line task preview. */
export function renderSpawnCall(args: unknown, theme: ToolTheme): Text {
  const partialArgs = args as Record<string, unknown>;
  const name =
    typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
  const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
  const agent =
    typeof partialArgs.agent === "string" && partialArgs.agent
      ? theme.fg("dim", ` (${partialArgs.agent})`)
      : "";
  const cwdHint =
    typeof partialArgs.cwd === "string" && partialArgs.cwd
      ? theme.fg("dim", ` in ${partialArgs.cwd}`)
      : "";
  let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

  // Show a one-line task preview. renderCall is called repeatedly as the
  // LLM generates tool arguments, so args.task grows token by token.
  if (task) {
    const firstLine = task.split("\n").find((line: string) => line.trim()) ?? "";
    const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
    if (preview) {
      text += "\n" + theme.fg("toolOutput", preview);
    }
    const totalLines = task.split("\n").length;
    if (totalLines > 1) {
      text += theme.fg("muted", ` (${totalLines} lines)`);
    }
  }

  return new Text(text, 0, 0);
}

export function renderListResult(children: ListedChildDetails[], theme: ToolTheme): Text {
  if (children.length === 0) {
    return new Text(theme.fg("dim", "No active subagents."), 0, 0);
  }
  const lines = children.map(
    (child) =>
      `  ${theme.fg("toolTitle", theme.bold(child.name))}` +
      theme.fg(
        "dim",
        ` [${child.id}] — ${child.state} — ${formatElapsed(child.elapsedSeconds)} — ${child.sessionFile}`,
      ),
  );
  return new Text(lines.join("\n"), 0, 0);
}

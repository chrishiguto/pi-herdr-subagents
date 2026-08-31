// Status widget — bordered live view of running subagents, rendered above the
// Pi editor.
//
// Ported from pi-interactive-subagents (MIT, HazAT): border rendering and the
// one-line-per-child layout from its index.ts widget machinery. Its activity-
// snapshot classification (status.ts) is replaced by Herdr's native agent
// states observed through inspectActiveChildren() — Herdr owns detection, so
// the widget only formats what Herdr already knows.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const WIDGET_ID = "subagent-status";
export const MAX_WIDGET_NAME_LENGTH = 40;

/** Age of a child before an unobserved state stops reading as "starting". */
const STARTING_GRACE_MS = 15_000;

export interface StatusWidgetChild {
  id: string;
  name: string;
  agent?: string;
  interactive: boolean;
  startTimeMs: number;
  /** Latest Herdr agent status (working | blocked | idle | unknown). */
  state?: string;
}

export interface WidgetColors {
  /** Wrap border characters. Default: identity (no color). */
  border?: (text: string) => string;
  /** Wrap a healthy working state. */
  working?: (text: string) => string;
  /** Wrap a state needing user attention. */
  attention?: (text: string) => string;
}

const IDENTITY = (text: string) => text;

export function formatWidgetElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Right-hand state label for one child, from Herdr's own agent state. */
export function widgetStateLabel(child: StatusWidgetChild, now: number): string {
  const state = child.state?.trim();
  if (state && state !== "unknown") {
    if (state === "blocked") return "blocked — needs input";
    if (state === "idle") return child.interactive ? "idle — interactive" : "idle";
    return state;
  }
  const age = Math.max(0, now - child.startTimeMs);
  return age < STARTING_GRACE_MS ? "starting…" : "unknown";
}

/** Build a bordered content line: │left          right│ */
function borderLine(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("│");

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);

  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return border("│") + truncRight + " ".repeat(rightPad) + border("│");
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return border("│") + truncLeft + " ".repeat(pad) + right + border("│");
}

/** Build the bordered top line: ╭─ Title ──── info ─╮ */
function borderTop(
  title: string,
  info: string,
  width: number,
  border: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("╭");

  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return border(`╭${content}╮`);
}

/** Build the bordered bottom line: ╰──────────────────╯ */
function borderBottom(width: number, border: (text: string) => string): string {
  if (width <= 0) return "";
  if (width === 1) return border("╰");
  const inner = Math.max(0, width - 2);
  return border(`╰${"─".repeat(inner)}╯`);
}

function stateColor(state: string, colors: WidgetColors): (text: string) => string {
  if (state === "blocked") return colors.attention ?? IDENTITY;
  if (state === "working") return colors.working ?? IDENTITY;
  return IDENTITY;
}

function truncateName(name: string): string {
  return name.length <= MAX_WIDGET_NAME_LENGTH
    ? name
    : `${name.slice(0, MAX_WIDGET_NAME_LENGTH - 1)}…`;
}

/**
 * Render the whole widget: a bordered box titled "Subagents" with one row per
 * running child — elapsed and name on the left, Herdr state on the right.
 */
export function renderStatusWidgetLines(
  children: StatusWidgetChild[],
  width: number,
  colors: WidgetColors = {},
): string[] {
  const border = colors.border ?? IDENTITY;
  const count = children.length;
  const lines: string[] = [borderTop("Subagents", `${count} running`, width, border)];

  const now = Date.now();
  for (const child of children) {
    const elapsed = formatWidgetElapsed(Math.max(0, now - child.startTimeMs));
    const agentTag = child.agent ? ` (${child.agent})` : "";
    const left = ` ${elapsed}  ${truncateName(child.name)}${agentTag} `;
    const state = widgetStateLabel(child, now);
    lines.push(borderLine(left, stateColor(state, colors)(` ${state} `), width, border));
  }

  lines.push(borderBottom(width, border));
  return lines;
}

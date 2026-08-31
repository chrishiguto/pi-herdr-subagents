// Session-scoped lifecycle for the status widget: mount while children run,
// unmount when the registry empties, driven by the runtime's activity events.
//
// Pi's extension framework owns every teardown path, so nothing here needs
// reload-survival state: `pi.events.on` subscriptions are released when the
// extension runtime is invalidated, and mounted widget components get
// `dispose()` on /reload and session replacement — which clears the tick
// interval the component owns.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { SUBAGENT_ACTIVITY_EVENT } from "./runtime-events.ts";
import {
  renderStatusWidgetLines,
  WIDGET_ID,
  type StatusWidgetChild,
} from "./status-widget.ts";
import type { SubagentRuntime } from "./runtime.ts";

const TICK_MS = 1_000;
const STATE_REFRESH_TICKS = 5;

type WidgetRuntime = Pick<SubagentRuntime, "running" | "inspect">;
type WidgetComponent = Component & { dispose(): void };

export interface StatusWidgetUi {
  hasUI: boolean;
  ui: {
    setWidget(
      key: string,
      content: ((tui: TUI, theme: Theme) => WidgetComponent) | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
}

/**
 * One mounted widget instance. Owns the 1s elapsed-time tick (cleared by
 * `dispose()`) and a slower Herdr agent-state refresh; `render()` always pulls
 * the live registry, so ticks only need to request a repaint.
 */
export function createStatusWidgetComponent(
  runtime: WidgetRuntime,
  tui: Pick<TUI, "requestRender">,
  theme: Pick<Theme, "fg">,
): WidgetComponent {
  const states = new Map<string, string>();
  let refreshing = false;

  async function refreshStates(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const active = await runtime.inspect();
      states.clear();
      for (const child of active) states.set(child.id, child.state);
    } catch {
      // Herdr may be momentarily unreachable; keep the last observed states.
    } finally {
      refreshing = false;
    }
  }

  void refreshStates();
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    if (ticks % STATE_REFRESH_TICKS === 0) void refreshStates();
    tui.requestRender();
  }, TICK_MS);
  interval.unref?.();

  return {
    render(width: number): string[] {
      const children: StatusWidgetChild[] = [...runtime.running.values()].map((child) => ({
        id: child.id,
        name: child.name,
        agent: child.agent,
        interactive: child.interactive,
        startTimeMs: child.startTime,
        state: states.get(child.id),
      }));
      return renderStatusWidgetLines(children, width, {
        border: (text) => theme.fg("dim", text),
        working: (text) => theme.fg("success", text),
        attention: (text) => theme.fg("warning", text),
      });
    },
    invalidate(): void {
      // No cached rendering state — every render() reads the live registry.
    },
    dispose(): void {
      clearInterval(interval);
    },
  };
}

/**
 * Mount/unmount the widget as the running registry fills and empties. Every
 * registry mutation — launch, resume, recovery, settle, shutdown — publishes
 * SUBAGENT_ACTIVITY_EVENT, so the widget needs no per-call-site hooks and no
 * emptiness polling. Returns a detach function for session_shutdown.
 */
export function attachStatusWidget(
  events: { on(channel: string, handler: (data: unknown) => void): () => void },
  ctx: StatusWidgetUi,
  runtime: WidgetRuntime,
): () => void {
  if (!ctx.hasUI) return () => {};

  let mounted = false;
  function sync(): void {
    const shouldMount = runtime.running.size > 0;
    if (shouldMount === mounted) return;
    mounted = shouldMount;
    ctx.ui.setWidget(
      WIDGET_ID,
      shouldMount ? (tui, theme) => createStatusWidgetComponent(runtime, tui, theme) : undefined,
      { placement: "aboveEditor" },
    );
  }

  const unsubscribe = events.on(SUBAGENT_ACTIVITY_EVENT, sync);
  sync();
  return () => {
    unsubscribe();
    if (mounted) {
      mounted = false;
      ctx.ui.setWidget(WIDGET_ID, undefined);
    }
  };
}

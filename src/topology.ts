export interface PaneRect {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface PaneLayout {
  panes: Array<{ pane_id: string; rect: PaneRect }>;
}

export type ChildPlacement =
  | { kind: "split"; direction: "right" | "down" }
  | { kind: "tab" };

export interface TopologyPolicy {
  /** Minimum usable width of both panes after a right split. */
  minWidth: number;
  /** Minimum usable height of both panes after a down split. */
  minHeight: number;
  /** Prefer side-by-side panes when both split directions are viable. */
  prefer: "right" | "down";
}

export const DEFAULT_TOPOLOGY_POLICY: TopologyPolicy = {
  minWidth: 60,
  minHeight: 12,
  prefer: "right",
};

/**
 * Choose a placement that keeps both the orchestrator and child usable.
 * Herdr splits the selected pane in half when no ratio is supplied.
 */
export function chooseChildPlacement(
  layout: PaneLayout,
  sourcePaneId: string,
  policy: TopologyPolicy = DEFAULT_TOPOLOGY_POLICY,
): ChildPlacement {
  const source = layout.panes.find((pane) => pane.pane_id === sourcePaneId);
  if (!source) return { kind: "tab" };

  const canSplitRight = Math.floor(source.rect.width / 2) >= policy.minWidth;
  const canSplitDown = Math.floor(source.rect.height / 2) >= policy.minHeight;
  if (canSplitRight && canSplitDown) {
    return { kind: "split", direction: policy.prefer };
  }
  if (canSplitRight) return { kind: "split", direction: "right" };
  if (canSplitDown) return { kind: "split", direction: "down" };
  return { kind: "tab" };
}

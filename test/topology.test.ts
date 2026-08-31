import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chooseChildPlacement } from "../src/topology.ts";

describe("chooseChildPlacement", () => {
  it("splits right when both resulting panes remain wide", () => {
    assert.deepEqual(
      chooseChildPlacement(
        { panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 50 } }] },
        "w1:p1",
      ),
      { kind: "split", direction: "right" },
    );
  });

  it("splits down rather than creating narrow columns", () => {
    assert.deepEqual(
      chooseChildPlacement(
        { panes: [{ pane_id: "w1:p1", rect: { width: 90, height: 50 } }] },
        "w1:p1",
      ),
      { kind: "split", direction: "down" },
    );
  });

  it("opens a tab when neither split would be usable", () => {
    assert.deepEqual(
      chooseChildPlacement(
        { panes: [{ pane_id: "w1:p1", rect: { width: 90, height: 20 } }] },
        "w1:p1",
      ),
      { kind: "tab" },
    );
  });

  it("opens a tab when the source pane is absent from the snapshot", () => {
    assert.deepEqual(chooseChildPlacement({ panes: [] }, "w1:p1"), { kind: "tab" });
  });

  it("honors a down preference when both directions are viable", () => {
    assert.deepEqual(
      chooseChildPlacement(
        { panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 50 } }] },
        "w1:p1",
        { minWidth: 60, minHeight: 12, prefer: "down" },
      ),
      { kind: "split", direction: "down" },
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  formatWidgetElapsed,
  renderStatusWidgetLines,
  widgetStateLabel,
  type StatusWidgetChild,
} from "../src/status-widget.ts";

function child(overrides: Partial<StatusWidgetChild> = {}): StatusWidgetChild {
  return {
    id: "a1",
    name: "Worker",
    agent: "worker",
    interactive: false,
    startTimeMs: Date.now() - 90_000,
    state: "working",
    ...overrides,
  };
}

describe("formatWidgetElapsed", () => {
  it("formats compact MM:SS", () => {
    assert.equal(formatWidgetElapsed(0), "00:00");
    assert.equal(formatWidgetElapsed(59_000), "00:59");
    assert.equal(formatWidgetElapsed(90_000), "01:30");
    assert.equal(formatWidgetElapsed(3_599_000), "59:59");
  });

  it("switches to hours past an hour", () => {
    assert.equal(formatWidgetElapsed(3_600_000), "1h 00m");
    assert.equal(formatWidgetElapsed(7_380_000), "2h 03m");
  });

  it("never reports negative elapsed", () => {
    assert.equal(formatWidgetElapsed(-5_000), "00:00");
  });
});

describe("widgetStateLabel", () => {
  it("maps Herdr states to human labels", () => {
    assert.equal(widgetStateLabel(child({ state: "working" }), Date.now()), "working");
    assert.equal(widgetStateLabel(child({ state: "idle" }), Date.now()), "idle");
    assert.equal(widgetStateLabel(child({ state: "blocked" }), Date.now()), "blocked — needs input");
  });

  it("distinguishes interactive idle children", () => {
    assert.equal(
      widgetStateLabel(child({ state: "idle", interactive: true }), Date.now()),
      "idle — interactive",
    );
  });

  it("reads as starting inside the grace window, unknown after", () => {
    const now = Date.now();
    assert.equal(widgetStateLabel(child({ state: undefined, startTimeMs: now - 1_000 }), now), "starting…");
    assert.equal(widgetStateLabel(child({ state: "unknown", startTimeMs: now - 60_000 }), now), "unknown");
  });
});

describe("renderStatusWidgetLines", () => {
  it("renders a bordered box with one row per child", () => {
    const width = 60;
    const lines = renderStatusWidgetLines([child(), child({ id: "b2", name: "Scout", agent: undefined })], width);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^╭─ Subagents .* 2 running ─╮$/);
    assert.match(lines[1], /Worker \(worker\)/);
    assert.match(lines[1], /working/);
    assert.match(lines[2], /Scout/);
    assert.match(lines[3], /^╰─+╯$/);
    for (const line of lines) {
      assert.equal([...line].length <= width, true, `line exceeds width: ${JSON.stringify(line)}`);
    }
  });

  it("renders only the border when no children are running", () => {
    const lines = renderStatusWidgetLines([], 60);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /0 running/);
  });

  it("degrades instead of overflowing on narrow widths", () => {
    for (const width of [1, 2, 5, 10, 20, 40]) {
      const lines = renderStatusWidgetLines([child()], width);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `line wider than ${width}: ${JSON.stringify(line)}`,
        );
      }
    }
  });

  it("truncates long names", () => {
    const longName = "x".repeat(80);
    const lines = renderStatusWidgetLines([child({ name: longName, agent: undefined })], 100);
    assert.match(lines[1], /x{39}…/);
  });
});

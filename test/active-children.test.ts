import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { inspectActiveChildren } from "../src/active-children.ts";
import type { RunningSubagent } from "../src/watcher.ts";

function running(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
  return {
    id: "a1",
    name: "Worker",
    task: "do work",
    agent: "worker",
    liveAgentName: "worker-a1",
    paneId: "w1:p4",
    sessionFile: "/tmp/a1.jsonl",
    startTime: 1_000,
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

describe("active child inspection", () => {
  it("uses the correlated Herdr identity and current state", async () => {
    const active = await inspectActiveChildren(
      [running()],
      async () => ({ name: "worker-a1", kind: "pi", paneId: "w1:p4", status: "blocked" }),
      66_000,
    );

    assert.deepEqual(active, [
      {
        id: "a1",
        name: "Worker",
        state: "blocked",
        elapsedSeconds: 65,
        sessionFile: "/tmp/a1.jsonl",
        paneId: "w1:p4",
      },
    ]);
  });

  it("keeps a moved pane active when terminal identity still matches", async () => {
    const active = await inspectActiveChildren(
      [running({ terminalId: "term_abc123" } as Partial<RunningSubagent>)],
      async () => ({
        name: "worker-a1",
        kind: "pi",
        paneId: "w2:p9",
        terminalId: "term_abc123",
        status: "working",
      }),
      2_000,
    );

    assert.equal(active[0].paneId, "w2:p9");
    assert.equal(active[0].terminalId, "term_abc123");
  });

  it("drops missing and identity-mismatched Herdr agents as stale", async () => {
    const children = [running(), running({ id: "b2", liveAgentName: "worker-b2", paneId: "w1:p5" })];
    const active = await inspectActiveChildren(children, async (name) =>
      name === "worker-a1"
        ? null
        : { name, kind: "pi", paneId: "w1:p9", status: "working" },
    );

    assert.deepEqual(active, []);
  });

  it("keeps a registered child with unknown state when reconciliation is unavailable", async () => {
    const active = await inspectActiveChildren([running()], async () => {
      throw new Error("socket unavailable");
    });

    assert.equal(active[0]?.state, "unknown");
  });
});

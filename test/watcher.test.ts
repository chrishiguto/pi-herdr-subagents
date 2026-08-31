import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { watchSubagent, type RunningSubagent } from "../src/watcher.ts";
import type { PaneInfo } from "../src/herdr/client.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function running(): RunningSubagent {
  const dir = mkdtempSync(join(tmpdir(), "herdr-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    id: "sub1",
    name: "Worker",
    task: "do it",
    paneId: "w1:p4",
    terminalId: "term-1",
    liveAgentName: "worker-sub1",
    startTime: Date.now(),
    sessionFile: join(dir, "child.jsonl"),
    interactive: false,
    autoExit: true,
  };
}

function writeSession(path: string, summary = "finished cleanly") {
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "text", text: summary }] } }),
  ].join("\n") + "\n");
}

function writeSignal(
  child: RunningSubagent,
  data: { type: "done" } | { type: "ping"; name: string; message: string },
  subagentId = child.id,
) {
  writeFileSync(
    `${child.sessionFile}.exit`,
    JSON.stringify({ version: 1, subagentId, ...data }),
  );
}

function fixtures(opts?: { agentAlive?: boolean; paneAlive?: boolean }) {
  let agentAlive = opts?.agentAlive ?? true;
  let paneAlive = opts?.paneAlive ?? true;
  let listener: ((event: any) => void) | null = null;
  let reconcile: (() => void) | null = null;
  const pane: PaneInfo = { pane_id: "w1:p4" };
  return {
    deps: {
      client: {
        async agentGet() {
          return agentAlive
            ? { name: "worker-sub1", kind: "pi", paneId: pane.pane_id, terminalId: "term-1" }
            : null;
        },
        async paneGet() { return paneAlive ? pane : null; },
      },
      listPanes: async () => (paneAlive ? [pane] : []),
      stream: {
        watch(_paneId: string, cb: typeof listener) { listener = cb; return () => { listener = null; }; },
        onReconcile(cb: () => void) { reconcile = cb; return () => { reconcile = null; }; },
      },
      signal: new AbortController().signal,
      pollIntervalMs: 5,
      unsignaledGraceMs: 15,
    },
    setAgentAlive(value: boolean) { agentAlive = value; },
    fire(event: "pane_exited" | "pane_closed" | "pane_agent_released") {
      listener?.({ event, paneId: pane.pane_id });
    },
    move(nextPaneId: string) {
      const previous = pane.pane_id;
      pane.pane_id = nextPaneId;
      listener?.({
        event: "pane_moved",
        paneId: previous,
        nextPaneId,
        terminalId: "term-1",
      });
    },
    reconcile() { reconcile?.(); },
  };
}

describe("native child lifecycle watcher", () => {
  it("reports one semantic completion and preserves its sidecar for parent finalization", async () => {
    const child = running();
    writeSession(child.sessionFile, "all done");
    writeSignal(child, { type: "done" });
    const fx = fixtures();
    const outcome = await watchSubagent(child, fx.deps);
    assert.deepEqual(outcome, {
      kind: "completed",
      summary: "all done",
      exitCode: 0,
      sessionFile: child.sessionFile,
    });
    assert.equal(existsSync(`${child.sessionFile}.exit`), true);
  });

  it("reports a help ping from the semantic sidecar", async () => {
    const child = running();
    writeSignal(child, { type: "ping", name: "Worker", message: "Need input" });
    const outcome = await watchSubagent(child, fixtures().deps);
    assert.deepEqual(outcome, {
      kind: "ping",
      name: "Worker",
      message: "Need input",
      sessionFile: child.sessionFile,
    });
  });

  it("detects native Pi disappearance even when its shell pane remains", async () => {
    const child = running();
    writeSession(child.sessionFile, "last output");
    const fx = fixtures({ agentAlive: false, paneAlive: true });
    const outcome = await watchSubagent(child, fx.deps);
    assert.deepEqual(outcome, {
      kind: "unsignaled-exit",
      reason: "agent-disappeared",
      summary: "last output",
      sessionFile: child.sessionFile,
    });
  });

  it("classifies Herdr's agent-release event without waiting for the poll", async () => {
    const child = running();
    writeSession(child.sessionFile, "last output");
    const fx = fixtures();
    const promise = watchSubagent(child, fx.deps);
    fx.fire("pane_agent_released");
    assert.deepEqual(await promise, {
      kind: "unsignaled-exit",
      reason: "agent-disappeared",
      summary: "last output",
      sessionFile: child.sessionFile,
    });
  });

  it("follows a moved pane without settling the child", async () => {
    const child = running();
    const fx = fixtures();
    const promise = watchSubagent(child, fx.deps);

    fx.move("w2:p9");
    assert.equal(child.paneId, "w2:p9");
    writeSignal(child, { type: "done" });

    assert.equal((await promise).kind, "completed");
  });

  it("reports pane closure without a semantic signal honestly", async () => {
    const child = running();
    writeSession(child.sessionFile, "partial output");
    const fx = fixtures();
    const promise = watchSubagent(child, fx.deps);
    fx.fire("pane_closed");
    assert.deepEqual(await promise, {
      kind: "unsignaled-exit",
      reason: "pane-closed",
      summary: "partial output",
      sessionFile: child.sessionFile,
    });
  });

  it("cancellation settles silently", async () => {
    const child = running();
    const controller = new AbortController();
    const fx = fixtures();
    const promise = watchSubagent(child, { ...fx.deps, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await promise, { kind: "cancelled", sessionFile: child.sessionFile });
  });

  it("settles exactly once when terminal signals race", async () => {
    const child = running();
    writeSession(child.sessionFile);
    const fx = fixtures();
    const promise = watchSubagent(child, fx.deps);
    writeSignal(child, { type: "done" });
    fx.fire("pane_exited");
    const outcome = await promise;
    assert.equal(outcome.kind, "completed");
    fx.fire("pane_closed");
  });

  it("rejects and preserves a stale sidecar from another child", async () => {
    const child = running();
    writeSession(child.sessionFile, "partial output");
    writeSignal(child, { type: "done" }, "prior-run");
    const fx = fixtures({ agentAlive: false, paneAlive: true });

    const outcome = await watchSubagent(child, fx.deps);
    assert.equal(outcome.kind, "unsignaled-exit");
    assert.equal(existsSync(`${child.sessionFile}.exit`), true);
  });

  it("lets a correlated semantic signal win when disappearance arrives first", async () => {
    const child = running();
    writeSession(child.sessionFile, "won the race");
    const fx = fixtures();
    const promise = watchSubagent(child, fx.deps);

    fx.fire("pane_exited");
    writeSignal(child, { type: "done" });

    const outcome = await promise;
    assert.equal(outcome.kind, "completed");
  });

  it("bounds a large assistant summary before returning the outcome", async () => {
    const child = running();
    writeSession(child.sessionFile, "x".repeat(50_000));
    writeSignal(child, { type: "done" });

    const outcome = await watchSubagent(child, fixtures().deps);
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.ok(outcome.summary.length <= 12_000);
    assert.match(outcome.summary, /output truncated/);
  });
});

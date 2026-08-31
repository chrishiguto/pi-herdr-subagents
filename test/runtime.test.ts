import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChildLaunchError, launchNativePiChild } from "../src/runtime.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import type { ResumeLaunchPlan } from "../src/launch.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function plan(): ResumeLaunchPlan {
  const root = mkdtempSync(join(tmpdir(), "child-launcher-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    id: "abcd1234",
    name: "Worker",
    sessionFile: join(root, "sessions", "child.jsonl"),
    resumeMessageFile: join(root, "artifacts", "task.md"),
    files: [{ path: join(root, "artifacts", "task.md"), content: "Do it" }],
    paneSplit: { sourcePaneId: "w1:p1", cwd: root, env: {} },
    agentStart: { liveAgentName: "worker-abcd1234", argv: ["--session", join(root, "sessions", "child.jsonl")] },
    initialPrompts: ["@task.md"],
    interactive: false,
    autoExit: true,
  };
}

function client(overrides: Partial<HerdrClient> = {}): HerdrClient {
  return {
    async sessionSnapshot() { return { panes: [] }; },
    async ping() { return { ok: true, version: "0.8.2", protocol: 20 }; },
    async paneLayout() {
      return {
        workspace_id: "w1",
        panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 50 } }],
      };
    },
    async paneSplit() { return { pane_id: "w1:p2" }; },
    async tabCreate() { return { pane_id: "w1:p3" }; },
    async agentStart(p) { return { name: p.liveAgentName, kind: "pi", paneId: p.paneId, terminalId: "", workspaceId: "w1", tabId: "w1:t1" }; },
    async agentPrompt() {},
    async agentGet() { return null; },
    async paneGet() { return null; },
    async paneList() { return []; },
    async paneClose() {},
    async agentSendKeys() {},
    async paneReportMetadata() {},
    ...overrides,
  };
}

describe("launchNativePiChild", () => {
  it("checks Herdr compatibility before materializing files", async () => {
    const spec = plan();
    await assert.rejects(
      () => launchNativePiChild(client({ async ping() { return { ok: true, version: "0.7.1", protocol: 14 }; } }), spec),
      (error: unknown) => error instanceof ChildLaunchError && error.stage === "readiness" && error.code === "incompatible",
    );
    assert.equal(existsSync(spec.files[0].path), false);
    assert.equal(existsSync(spec.sessionFile), false);
  });

  it("materializes, starts, and submits prompts in order", async () => {
    const spec = plan();
    const calls: string[] = [];
    const started = await launchNativePiChild(client({
      async paneSplit() { calls.push("split"); return { pane_id: "w1:p2" }; },
      async agentStart(p) { calls.push("start"); return { name: p.liveAgentName, kind: "pi", paneId: p.paneId, terminalId: "", workspaceId: "w1", tabId: "w1:t1" }; },
      async agentPrompt() { calls.push("prompt"); },
    }), spec);
    assert.deepEqual(calls, ["split", "start", "prompt"]);
    assert.equal(started.name, "worker-abcd1234");
    assert.equal(existsSync(spec.files[0].path), true);
  });

  it("uses a new background tab when the source pane cannot be split safely", async () => {
    const spec = plan();
    const calls: string[] = [];
    const started = await launchNativePiChild(client({
      async paneLayout() {
        return {
          workspace_id: "w1",
          panes: [{ pane_id: "w1:p1", rect: { width: 80, height: 20 } }],
        };
      },
      async paneSplit() { throw new Error("must not split"); },
      async tabCreate(p) {
        calls.push(`${p.workspaceId}:${p.cwd}`);
        return { pane_id: "w1:p3" };
      },
    }), spec);

    assert.equal(started.paneId, "w1:p3");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^w1:/);
  });

  it("marks cleanup unconfirmed when prompt failure leaves the pane open", async () => {
    const spec = plan();
    await assert.rejects(
      () => launchNativePiChild(client({
        async agentPrompt() { throw new Error("prompt transport failed"); },
        async paneClose() { throw new Error("close transport failed"); },
      }), spec),
      (error: unknown) =>
        error instanceof ChildLaunchError &&
        error.stage === "agent" &&
        error.cleanupConfirmed === false,
    );
  });

  it("closes the created pane when Pi start fails", async () => {
    const spec = plan();
    let closed = "";
    await assert.rejects(
      () => launchNativePiChild(client({
        async agentStart() { throw new Error("bad model"); },
        async paneClose(paneId) { closed = paneId; },
      }), spec),
      (error: unknown) => error instanceof ChildLaunchError && error.stage === "agent",
    );
    assert.equal(closed, "w1:p2");
  });
});

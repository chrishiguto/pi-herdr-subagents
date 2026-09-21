// Spawn tool behavior: launch wiring, outcome->steer delivery, and
// session/generation replacement semantics.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import herdrSubagents from "../extensions/herdr-subagents/index.ts";
import { __test__ } from "../src/orchestrator.ts";
import { createSubagentActivityTracker } from "../src/runtime-events.ts";
import {
  DURABLE_STATE_VERSION,
  readDurableRecords,
  writeDurableRecord,
} from "../src/durable-state.ts";
import type { SubagentOutcome } from "../src/watcher.ts";
import {
  createFakePi,
  envInsideHerdr,
  installOrchestratorHooks,
  makeFakeClient,
  makeFakeCtx,
  makeFakeStream,
  makeSpawnFixture,
  registerAndGetTool,
  waitFor,
} from "./orchestrator-fixtures.ts";

installOrchestratorHooks();

describe("index: subagent tool", () => {

  it("self-spawn is blocked", async () => {
    const { tool } = registerAndGetTool();
    process.env.PI_SUBAGENT_AGENT = "worker";
    const { ctx } = makeFakeCtx();

    const result = await tool.execute(
      "t1",
      { name: "Worker 2", task: "do it", agent: "worker" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "self-spawn blocked");
    assert.match(result.content[0].text, /worker/);
  });

  it("requires a persistent session file", async () => {
    const { tool } = registerAndGetTool();
    const { ctx } = makeFakeCtx({ sessionFile: null });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "no session file");
  });

  it("spawn: writes plan files, starts herdr agent, returns fire-and-forget ack", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    const agentStartCalls: any[] = [];
    let watchedStream: unknown = null;
    const fakeStream = makeFakeStream();
    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async (p: any) => {
          agentStartCalls.push(p);
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
      watch: async (_running: any, deps: any): Promise<SubagentOutcome> => {
        watchedStream = deps.stream;
        return { kind: "completed", summary: "did the thing", exitCode: 0 };
      },
      createStream: () => fakeStream as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(result.details.paneId, "w1:p9");
    assert.equal(result.details.name, "Worker");
    assert.ok(result.details.sessionFile.endsWith(".jsonl"));
    assert.equal(typeof result.details.liveAgentName, "string");
    assert.match(result.content[0].text, /launched and is now running/);

    // argv launch through the client
    assert.equal(agentStartCalls.length, 1);
    assert.equal(agentStartCalls[0].paneId, "w1:p9");
    assert.equal(agentStartCalls[0].argv[0], "--session");
    assert.ok(agentStartCalls[0].argv.includes(result.details.sessionFile));

    // watcher armed against the shared event stream
    await waitFor(() => watchedStream !== null);
    assert.equal(watchedStream, fakeStream);
  });

  it("interactive launch disables automatic exit in the child runtime", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const paneSplits: any[] = [];

    __test__.setDeps({
      client: makeFakeClient({
        paneSplit: async (params: any) => {
          paneSplits.push(params);
          return { pane_id: "w1:p9", terminal_id: "term1", workspace_id: "w1", tab_id: "t1" };
        },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      {
        name: "Iterate",
        task: "Fix the bug",
        contextMode: "fork",
        interactive: true,
      },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(result.details.contextMode, "fork");
    assert.equal(paneSplits.length, 1);
    assert.equal(paneSplits[0].env.PI_SUBAGENT_INTERACTIVE, "1");
    assert.equal(paneSplits[0].env.PI_SUBAGENT_AUTO_EXIT, undefined);
  });

  it("expands a portable workflow inside the child as its first prompt", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const prompts: string[] = [];
    __test__.setDeps({
      client: makeFakeClient({
        agentPrompt: async (_target: string, prompt: string) => { prompts.push(prompt); },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      {
        name: "Implement",
        task: "Implement issue 42",
        workflow: { kind: "skill", name: "implement" },
      },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.deepEqual(prompts, ["/skill:implement Implement issue 42"]);
    assert.deepEqual(result.details.workflow, { kind: "skill", name: "implement" });
  });

  it("compiles a prompt-template workflow without pre-validating the child catalog", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const prompts: string[] = [];
    __test__.setDeps({
      client: makeFakeClient({
        agentPrompt: async (_target: string, prompt: string) => { prompts.push(prompt); },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Deploy", task: "ship", workflow: { kind: "prompt", name: "deploy" } },
      undefined,
      undefined,
      fx.ctx,
    );

    // A missing command fails visibly inside the child; the spawn itself proceeds.
    assert.equal(result.details.status, "started");
    assert.deepEqual(prompts, ["/deploy ship"]);
  });

  it("outcome wiring: completed outcome → subagent_result steer wakes the orchestrator", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        writeFileSync(
          `${running.sessionFile}.context-usage`,
          JSON.stringify({
            version: 1,
            subagentId: running.id,
            tokens: 75_000,
            contextWindow: 200_000,
            percent: 37.5,
          }),
        );
        return {
          kind: "completed",
          summary: "did the thing",
          exitCode: 0,
        };
      },
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => fake.sent.length === 1);

    const { message, options } = fake.sent[0];
    assert.equal(message.customType, "subagent_result");
    assert.match(message.content, /completed/);
    assert.match(message.content, /did the thing/);
    assert.match(message.content, /Context: 75,000\/200,000 tokens/);
    assert.deepEqual(message.details.contextUsage, {
      version: 1,
      subagentId: result.details.id,
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
    assert.equal(
      existsSync(`${result.details.sessionFile}.context-usage`),
      false,
      "telemetry is consumed after the terminal outcome",
    );
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(__test__.runningSubagents.size, 0);
  });

  it("outcome wiring: waits for Herdr's release event before closing the child pane", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const closed: string[] = [];
    let paneListener: ((event: { event: string; paneId: string }) => void) | undefined;
    const stream = {
      watch(_paneId: string, listener: typeof paneListener) {
        paneListener = listener;
        return () => {};
      },
      onReconcile() {
        return () => {};
      },
      close() {},
      connected: true,
    };

    __test__.setDeps({
      client: makeFakeClient({
        agentGet: async (target: string) => ({
          name: target,
          kind: "pi",
          paneId: "w1:p9",
          status: "working",
        }),
        paneClose: async (paneId: string) => {
          closed.push(paneId);
        },
      }),
      watch: async (): Promise<SubagentOutcome> => ({
        kind: "completed",
        summary: "did the thing",
        exitCode: 0,
      }),
      createStream: () => stream as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => fake.sent.length === 1 && paneListener !== undefined);
    assert.deepEqual(closed, [], "a live child must not be SIGHUPed during shutdown");

    paneListener!({ event: "pane_agent_released", paneId: result.details.paneId });
    await waitFor(() => closed.length === 1);
    assert.deepEqual(closed, [result.details.paneId]);
  });

  it("outcome wiring: cancelled outcome leaves the child pane for reattach", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const lifecycle: string[] = [];

    __test__.setDeps({
      client: makeFakeClient({
        paneClose: async (paneId: string) => {
          lifecycle.push(`close:${paneId}`);
        },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => __test__.runningSubagents.size === 0);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lifecycle, []);
  });

  it("delivers exactly once after the parent switches sessions", async () => {
    const { fake, tool } = registerAndGetTool();
    const previous = makeSpawnFixture();
    const currentSessionDir = join(previous.root, "current-sessions");
    mkdirSync(currentSessionDir, { recursive: true });
    const currentSessionFile = join(currentSessionDir, "parent.jsonl");
    writeFileSync(
      currentSessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "current" })}\n`,
    );
    const { ctx: currentCtx } = makeFakeCtx({
      cwd: previous.cwd,
      sessionFile: currentSessionFile,
      sessionDir: currentSessionDir,
      sessionId: "current-session-id",
    });
    const stateDir = __test__.getDurableStateDir(currentSessionDir, "current-session-id");

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        writeFileSync(
          `${running.sessionFile}.exit`,
          JSON.stringify({ version: 1, subagentId: running.id, type: "done" }),
        );
        return { kind: "completed", summary: "survived session switch", exitCode: 0 };
      },
      createStream: () => makeFakeStream() as any,
    });

    fake.fire("session_start", { reason: "startup" }, previous.ctx);
    fake.fire("session_shutdown", {}, previous.ctx);
    fake.fire("session_start", { reason: "new" }, currentCtx);

    const result = await tool.execute(
      "after-new",
      { name: "Worker", task: "do it after /new" },
      undefined,
      undefined,
      currentCtx,
    );
    await waitFor(() => fake.sent.length === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(fake.sent.length, 1);
    assert.equal(
      fake.appended.filter(
        (entry) => entry.customType === "herdr-subagent" &&
          (entry.data as any)?.state === "reported" &&
          (entry.data as any)?.id === result.details.id,
      ).length,
      1,
    );
    assert.deepEqual(readDurableRecords(stateDir), []);
    assert.equal(existsSync(`${result.details.sessionFile}.exit`), false);
  });

  it("delivers the terminal steer before marking its durable record reported", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(fx.sessionDir, "orch-session-id");
    let recordCountAtDelivery = -1;
    const sendMessage = fake.api.sendMessage.bind(fake.api);
    fake.api.sendMessage = (message: any, options: any) => {
      recordCountAtDelivery = readDurableRecords(stateDir).length;
      sendMessage(message, options);
    };
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        writeFileSync(
          `${running.sessionFile}.exit`,
          JSON.stringify({ version: 1, subagentId: running.id, type: "done" }),
        );
        return {
          kind: "completed",
          summary: "delivered",
          exitCode: 0,
        };
      },
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => fake.sent.length === 1);

    assert.equal(recordCountAtDelivery, 1, "record must survive until delivery");
    assert.deepEqual(readDurableRecords(stateDir), []);
    assert.equal(existsSync(`${result.details.sessionFile}.exit`), false);
  });

  it("retains a recoverable record when steer delivery fails", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(fx.sessionDir, "orch-session-id");
    let deliveryAttempted = false;
    fake.api.sendMessage = () => {
      deliveryAttempted = true;
      throw new Error("delivery unavailable");
    };
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        writeFileSync(
          `${running.sessionFile}.exit`,
          JSON.stringify({ version: 1, subagentId: running.id, type: "done" }),
        );
        return {
          kind: "completed",
          summary: "recover me",
          exitCode: 0,
        };
      },
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => deliveryAttempted);

    assert.equal(readDurableRecords(stateDir).length, 1, "record must remain for recovery");
    assert.equal(
      existsSync(`${result.details.sessionFile}.exit`),
      true,
      "semantic sidecar must remain recoverable when delivery fails",
    );
  });

  it("does not deliver from an obsolete runtime during the deferred acknowledgement gap", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(fx.sessionDir, "orch-session-id");
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => ({
        kind: "completed",
        summary: "deferred",
        exitCode: 0,
      }),
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await Promise.resolve();
    __test__.reset();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(fake.sent, []);
    assert.equal(readDurableRecords(stateDir).length, 1, "record must remain for recovery");
    assert.equal(
      fake.appended.filter((entry) => (entry.data as any)?.state === "retained").length,
      1,
      "obsolete delivery is observable in transcript history",
    );
  });

  it("a duplicate load obsoletes only the previous source generation", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(fx.sessionDir, "orch-session-id");
    let settle!: (outcome: SubagentOutcome) => void;
    const pending = new Promise<SubagentOutcome>((resolve) => { settle = resolve; });
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async () => pending,
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("duplicate-load", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    const replacement = await import(`../src/orchestrator.ts?reload=${Date.now()}`);
    settle({ kind: "completed", summary: "old generation", exitCode: 0 });
    await waitFor(() => __test__.runningSubagents.size === 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(fake.sent, []);
    assert.equal(readDurableRecords(stateDir).length, 1);

    // "only": the replacement generation is live — it recovers the retained
    // record and delivers the honest outcome the old generation withheld.
    replacement.__test__.setDeps({
      client: makeFakeClient({
        agentGet: async () => null,
        paneGet: async () => null,
      }),
      createStream: () => makeFakeStream() as any,
    });
    await replacement.__test__.recoverChildren(fake.api, fx.ctx);
    // (deepEqual above narrowed fake.sent to never[]; widen for the content check)
    const delivered = fake.sent as Array<{ message: { content: string } }>;
    assert.equal(delivered.length, 1, "replacement generation must deliver");
    assert.match(delivered[0].message.content, /Worker/);
    assert.deepEqual(readDurableRecords(stateDir), []);
    replacement.__test__.reset();
  });

  it("keeps the durable record recoverable when the lifecycle observer fails", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(fx.sessionDir, "orch-session-id");
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => {
        throw new Error("observer disconnected");
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => fake.sent.length === 1);

    assert.equal(readDurableRecords(stateDir).length, 1, "record must remain for recovery");
  });

  it("routes nested help and failure outcomes only to their direct parent Pi", async () => {
    const { fake: directParent, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    let settle!: (outcome: SubagentOutcome) => void;
    const pending = new Promise<SubagentOutcome>((resolve) => {
      settle = resolve;
    });
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async () => pending,
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute(
      "nested-call",
      { name: "Grandchild", task: "nested work" },
      undefined,
      undefined,
      fx.ctx,
    );

    // A second extension instance represents an unrelated/root Pi runtime.
    // Completion must remain captured by the direct parent's ExtensionAPI.
    const root = createFakePi();
    herdrSubagents(root.api);
    settle({ kind: "ping", name: "Grandchild", message: "need direct parent" });
    await waitFor(() => directParent.sent.length === 1);

    assert.equal(directParent.sent[0].message.customType, "subagent_ping");
    assert.match(directParent.sent[0].message.content, /need direct parent/);
    assert.deepEqual(directParent.sent[0].options, {
      triggerTurn: true,
      deliverAs: "steer",
    });
    assert.deepEqual(root.sent, []);

    __test__.setDeps({
      watch: async () => ({
        kind: "unsignaled-exit",
        reason: "agent-disappeared",
        summary: "nested failure",
      }),
    });
    await tool.execute(
      "nested-failure",
      { name: "Failing grandchild", task: "fail honestly" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => directParent.sent.length === 2);

    assert.equal(directParent.sent[1].message.customType, "subagent_result");
    assert.equal(directParent.sent[1].message.details.disposition, "unsignaled-exit");
    assert.match(directParent.sent[1].message.content, /nested failure/);
    assert.deepEqual(root.sent, []);
  });

  it("rejects and removes stale context usage from another resume id", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let telemetryPath = "";
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        telemetryPath = `${running.sessionFile}.context-usage`;
        writeFileSync(
          telemetryPath,
          JSON.stringify({
            version: 1,
            subagentId: "previous-launch-id",
            tokens: 90_000,
            contextWindow: 100_000,
            percent: 90,
          }),
        );
        return { kind: "completed", summary: "done", exitCode: 0 };
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await waitFor(() => fake.sent.length === 1);

    assert.doesNotMatch(fake.sent[0].message.content, /Context:/);
    assert.equal("contextUsage" in fake.sent[0].message.details, false);
    assert.equal(existsSync(telemetryPath), false, "stale telemetry is consumed");
  });

  it("publishes active watcher transitions on Pi's event bus", async () => {
    const { fake, tool } = registerAndGetTool();
    const tracker = createSubagentActivityTracker(fake.events);
    const fx = makeSpawnFixture();

    let settle!: (outcome: SubagentOutcome) => void;
    const pending = new Promise<SubagentOutcome>((resolve) => {
      settle = resolve;
    });
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async () => pending,
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    assert.equal(tracker.count(), 1);

    settle({ kind: "completed", summary: "done", exitCode: 0 });
    await waitFor(() => __test__.runningSubagents.size === 0);
    assert.equal(tracker.count(), 0);
    tracker.close();
  });

  it("cancelled outcome sends no steer message", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let watched = false;
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => {
        watched = true;
        return { kind: "cancelled" };
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await waitFor(() => watched && __test__.runningSubagents.size === 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.sent.length, 0);
  });

  it("agentStart failure closes the created pane and registers nothing", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    const closed: string[] = [];

    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async () => {
          throw new Error("connection refused");
        },
        paneClose: async (paneId: string) => {
          closed.push(paneId);
        },
      }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /connection refused/);
    assert.ok(result.details.error);
    assert.deepEqual(closed, ["w1:p9"]);
    assert.equal(__test__.runningSubagents.size, 0);
    assert.equal(fake.sent.length, 0);
  });

  it("rejects unsupported Herdr before creating a pane", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    let splitCalls = 0;
    __test__.setDeps({
      client: makeFakeClient({
        ping: async () => ({ ok: true, version: "0.7.1", protocol: 14 }),
        paneSplit: async () => {
          splitCalls++;
          throw new Error("must not run");
        },
      }),
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.error, "incompatible");
    assert.match(result.content[0].text, /Herdr >=0\.8\.2 <0\.9.*protocol 20/);
    assert.equal(splitCalls, 0);
  });

  it("unsupported cli agent def returns a clear error", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    mkdirSync(join(fx.agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(fx.agentDir, "agents", "claudey.md"),
      "---\nname: claudey\ncli: claude\n---\nBody\n",
    );

    __test__.setDeps({ client: makeFakeClient(), createStream: () => makeFakeStream() as any });

    const result = await tool.execute(
      "t1",
      { name: "C", task: "x", agent: "claudey" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /not supported/);
  });
});

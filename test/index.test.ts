import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import herdrSubagents, { __test__ } from "../extensions/herdr-subagents/index.ts";
import { createSubagentActivityTracker } from "../src/runtime-events.ts";
import {
  DURABLE_STATE_VERSION,
  readDurableRecords,
  writeDurableRecord,
} from "../src/durable-state.ts";
import type { SubagentOutcome } from "../src/watcher.ts";

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "herdr-subagents", "index.ts");

// ── env management ─────────────────────────────────────────────────────────
// These tests may themselves run inside herdr / a subagent — always set or
// delete every relevant key explicitly, and restore afterwards.

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_INTERACTIVE",
  "PI_HERDR_PI_BIN",
  "PI_CODING_AGENT_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();
const cleanups: Array<() => void> = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  __test__.reset();
  while (cleanups.length > 0) cleanups.pop()!();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function envInsideHerdr(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr-test.sock";
}

// ── fakes ──────────────────────────────────────────────────────────────────

interface FakeToolInfo {
  name: string;
  sourceInfo?: { path: string };
}

function createFakePi(opts?: { allTools?: FakeToolInfo[]; slashCommands?: any[] }) {
  const registeredTools: any[] = [];
  const commands: Array<{ name: string; handler: Function }> = [];
  const renderers = new Map<string, unknown>();
  const handlers = new Map<string, Function[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const sentUser: string[] = [];
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    emit(channel: string, data: unknown) {
      for (const handler of eventHandlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const set = eventHandlers.get(channel) ?? new Set();
      set.add(handler);
      eventHandlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
  let allTools: FakeToolInfo[] | null = opts?.allTools ?? null;

  const api: any = {
    events,
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, ...options });
    },
    registerMessageRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
    registerShortcut() {},
    appendEntry() {},
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
    sendUserMessage(text: string) {
      sentUser.push(text);
    },
    getAllTools(): FakeToolInfo[] {
      if (allTools) return allTools;
      return registeredTools.map((t) => ({ name: t.name, sourceInfo: { path: INDEX_PATH } }));
    },
    getCommands() {
      return opts?.slashCommands ?? [];
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  return {
    api,
    registeredTools,
    commands,
    renderers,
    sent,
    sentUser,
    events,
    setAllTools(tools: FakeToolInfo[]) {
      allTools = tools;
    },
    toolNames(): string[] {
      return registeredTools.map((t) => t.name);
    },
    findTool(name: string) {
      return registeredTools.find((t) => t.name === name);
    },
    fire(event: string, eventObj: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(eventObj, ctx);
    },
  };
}

function makeFakeCtx(overrides?: {
  cwd?: string;
  sessionFile?: string | null;
  sessionDir?: string;
  sessionId?: string;
}) {
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    hasUI: false,
    cwd: overrides?.cwd ?? "/tmp",
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      setWidget() {},
    },
    sessionManager: {
      getSessionFile: () =>
        overrides?.sessionFile !== undefined ? overrides.sessionFile : "/tmp/orch.jsonl",
      getSessionId: () => overrides?.sessionId ?? "orch-session-id",
      getSessionDir: () => overrides?.sessionDir ?? "/tmp/orch-sessions",
      getLeafId: () => null,
    },
    modelRegistry: { getAvailable: () => [] },
  };
  return { ctx, notifications };
}

function makeFakeClient(overrides?: Partial<Record<string, Function>>) {
  return {
    async paneLayout() {
      return { workspace_id: "w1", panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 50 } }] };
    },
    async paneSplit() {
      return { pane_id: "w1:p9", terminal_id: "term1", workspace_id: "w1", tab_id: "t1" };
    },
    async tabCreate() {
      return { pane_id: "w1:p9", terminal_id: "term1", workspace_id: "w1", tab_id: "t1" };
    },
    async agentStart() {
      return { paneId: "w1:p9", terminalId: "term1", workspaceId: "w1", tabId: "t1" };
    },
    async agentPrompt() {},
    async agentGet() {
      return null;
    },
    async paneGet() {
      return null;
    },
    async paneList() {
      return [];
    },
    async paneClose() {},
    async agentSendKeys() {},
    async paneReportMetadata() {},
    async ping() {
      return { ok: true, version: "0.8.2", protocol: 20 };
    },
    ...overrides,
  } as any;
}

function makeFakeStream() {
  return {
    watch() {
      return () => {};
    },
    onReconcile() {
      return () => {};
    },
    close() {},
    connected: false,
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── fixture for real-launch-plan spawns ────────────────────────────────────

function makeSpawnFixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-index-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const agentDir = join(root, "agent-config");
  mkdirSync(agentDir, { recursive: true });
  const sessionDir = join(root, "orch-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const parentSessionFile = join(sessionDir, "parent.jsonl");
  writeFileSync(parentSessionFile, JSON.stringify({ type: "session", version: 3, id: "p1" }) + "\n");

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HERDR_PI_BIN = "/usr/local/bin/pi-fake";

  const { ctx, notifications } = makeFakeCtx({
    cwd,
    sessionFile: parentSessionFile,
    sessionDir,
    sessionId: "orch-session-id",
  });
  return { root, cwd, agentDir, sessionDir, parentSessionFile, ctx, notifications };
}

// ── activation guard ───────────────────────────────────────────────────────

describe("index: activation guard", () => {
  it("not inside herdr → only setup-hint stubs registered at load", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.deepEqual(fake.toolNames().sort(), [
      "subagent",
      "subagent_interrupt",
      "subagent_resume",
      "subagents_list",
    ]);
  });

  it("inside herdr → subagent tool registered at load", () => {
    envInsideHerdr();
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.toolNames().includes("subagent"));
  });

  it("outside herdr: registers setup-hint stubs at load", async () => {
    const fake = createFakePi({ allTools: [] });
    herdrSubagents(fake.api);

    const { ctx } = makeFakeCtx();
    const stub = fake.findTool("subagent");
    assert.ok(stub, "expected a subagent setup-hint stub");
    const result = await stub.execute("t1", { name: "X", task: "y" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /herdr/i);
    assert.equal(result.details.error, "not in herdr");
  });

  it("PI_DENY_TOOLS=subagent suppresses registration inside herdr", () => {
    envInsideHerdr();
    process.env.PI_DENY_TOOLS = "subagent";
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(!fake.toolNames().includes("subagent"));
    // other spawning tools are gated individually, not as a block
    assert.ok(fake.toolNames().includes("subagent_interrupt"));
    assert.ok(fake.toolNames().includes("subagents_list"));
  });

  it("a nesting-denied child cannot register any delegation lifecycle tool", () => {
    envInsideHerdr();
    process.env.PI_DENY_TOOLS =
      "subagent,subagent_interrupt,subagents_list,subagent_resume";
    const fake = createFakePi();
    herdrSubagents(fake.api);

    assert.deepEqual(
      fake.toolNames().filter((name) =>
        ["subagent", "subagent_interrupt", "subagents_list", "subagent_resume"].includes(name),
      ),
      [],
    );
  });

  it("inside herdr with unreachable socket → visible notify from session_start ping", async () => {
    envInsideHerdr();
    __test__.setDeps({
      client: makeFakeClient({
        ping: async () => ({ ok: false, version: null, protocol: null }),
      }),
    });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    await waitFor(() => notifications.length > 0);
    assert.match(notifications[0].message, /herdr/i);
  });
});

// ── subagent tool execute ──────────────────────────────────────────────────

describe("index: subagent tool", () => {
  function registerAndGetTool(opts?: Parameters<typeof createFakePi>[0]) {
    envInsideHerdr();
    const fake = createFakePi(opts);
    herdrSubagents(fake.api);
    const tool = fake.findTool("subagent");
    assert.ok(tool, "subagent tool must be registered");
    return { fake, tool };
  }

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

describe("index: durable recovery", () => {
  it("consumes a completion that arrived during reload and reports it once", async () => {
    envInsideHerdr();
    const fake = createFakePi();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(
      fx.ctx.sessionManager.getSessionDir(),
      fx.ctx.sessionManager.getSessionId(),
    );
    const sessionFile = join(fx.root, "recovered.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "recovered summary" }] },
      }) + "\n",
    );
    writeDurableRecord(stateDir, {
      version: DURABLE_STATE_VERSION,
      id: "recover-1",
      name: "Recovered",
      task: "finish work",
      paneId: "w1:p8",
      liveAgentName: "recovered-1",
      sessionFile,
      lifecycleMode: "autonomous",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ version: 1, subagentId: "recover-1", type: "done" }),
    );
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => ({
        kind: "completed",
        summary: "recovered summary",
        exitCode: 0,
      }),
      createStream: () => makeFakeStream() as any,
    });

    await __test__.recoverChildren(fake.api, fx.ctx);
    await waitFor(() => fake.sent.length === 1);

    assert.match(fake.sent[0].message.content, /recovered summary/);
    assert.equal(fake.sent[0].message.details.sessionFile, sessionFile);
    assert.deepEqual(readDurableRecords(stateDir), []);
    assert.equal(existsSync(`${sessionFile}.exit`), false);
    await __test__.recoverChildren(fake.api, fx.ctx);
    assert.equal(fake.sent.length, 1);
  });

  it("delivers a recovered terminal outcome before finalizing its record", async () => {
    envInsideHerdr();
    const fake = createFakePi();
    const fx = makeSpawnFixture();
    const stateDir = __test__.getDurableStateDir(
      fx.ctx.sessionManager.getSessionDir(),
      fx.ctx.sessionManager.getSessionId(),
    );
    const sessionFile = join(fx.root, "missing-child.jsonl");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "child" })}\n`);
    writeDurableRecord(stateDir, {
      version: DURABLE_STATE_VERSION,
      id: "recover-missing",
      name: "Missing",
      task: "finish work",
      paneId: "w1:p8",
      liveAgentName: "missing-agent",
      sessionFile,
      lifecycleMode: "autonomous",
      createdAt: new Date().toISOString(),
    });
    let recordCountAtDelivery = -1;
    const sendMessage = fake.api.sendMessage.bind(fake.api);
    fake.api.sendMessage = (message: any, options: any) => {
      recordCountAtDelivery = readDurableRecords(stateDir).length;
      sendMessage(message, options);
    };
    __test__.setDeps({
      client: makeFakeClient({ agentGet: async () => null }),
      createStream: () => makeFakeStream() as any,
    });

    await __test__.recoverChildren(fake.api, fx.ctx);

    assert.equal(fake.sent.length, 1);
    assert.equal(recordCountAtDelivery, 1, "record must survive until delivery");
    assert.deepEqual(readDurableRecords(stateDir), []);
  });
});

// ── steer message renderers ────────────────────────────────────────────────

describe("index: renderers", () => {
  it("registers subagent_result and subagent_ping renderers", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.renderers.has("subagent_result"));
    assert.ok(fake.renderers.has("subagent_ping"));
  });
});

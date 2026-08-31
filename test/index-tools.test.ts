import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../extensions/herdr-subagents/index.ts";
import type { RunningSubagent, SubagentOutcome } from "../src/watcher.ts";

// ── env management (same discipline as index.test.ts) ──────────────────────

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

function createFakePi() {
  const registeredTools: any[] = [];
  const commands: Array<{ name: string; handler: Function }> = [];
  const handlers = new Map<string, Function[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const sentUser: string[] = [];
  const extensionEventHandlers = new Map<string, Function[]>();

  const api: any = {
    events: {
      on(event: string, handler: Function) {
        extensionEventHandlers.set(event, [
          ...(extensionEventHandlers.get(event) ?? []),
          handler,
        ]);
        return () => {};
      },
      emit(event: string, data: unknown) {
        for (const handler of extensionEventHandlers.get(event) ?? []) handler(data);
      },
    },
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, ...options });
    },
    registerMessageRenderer() {},
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
    getAllTools() {
      return registeredTools.map((t) => ({ name: t.name }));
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  return {
    api,
    registeredTools,
    commands,
    sent,
    sentUser,
    findTool(name: string) {
      return registeredTools.find((t) => t.name === name);
    },
    findCommand(name: string) {
      return commands.find((c) => c.name === name);
    },
    fire(event: string, eventObj: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(eventObj, ctx);
    },
  };
}

function makeFakeCtx(overrides?: { cwd?: string; sessionDir?: string; sessionFile?: string; leafId?: string | null }) {
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
      getSessionFile: () => overrides?.sessionFile ?? "/tmp/orch.jsonl",
      getSessionId: () => "orch-session-id",
      getSessionDir: () => overrides?.sessionDir ?? "/tmp/orch-sessions",
      getLeafId: () => overrides?.leafId ?? null,
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
      return { pane_id: "w1:p9", terminal_id: "", workspace_id: "", tab_id: "" };
    },
    async tabCreate() {
      return { pane_id: "w1:p9", terminal_id: "", workspace_id: "w1", tab_id: "" };
    },
    async agentStart() {
      return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
    },
    async agentPrompt() {},
    async agentGet(target: string) {
      return { name: target, kind: "pi", paneId: "w1:p4", status: "working" };
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

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-tools-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const agentDir = join(root, "agent-config");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  const sessionDir = join(root, "orch-sessions");
  mkdirSync(sessionDir, { recursive: true });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HERDR_PI_BIN = "/usr/local/bin/pi-fake";

  const parentSessionFile = join(root, "parent.jsonl");
  writeChildSession(parentSessionFile, "parent context");
  const { ctx, notifications } = makeFakeCtx({
    cwd,
    sessionDir,
    sessionFile: parentSessionFile,
    leafId: "m2",
  });
  return { root, cwd, agentDir, sessionDir, ctx, notifications };
}

function makeRunning(overrides?: Partial<RunningSubagent>): RunningSubagent {
  return {
    id: "a1",
    name: "Worker",
    task: "do it",
    paneId: "w1:p4",
    liveAgentName: "worker-a1",
    startTime: Date.now(),
    sessionFile: "/tmp/a1.jsonl",
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

function writeChildSession(sessionFile: string, assistantText: string): void {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: "task" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
    }),
  ];
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

function appendAssistantEntry(sessionFile: string, text: string): void {
  appendFileSync(
    sessionFile,
    JSON.stringify({
      type: "message",
      id: `m${Math.random().toString(16).slice(2, 6)}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

function registerAll() {
  envInsideHerdr();
  const fake = createFakePi();
  herdrSubagents(fake.api);
  return fake;
}

// ── registration surface ────────────────────────────────────────────────────

describe("index tools: registration", () => {
  it("registers all four orchestrator tools inside herdr", () => {
    const fake = registerAll();
    const names = fake.registeredTools.map((t) => t.name);
    for (const name of ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"]) {
      assert.ok(names.includes(name), `expected ${name} to be registered`);
    }
  });

  it("registers /subagent and /iterate commands inside herdr", () => {
    const fake = registerAll();
    assert.ok(fake.findCommand("subagent"));
    assert.ok(fake.findCommand("iterate"));
  });
});

// ── subagent_interrupt ──────────────────────────────────────────────────────

describe("index tools: subagent_interrupt", () => {
  it("resolveTarget resolves by exact id and reports ambiguity/missing", () => {
    const map = __test__.runningSubagents;
    map.clear();
    try {
      map.set("a1", makeRunning({ id: "a1", name: "Worker" }));
      map.set("b2", makeRunning({ id: "b2", name: "Worker" }));
      map.set("c3", makeRunning({ id: "c3", name: "Scout" }));

      const byId = __test__.resolveTarget({ id: "c3", name: "Worker" }) as any;
      assert.equal(byId.ok, true);
      assert.equal(byId.child.id, "c3");

      const byName = __test__.resolveTarget({ name: "Scout" }) as any;
      assert.equal(byName.child.id, "c3");

      const ambiguous = __test__.resolveTarget({ name: "Worker" }) as any;
      assert.equal(ambiguous.reason, "ambiguous");
      assert.match(ambiguous.message, /Ambiguous subagent name/);

      const missingId = __test__.resolveTarget({ id: "zz" }) as any;
      assert.equal(missingId.reason, "missing");
      assert.match(missingId.message, /No running subagent with id/);

      const missingName = __test__.resolveTarget({ name: "Nope" }) as any;
      assert.match(missingName.message, /No running subagent named/);

      const noParams = __test__.resolveTarget({}) as any;
      assert.match(noParams.message, /id or exact display name/);
    } finally {
      map.clear();
    }
  });

  it("interrupt sends Escape via herdr agent send-keys and keeps the entry alive", async () => {
    const fake = registerAll();
    const sendKeysCalls: Array<{ target: string; keys: string[] }> = [];
    __test__.setDeps({
      client: makeFakeClient({
        agentSendKeys: async (target: string, keys: string[]) => {
          sendKeysCalls.push({ target, keys });
        },
      }),
    });
    __test__.runningSubagents.set("a1", makeRunning({ id: "a1", paneId: "w1:p4" }));

    const tool = fake.findTool("subagent_interrupt");
    const result = await tool.execute("t1", { id: "a1" }, undefined, undefined, makeFakeCtx().ctx);

    assert.equal(result.details.status, "interrupt_requested");
    assert.deepEqual(sendKeysCalls, [{ target: "worker-a1", keys: ["esc"] }]);
    assert.ok(__test__.runningSubagents.has("a1"), "entry stays alive (ack-only semantics)");
    assert.equal(fake.sent.length, 0, "no steer emitted for an interrupt");
  });

  it("interrupt with unknown id returns an error result", async () => {
    const fake = registerAll();
    const tool = fake.findTool("subagent_interrupt");
    const result = await tool.execute("t1", { id: "nope" }, undefined, undefined, makeFakeCtx().ctx);
    assert.match(result.details.error, /No running subagent with id/);
  });

  it("Escape delivery failure returns an explicit error", async () => {
    const fake = registerAll();
    __test__.setDeps({
      client: makeFakeClient({
        agentSendKeys: async () => {
          throw new Error("socket write failed");
        },
      }),
    });
    __test__.runningSubagents.set("a1", makeRunning({ id: "a1" }));

    const tool = fake.findTool("subagent_interrupt");
    const result = await tool.execute("t1", { id: "a1" }, undefined, undefined, makeFakeCtx().ctx);

    assert.match(result.details.error, /socket write failed/);
    assert.match(result.content[0].text, /Failed to send Escape/);
  });

  it("does not send Escape or mutate lifecycle state when identity no longer matches", async () => {
    const fake = registerAll();
    let sent = false;
    __test__.runningSubagents.set("a1", makeRunning({ id: "a1", paneId: "w1:p4" }));
    __test__.setDeps({
      client: makeFakeClient({
        agentGet: async () => ({
          name: "replacement-agent",
          kind: "pi",
          paneId: "w1:p4",
          status: "working",
        }),
        agentSendKeys: async () => {
          sent = true;
        },
      }),
    });

    const result = await fake.findTool("subagent_interrupt").execute("t1", { id: "a1" });

    assert.equal(sent, false);
    assert.match(result.content[0].text, /no longer active in Herdr/);
    assert.equal(__test__.runningSubagents.has("a1"), true);
  });
});

// ── subagent_resume ─────────────────────────────────────────────────────────

describe("index tools: subagent_resume", () => {
  it("resolveResumeLaunchBehavior defaults to auto-exit, non-interactive", () => {
    assert.deepEqual(__test__.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(__test__.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("rejects a missing session file", async () => {
    const fake = registerAll();
    makeFixture();
    const tool = fake.findTool("subagent_resume");
    const result = await tool.execute(
      "t1",
      { sessionPath: "/nonexistent/child.jsonl" },
      undefined,
      undefined,
      makeFakeCtx().ctx,
    );
    assert.equal(result.details.error, "session not found");
    assert.match(result.content[0].text, /session file not found/);
  });

  it("rejects an active session before deleting its valid result sidecar", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const sessionPath = join(fx.root, "active-child.jsonl");
    writeChildSession(sessionPath, "finished output");
    writeFileSync(
      `${sessionPath}.exit`,
      JSON.stringify({ version: 1, subagentId: "active-1", type: "done" }),
    );
    __test__.runningSubagents.set(
      "active-1",
      makeRunning({ id: "active-1", sessionFile: sessionPath }),
    );

    const result = await fake.findTool("subagent_resume").execute(
      "resume-active",
      { sessionPath },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.error, "session active");
    assert.equal(existsSync(`${sessionPath}.exit`), true);
  });

  it("clears stale sidecars, launches via argv, and extracts only NEW entries for the summary", async () => {
    const fake = registerAll();
    const fx = makeFixture();

    const sessionPath = join(fx.root, "child.jsonl");
    writeChildSession(sessionPath, "old summary");
    // stale sidecars from the previous run — must be gone before launch
    writeFileSync(`${sessionPath}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(
      `${sessionPath}.context-usage`,
      JSON.stringify({
        version: 1,
        subagentId: "previous-resume",
        tokens: 99,
        contextWindow: 100,
        percent: 99,
      }),
    );

    let sidecarsAtLaunch: boolean | null = null;
    let launchedArgv: string[] | null = null;
    const submittedPrompts: string[] = [];
    let launchEnv: Record<string, string> | null = null;
    __test__.setDeps({
      client: makeFakeClient({
        paneSplit: async (p: any) => {
          launchEnv = p.env;
          return { pane_id: "w1:p7", terminal_id: "", workspace_id: "", tab_id: "" };
        },
        agentStart: async (p: any) => {
          sidecarsAtLaunch =
            existsSync(`${sessionPath}.exit`) ||
            existsSync(`${sessionPath}.context-usage`);
          launchedArgv = p.argv;
          return { paneId: "w1:p7", terminalId: "", workspaceId: "", tabId: "" };
        },
        agentPrompt: async (_target: string, prompt: string) => {
          submittedPrompts.push(prompt);
        },
      }),
      watch: async (): Promise<SubagentOutcome> => {
        // the resumed child writes new entries, then completes
        appendAssistantEntry(sessionPath, "new summary");
        return { kind: "completed", summary: "old summary", exitCode: 0 };
      },
      createStream: () => makeFakeStream() as any,
    });

    const tool = fake.findTool("subagent_resume");
    const result = await tool.execute(
      "t1",
      { sessionPath, name: "Retry", message: "keep going" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(result.details.paneId, "w1:p7");
    assert.equal(sidecarsAtLaunch, false, "stale sidecars removed before launch");
    assert.ok(launchedArgv, "agentStart called");
    const observedArgv = launchedArgv as unknown as string[];
    assert.equal(observedArgv[0], "--session");
    assert.ok(observedArgv.includes(sessionPath), "argv resumes the given session");
    assert.equal(submittedPrompts.length, 1);
    assert.match(submittedPrompts[0], /^@.*subagent-resume/);
    assert.equal(launchEnv!.PI_SUBAGENT_AUTO_EXIT, "1", "auto-exit defaults to true");

    await waitFor(() => fake.sent.length === 1);
    const { message, options } = fake.sent[0];
    assert.equal(message.customType, "subagent_result");
    assert.match(message.content, /new summary/);
    assert.ok(!message.content.includes("old summary"), "pre-resume entries are excluded");
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  });

  it("reports 'no new output' when the resumed session gained no entries", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const sessionPath = join(fx.root, "child.jsonl");
    writeChildSession(sessionPath, "old summary");

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => ({
        kind: "completed",
        summary: "old summary",
        exitCode: 0,
      }),
      createStream: () => makeFakeStream() as any,
    });

    const tool = fake.findTool("subagent_resume");
    await tool.execute("t1", { sessionPath }, undefined, undefined, fx.ctx);

    await waitFor(() => fake.sent.length === 1);
    assert.match(fake.sent[0].message.content, /without new output/);
  });
});

// ── subagents_list ──────────────────────────────────────────────────────────

describe("index tools: subagents_list", () => {
  it("lists every active child with id, name, state, elapsed time, and session", async () => {
    const fake = registerAll();
    const now = Date.now();
    __test__.runningSubagents.set(
      "a1",
      makeRunning({
        id: "a1",
        name: "Worker",
        liveAgentName: "worker-a1",
        paneId: "w1:p4",
        sessionFile: "/tmp/a1.jsonl",
        startTime: now - 65_000,
      }),
    );
    __test__.runningSubagents.set(
      "b2",
      makeRunning({
        id: "b2",
        name: "Scout",
        liveAgentName: "scout-b2",
        paneId: "w1:p5",
        sessionFile: "/tmp/b2.jsonl",
        startTime: now - 5_000,
      }),
    );
    __test__.setDeps({
      client: makeFakeClient({
        agentGet: async (target: string) =>
          target === "worker-a1"
            ? { name: target, kind: "pi", paneId: "w1:p4", status: "blocked" }
            : { name: target, kind: "pi", paneId: "w1:p5", status: "working" },
      }),
    });

    const tool = fake.findTool("subagents_list");
    const result = await tool.execute("t1", {}, undefined, undefined, makeFakeCtx().ctx);

    const text = result.content[0].text;
    assert.match(text, /a1.*Worker.*blocked.*1m 5s.*\/tmp\/a1\.jsonl/s);
    assert.match(text, /b2.*Scout.*working.*5s.*\/tmp\/b2\.jsonl/s);
    assert.equal(result.details.children.length, 2);
    assert.deepEqual(
      result.details.children.map((child: any) => child.id),
      ["a1", "b2"],
    );
  });

  it("does not report a stale registry entry after Herdr identity reconciliation", async () => {
    const fake = registerAll();
    __test__.runningSubagents.set("stale", makeRunning({ id: "stale" }));
    __test__.setDeps({ client: makeFakeClient({ agentGet: async () => null }) });

    const result = await fake
      .findTool("subagents_list")
      .execute("t1", {}, undefined, undefined, makeFakeCtx().ctx);

    assert.equal(result.content[0].text, "No active subagents.");
    assert.deepEqual(result.details.children, []);
    assert.equal(
      __test__.runningSubagents.has("stale"),
      true,
      "list is observational; the lifecycle coordinator owns removal",
    );
  });
});

// ── commands ────────────────────────────────────────────────────────────────

describe("index tools: commands", () => {
  function captureCommandLaunch() {
    const launches: Array<{ liveAgentName: string; argv: string[] }> = [];
    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async (params: any) => {
          launches.push(params);
          return {
            name: params.liveAgentName,
            kind: "pi",
            paneId: params.paneId,
            terminalId: "term-1",
            workspaceId: "w1",
            tabId: "w1:t1",
          };
        },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });
    return launches;
  }

  it("does not register a role-definition initialization command", () => {
    const fake = registerAll();
    assert.equal(fake.findCommand("subagents-init"), undefined);
  });

  it("subagent tool rejects an explicitly named missing agent before launch", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    let launchCount = 0;
    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async () => {
          launchCount += 1;
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
    });

    const result = await fake.findTool("subagent").execute(
      "t1",
      { name: "Missing", task: "do work", agent: "missing" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.error, "agent not found");
    assert.match(result.content[0].text, /Agent "missing" not found/);
    assert.match(result.content[0].text, /\.pi\/agents/);
    assert.equal(launchCount, 0);
  });

  it("subagent tool rejects an invalid runtime policy before any pane exists", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    let launchCount = 0;
    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async () => {
          launchCount += 1;
          return { paneId: "w1:p9", terminalId: "" };
        },
      }),
    });

    const result = await fake.findTool("subagent").execute(
      "t1",
      { name: "Worker", task: "do work", cwd: "/definitely/not/a/real/dir" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /Invalid subagent launch request/);
    assert.match(result.content[0].text, /Working directory does not exist/);
    assert.equal(launchCount, 0);
  });

  it("subagent tool still permits a spawn with no agent", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    let launchCount = 0;
    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async () => {
          launchCount += 1;
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await fake.findTool("subagent").execute(
      "t1",
      { name: "Generic", task: "do work" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(launchCount, 1);
  });

  it("/iterate launches an explicit task directly as an interactive fork", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const launches = captureCommandLaunch();
    await fake.findCommand("iterate")!.handler("Fix the bug", fx.ctx);

    assert.equal(fake.sentUser.length, 0, "command must not spend an extra model turn");
    assert.equal(launches.length, 1);
    assert.ok(!launches[0].argv.includes("--auto-exit"));
    assert.match(fx.notifications[0].message, /Iterate.*launched/);
  });

  it("/iterate launches directly when no task argument is supplied", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const launches = captureCommandLaunch();
    await fake.findCommand("iterate")!.handler("   ", fx.ctx);

    assert.equal(fake.sentUser.length, 0);
    assert.equal(launches.length, 1);
    assert.match(fx.notifications[0].message, /Iterate.*launched/);
  });

  it("/subagent directly spawns a named agent with the given task", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    writeFileSync(
      join(fx.agentDir, "agents", "scout.md"),
      "---\nname: scout\n---\nYou scout.\n",
    );

    const launches = captureCommandLaunch();
    await fake.findCommand("subagent")!.handler("scout find the bug", fx.ctx);

    assert.equal(fake.sentUser.length, 0, "command must not spend an extra model turn");
    assert.equal(launches.length, 1);
    assert.match(launches[0].liveAgentName, /^scout-/);
    assert.match(fx.notifications[0].message, /Scout.*launched/);
  });

  it("/subagent with an unknown agent notifies an error", async () => {
    const fake = registerAll();
    makeFixture();
    const { ctx, notifications } = makeFakeCtx();

    const cmd = fake.findCommand("subagent");
    await cmd!.handler("nonexistent-agent do stuff", ctx);

    assert.equal(fake.sentUser.length, 0);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /not found/);
  });
});

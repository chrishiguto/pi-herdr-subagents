// Shared fixtures for the orchestrator-level suites (index/spawn/recovery).
// Each *.test.ts file runs in its own process; call installOrchestratorHooks()
// once at module top level to get the env save/restore + reset discipline.
import { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import herdrSubagents from "../extensions/herdr-subagents/index.ts";
import { __test__ } from "../src/orchestrator.ts";

export const INDEX_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "herdr-subagents",
  "index.ts",
);

// These tests may themselves run inside herdr / a subagent — always set or
// delete every relevant key explicitly, and restore afterwards.
export const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_INTERACTIVE",
  "PI_HERDR_PI_BIN",
  "PI_CODING_AGENT_DIR",
] as const;

export const cleanups: Array<() => void> = [];

export function installOrchestratorHooks(): void {
  const savedEnv = new Map<string, string | undefined>();

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
}

export function envInsideHerdr(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr-test.sock";
}

// ── fakes ──────────────────────────────────────────────────────────────────

export interface FakeToolInfo {
  name: string;
  sourceInfo?: { path: string };
}

export function createFakePi(opts?: { allTools?: FakeToolInfo[]; slashCommands?: any[] }) {
  const registeredTools: any[] = [];
  const commands: Array<{ name: string; handler: Function }> = [];
  const renderers = new Map<string, unknown>();
  const handlers = new Map<string, Function[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const sentUser: string[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
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
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
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
    appended,
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

export function makeFakeCtx(overrides?: {
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

export function makeFakeClient(overrides?: Partial<Record<string, Function>>) {
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

export function makeFakeStream() {
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

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── fixture for real-launch-plan spawns ────────────────────────────────────

export function makeSpawnFixture() {
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

/** Register the extension inside herdr and return the subagent tool. */
export function registerAndGetTool(opts?: Parameters<typeof createFakePi>[0]) {
  envInsideHerdr();
  const fake = createFakePi(opts);
  herdrSubagents(fake.api);
  const tool = fake.findTool("subagent");
  assert.ok(tool, "subagent tool must be registered");
  return { fake, tool };
}

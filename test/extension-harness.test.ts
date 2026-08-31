import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  wrapRegisteredTool,
  type ExtensionActions,
  type ExtensionContextActions,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import herdrSubagents, { __test__ } from "../extensions/herdr-subagents/index.ts";
import type { SubagentOutcome } from "../src/watcher.ts";

const FACTORY_KEY = Symbol.for("pi-herdr-subagents/extension-harness-factory");

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "PI_CODING_AGENT_DIR",
  "PI_HERDR_PI_BIN",
] as const;

const savedEnv = new Map<string, string | undefined>();
let fixtureRoot = "";

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  __test__.reset();
  delete (globalThis as any)[FACTORY_KEY];
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function fakeStream() {
  return {
    watch() {
      return () => {};
    },
    onReconcile() {
      return () => {};
    },
    close() {},
    connected: true,
  };
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeout) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Pi extension runtime: generic subagent", () => {
  it("registers and runs a plain async launch through Pi's public extension boundary", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "pi-herdr-extension-harness-"));
    const cwd = join(fixtureRoot, "work");
    const sessionDir = join(fixtureRoot, "sessions");
    const parentSessionFile = join(sessionDir, "parent.jsonl");
    const agentDir = join(fixtureRoot, "agent-config");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      parentSessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd })}\n`,
    );

    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.HERDR_SOCKET_PATH = join(fixtureRoot, "herdr.sock");
    process.env.HERDR_TAB_ID = "w1:t1";
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Pi's public loader accepts paths rather than factory values. This tiny adapter
    // lets it load the real, already-imported factory so the extension's documented
    // dependency-injection seam remains the one used by the test.
    (globalThis as any)[FACTORY_KEY] = herdrSubagents;
    const extensionAdapter = join(fixtureRoot, "extension-adapter.ts");
    writeFileSync(
      extensionAdapter,
      `export default globalThis[Symbol.for("pi-herdr-subagents/extension-harness-factory")];\n`,
    );

    const childOutcome = Promise.resolve<SubagentOutcome>({
      kind: "completed",
      summary: "generic task complete",
      exitCode: 0,
    });
    const starts: unknown[] = [];
    __test__.setDeps({
      client: {
        async sessionSnapshot() { return { panes: [] }; },
        async paneLayout() {
          return { workspace_id: "w1", panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 50 } }] };
        },
        async paneSplit() {
          return { pane_id: "w1:p2", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t1" };
        },
        async tabCreate() {
          return { pane_id: "w1:p3", terminal_id: "term-3", workspace_id: "w1", tab_id: "w1:t2" };
        },
        async agentStart(params: any) {
          starts.push(params);
          return {
            name: params.liveAgentName,
            kind: "pi" as const,
            paneId: "w1:p2",
            terminalId: "term-2",
            workspaceId: "w1",
            tabId: "w1:t1",
          };
        },
        async agentPrompt() {},
        async agentGet() { return { name: "plain-task-abcd1234", kind: "pi", paneId: "w1:p2" }; },
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
      },
      watch: async () => childOutcome,
      createStream: () => fakeStream() as any,
    });

    const loaded = await discoverAndLoadExtensions(
      [extensionAdapter],
      cwd,
      agentDir,
      createEventBus(),
    );
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const [extension] = loaded.extensions;
    const { runtime } = loaded;

    const sent: Array<{ message: any; options: any }> = [];
    let runner!: ExtensionRunner;
    const actions: ExtensionActions = {
      sendMessage(message, options) {
        sent.push({ message, options });
      },
      sendUserMessage() {},
      appendEntry() {},
      setSessionName() {},
      getSessionName: () => undefined,
      setLabel() {},
      getActiveTools: () => runner.getAllRegisteredTools().map(({ definition }) => definition.name),
      getAllTools: (): ToolInfo[] =>
        runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          sourceInfo,
        })),
      setActiveTools() {},
      refreshTools() {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel() {},
    };
    const contextActions: ExtensionContextActions = {
      getModel: () => undefined,
      getScopedModels: () => [],
      isProjectTrusted: () => true,
      isIdle: () => true,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
    };
    const sessionManager = {
      getSessionFile: () => parentSessionFile,
      getSessionId: () => "orchestrator-session",
      getSessionDir: () => sessionDir,
      getLeafId: () => "parent",
    };
    runner = new ExtensionRunner(
      [extension],
      runtime,
      cwd,
      sessionManager as any,
      {} as any,
    );
    runner.bindCore(actions, contextActions);

    const registered = runner
      .getAllRegisteredTools()
      .find(({ definition }) => definition.name === "subagent");
    assert.ok(registered, "the extension should register subagent inside Herdr");
    assert.equal(Value.Check(registered.definition.parameters, { name: "Plain task", task: "Do it" }), true);
    for (const contextMode of ["standalone", "lineage-only", "fork"]) {
      assert.equal(
        Value.Check(registered.definition.parameters, { name: "Plain task", task: "Do it", contextMode }),
        true,
      );
    }
    assert.equal(
      Value.Check(registered.definition.parameters, { name: "Plain task", task: "Do it", contextMode: "live" }),
      false,
    );
    assert.equal(
      Value.Check(registered.definition.parameters, {
        name: "Plain task",
        task: "Do it",
        workflow: { kind: "skill", name: "implement" },
      }),
      true,
    );
    assert.equal(
      Value.Check(registered.definition.parameters, {
        name: "Plain task",
        task: "Do it",
        workflow: { kind: "extension", name: "deploy" },
      }),
      false,
    );
    assert.equal(
      Value.Check(registered.definition.parameters, {
        name: "Policy child",
        task: "Do it",
        model: "openai/gpt-5",
        thinking: "max",
        tools: ["read", "bash"],
        allowNestedDelegation: false,
      }),
      true,
    );
    assert.equal(
      Value.Check(registered.definition.parameters, {
        name: "Plain task",
        task: "Do it",
        agent: 42,
      }),
      false,
      "Pi's registered public schema should reject a non-string agent",
    );

    const tool = wrapRegisteredTool(registered, runner);
    const ack = await tool.execute(
      "tool-call-1",
      { name: "Plain task", task: "Complete a generic task without an agent definition" },
      undefined,
      undefined,
    );

    assert.equal(starts.length, 1);
    assert.equal(ack.details.status, "started");
    assert.equal(ack.details.agent, undefined);
    assert.equal(ack.details.paneId, "w1:p2");
    assert.equal(typeof ack.details.liveAgentName, "string");
    assert.equal(ack.details.contextMode, "lineage-only");
    assert.equal(sent.length, 0, "even immediate completion must wait for the acknowledgement");
    await waitFor(() => sent.length === 1);

    assert.equal(sent[0].message.customType, "subagent_result");
    assert.equal(sent[0].message.details.sessionFile, ack.details.sessionFile);
    assert.match(sent[0].message.content, /generic task complete/);
    assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
  });
});

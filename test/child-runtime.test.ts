import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { shouldAutoExitOnAgentEnd } from "../src/child-runtime.ts";
import { parseDeniedTools, writeExitSidecar } from "../src/child-protocol.ts";
import { writeContextUsageSidecar } from "../src/context-usage.ts";
import {
  createSubagentActivityTracker,
  publishSubagentActivity,
} from "../src/runtime-events.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function createFakeEventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

it("keeps replacement ownership active when a stale reload watcher settles", () => {
  const events = createFakeEventBus();
  const tracker = createSubagentActivityTracker(events);
  publishSubagentActivity(events, "nested-1", "old-runtime", true);
  publishSubagentActivity(events, "nested-1", "new-runtime", true);
  publishSubagentActivity(events, "nested-1", "old-runtime", false);
  assert.equal(tracker.count(), 1);
  publishSubagentActivity(events, "nested-1", "new-runtime", false);
  assert.equal(tracker.count(), 0);
  tracker.close();
});

describe("child runtime: shouldAutoExitOnAgentEnd", () => {
  it("auto-exits after normal completion regardless of who sent the prompt", () => {
    const messages = [{ role: "assistant", stopReason: "stop" }];
    assert.equal(shouldAutoExitOnAgentEnd(messages), true);
  });

  it("stays open after Escape aborts the run", () => {
    const messages = [{ role: "assistant", stopReason: "aborted" }];
    assert.equal(shouldAutoExitOnAgentEnd(messages), false);
  });

  it("stays open on API errors (timeout, connection failure) so pi can retry", () => {
    const messages = [{ role: "assistant", stopReason: "error", errorMessage: "Request timed out." }];
    assert.equal(shouldAutoExitOnAgentEnd(messages), false);
  });

  it("stays open on connection errors so pi can retry", () => {
    const messages = [{ role: "assistant", stopReason: "error", errorMessage: "Connection error: WebSocket error" }];
    assert.equal(shouldAutoExitOnAgentEnd(messages), false);
  });

  it("defaults to exiting when no messages are available", () => {
    assert.equal(shouldAutoExitOnAgentEnd(undefined), true);
  });

  it("stays open when the turn produced no new assistant message (errored/retrying turn)", () => {
    // Resumed-session failure mode (verified live, pi 0.80.3): the resume
    // message is delivered, the first request times out, pi schedules a retry,
    // and agent_end fires with the conversation ending at the just-delivered
    // USER message. Walking backwards would find the PREVIOUS conversation's
    // assistant (stopReason "stop") and shut pi down mid-retry.
    const messages = [
      { role: "assistant", stopReason: "stop" }, // stale: pre-resume history
      { role: "user" }, // the resume message — no reply yet
    ];
    assert.equal(shouldAutoExitOnAgentEnd(messages), false);
  });

  it("still auto-exits when a completed turn follows a resumed conversation", () => {
    const messages = [
      { role: "assistant", stopReason: "stop" },
      { role: "user" },
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult" },
      { role: "assistant", stopReason: "stop" },
    ];
    assert.equal(shouldAutoExitOnAgentEnd(messages), true);
  });
});

describe("child runtime: parseDeniedTools", () => {
  it("splits and trims comma-separated names, dropping empties", () => {
    assert.deepEqual(parseDeniedTools(" subagent , subagent_resume ,,bash "), [
      "subagent",
      "subagent_resume",
      "bash",
    ]);
  });

  it("returns an empty list when unset", () => {
    assert.deepEqual(parseDeniedTools(undefined), []);
  });
});

describe("child runtime: .exit sidecar shapes (cross-extension contract)", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("writes a correlated done signal atomically", () => {
    const sessionFile = makeSessionFile();
    writeExitSidecar({ sessionFile, subagentId: "child-1" }, { type: "done" });
    assert.equal(
      readFileSync(`${sessionFile}.exit`, "utf8"),
      '{"version":1,"subagentId":"child-1","type":"done"}',
    );
  });

  it("ping writes type/name/message in reference byte order", () => {
    const sessionFile = makeSessionFile();
    writeExitSidecar(
      { sessionFile, subagentId: "child-1" },
      { type: "ping", name: "Worker", message: "need input" },
    );
    assert.equal(
      readFileSync(`${sessionFile}.exit`, "utf8"),
      '{"version":1,"subagentId":"child-1","type":"ping","name":"Worker","message":"need input"}',
    );
  });

  it("publishes context usage atomically with version and subagent id", () => {
    const sessionFile = makeSessionFile();
    assert.equal(
      writeContextUsageSidecar(sessionFile, "child-1", {
        tokens: 75_000,
        contextWindow: 200_000,
        percent: 37.5,
      }),
      true,
    );
    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.context-usage`, "utf8")), {
      version: 1,
      subagentId: "child-1",
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
    assert.deepEqual(
      readdirSync(join(sessionFile, "..")),
      ["child.jsonl.context-usage"],
      "the temporary file is renamed away",
    );
  });
});

describe("child runtime: module", () => {
  it("loads as an internal runtime registrar", async () => {
    const mod = await import("../src/child-runtime.ts");
    assert.equal(typeof mod.registerChildRuntime, "function");
  });
});

describe("child runtime: subagent_done tool writes sidecar and shuts down", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("writes usage before the exact done sidecar and shuts down", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "child-1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origId !== undefined) process.env.PI_SUBAGENT_ID = origId;
      else delete process.env.PI_SUBAGENT_ID;
    });

    const registeredTools: Record<string, any> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: () => {},
      registerTool: (tool: any) => { registeredTools[tool.name] = tool; },
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const fakeCtx = {
      shutdown: () => {
        assert.ok(existsSync(`${sessionFile}.context-usage`), "usage is published before shutdown");
        assert.ok(existsSync(`${sessionFile}.exit`), "terminal signal is published before shutdown");
        shutdownCalled = true;
      },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 200_000, percent: 37.5 }),
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);

    assert.ok(registeredTools.subagent_done, "subagent_done tool should be registered");
    await registeredTools.subagent_done.execute("call-1", {}, null, () => {}, fakeCtx);

    assert.equal(shutdownCalled, true, "should have called shutdown");
    const sidecar = readFileSync(`${sessionFile}.exit`, "utf8");
    assert.equal(
      sidecar,
      '{"version":1,"subagentId":"child-1","type":"done"}',
      "should write correlated done sidecar",
    );
    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.context-usage`, "utf8")), {
      version: 1,
      subagentId: "child-1",
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
  });
});

describe("child runtime: caller_ping escalation", () => {
  it("preserves one structured help signal when shutdown is followed by agent_end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-ping-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sessionFile = join(dir, "child.jsonl");
    const saved = {
      session: process.env.PI_SUBAGENT_SESSION,
      id: process.env.PI_SUBAGENT_ID,
      name: process.env.PI_SUBAGENT_NAME,
      autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
    };
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "asking-1";
    process.env.PI_SUBAGENT_NAME = "Asking Child";
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    cleanups.push(() => {
      for (const [key, value] of Object.entries({
        PI_SUBAGENT_SESSION: saved.session,
        PI_SUBAGENT_ID: saved.id,
        PI_SUBAGENT_NAME: saved.name,
        PI_SUBAGENT_AUTO_EXIT: saved.autoExit,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const handlers: Record<string, Function> = {};
    const tools: Record<string, any> = {};
    let shutdownCount = 0;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const fakeCtx = {
      shutdown: () => { shutdownCount += 1; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);
    handlers.agent_start?.();
    await tools.caller_ping.execute(
      "ping-1",
      { message: "  Which database should I migrate?  " },
      undefined,
      undefined,
      fakeCtx,
    );
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );

    assert.equal(shutdownCount, 1);
    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
      version: 1,
      subagentId: "asking-1",
      type: "ping",
      name: "Asking Child",
      message: "Which database should I migrate?",
    });
  });
});

describe("child runtime: user close without subagent_done leaves no sidecar", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("no sidecar written when agent_end fires after abort (user Escape)", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_ID = "child-1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
      if (origId !== undefined) process.env.PI_SUBAGENT_ID = origId;
      else delete process.env.PI_SUBAGENT_ID;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);

    handlers.session_start?.({}, fakeCtx);
    handlers.agent_start?.();
    // User aborts — should NOT auto-exit, no sidecar
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      fakeCtx,
    );

    assert.equal(shutdownCalled, false, "should NOT shutdown on abort");
    let sidecarExists = false;
    try { readFileSync(`${sessionFile}.exit`); sidecarExists = true; } catch {}
    assert.equal(sidecarExists, false, "should NOT write sidecar on user abort");
  });
});

describe("child runtime: interactive lifecycle", () => {
  it("stays open across clean and interrupted turns until a terminal tool is called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-interactive-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sessionFile = join(dir, "child.jsonl");
    const saved = {
      session: process.env.PI_SUBAGENT_SESSION,
      id: process.env.PI_SUBAGENT_ID,
      autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      interactive: process.env.PI_SUBAGENT_INTERACTIVE,
    };
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "interactive-1";
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_INTERACTIVE = "1";
    cleanups.push(() => {
      for (const [key, value] of Object.entries({
        PI_SUBAGENT_SESSION: saved.session,
        PI_SUBAGENT_ID: saved.id,
        PI_SUBAGENT_AUTO_EXIT: saved.autoExit,
        PI_SUBAGENT_INTERACTIVE: saved.interactive,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const handlers: Record<string, Function> = {};
    const tools: Record<string, any> = {};
    let shutdownCount = 0;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const fakeCtx = {
      shutdown: () => { shutdownCount += 1; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);
    handlers.agent_start?.();
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      fakeCtx,
    );

    assert.equal(shutdownCount, 0);
    assert.equal(existsSync(`${sessionFile}.exit`), false);

    await tools.subagent_done.execute("done-1", {}, undefined, undefined, fakeCtx);
    assert.equal(shutdownCount, 1);
    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
      version: 1,
      subagentId: "interactive-1",
      type: "done",
    });
  });
});

describe("child runtime: session_shutdown context usage fallback", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("writes once on user shutdown and does not overwrite the first valid snapshot", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "child-shutdown";
    cleanups.push(() => {
      if (origSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
      else process.env.PI_SUBAGENT_SESSION = origSession;
      if (origId === undefined) delete process.env.PI_SUBAGENT_ID;
      else process.env.PI_SUBAGENT_ID = origId;
    });

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    let usage = { tokens: 10, contextWindow: 100, percent: 10 };
    const fakeCtx = {
      getContextUsage: () => usage,
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);
    handlers.session_shutdown?.({}, fakeCtx);
    usage = { tokens: 90, contextWindow: 100, percent: 90 };
    handlers.session_shutdown?.({}, fakeCtx);

    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.context-usage`, "utf8")), {
      version: 1,
      subagentId: "child-shutdown",
      tokens: 10,
      contextWindow: 100,
      percent: 10,
    });
    assert.equal(existsSync(`${sessionFile}.exit`), false, "fallback does not alter terminal signals");
  });

  it("skips unavailable usage without throwing", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "child-unknown";
    cleanups.push(() => {
      if (origSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
      else process.env.PI_SUBAGENT_SESSION = origSession;
      if (origId === undefined) delete process.env.PI_SUBAGENT_ID;
      else process.env.PI_SUBAGENT_ID = origId;
    });

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);

    assert.doesNotThrow(() => handlers.session_shutdown?.({}, { getContextUsage: () => undefined }));
    assert.equal(existsSync(`${sessionFile}.context-usage`), false);
  });
});

describe("child runtime: agent_settled writes .exit sidecar on clean auto-exit", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("waits for agent_settled before writing the done sidecar", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_ID = "child-1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
      if (origId !== undefined) process.env.PI_SUBAGENT_ID = origId;
      else delete process.env.PI_SUBAGENT_ID;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      isIdle: () => true,
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);

    handlers.session_start?.({}, fakeCtx);
    handlers.agent_start?.();
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );
    assert.equal(shutdownCalled, false, "agent_end is not a safe shutdown point");
    handlers.agent_settled?.({}, fakeCtx);

    assert.equal(shutdownCalled, true, "should shutdown once Pi is settled");
    const sidecar = readFileSync(`${sessionFile}.exit`, "utf8");
    assert.equal(
      sidecar,
      '{"version":1,"subagentId":"child-1","type":"done"}',
      "should write correlated done sidecar on auto-exit",
    );
  });

  it("does NOT write done sidecar when the settled run ended in an error", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_ID = "error-child";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
      if (origId !== undefined) process.env.PI_SUBAGENT_ID = origId;
      else delete process.env.PI_SUBAGENT_ID;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      events: createFakeEventBus(),
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      isIdle: () => true,
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);

    handlers.session_start?.({}, fakeCtx);
    handlers.agent_start?.();
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Request timed out." }] },
      fakeCtx,
    );
    handlers.agent_settled?.({}, fakeCtx);

    assert.equal(shutdownCalled, false, "should NOT shutdown on error");
    let sidecarExists = false;
    try { readFileSync(`${sessionFile}.exit`); sidecarExists = true; } catch {}
    assert.equal(sidecarExists, false, "should NOT write sidecar on error");
  });

  it("does NOT auto-exit an orchestrator while nested subagents are running", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_ID = "nested-parent";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
      if (origId !== undefined) process.env.PI_SUBAGENT_ID = origId;
      else delete process.env.PI_SUBAGENT_ID;
    });

    const handlers: Record<string, Function> = {};
    const events = createFakeEventBus();
    let shutdownCalled = false;
    const fakePi = {
      events,
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      isIdle: () => true,
      ui: { setWidget: () => {} },
    };

    const mod = await import("../src/child-runtime.ts");
    mod.registerChildRuntime(fakePi as any);
    publishSubagentActivity(events, "nested-1", "runtime", true);
    publishSubagentActivity(events, "nested-2", "runtime", true);
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );
    handlers.agent_settled?.({}, fakeCtx);

    assert.equal(shutdownCalled, false, "should keep the nested orchestrator alive");
    let sidecarExists = false;
    try { readFileSync(`${sessionFile}.exit`); sidecarExists = true; } catch {}
    assert.equal(sidecarExists, false, "must not signal completion before children settle");
  });
});

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  attachStatusWidget,
  createStatusWidgetComponent,
  type StatusWidgetUi,
} from "../src/status-widget-controller.ts";
import { SUBAGENT_ACTIVITY_EVENT } from "../src/runtime-events.ts";
import { WIDGET_ID } from "../src/status-widget.ts";
import type { RunningSubagent } from "../src/watcher.ts";

function runningChild(id: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
  return {
    id,
    name: `child-${id}`,
    task: "task",
    paneId: "w1:p2",
    liveAgentName: `pi-sub-${id}`,
    startTime: Date.now() - 30_000,
    sessionFile: `/tmp/${id}.jsonl`,
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

function fakeRuntime(states: Record<string, string> = {}) {
  const running = new Map<string, RunningSubagent>();
  let inspectCalls = 0;
  return {
    running,
    inspectCalls: () => inspectCalls,
    async inspect() {
      inspectCalls++;
      return [...running.values()].map((child) => ({
        id: child.id,
        name: child.name,
        state: states[child.id] ?? "working",
        elapsedSeconds: 30,
        sessionFile: child.sessionFile,
        paneId: child.paneId,
      }));
    },
  };
}

function fakeBus() {
  const handlers = new Set<(data: unknown) => void>();
  return {
    on(_channel: string, handler: (data: unknown) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit() {
      for (const handler of handlers) handler({});
    },
    size: () => handlers.size,
  };
}

type SetWidgetCall = { key: string; content: unknown };

function fakeCtx(hasUI = true): StatusWidgetUi & { calls: SetWidgetCall[] } {
  const calls: SetWidgetCall[] = [];
  return {
    hasUI,
    calls,
    ui: {
      setWidget(key, content) {
        calls.push({ key, content });
      },
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("attachStatusWidget", () => {
  it("mounts on the first activity with running children, once", () => {
    const runtime = fakeRuntime();
    const bus = fakeBus();
    const ctx = fakeCtx();
    attachStatusWidget(bus, ctx, runtime);
    assert.equal(ctx.calls.length, 0);

    runtime.running.set("a", runningChild("a"));
    bus.emit();
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].key, WIDGET_ID);
    assert.equal(typeof ctx.calls[0].content, "function");

    runtime.running.set("b", runningChild("b"));
    bus.emit();
    assert.equal(ctx.calls.length, 1, "no re-registration while already mounted");
  });

  it("unmounts when the registry empties", () => {
    const runtime = fakeRuntime();
    runtime.running.set("a", runningChild("a"));
    const bus = fakeBus();
    const ctx = fakeCtx();
    attachStatusWidget(bus, ctx, runtime);
    assert.equal(ctx.calls.length, 1, "mounts immediately when children already run");

    runtime.running.delete("a");
    bus.emit();
    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.calls[1].content, undefined);
  });

  it("detach unsubscribes and unmounts", () => {
    const runtime = fakeRuntime();
    runtime.running.set("a", runningChild("a"));
    const bus = fakeBus();
    const ctx = fakeCtx();
    const detach = attachStatusWidget(bus, ctx, runtime);
    detach();
    assert.equal(bus.size(), 0);
    assert.equal(ctx.calls.at(-1)?.content, undefined);
  });

  it("does nothing without a UI", () => {
    const runtime = fakeRuntime();
    runtime.running.set("a", runningChild("a"));
    const bus = fakeBus();
    const ctx = fakeCtx(false);
    const detach = attachStatusWidget(bus, ctx, runtime);
    detach();
    assert.equal(bus.size(), 0);
    assert.equal(ctx.calls.length, 0);
  });
});

describe("createStatusWidgetComponent", () => {
  const theme = { fg: (_color: string, text: string) => text };

  it("renders live registry children with inspected states", async () => {
    const runtime = fakeRuntime({ a: "blocked" });
    runtime.running.set("a", runningChild("a"));
    const component = createStatusWidgetComponent(runtime, { requestRender() {} }, theme);
    await flush();

    const lines = component.render(60);
    assert.match(lines[1], /child-a/);
    assert.match(lines[1], /blocked — needs input/);

    runtime.running.set("b", runningChild("b"));
    assert.equal(component.render(60).length, 4, "render pulls the live registry");
    component.dispose();
  });

  it("ticks request repaints and refresh states on the slower cadence until disposed", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const runtime = fakeRuntime();
      runtime.running.set("a", runningChild("a"));
      let repaints = 0;
      const component = createStatusWidgetComponent(
        runtime,
        { requestRender: () => repaints++ },
        theme,
      );
      await flush();
      assert.equal(runtime.inspectCalls(), 1, "initial state refresh");

      mock.timers.tick(4_000);
      assert.equal(repaints, 4);
      assert.equal(runtime.inspectCalls(), 1);

      mock.timers.tick(1_000);
      await flush();
      assert.equal(repaints, 5);
      assert.equal(runtime.inspectCalls(), 2, "every 5th tick refreshes states");

      component.dispose();
      mock.timers.tick(10_000);
      assert.equal(repaints, 5, "disposed component stops ticking");
    } finally {
      mock.timers.reset();
    }
  });
});

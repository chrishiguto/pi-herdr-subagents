import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildOutcomeMessage,
  formatElapsed,
  renderSubagentPing,
  renderSubagentResult,
  resolveResultPresentation,
} from "../src/messages.ts";
import type { RunningSubagent, SubagentOutcome } from "../src/watcher.ts";

function makeRunning(overrides?: Partial<RunningSubagent>): RunningSubagent {
  return {
    id: "sub1",
    name: "Worker",
    task: "do the thing",
    agent: "worker",
    paneId: "w1:p4",
    liveAgentName: "worker-sub1",
    startTime: 1_000_000,
    sessionFile: "/tmp/sessions/child.jsonl",
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

function build(outcome: SubagentOutcome, running = makeRunning()) {
  // 65s elapsed → "1m 5s"
  return buildOutcomeMessage(running, outcome, { now: () => running.startTime + 65_000 });
}

describe("buildOutcomeMessage", () => {
  it("completed → 'Sub-agent X completed' + summary + Session/Resume block", () => {
    const msg = build({ kind: "completed", summary: "Shipped the feature.", exitCode: 0 });
    assert.ok(msg);
    assert.equal(msg.customType, "subagent_result");
    assert.equal(msg.display, true);
    assert.match(msg.content, /Sub-agent "Worker" completed \(1m 5s\)\./);
    assert.match(msg.content, /Shipped the feature\./);
    assert.match(msg.content, /Session: \/tmp\/sessions\/child\.jsonl/);
    assert.match(msg.content, /Resume: pi --session \/tmp\/sessions\/child\.jsonl/);
    assert.equal(msg.details.name, "Worker");
    assert.equal(msg.details.task, "do the thing");
    assert.equal(msg.details.agent, "worker");
    assert.equal(msg.details.exitCode, 0);
    assert.equal(msg.details.elapsed, 65);
    assert.equal(msg.details.sessionFile, "/tmp/sessions/child.jsonl");
    assert.equal(msg.details.paneId, "w1:p4");
    assert.equal(msg.details.summary, "Shipped the feature.");
    assert.equal(msg.details.disposition, "completed");
  });

  it("adds terminal context usage to content and structured details", () => {
    const running = makeRunning();
    const contextUsage = {
      version: 1 as const,
      subagentId: running.id,
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    };
    const msg = buildOutcomeMessage(
      running,
      { kind: "completed", summary: "Shipped.", exitCode: 0 },
      { now: () => running.startTime + 65_000, contextUsage },
    );

    assert.ok(msg);
    assert.match(
      msg.content,
      /Context: 75,000\/200,000 tokens \(37\.5% used, 125,000 remaining\)\./,
    );
    assert.deepEqual(msg.details.contextUsage, contextUsage);

    const rendered = renderSubagentResult(
      msg as any,
      { expanded: false } as any,
      createTheme() as any,
    );
    assert.ok(rendered);
    assert.match(rendered.render(80).join("\n"), /125,000 remaining/);
  });

  it("keeps unknown/null usage structured but omits a misleading visible line", () => {
    const running = makeRunning();
    const contextUsage = {
      version: 1 as const,
      subagentId: running.id,
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    };
    const msg = buildOutcomeMessage(
      running,
      { kind: "completed", summary: "Shipped.", exitCode: 0 },
      { contextUsage },
    );

    assert.ok(msg);
    assert.doesNotMatch(msg.content, /Context:/);
    assert.deepEqual(msg.details.contextUsage, contextUsage);
  });

  it("ping → subagent_ping customType with message and session path", () => {
    const msg = build({ kind: "ping", name: "Worker", message: "Need the API key" });
    assert.ok(msg);
    assert.equal(msg.customType, "subagent_ping");
    assert.match(msg.content, /Sub-agent "Worker" needs help \(1m 5s\)/);
    assert.match(msg.content, /Need the API key/);
    assert.match(msg.content, /Session: \/tmp\/sessions\/child\.jsonl/);
    assert.equal(msg.details.message, "Need the API key");
    assert.equal(msg.details.sessionFile, "/tmp/sessions/child.jsonl");
  });

  it("launch-failed → names exit code and pane id", () => {
    const msg = build({
      kind: "launch-failed",
      error: "Pi did not become ready",
      paneId: "w1:p4",
      sessionFile: "/tmp/sessions/child.jsonl",
    });
    assert.ok(msg);
    assert.equal(msg.customType, "subagent_result");
    assert.match(msg.content, /failed to launch/);
    assert.match(msg.content, /Pi did not become ready/);
    assert.match(msg.content, /w1:p4/);
    assert.match(msg.content, /Resume: pi --session/);
    assert.equal(msg.details.error, "launch-failed");
    assert.equal(msg.details.sessionFile, "/tmp/sessions/child.jsonl");
  });

  it("unsignaled-exit → honest failure + last message + session path", () => {
    const msg = build({
      kind: "unsignaled-exit",
      reason: "agent-disappeared",
      summary: "Halfway through the tests.",
      sessionFile: "/tmp/sessions/child.jsonl",
    });
    assert.ok(msg);
    assert.match(msg.content, /without a completion signal/);
    assert.match(msg.content, /w1:p4/);
    assert.match(msg.content, /Halfway through the tests\./);
    assert.match(msg.content, /Resume: pi --session/);
    assert.equal(msg.details.error, "unsignaled-exit");
  });

  it("cancelled → no steer message", () => {
    assert.equal(build({ kind: "cancelled", sessionFile: "/tmp/sessions/child.jsonl" }), null);
  });

  it("bounds large summaries in both content and structured details", () => {
    const msg = build({
      kind: "completed",
      summary: "x".repeat(50_000),
      exitCode: 0,
      sessionFile: "/tmp/sessions/child.jsonl",
    });
    assert.ok(msg);
    assert.ok(msg.content.length < 13_000);
    assert.ok((msg.details.summary as string).length <= 12_000);
    assert.match(msg.details.summary as string, /output truncated/);
    assert.equal(msg.details.outputTruncated, true);
  });
});

describe("ported presentation helpers", () => {
  it("formatElapsed", () => {
    assert.equal(formatElapsed(45), "45s");
    assert.equal(formatElapsed(61), "1m 1s");
  });

  it("resolveResultPresentation formats exit code 130 as an ordinary failure", () => {
    const presentation = resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );
    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });
});

// ── renderers ─────────────────────────────────────────────────────────────

function createTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

describe("message renderers", () => {
  it("subagent_result renders collapsed with ≤5 preview lines", () => {
    const running = makeRunning();
    const msg = buildOutcomeMessage(
      running,
      {
        kind: "completed",
        summary: ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n"),
        exitCode: 0,
      },
      { now: () => running.startTime + 5000 },
    )!;

    const rendered = renderSubagentResult(msg as any, { expanded: false } as any, createTheme() as any);
    assert.ok(rendered, "renderer must handle the message");
    const lines = rendered.render(80);
    const output = lines.join("\n");
    assert.match(output, /Worker/);
    assert.match(output, /completed/);
    assert.match(output, /l5/);
    assert.doesNotMatch(output, /l6/, "collapsed preview is capped at 5 lines");
    assert.match(output, /… 2 more lines/);
  });

  it("subagent_result expanded shows full summary and session block", () => {
    const msg = build({ kind: "completed", summary: "line-a\nline-b", exitCode: 0 })!;
    const rendered = renderSubagentResult(msg as any, { expanded: true } as any, createTheme() as any);
    assert.ok(rendered);
    const output = rendered.render(80).join("\n");
    assert.match(output, /line-a/);
    assert.match(output, /line-b/);
    assert.match(output, /Session: \/tmp\/sessions\/child\.jsonl/);
    assert.match(output, /Resume: {2}pi --session/);
  });

  it("subagent_result renders failure statuses honestly", () => {
    for (const [outcome, expected] of [
      [
        { kind: "launch-failed", error: "boom", paneId: "w1:p4", sessionFile: "/tmp/s" },
        /failed to launch/,
      ],
      [
        {
          kind: "unsignaled-exit",
          reason: "pane-closed",
          summary: null,
          sessionFile: "/tmp/s",
        },
        /without completion signal/,
      ],
    ] as Array<[SubagentOutcome, RegExp]>) {
      const msg = build(outcome)!;
      const rendered = renderSubagentResult(msg as any, { expanded: false } as any, createTheme() as any);
      assert.ok(rendered, `renderer must handle ${JSON.stringify(outcome)}`);
      assert.match(rendered.render(80).join("\n"), expected);
    }
  });

  it("subagent_ping renders collapsed and expanded without throwing", () => {
    const msg = build({ kind: "ping", name: "Worker", message: "first line\nsecond line" })!;

    const collapsed = renderSubagentPing(msg as any, { expanded: false } as any, createTheme() as any);
    assert.ok(collapsed);
    const collapsedOut = collapsed.render(80).join("\n");
    assert.match(collapsedOut, /Worker/);
    assert.match(collapsedOut, /needs help/);
    assert.match(collapsedOut, /first line/);
    assert.doesNotMatch(collapsedOut, /second line/);

    const expanded = renderSubagentPing(msg as any, { expanded: true } as any, createTheme() as any);
    assert.ok(expanded);
    const expandedOut = expanded.render(80).join("\n");
    assert.match(expandedOut, /second line/);
    assert.match(expandedOut, /Session: \/tmp\/sessions\/child\.jsonl/);
  });

  it("renderers return undefined for messages without details", () => {
    const bare = { customType: "subagent_result", content: "x", details: undefined };
    assert.equal(renderSubagentResult(bare as any, { expanded: false } as any, createTheme() as any), undefined);
    assert.equal(renderSubagentPing(bare as any, { expanded: false } as any, createTheme() as any), undefined);
  });

  it("renders old pi-interactive-subagents steer messages (no disposition) as success", () => {
    // Old steer messages have exitCode: 0 but no disposition field
    const oldStyleMsg = {
      customType: "subagent_result",
      content: 'Sub-agent "Worker" completed (1m 5s).\n\nDid the thing.',
      display: true,
      details: {
        name: "Worker",
        agent: "worker",
        exitCode: 0,
        elapsed: 65,
        sessionFile: "/tmp/sessions/child.jsonl",
        // no disposition field — this is the key difference
      },
    };
    const rendered = renderSubagentResult(oldStyleMsg as any, { expanded: false } as any, createTheme() as any);
    assert.ok(rendered);
    const output = rendered.render(80).join("\n");
    assert.match(output, /✓/, "should show checkmark, not X");
    assert.match(output, /completed/, "should show completed status");
    assert.doesNotMatch(output, /✗/, "should NOT show failure X");
  });

  it("renders old pi-interactive-subagents failed steer messages as failure", () => {
    const oldStyleFailMsg = {
      customType: "subagent_result",
      content: 'Sub-agent "Worker" failed.',
      display: true,
      details: {
        name: "Worker",
        agent: "worker",
        exitCode: 1,
        elapsed: 10,
        sessionFile: "/tmp/sessions/child.jsonl",
      },
    };
    const rendered = renderSubagentResult(oldStyleFailMsg as any, { expanded: false } as any, createTheme() as any);
    assert.ok(rendered);
    const output = rendered.render(80).join("\n");
    assert.match(output, /✗/, "should show failure X");
    assert.doesNotMatch(output, /✓/, "should NOT show checkmark");
  });
});

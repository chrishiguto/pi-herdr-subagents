import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createHerdrClient,
  makeLiveAgentName,
  type ExecFn,
} from "../src/herdr/client.ts";

interface ExecCall {
  cmd: string;
  args: string[];
}

function fakeExec(responses: Array<{ stdout?: string; stderr?: string; code?: number }>): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const queue = [...responses];
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const next = queue.shift();
    if (!next) throw new Error("fakeExec: no more scripted responses");
    return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 };
  };
  return { exec, calls };
}

const paneSplitEnvelope = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: {
      pane_id: "w1:p2",
      terminal_id: "term_abc123",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
    },
    type: "pane_split",
  },
});

const agentStartedEnvelope = JSON.stringify({
  id: "cli:agent:start",
  result: {
    agent: {
      name: "worker-abcd1234",
      agent: "pi",
      pane_id: "w1:p2",
      terminal_id: "term_abc123",
      workspace_id: "w1",
      tab_id: "w1:t1",
    },
    type: "agent_started",
  },
});

describe("HerdrClient", () => {
  it("reads one authoritative session snapshot for reconnect reconciliation", async () => {
    const panes = [{ pane_id: "w1:p1", terminal_id: "term-1" }];
    const { exec, calls } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { snapshot: { panes }, type: "session_snapshot" } }) },
    ]);
    const client = createHerdrClient({ exec });

    assert.deepEqual(await client.sessionSnapshot(), { panes });
    assert.deepEqual(calls[0].args, ["api", "snapshot"]);
  });

  it("reads pane geometry for adaptive placement", async () => {
    const layout = {
      workspace_id: "w1",
      panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 50 } }],
    };
    const { exec, calls } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { layout, type: "pane_layout" } }) },
    ]);
    const client = createHerdrClient({ exec });

    assert.deepEqual(await client.paneLayout("w1:p1"), layout);
    assert.deepEqual(calls[0].args, ["pane", "layout", "--pane", "w1:p1"]);
  });

  it("paneSplit targets the current pane, preserves cwd/env, and never takes focus", async () => {
    const { exec, calls } = fakeExec([{ stdout: paneSplitEnvelope }]);
    const client = createHerdrClient({ exec });

    const result = await client.paneSplit({
      cwd: "/tmp/project",
      direction: "right",
      env: { PI_SUBAGENT_ID: "abc", FOO: "bar" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "herdr");
    assert.deepEqual(calls[0].args, [
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      "/tmp/project",
      "--env",
      "PI_SUBAGENT_ID=abc",
      "--env",
      "FOO=bar",
      "--no-focus",
    ]);
    assert.deepEqual(result, {
      pane_id: "w1:p2",
      terminal_id: "term_abc123",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
    });
  });

  it("paneSplit targets an explicit source pane instead of ambient UI focus", async () => {
    const { exec, calls } = fakeExec([{ stdout: paneSplitEnvelope }]);
    const client = createHerdrClient({ exec });

    await client.paneSplit({
      sourcePaneId: "w1:p1",
      cwd: "/tmp/project",
      direction: "down",
    });

    assert.deepEqual(calls[0].args, [
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "down",
      "--cwd",
      "/tmp/project",
      "--no-focus",
    ]);
  });

  it("paneSplit rejects a response without the created pane id", async () => {
    const { exec } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { type: "pane_split" } }) },
    ]);
    const client = createHerdrClient({ exec });

    await assert.rejects(
      () => client.paneSplit({ cwd: "/tmp/project", direction: "right" }),
      /returned no pane id/,
    );
  });

  it("creates a background tab and returns its root pane", async () => {
    const rootPane = { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2" };
    const { exec, calls } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { root_pane: rootPane, type: "tab_created" } }) },
    ]);
    const client = createHerdrClient({ exec });

    assert.deepEqual(
      await client.tabCreate({ workspaceId: "w1", cwd: "/tmp/project", env: { FOO: "bar" } }),
      rootPane,
    );
    assert.deepEqual(calls[0].args, [
      "tab", "create", "--workspace", "w1", "--cwd", "/tmp/project", "--env", "FOO=bar", "--no-focus",
    ]);
  });

  it("agentStart starts Pi in an existing pane with a valid unique live-agent name", async () => {
    const { exec, calls } = fakeExec([{ stdout: agentStartedEnvelope }]);
    const client = createHerdrClient({ exec });

    const result = await client.agentStart({
      liveAgentName: "worker-abcd1234",
      paneId: "w1:p2",
      argv: ["--session", "/tmp/child.jsonl", "-e", "/tmp/subagent-done.ts"],
    });

    assert.deepEqual(calls[0].args, [
      "agent",
      "start",
      "worker-abcd1234",
      "--kind",
      "pi",
      "--pane",
      "w1:p2",
      "--",
      "--session",
      "/tmp/child.jsonl",
      "-e",
      "/tmp/subagent-done.ts",
    ]);
    assert.deepEqual(result, {
      name: "worker-abcd1234",
      kind: "pi",
      paneId: "w1:p2",
      terminalId: "term_abc123",
    });
  });

  it("agentStart rejects invalid live-agent names before invoking herdr", async () => {
    const { exec, calls } = fakeExec([]);
    const client = createHerdrClient({ exec });

    await assert.rejects(
      () => client.agentStart({ liveAgentName: "Worker 1", paneId: "w1:p2", argv: ["pi"] }),
      /live-agent name/,
    );
    assert.equal(calls.length, 0);
  });

  it("agentPrompt submits multiline task text through the live-agent interface", async () => {
    const { exec, calls } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { type: "agent_prompted" } }) },
    ]);
    const client = createHerdrClient({ exec });
    await client.agentPrompt("worker-abcd1234", "first line\nsecond line");
    assert.deepEqual(calls[0].args, [
      "agent",
      "prompt",
      "worker-abcd1234",
      "first line\nsecond line",
    ]);
  });

  it("agentGet normalizes a live agent and returns null after identity release", async () => {
    const found = JSON.stringify({
      id: "cli:agent:get",
      result: {
        agent: {
          name: "worker-abcd1234",
          agent: "pi",
          pane_id: "w1:p2",
          terminal_id: "term_abc123",
          agent_status: "working",
        },
      },
    });
    const missing = JSON.stringify({
      id: "cli:agent:get",
      error: { code: "agent_not_found", message: "agent is no longer live" },
    });
    const { exec, calls } = fakeExec([
      { stdout: found },
      { stdout: missing, code: 1 },
    ]);
    const client = createHerdrClient({ exec });

    assert.deepEqual(await client.agentGet("worker-abcd1234"), {
      name: "worker-abcd1234",
      kind: "pi",
      paneId: "w1:p2",
      terminalId: "term_abc123",
      status: "working",
    });
    assert.equal(await client.agentGet("worker-abcd1234"), null);
    assert.deepEqual(calls[0].args, ["agent", "get", "worker-abcd1234"]);
  });

  it("makeLiveAgentName sanitizes display text while preserving the unique suffix", () => {
    assert.equal(makeLiveAgentName("PR Review / API!", "abcd1234"), "pr-review-api-abcd1234");
    assert.equal(makeLiveAgentName("123", "deadbeef"), "agent-123-deadbeef");
    const longName = makeLiveAgentName(
      "A very long display name that must be cut",
      "0123456789abcdef",
    );
    assert.match(longName, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.ok(longName.endsWith("-0123456789abcdef"));
    assert.throws(() => makeLiveAgentName("Worker", "not unique!"), /unique suffix/);
  });

  it("error envelope surfaces code+message", async () => {
    const errorEnvelope = JSON.stringify({
      error: { code: "pane_not_found", message: "pane w1:p4 not found" },
      id: "x",
    });

    // exit 0 with error envelope on stdout
    {
      const { exec } = fakeExec([{ stdout: errorEnvelope, code: 0 }]);
      const client = createHerdrClient({ exec });
      await assert.rejects(
        () => client.paneClose("w1:p4"),
        (err: Error) =>
          err.message.includes("pane_not_found") || err.message.includes("pane w1:p4 not found"),
      );
    }

    // nonzero exit with error envelope on stderr
    {
      const { exec } = fakeExec([{ stderr: errorEnvelope, code: 1 }]);
      const client = createHerdrClient({ exec });
      await assert.rejects(
        () => client.paneClose("w1:p4"),
        (err: Error) =>
          err.message.includes("pane_not_found") || err.message.includes("pane w1:p4 not found"),
      );
    }
  });

  it("nonzero exit with non-JSON stderr", async () => {
    const { exec } = fakeExec([{ stderr: "herdr: connection refused", code: 1 }]);
    const client = createHerdrClient({ exec });
    await assert.rejects(
      () => client.paneList(),
      (err: Error) => err.message.includes("herdr: connection refused"),
    );
  });

  it("paneGet returns null for pane_not_found, throws for other errors", async () => {
    const notFound = JSON.stringify({
      error: { code: "pane_not_found", message: "pane w1:p9 not found" },
      id: "x",
    });
    {
      const { exec } = fakeExec([{ stdout: notFound, code: 1 }]);
      const client = createHerdrClient({ exec });
      assert.equal(await client.paneGet("w1:p9"), null);
    }
    {
      const { exec } = fakeExec([
        {
          stdout: JSON.stringify({ error: { code: "internal_error", message: "boom" }, id: "x" }),
          code: 1,
        },
      ]);
      const client = createHerdrClient({ exec });
      await assert.rejects(
        () => client.paneGet("w1:p9"),
        (err: Error) => err.message.includes("boom") || err.message.includes("internal_error"),
      );
    }
    // success case parses the pane record
    {
      const paneEnvelope = JSON.stringify({
        id: "x",
        result: {
          type: "pane_info",
          pane: { pane_id: "w1:p2", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1" },
        },
      });
      const { exec, calls } = fakeExec([{ stdout: paneEnvelope }]);
      const client = createHerdrClient({ exec });
      const pane = await client.paneGet("w1:p2");
      assert.deepEqual(calls[0].args, ["pane", "get", "w1:p2"]);
      assert.equal(pane?.pane_id, "w1:p2");
    }
  });

  it("paneList returns panes array", async () => {
    const envelope = JSON.stringify({
      id: "x",
      result: {
        type: "pane_list",
        panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }],
      },
    });
    const { exec, calls } = fakeExec([{ stdout: envelope }]);
    const client = createHerdrClient({ exec });
    const panes = await client.paneList();
    assert.deepEqual(calls[0].args, ["pane", "list"]);
    assert.deepEqual(
      panes.map((p) => p.pane_id),
      ["w1:p1", "w1:p2"],
    );
  });

  it("paneClose issues pane close", async () => {
    const { exec, calls } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { type: "pane_closed" } }) },
    ]);
    const client = createHerdrClient({ exec });
    await client.paneClose("w1:p3");
    assert.deepEqual(calls[0].args, ["pane", "close", "w1:p3"]);
  });

  it("reports display-only metadata without raw pane input", async () => {
    const { exec, calls } = fakeExec([{ stdout: "" }]);
    const client = createHerdrClient({ exec });
    await client.paneReportMetadata("w1:p2", { title: "Review API", displayAgent: "Reviewer" });
    assert.deepEqual(calls[0].args, [
      "pane", "report-metadata", "w1:p2", "--source", "pi-herdr-subagents",
      "--title", "Review API", "--display-agent", "Reviewer",
    ]);
  });

  it("agentSendKeys sends keys through the live-agent target", async () => {
    const { exec, calls } = fakeExec([{ stdout: "" }]);
    const client = createHerdrClient({ exec });
    await client.agentSendKeys("worker-abcd1234", ["esc"]);
    assert.deepEqual(calls[0].args, ["agent", "send-keys", "worker-abcd1234", "esc"]);
  });

  it("agentSendKeys surfaces the error envelope on failure", async () => {
    const { exec } = fakeExec([
      {
        stdout: JSON.stringify({
          error: { code: "agent_not_found", message: "agent worker-x not found" },
          id: "cli:request",
        }),
        code: 1,
      },
    ]);
    const client = createHerdrClient({ exec });
    await assert.rejects(() => client.agentSendKeys("worker-x", ["esc"]), /agent_not_found/);
  });

  it("ping returns protocol/version info", async () => {
    const statusJson = JSON.stringify({
      status: "running",
      running: true,
      version: "0.7.1",
      protocol: 14,
      socket: "/tmp/herdr.sock",
    });
    {
      const { exec, calls } = fakeExec([{ stdout: statusJson }]);
      const client = createHerdrClient({ exec });
      const ping = await client.ping();
      assert.deepEqual(calls[0].args, ["status", "server", "--json"]);
      assert.equal(ping.ok, true);
      assert.equal(ping.version, "0.7.1");
      assert.equal(ping.protocol, 14);
    }
    // not running → ok: false, no throw
    {
      const { exec } = fakeExec([
        {
          stdout: JSON.stringify({
            status: "not_running",
            running: false,
            version: null,
            protocol: null,
          }),
        },
      ]);
      const client = createHerdrClient({ exec });
      const ping = await client.ping();
      assert.equal(ping.ok, false);
    }
  });

  it("herdr binary resolution", async () => {
    const envelope = JSON.stringify({ id: "x", result: { type: "pane_list", panes: [] } });

    // default: "herdr"
    {
      const prev = process.env.HERDR_BIN;
      delete process.env.HERDR_BIN;
      try {
        const { exec, calls } = fakeExec([{ stdout: envelope }]);
        await createHerdrClient({ exec }).paneList();
        assert.equal(calls[0].cmd, "herdr");
      } finally {
        if (prev !== undefined) process.env.HERDR_BIN = prev;
      }
    }

    // HERDR_BIN env override
    {
      const prev = process.env.HERDR_BIN;
      process.env.HERDR_BIN = "/opt/custom/herdr";
      try {
        const { exec, calls } = fakeExec([{ stdout: envelope }]);
        await createHerdrClient({ exec }).paneList();
        assert.equal(calls[0].cmd, "/opt/custom/herdr");
      } finally {
        if (prev === undefined) delete process.env.HERDR_BIN;
        else process.env.HERDR_BIN = prev;
      }
    }

    // constructor opt wins over env
    {
      const prev = process.env.HERDR_BIN;
      process.env.HERDR_BIN = "/opt/custom/herdr";
      try {
        const { exec, calls } = fakeExec([{ stdout: envelope }]);
        await createHerdrClient({ exec, bin: "/opt/explicit/bin/herdr" }).paneList();
        assert.equal(calls[0].cmd, "/opt/explicit/bin/herdr");
      } finally {
        if (prev === undefined) delete process.env.HERDR_BIN;
        else process.env.HERDR_BIN = prev;
      }
    }
  });
});

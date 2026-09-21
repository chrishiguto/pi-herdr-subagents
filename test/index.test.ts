// Extension surface: activation guard and message renderers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import herdrSubagents from "../extensions/herdr-subagents/index.ts";
import { __test__ } from "../src/orchestrator.ts";
import {
  createFakePi,
  envInsideHerdr,
  installOrchestratorHooks,
  makeFakeClient,
  makeFakeCtx,
  waitFor,
} from "./orchestrator-fixtures.ts";

installOrchestratorHooks();

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

  it("composes child control and nested orchestration tools through one entrypoint", () => {
    envInsideHerdr();
    process.env.PI_SUBAGENT_SESSION = "/tmp/child-session.jsonl";
    process.env.PI_SUBAGENT_ID = "child-1";
    const fake = createFakePi();
    herdrSubagents(fake.api);

    assert.ok(fake.toolNames().includes("caller_ping"));
    assert.ok(fake.toolNames().includes("subagent_done"));
    for (const name of ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"]) {
      assert.ok(fake.toolNames().includes(name), `${name} should be available to a nested orchestrator`);
    }
  });

  it("rejects an incomplete child handshake before semantic tools register", () => {
    envInsideHerdr();
    process.env.PI_SUBAGENT_SESSION = "/tmp/child-session.jsonl";
    const fake = createFakePi();
    assert.throws(() => herdrSubagents(fake.api), /PI_SUBAGENT_ID/);
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
    assert.deepEqual(fake.commands, [], "delegation slash commands follow nesting denial");
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


describe("index: renderers", () => {
  it("registers subagent_result and subagent_ping renderers", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.renderers.has("subagent_result"));
    assert.ok(fake.renderers.has("subagent_ping"));
  });
});

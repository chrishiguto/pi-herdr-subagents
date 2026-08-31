// Durable recovery: reattach, gone-child reporting, and reload survival.
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


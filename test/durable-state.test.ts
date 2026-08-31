import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DURABLE_STATE_VERSION,
  finalizeReportedChild,
  readDurableRecords,
  recoverDurableChildren,
  writeDurableRecord,
  type DurableChildRecord,
} from "../src/durable-state.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-durable-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(overrides: Partial<DurableChildRecord> = {}): DurableChildRecord {
  return {
    version: DURABLE_STATE_VERSION,
    id: "child-abcd1234",
    name: "Worker",
    task: "do work",
    paneId: "w1:p2",
    liveAgentName: "worker-abcd1234",
    sessionFile: "/tmp/child.jsonl",
    lifecycleMode: "autonomous",
    createdAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function client(opts: { agent?: unknown | null; pane?: unknown | null } = {}) {
  const agent = opts.agent === undefined
    ? { name: "worker-abcd1234", kind: "pi", paneId: "w1:p2" }
    : opts.agent;
  const pane = opts.pane === undefined ? { pane_id: "w1:p2" } : opts.pane;
  return {
    async agentGet() { return agent; },
    async paneGet() { return pane; },
  };
}

describe("durable child state", () => {
  it("keeps direct-parent recovery records isolated by session state directory", async () => {
    const parentA = store();
    const parentB = store();
    writeDurableRecord(parentA, record({
      id: "nested-a",
      liveAgentName: "nested-a-live",
      sessionFile: join(parentA, "a.jsonl"),
    }));
    writeDurableRecord(parentB, record({
      id: "nested-b",
      liveAgentName: "nested-b-live",
      sessionFile: join(parentB, "b.jsonl"),
    }));

    const client = {
      agentGet: async (name: string) =>
        name === "nested-a-live" ? { name, kind: "pi", paneId: "w1:p2" } : null,
      paneGet: async () => null,
    };
    const recoveredA = await recoverDurableChildren(parentA, client);

    assert.deepEqual(recoveredA.map((decision) => decision.record.id), ["nested-a"]);
    assert.equal(recoveredA[0].kind, "reattach");
    assert.deepEqual(readDurableRecords(parentB).map((candidate) => candidate.id), ["nested-b"]);
  });

  it("atomically round-trips a versioned record with every recovery identity field", () => {
    const dir = store();
    const saved = record({ lifecycleMode: "manual" });

    writeDurableRecord(dir, saved);

    assert.deepEqual(readDurableRecords(dir), [saved]);
    assert.deepEqual(readdirSync(dir), ["child-abcd1234.json"]);
    assert.doesNotMatch(readFileSync(join(dir, "child-abcd1234.json"), "utf8"), /\.tmp/);
  });

  it("reattaches only when Herdr reports the same live identity and pane", async () => {
    const dir = store();
    writeDurableRecord(dir, record());

    const [decision] = await recoverDurableChildren(dir, client());

    assert.equal(decision.kind, "reattach");
    assert.equal(decision.record.liveAgentName, "worker-abcd1234");
  });

  it("reattaches moved panes by stable terminal identity", async () => {
    const dir = store();
    writeDurableRecord(dir, record({ terminalId: "term_abc123" }));

    const [decision] = await recoverDurableChildren(
      dir,
      client({ agent: { name: "worker-abcd1234", kind: "pi", paneId: "w2:p9", terminalId: "term_abc123" } }),
    );

    assert.equal(decision.kind, "reattach");
  });

  it("reattaches on a correlated completion signal even when the child is gone", async () => {
    const dir = store();
    const saved = record({ sessionFile: join(dir, "child.jsonl") });
    writeDurableRecord(dir, saved);
    writeFileSync(
      `${saved.sessionFile}.exit`,
      JSON.stringify({ version: 1, subagentId: saved.id, type: "done" }),
    );
    cleanups.push(() => rmSync(`${saved.sessionFile}.exit`, { force: true }));

    // The re-armed watcher settles immediately from the sidecar.
    const [decision] = await recoverDurableChildren(dir, client({ agent: null, pane: null }));

    assert.equal(decision.kind, "reattach");
  });

  it("rejects a stale signal and keeps a genuinely live child", async () => {
    const dir = store();
    const saved = record({ sessionFile: join(dir, "child.jsonl") });
    writeDurableRecord(dir, saved);
    writeFileSync(
      `${saved.sessionFile}.exit`,
      JSON.stringify({ version: 1, subagentId: "prior-run", type: "done" }),
    );
    cleanups.push(() => rmSync(`${saved.sessionFile}.exit`, { force: true }));

    const [decision] = await recoverDurableChildren(dir, client());

    assert.equal(decision.kind, "reattach");
    assert.equal(existsSync(`${saved.sessionFile}.exit`), true);
  });

  it("classifies a child missing from Herdr as gone", async () => {
    const dir = store();
    writeDurableRecord(dir, record());

    const [decision] = await recoverDurableChildren(dir, client({ agent: null, pane: null }));

    assert.equal(decision.kind, "gone");
    if (decision.kind === "gone") assert.equal(decision.closePane, false);
  });

  it("flags a leftover pane for cleanup when the agent is gone but the pane survives", async () => {
    const dir = store();
    writeDurableRecord(dir, record());

    const [decision] = await recoverDurableChildren(
      dir,
      client({ agent: null, pane: { pane_id: "w1:p2" } }),
    );

    assert.equal(decision.kind, "gone");
    if (decision.kind === "gone") assert.equal(decision.closePane, true);
  });

  it("classifies an identity mismatch (agent name reused elsewhere) as gone", async () => {
    const dir = store();
    writeDurableRecord(dir, record());

    const [decision] = await recoverDurableChildren(
      dir,
      client({ agent: { name: "worker-abcd1234", kind: "pi", paneId: "w9:p9" }, pane: null }),
    );

    assert.equal(decision.kind, "gone");
  });

  it("finalizeReportedChild removes the record and semantic sidecar after delivery", async () => {
    const dir = store();
    const saved = record({ sessionFile: join(dir, "child.jsonl") });
    writeDurableRecord(dir, saved);
    writeFileSync(
      `${saved.sessionFile}.exit`,
      JSON.stringify({ version: 1, subagentId: saved.id, type: "done" }),
    );
    cleanups.push(() => rmSync(`${saved.sessionFile}.exit`, { force: true }));

    finalizeReportedChild(dir, saved.id, saved.sessionFile);

    assert.equal(existsSync(`${saved.sessionFile}.exit`), false);
    assert.deepEqual(readDurableRecords(dir), []);
    assert.deepEqual(await recoverDurableChildren(dir, client()), []);
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireResumeLock,
  releaseResumeLock,
  resumeLockPath,
} from "../src/resume-lock.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function sessionFile(): string {
  const root = mkdtempSync(join(tmpdir(), "resume-lock-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "child.jsonl");
}

function candidate(id: string) {
  return {
    version: 1 as const,
    id,
    liveAgentName: `worker-${id}`,
    createdAt: new Date().toISOString(),
  };
}

describe("resume exclusivity lock", () => {
  it("allows exactly one simultaneous claimant", async () => {
    const session = sessionFile();
    const [first, second] = await Promise.all([
      acquireResumeLock(session, candidate("first"), async () => false),
      acquireResumeLock(session, candidate("second"), async () => false),
    ]);

    assert.equal([first, second].filter(Boolean).length, 1);
    releaseResumeLock(first ?? second ?? undefined);
  });

  it("reclaims an old lock only after its correlated agent is gone", async () => {
    const session = sessionFile();
    const path = resumeLockPath(session);
    writeFileSync(path, JSON.stringify({
      ...candidate("old"),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const denied = await acquireResumeLock(session, candidate("new"), async () => true);
    assert.equal(denied, null);
    assert.equal(existsSync(path), true);

    const claimed = await acquireResumeLock(session, candidate("new"), async () => false);
    assert.equal(claimed, path);
    releaseResumeLock(claimed ?? undefined);
  });
});

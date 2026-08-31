import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireSessionLock,
  releaseSessionLock,
  sessionLockPath,
} from "../src/session-claim.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function sessionFile(): string {
  const root = mkdtempSync(join(tmpdir(), "session-claim-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "child.jsonl");
}

function candidate(id: string, createdAt = new Date().toISOString()) {
  return {
    version: 1 as const,
    id,
    liveAgentName: `worker-${id}`,
    createdAt,
  };
}

describe("session exclusivity lock", () => {
  it("allows exactly one simultaneous claimant", async () => {
    const session = sessionFile();
    // The exclusive wx open is the whole arbiter: the loser sees EEXIST and,
    // because the winner's lock is fresh, is denied without any probe.
    const probe = async () => {
      throw new Error("a fresh lock must be denied without probing liveness");
    };
    const [first, second] = await Promise.all([
      acquireSessionLock(session, candidate("first"), probe),
      acquireSessionLock(session, candidate("second"), probe),
    ]);

    assert.equal([first, second].filter(Boolean).length, 1);
    releaseSessionLock(first ?? second ?? undefined);
  });

  it("denies a fresh lock even when its correlated agent is not yet visible", async () => {
    const session = sessionFile();
    writeFileSync(sessionLockPath(session), JSON.stringify(candidate("starting")));

    // The launch window: the holder just claimed but Herdr has not registered
    // its agent yet. A dead-looking agent must NOT allow reclaim.
    const denied = await acquireSessionLock(session, candidate("thief"), async () => false);
    assert.equal(denied, null);
    assert.equal(existsSync(sessionLockPath(session)), true);
  });

  it("reclaims an old lock only after its correlated agent is gone", async () => {
    const session = sessionFile();
    const path = sessionLockPath(session);
    writeFileSync(path, JSON.stringify(candidate("old", new Date(Date.now() - 60_000).toISOString())));

    const denied = await acquireSessionLock(session, candidate("new"), async () => true);
    assert.equal(denied, null);
    assert.equal(existsSync(path), true);

    const claimed = await acquireSessionLock(session, candidate("new"), async () => false);
    assert.equal(claimed, path);
    releaseSessionLock(claimed ?? undefined);
  });

  it("fails closed when the liveness probe cannot reach Herdr", async () => {
    const session = sessionFile();
    const path = sessionLockPath(session);
    writeFileSync(path, JSON.stringify(candidate("old", new Date(Date.now() - 60_000).toISOString())));

    await assert.rejects(
      acquireSessionLock(session, candidate("new"), async () => {
        throw new Error("herdr unreachable");
      }),
      /herdr unreachable/,
    );
    assert.equal(existsSync(path), true, "an unverifiable lock must never be reclaimed");
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  launchPolicyPath,
  lifecycleFlags,
  lifecycleModeOf,
  readLaunchPolicy,
  serializeLaunchPolicy,
  type LaunchPolicy,
} from "../src/launch-policy.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function sessionFile(): string {
  const root = mkdtempSync(join(tmpdir(), "launch-policy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "child.jsonl");
}

describe("launch policy sidecar", () => {
  it("round-trips a serialized policy", () => {
    const session = sessionFile();
    const policy: LaunchPolicy = {
      version: 2,
      cwd: "/work",
      model: "openai/gpt-5",
      thinking: "high",
      tools: ["read", "bash"],
      allowNestedDelegation: false,
      denyTools: "subagent",
      agent: "worker",
      lifecycleMode: "manual",
    };
    writeFileSync(launchPolicyPath(session), serializeLaunchPolicy(policy));

    assert.deepEqual(readLaunchPolicy(session), { kind: "ok", policy });
  });

  it("migrates a version-1 policy's lifecycle booleans into the mode enum", () => {
    const session = sessionFile();
    writeFileSync(
      launchPolicyPath(session),
      JSON.stringify({
        version: 1,
        cwd: "/work",
        allowNestedDelegation: true,
        interactive: false,
        autoExit: false,
      }),
    );

    const read = readLaunchPolicy(session);
    assert.equal(read.kind, "ok");
    assert.equal(read.kind === "ok" && read.policy.lifecycleMode, "manual");
  });

  it("distinguishes an absent sidecar from a corrupt one", () => {
    const absent = sessionFile();
    assert.deepEqual(readLaunchPolicy(absent), { kind: "absent" });

    const corrupt = sessionFile();
    writeFileSync(launchPolicyPath(corrupt), "not json {");
    assert.deepEqual(readLaunchPolicy(corrupt), { kind: "corrupt" });

    const wrongShape = sessionFile();
    writeFileSync(
      launchPolicyPath(wrongShape),
      JSON.stringify({ version: 2, cwd: "/work", lifecycleMode: "chaotic" }),
    );
    assert.deepEqual(readLaunchPolicy(wrongShape), { kind: "corrupt" });
  });

  it("maps lifecycle modes to and from the request flags", () => {
    assert.equal(lifecycleModeOf({ interactive: true, autoExit: false }), "interactive");
    assert.equal(lifecycleModeOf({ interactive: false, autoExit: true }), "autonomous");
    assert.equal(lifecycleModeOf({ interactive: false, autoExit: false }), "manual");
    assert.deepEqual(lifecycleFlags("manual"), { interactive: false, autoExit: false });
    assert.deepEqual(lifecycleFlags("interactive"), { interactive: true, autoExit: false });
    assert.deepEqual(lifecycleFlags("autonomous"), { interactive: false, autoExit: true });
  });
});

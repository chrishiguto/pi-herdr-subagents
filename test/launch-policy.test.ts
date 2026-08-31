import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveRuntimePolicy } from "../src/launch.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-policy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const child = join(project, "packages", "child");
  mkdirSync(child, { recursive: true });
  return { root, project, child };
}

describe("runtime policy", () => {
  it("resolves all request overrides without an agent definition", () => {
    const { project, child } = projectFixture();
    const policy = resolveRuntimePolicy(
      {
        cwd: "packages/child",
        model: "openai/gpt-5",
        thinking: "high",
        tools: ["read", "bash"],
        allowNestedDelegation: false,
      },
      null,
      {
        parentCwd: project,
        isModelAvailable: (model) => model === "openai/gpt-5",
      },
    );

    assert.deepEqual(policy, {
      cwd: child,
      model: "openai/gpt-5",
      thinking: "high",
      tools: ["read", "bash"],
      allowNestedDelegation: false,
    });
  });

  it("resolves a relative agent-definition cwd against the agent config directory", () => {
    const { root, project } = projectFixture();
    const agentDir = join(root, "agent-config");
    const target = join(agentDir, "agent-sub");
    mkdirSync(target, { recursive: true });
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    cleanups.push(() => {
      if (saved == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    });

    const policy = resolveRuntimePolicy({}, { cwd: "agent-sub" }, { parentCwd: project });
    assert.equal(policy.cwd, target);
  });

  it("inherits normal tools and allows nesting when no policy overrides are supplied", () => {
    const { project } = projectFixture();
    const policy = resolveRuntimePolicy({}, null, { parentCwd: project });
    assert.equal(policy.tools, undefined);
    assert.equal(policy.allowNestedDelegation, true);
    assert.equal(policy.cwd, project);
  });

  it("lets every request field override agent defaults and accepts an absolute cwd", () => {
    const { child } = projectFixture();
    const policy = resolveRuntimePolicy(
      {
        cwd: child,
        model: "openai/request-model",
        thinking: "low",
        tools: ["read"],
        allowNestedDelegation: true,
      },
      {
        cwd: "agent-cwd",
        model: "openai/agent-model",
        thinking: "high",
        tools: "bash,write",
        spawning: false,
      },
      {
        parentCwd: child,
        isModelAvailable: (model) => model === "openai/request-model",
      },
    );

    assert.deepEqual(policy, {
      cwd: child,
      model: "openai/request-model",
      thinking: "low",
      tools: ["read"],
      allowNestedDelegation: true,
    });
  });

  it("rejects invalid directories, models, thinking levels, tools, and nesting values", () => {
    const { project, root } = projectFixture();
    const file = join(root, "not-a-directory");
    writeFileSync(file, "x");

    assert.throws(
      () => resolveRuntimePolicy({ cwd: "missing" }, null, { parentCwd: project }),
      /Working directory does not exist/,
    );
    assert.throws(
      () => resolveRuntimePolicy({ cwd: file }, null, { parentCwd: project }),
      /Working directory is not a directory/,
    );
    assert.throws(
      () =>
        resolveRuntimePolicy({ model: "openai/missing" }, null, {
          parentCwd: project,
          isModelAvailable: () => false,
        }),
      /Model "openai\/missing" is not available/,
    );
    assert.throws(
      () => resolveRuntimePolicy({ thinking: "extreme" as never }, null, { parentCwd: project }),
      /Invalid thinking level "extreme"/,
    );
    assert.throws(
      () => resolveRuntimePolicy({ tools: ["read", "bad tool"] }, null, { parentCwd: project }),
      /Invalid tool name "bad tool"/,
    );
    assert.throws(
      () =>
        resolveRuntimePolicy({ allowNestedDelegation: "sometimes" as never }, null, {
          parentCwd: project,
        }),
      /allowNestedDelegation must be a boolean/,
    );
  });
});

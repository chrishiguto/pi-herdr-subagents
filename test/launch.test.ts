import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildLaunchPlan,
  buildPiPromptArgs,
  buildResumeLaunchPlan,
  buildSubagentToolAllowlist,
  type LaunchPlanContext,
  type SubagentLaunchParams,
} from "../src/launch.ts";
import type { AgentDefaults } from "../src/agents.ts";

function planLaunch(
  params: SubagentLaunchParams,
  agentDefs: AgentDefaults | null,
  ctx: LaunchPlanContext,
  isModelAvailable?: (model: string) => boolean,
) {
  return buildLaunchPlan(params, agentDefs, { ...ctx, isModelAvailable });
}

const cleanups: Array<() => void> = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (savedAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function fixture(): LaunchPlanContext {
  const root = mkdtempSync(join(tmpdir(), "herdr-launch-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    sessionDir: join(root, "orchestrator"),
    sessionId: "parent-id",
    parentSessionFile: join(root, "orchestrator", "parent.jsonl"),
    parentLeafId: "parent-leaf",
    parentCwd: cwd,
    env: { PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: agentDir, HERDR_PANE_ID: "w1:p1" },
    id: "abcd1234",
    now: new Date("2026-07-06T12:00:00.000Z"),
    subagentDonePath: "/pkg/subagent-done.ts",
  };
}

describe("native launch planning", () => {
  it("launches a plain autonomous Pi child without an agent definition", () => {
    const plan = planLaunch({ name: "Worker", task: "Do the thing" }, null, fixture());
    assert.equal(plan.autoExit, true);
    assert.equal(plan.interactive, false);
    assert.equal(plan.paneSplit.sourcePaneId, "w1:p1");
    assert.equal("direction" in plan.paneSplit, false);
    assert.equal(plan.agentStart.liveAgentName, "worker-abcd1234");
    assert.deepEqual(plan.agentStart.argv.slice(0, 4), ["--session", plan.sessionFile, "-e", "/pkg/subagent-done.ts"]);
    assert.equal(plan.initialPrompts.length, 1);
    assert.match(plan.initialPrompts[0], /^@/);
    assert.ok(!("launchScriptFile" in plan));
    assert.equal(plan.seedSession?.mode, "lineage-only");
    assert.equal(plan.seedSession?.parentLeafId, "parent-leaf");
  });

  it("keeps planning side-effect free", () => {
    const plan = planLaunch({ name: "Worker", task: "Task" }, null, fixture());
    assert.equal(existsSync(dirname(plan.sessionFile)), false);
  });

  it("passes model, tools, system prompt, and curated environment natively", () => {
    const plan = planLaunch(
      { name: "Review Bot", task: "Review", model: "openai/gpt", tools: "read,bash", systemPrompt: "Be exact" },
      { systemPromptMode: "append", thinking: "high", denyTools: "write" },
      fixture(),
    );
    assert.deepEqual(
      plan.agentStart.argv.slice(
        plan.agentStart.argv.indexOf("--model"),
        plan.agentStart.argv.indexOf("--model") + 4,
      ),
      ["--model", "openai/gpt", "--thinking", "high"],
    );
    assert.ok(plan.agentStart.argv.includes("read,bash,caller_ping,subagent_done"));
    assert.ok(plan.agentStart.argv.includes("--append-system-prompt"));
    assert.equal(plan.paneSplit.env.PI_DENY_TOOLS, "write");
    assert.equal(plan.paneSplit.env.PI_SUBAGENT_AUTO_EXIT, undefined);
  });

  it("applies a combined generic runtime policy before native launch", () => {
    const ctx = fixture();
    const childCwd = join(ctx.parentCwd, "packages", "child");
    mkdirSync(childCwd, { recursive: true });
    ctx.env.UNRELATED_SECRET = "must-not-leak";

    const plan = planLaunch(
      {
        name: "Policy Worker",
        task: "Work",
        cwd: "packages/child",
        model: "openai/gpt-5",
        thinking: "xhigh",
        tools: ["read", "bash"],
        allowNestedDelegation: false,
      },
      null,
      ctx,
      (model) => model === "openai/gpt-5",
    );

    assert.equal(plan.effectiveCwd, childCwd);
    assert.equal(plan.seedSession.childCwd, childCwd);
    assert.equal(plan.paneSplit.cwd, childCwd);
    assert.ok(plan.agentStart.argv.includes("openai/gpt-5"));
    assert.ok(plan.agentStart.argv.includes("xhigh"));
    assert.ok(plan.agentStart.argv.includes("read,bash,caller_ping,subagent_done"));
    assert.equal(
      plan.paneSplit.env.PI_DENY_TOOLS,
      "subagent,subagent_interrupt,subagents_list,subagent_resume",
    );
    assert.equal(plan.paneSplit.env.UNRELATED_SECRET, undefined);
  });

  it("refuses to plan a launch outside a Herdr pane", () => {
    const ctx = fixture();
    delete ctx.env.HERDR_PANE_ID;
    assert.throws(
      () => planLaunch({ name: "Worker", task: "Task" }, null, ctx),
      /HERDR_PANE_ID is not set/,
    );
  });

  it("fails invalid runtime policy before producing a launch plan", () => {
    const ctx = fixture();
    assert.throws(
      () => planLaunch({ name: "Worker", task: "Task", cwd: "missing" }, null, ctx),
      /Working directory does not exist/,
    );
    assert.throws(
      () =>
        planLaunch(
          { name: "Worker", task: "Task", model: "openai/not-configured" },
          null,
          ctx,
          () => false,
        ),
      /Model "openai\/not-configured" is not available/,
    );
  });

  it("separates startup arguments from initial prompts", () => {
    const plan = planLaunch({ name: "Worker", task: "Task", skills: "research" }, null, fixture());
    assert.ok(!plan.agentStart.argv.some((arg) => arg.startsWith("@")));
    assert.deepEqual(plan.initialPrompts.slice(0, 2), ["", "/skill:research"]);
  });

  it("submits a compiled workflow slash command before any model request", () => {
    const plan = planLaunch(
      {
        name: "Worker",
        task: "Implement issue 42",
        workflow: { kind: "skill", name: "implement" },
      },
      null,
      fixture(),
    );
    assert.deepEqual(plan.initialPrompts, ["/skill:implement Implement issue 42"]);
    assert.equal(plan.taskArtifactFile, null);
    assert.ok(!plan.agentStart.argv.some((arg) => arg.includes("Implement issue 42")));
  });

  it("plans standalone, lineage-only, and fork with the task as the first new user input", () => {
    for (const contextMode of ["standalone", "lineage-only", "fork"] as const) {
      const plan = planLaunch(
        { name: `Worker ${contextMode}`, task: `TASK_${contextMode}`, contextMode },
        null,
        fixture(),
      );

      assert.equal(plan.seedSession?.mode, contextMode);
      assert.equal(plan.seedSession?.parentLeafId, "parent-leaf");
      assert.equal(plan.agentStart.argv.includes(`TASK_${contextMode}`), false);
      assert.equal(plan.initialPrompts.length, 1);
      if (contextMode === "fork") {
        assert.equal(plan.initialPrompts[0], "TASK_fork");
        assert.equal(plan.taskArtifactFile, null);
      } else {
        assert.equal(plan.initialPrompts[0], `@${plan.taskArtifactFile}`);
        const taskArtifact = plan.files.find((file) => file.path === plan.taskArtifactFile);
        assert.match(taskArtifact?.content ?? "", new RegExp(`TASK_${contextMode}`));
      }
    }
  });

  it("plans resume with the existing deterministic session reference", () => {
    const ctx = fixture();
    const sessionPath = join(ctx.parentCwd, "child.jsonl");
    const plan = buildResumeLaunchPlan({ sessionPath, message: "Continue" }, ctx);
    assert.equal(plan.sessionFile, sessionPath);
    assert.equal(plan.autoExit, true);
    assert.deepEqual(plan.agentStart.argv.slice(0, 2), ["--session", sessionPath]);
    assert.deepEqual(plan.initialPrompts, [`@${plan.resumeMessageFile}`]);
  });

  it("marks an interactive resume and preserves the same session", () => {
    const ctx = fixture();
    const sessionPath = join(ctx.parentCwd, "asking-child.jsonl");
    const plan = buildResumeLaunchPlan(
      { sessionPath, message: "Use PostgreSQL", autoExit: false },
      ctx,
    );

    assert.equal(plan.sessionFile, sessionPath);
    assert.equal(plan.interactive, true);
    assert.equal(plan.autoExit, false);
    assert.equal(plan.paneSplit.env.PI_SUBAGENT_INTERACTIVE, "1");
    assert.equal(plan.paneSplit.env.PI_SUBAGENT_AUTO_EXIT, undefined);
    assert.deepEqual(plan.agentStart.argv.slice(0, 2), ["--session", sessionPath]);
    assert.deepEqual(plan.initialPrompts, [`@${plan.resumeMessageFile}`]);
  });
});

describe("Pi argument helpers", () => {
  it("preserves child control tools in a restricted allowlist", () => {
    assert.equal(buildSubagentToolAllowlist(["read", "bash"]), "read,bash,caller_ping,subagent_done");
    assert.equal(buildSubagentToolAllowlist([]), "caller_ping,subagent_done");
    assert.equal(buildSubagentToolAllowlist(), null);
  });

  it("keeps skill prompts separate from artifact-backed tasks", () => {
    assert.deepEqual(
      buildPiPromptArgs({ effectiveSkills: "one,two", taskDelivery: "artifact", taskArg: "@task.md" }),
      ["", "/skill:one", "/skill:two", "@task.md"],
    );
  });
});

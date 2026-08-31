// Ported from pi-interactive-subagents test/test.ts ("subagent discovery" +
// resolveDenyTools cases) — these tests define the frontmatter compatibility contract
// (PROJECT-BRIEF.md hard requirement 2). Adaptations: functions imported directly from
// src/agents.ts instead of the extension __test__ API; no bundled-agent runtime source.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadAgentDefaults,
  parseAgentDefinition,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  SPAWNING_TOOLS,
} from "../src/agents.ts";

// --- Helpers (same technique as the reference tests) ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "herdr-agents-test-"));
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}

// --- Tests ---

describe("agents.ts", () => {
  describe("parseAgentDefinition", () => {
    it("parses the full frontmatter field set", () => {
      const content = [
        "---",
        "name: full-agent",
        "description: Does everything",
        "model: anthropic/claude-sonnet-4-5",
        "tools: read,bash",
        "skill: review",
        "thinking: high",
        "deny-tools: web_search",
        "spawning: false",
        "auto-exit: true",
        "interactive: false",
        "session-mode: fork",
        "cwd: sub/dir",
        "cli: pi",
        "system-prompt: replace",
        "disable-model-invocation: true",
        "---",
        "",
        "Body text here.",
      ].join("\n");

      const parsed = parseAgentDefinition(content, "fallback");
      assert.ok(parsed);
      assert.equal(parsed.name, "full-agent");
      assert.equal(parsed.description, "Does everything");
      assert.equal(parsed.model, "anthropic/claude-sonnet-4-5");
      assert.equal(parsed.tools, "read,bash");
      assert.equal(parsed.skills, "review");
      assert.equal(parsed.thinking, "high");
      assert.equal(parsed.denyTools, "web_search");
      assert.equal(parsed.spawning, false);
      assert.equal(parsed.autoExit, true);
      assert.equal(parsed.interactive, false);
      assert.equal(parsed.sessionMode, "fork");
      assert.equal(parsed.cwd, "sub/dir");
      assert.equal(parsed.cli, "pi");
      assert.equal(parsed.systemPromptMode, "replace");
      assert.equal(parsed.disableModelInvocation, true);
      assert.equal(parsed.body, "Body text here.");
    });

    it("uses the fallback name and returns null without frontmatter", () => {
      const parsed = parseAgentDefinition("---\nmodel: m\n---\nbody", "from-filename");
      assert.equal(parsed?.name, "from-filename");
      assert.equal(parseAgentDefinition("no frontmatter here", "x"), null);
    });

    it("prefers `skill` over `skills` and accepts either", () => {
      const both = parseAgentDefinition("---\nskill: a\nskills: b\n---\n", "x");
      assert.equal(both?.skills, "a");
      const plural = parseAgentDefinition("---\nskills: b\n---\n", "x");
      assert.equal(plural?.skills, "b");
    });

    it("parses cli: claude for compat (rejection happens at launch, not parse)", () => {
      const parsed = parseAgentDefinition(
        "---\nname: cc\ncli: claude\nmodel: opus\n---\nBody",
        "cc",
      );
      assert.ok(parsed);
      assert.equal(parsed.cli, "claude");
      assert.equal(parsed.model, "opus");
    });
  });

  describe("loadAgentDefaults", () => {
    it("loads session-mode from frontmatter", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
        writeAgentFile(
          projectAgentsDir,
          "lineage-mode-test-agent",
          [
            "name: lineage-mode-test-agent",
            "model: anthropic/test-lineage",
            "session-mode: lineage-only",
          ].join("\n"),
        );

        const loaded = loadAgentDefaults("lineage-mode-test-agent");
        assert.ok(loaded, "expected agent to load");
        assert.equal(loaded.sessionMode, "lineage-only");
      });
    });

    it("loads explicit interactive flag from frontmatter", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
        writeAgentFile(
          projectAgentsDir,
          "interactive-true-test-agent",
          [
            "name: interactive-true-test-agent",
            "model: anthropic/test-interactive-true",
            "interactive: true",
          ].join("\n"),
        );
        writeAgentFile(
          projectAgentsDir,
          "interactive-false-test-agent",
          [
            "name: interactive-false-test-agent",
            "model: anthropic/test-interactive-false",
            "interactive: false",
          ].join("\n"),
        );

        assert.equal(loadAgentDefaults("interactive-true-test-agent")?.interactive, true);
        assert.equal(loadAgentDefaults("interactive-false-test-agent")?.interactive, false);
      });
    });

    it("leaves interactive undefined when not set in frontmatter", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
        writeAgentFile(
          projectAgentsDir,
          "interactive-unset-test-agent",
          ["name: interactive-unset-test-agent", "model: anthropic/test-interactive-unset"].join(
            "\n",
          ),
        );

        assert.equal(loadAgentDefaults("interactive-unset-test-agent")?.interactive, undefined);
      });
    });

    it("ignores invalid session-mode values", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
        writeAgentFile(
          projectAgentsDir,
          "invalid-mode-test-agent",
          [
            "name: invalid-mode-test-agent",
            "model: anthropic/test-invalid",
            "session-mode: sideways",
          ].join("\n"),
        );

        const loaded = loadAgentDefaults("invalid-mode-test-agent");
        assert.ok(loaded, "expected agent to load");
        assert.equal(loaded.sessionMode, undefined);
      });
    });

    it("project agents override global agents", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "precedence-test-agent",
          ["name: precedence-test-agent", "model: anthropic/test-global"].join("\n"),
          "You are the global agent.",
        );
        writeAgentFile(
          projectAgentsDir,
          "precedence-test-agent",
          ["name: precedence-test-agent", "model: anthropic/test-project"].join("\n"),
          "You are the project agent.",
        );

        const loaded = loadAgentDefaults("precedence-test-agent");
        assert.equal(loaded?.model, "anthropic/test-project");
        assert.equal(loaded?.body, "You are the project agent.");
      });
    });

    it("falls back to the global dir when the project has no such agent", async () => {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "global-only-test-agent",
          ["name: global-only-test-agent", "model: anthropic/test-global-only"].join("\n"),
        );

        assert.equal(loadAgentDefaults("global-only-test-agent")?.model, "anthropic/test-global-only");
      });
    });

    it("returns null for unknown agents", async () => {
      await withIsolatedAgentEnv(async () => {
        assert.equal(loadAgentDefaults("no-such-agent-anywhere"), null);
      });
    });
  });

  describe("disable-model-invocation agents", () => {
    it("keeps disable-model-invocation agents directly loadable", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
        writeAgentFile(
          projectAgentsDir,
          "hidden-discovery-test-agent",
          [
            "name: hidden-discovery-test-agent",
            "description: Hidden test agent",
            "model: anthropic/test-hidden",
            "disable-model-invocation: true",
          ].join("\n"),
          "You are the hidden agent.",
        );

        const loaded = loadAgentDefaults("hidden-discovery-test-agent");
        assert.ok(loaded, "expected hidden agent to remain directly loadable");
        assert.equal(loaded.model, "anthropic/test-hidden");
        assert.equal(loaded.body, "You are the hidden agent.");
        assert.equal(loaded.disableModelInvocation, true);
      });
    });

    it("lets a hidden project agent shadow a visible global agent", async () => {
      await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "shadowed-hidden-test-agent",
          [
            "name: shadowed-hidden-test-agent",
            "description: Global visible agent",
            "model: anthropic/test-global",
          ].join("\n"),
          "You are the global visible agent.",
        );
        writeAgentFile(
          projectAgentsDir,
          "shadowed-hidden-test-agent",
          [
            "name: shadowed-hidden-test-agent",
            "description: Project hidden agent",
            "model: anthropic/test-project",
            "disable-model-invocation: true",
          ].join("\n"),
          "You are the project hidden agent.",
        );

        const loaded = loadAgentDefaults("shadowed-hidden-test-agent");
        assert.ok(loaded, "expected project override to remain directly loadable");
        assert.equal(loaded.model, "anthropic/test-project");
        assert.equal(loaded.body, "You are the project hidden agent.");
        assert.equal(loaded.disableModelInvocation, true);
      });
    });
  });

  describe("resolveEffectiveInteractive", () => {
    it("defaults to the inverse of auto-exit", () => {
      // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
      assert.equal(resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }), false);
      // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
      assert.equal(resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }), true);
      assert.equal(resolveEffectiveInteractive({ name: "A", task: "T" }, {}), true);
      // Bare generic tasks are autonomous unless the caller opts into interaction.
      assert.equal(resolveEffectiveInteractive({ name: "A", task: "T" }, null), false);
    });

    it("honors explicit frontmatter over the auto-exit default", () => {
      // Autonomous agent that still wants to be treated as interactive.
      assert.equal(
        resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true, interactive: true }),
        true,
      );
      // Non-auto-exit agent that opts back into stall pings.
      assert.equal(
        resolveEffectiveInteractive({ name: "A", task: "T" }, { interactive: false }),
        false,
      );
    });

    it("honors the explicit tool parameter over all else", () => {
      assert.equal(
        resolveEffectiveInteractive(
          { name: "A", task: "T", interactive: false },
          { autoExit: false, interactive: true },
        ),
        false,
      );
      assert.equal(
        resolveEffectiveInteractive(
          { name: "A", task: "T", interactive: true },
          { autoExit: true, interactive: false },
        ),
        true,
      );
    });
  });

  describe("resolveEffectiveSessionMode / resolveLaunchBehavior", () => {
    it("defaults generic launches to lineage-only and honors explicit contextMode", () => {
      assert.equal(resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "lineage-only");
      assert.equal(
        resolveEffectiveSessionMode(
          { name: "A", task: "T", contextMode: "standalone" },
          { sessionMode: "fork" },
        ),
        "standalone",
      );
      assert.equal(
        resolveEffectiveSessionMode(
          { name: "A", task: "T", contextMode: "lineage-only" },
          { sessionMode: "standalone" },
        ),
        "lineage-only",
      );
      assert.equal(
        resolveEffectiveSessionMode(
          { name: "A", task: "T", contextMode: "fork" },
          { sessionMode: "standalone" },
        ),
        "fork",
      );
    });

    it("keeps agent-definition modes below contextMode precedence", () => {
      assert.equal(
        resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
        "lineage-only",
      );
    });

    it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
      assert.deepEqual(resolveLaunchBehavior({ name: "A", task: "T" }, null), {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      });
      assert.deepEqual(
        resolveLaunchBehavior({ name: "A", task: "T", contextMode: "standalone" }, null),
        {
          sessionMode: "standalone",
          seededSessionMode: "standalone",
          inheritsConversationContext: false,
          taskDelivery: "artifact",
        },
      );
      assert.deepEqual(
        resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
        {
          sessionMode: "lineage-only",
          seededSessionMode: "lineage-only",
          inheritsConversationContext: false,
          taskDelivery: "artifact",
        },
      );
      assert.deepEqual(resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }), {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      });
    });
  });

  describe("resolveDenyTools", () => {
    it("expands spawning false to deny all spawning tools", () => {
      const denied = resolveDenyTools({ spawning: false });
      assert.equal(denied.has("subagent"), true);
      assert.equal(denied.has("subagent_interrupt"), true);
      assert.equal(denied.has("subagent_resume"), true);
      assert.equal(denied.has("subagents_list"), true);
      for (const t of SPAWNING_TOOLS) assert.equal(denied.has(t), true);
    });

    it("adds explicit deny-tools entries on top", () => {
      const denied = resolveDenyTools({ spawning: false, denyTools: "web_search, bash" });
      assert.equal(denied.has("web_search"), true);
      assert.equal(denied.has("bash"), true);
      assert.equal(denied.has("subagent"), true);
    });

    it("returns an empty set for null defs or spawning left enabled", () => {
      assert.equal(resolveDenyTools(null).size, 0);
      assert.equal(resolveDenyTools({}).size, 0);
      assert.equal(resolveDenyTools({ spawning: true }).size, 0);
    });

    it("lets an explicit request nesting policy override the agent default", () => {
      assert.deepEqual(resolveDenyTools({ spawning: false }, true), new Set());
      assert.deepEqual(resolveDenyTools(null, false), SPAWNING_TOOLS);
    });
  });

});

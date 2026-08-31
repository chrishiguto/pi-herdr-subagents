import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeLiveAgentName } from "../../src/herdr/client.ts";
import {
  createTestSession,
  dumpPanes,
  integrationPrereqs,
  paneExists,
  PI_TIMEOUT,
  startPiAgent,
  type TestSession,
  waitFor,
  waitForFile,
} from "./harness.ts";

const prereqs = integrationPrereqs({ noModel: true });

describe(
  "Herdr 0.8 no-model workflow smoke",
  { skip: prereqs.ok ? false : prereqs.reason, timeout: PI_TIMEOUT },
  () => {
    let ts: TestSession;

    before(async () => {
      ts = await createTestSession({ noModel: true });
    });
    after(async () => {
      await ts?.teardown();
    });

  it("expands a delegated child skill before any model request", async () => {
    const skillDir = join(ts.configDir, "skills", "live-probe");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: live-probe",
        "description: Provider-free workflow expansion probe.",
        "---",
        "LIVE_SKILL_EXPANSION_MARKER",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(ts.configDir, "models.json"),
      JSON.stringify({
        providers: {
          probe: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "provider-free-probe",
            models: [{ id: "no-model" }],
          },
        },
      }),
    );

    const sessionRef = join(ts.tmpDir, "workflow-session.jsonl");
    const pane = await ts.client.paneSplit({
      sourcePaneId: ts.sourcePaneId,
      cwd: ts.tmpDir,
      direction: "right",
      env: { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: ts.configDir },
    });
    ts.trackedPanes.push(pane.pane_id);
    const liveAgentName = makeLiveAgentName("workflow-probe", "slice04");
    await startPiAgent(ts, {
      liveAgentName,
      paneId: pane.pane_id,
      argv: ["-ne", "--session", sessionRef, "--model", "probe/no-model", "--no-context-files", "--offline"],
    });

    await ts.client.agentPrompt(liveAgentName, "/skill:live-probe delegated input");
    const session = await waitForFile(
      sessionRef,
      15_000,
      /LIVE_SKILL_EXPANSION_MARKER/,
      () => dumpPanes(ts),
    );
    assert.match(session, /delegated input/);
    assert.equal(existsSync(join(ts.configDir, "agents")), false);

    await ts.client.paneClose(pane.pane_id);
    await waitFor(async () => !(await paneExists(ts, pane.pane_id)), {
      timeout: 10_000,
      label: `workflow pane ${pane.pane_id} cleanup`,
    });
    });
  },
);

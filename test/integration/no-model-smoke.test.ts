/**
 * Provider-free Herdr smoke test for the slice-01 launch boundary.
 *
 * A real Pi process is started through Herdr 0.8's paneSplit → agentStart
 * contract, but its tiny extension only writes deterministic lifecycle files;
 * it never submits a prompt or calls a model. The public Pi extension-runtime
 * test separately covers pi-herdr-subagents' tool registration and steer wiring.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeLiveAgentName } from "../../src/herdr/client.ts";
import {
  agentExists,
  createTestSession,
  dumpPanes,
  integrationPrereqs,
  paneExists,
  PI_TIMEOUT,
  sleep,
  startPiAgent,
  type TestSession,
  waitFor,
  waitForFile,
} from "./harness.ts";

const prereqs = integrationPrereqs({ noModel: true });

describe(
  "Herdr 0.8 no-model launch smoke",
  { skip: prereqs.ok ? false : prereqs.reason, timeout: PI_TIMEOUT },
  () => {
    let ts: TestSession;

    before(async () => {
      ts = await createTestSession({ noModel: true });
    });

    after(async () => {
      await ts?.teardown();
    });

    it("keeps focus, acknowledges readiness, and reports one released completion", async () => {
      assert.equal(existsSync(join(ts.configDir, "auth.json")), false);
      assert.equal(existsSync(join(ts.configDir, "agents")), false);

      const sessionRef = join(ts.tmpDir, "probe-session.jsonl");
      const ackFile = join(ts.tmpDir, "probe-ack.json");
      const resultFile = join(ts.tmpDir, "probe-results.jsonl");
      const extensionFile = join(ts.tmpDir, "no-model-probe.ts");
      const probeFactory = `
import { appendFileSync, writeFileSync } from "node:fs";

let started = false;

export default function noModelProbe(pi) {
  pi.on("session_start", (_event, ctx) => {
    if (started) return;
    started = true;
    const sessionFile = ctx.sessionManager.getSessionFile();
    writeFileSync(${JSON.stringify(ackFile)}, JSON.stringify({ status: "started", sessionFile }));

    pi.registerCommand("probe-complete", {
      description: "Complete the provider-free probe",
      handler: async () => {
      appendFileSync(
        ${JSON.stringify(resultFile)},
        JSON.stringify({ summary: "provider-free probe complete", sessionFile }) + "\\n",
      );
      ctx.shutdown();
      },
    });
  });
}
`;
      writeFileSync(extensionFile, probeFactory, "utf8");

      const sourceBefore = await ts.client.paneGet(ts.sourcePaneId);
      assert.equal(sourceBefore?.focused, true, "the isolated source pane should start focused");

      const childPane = await ts.client.paneSplit({
        sourcePaneId: ts.sourcePaneId,
        cwd: ts.tmpDir,
        direction: "right",
        env: {
          PATH: process.env.PATH ?? "",
          PI_CODING_AGENT_DIR: ts.configDir,
        },
      });
      ts.trackedPanes.push(childPane.pane_id);

      const liveAgentName = makeLiveAgentName("no-model-probe", "slice01");
      const started = await startPiAgent(ts, {
        liveAgentName,
        paneId: childPane.pane_id,
        argv: [
          "-ne",
          "-e",
          extensionFile,
          "--session",
          sessionRef,
          "--no-context-files",
          "--offline",
        ],
      });
      assert.equal(started.paneId, childPane.pane_id);

      const ack = JSON.parse(await waitForFile(ackFile, 15_000, undefined, () => dumpPanes(ts)));
      assert.deepEqual(ack, { status: "started", sessionFile: sessionRef });
      assert.equal(existsSync(resultFile), false, "ack must precede released completion");

      const sourceAfterStart = await ts.client.paneGet(ts.sourcePaneId);
      const childAfterStart = await ts.client.paneGet(childPane.pane_id);
      assert.equal(sourceAfterStart?.focused, true, "background launch must preserve source focus");
      assert.equal(childAfterStart?.focused, false, "the child pane must not take focus");

      await ts.client.agentPrompt(liveAgentName, "/probe-complete");
      await waitForFile(resultFile, 15_000, /provider-free probe complete/, () => dumpPanes(ts));
      await waitFor(
        async () => !(await agentExists(ts, liveAgentName)),
        {
          timeout: 15_000,
          label: `Pi agent ${liveAgentName} to release its pane`,
          debug: () => dumpPanes(ts),
        },
      );

      const results = readFileSync(resultFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(results, [
        { summary: "provider-free probe complete", sessionFile: sessionRef },
      ]);
      await sleep(100);
      assert.equal(readFileSync(resultFile, "utf8").trim().split("\n").length, 1);

      await ts.client.paneClose(childPane.pane_id);
      await waitFor(async () => !(await paneExists(ts, childPane.pane_id)), {
        timeout: 10_000,
        label: `probe pane ${childPane.pane_id} cleanup`,
      });
    });

  },
);

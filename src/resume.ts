// subagent_resume — reapply the persisted launch policy, establish the
// exclusive session claim, and relaunch the child. The runtime owns the
// claim/launch machinery; this module owns the tool contract around it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { exitSidecarPath } from "./child-protocol.ts";
import { contextUsagePath } from "./context-usage.ts";
import { getDurableStateDir } from "./durable-state.ts";
import { buildResumeLaunchPlan } from "./launch.ts";
import { launchPolicyPath, readLaunchPolicy } from "./launch-policy.ts";
import { describeChildLaunchError, type SubagentRuntime } from "./runtime.ts";
import { findLastAssistantMessage, getNewEntriesSafe } from "./session.ts";
import {
  errorResult,
  ResumeParamsSchema,
  type ResumeParams,
  type ResumeToolDetails,
} from "./tool-contracts.ts";
import { renderAckResult, renderToolTitle } from "./tool-renderers.ts";
import type { RunningSubagent, SubagentOutcome } from "./watcher.ts";

/** The orchestrator surface the resume tool needs: the live generation's runtime. */
export interface ResumeHost {
  runtime(): SubagentRuntime;
}

/**
 * Re-scope a resumed subagent's outcome summary to entries added AFTER the
 * resume launch (ported reference behavior): the pre-existing conversation
 * must not masquerade as new output. Launch failures and pings pass through
 * untouched — their payloads are already truthful.
 */
export function resolveResumeOutcome(
  outcome: SubagentOutcome,
  sessionPath: string,
  entryCountBefore: number,
): SubagentOutcome {
  const newSummary = () =>
    findLastAssistantMessage(getNewEntriesSafe(sessionPath, entryCountBefore));

  switch (outcome.kind) {
    case "completed":
      return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
    case "unsignaled-exit":
      return { ...outcome, summary: newSummary() };
    default:
      return outcome;
  }
}

const RESUME_DESCRIPTION =
  "Resume a previous sub-agent session in a new herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
  "Use when a sub-agent was cancelled or needs follow-up work.";

export async function executeSubagentResume(
  pi: ExtensionAPI,
  host: ResumeHost,
  params: ResumeParams,
  ctx: {
    cwd: string;
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
  },
) {
  params = { ...params, sessionPath: resolve(ctx.cwd, params.sessionPath) };
  if (!existsSync(params.sessionPath)) {
    return errorResult(
      `Error: session file not found: ${params.sessionPath}`,
      "session not found",
    );
  }

  // Reapply the persisted launch policy; a corrupt policy file must refuse
  // the resume rather than relaunch the child with degraded restrictions.
  const policyRead = readLaunchPolicy(params.sessionPath);
  if (policyRead.kind === "corrupt") {
    return errorResult(
      `Error: the persisted launch policy for this session is unreadable or invalid; ` +
        `refusing to resume without its restrictions. Repair or delete ` +
        `${launchPolicyPath(params.sessionPath)} to proceed.`,
      "corrupt launch policy",
    );
  }

  let plan;
  try {
    plan = buildResumeLaunchPlan(params, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentCwd: ctx.cwd,
      env: process.env,
      resumePolicy: policyRead.kind === "ok" ? policyRead.policy : null,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to plan resume launch: ${message}`, message);
  }

  // Record entry count before resuming so we can extract only new messages.
  const entryCountBefore = getNewEntriesSafe(params.sessionPath, 0).length;
  const durableStateDir = getDurableStateDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );

  const claim = await host.runtime().claimSessionForResume(
    pi,
    params.sessionPath,
    durableStateDir,
    plan,
  );
  if (!claim.ok) {
    return errorResult(`Error: ${claim.message}`, claim.code);
  }

  let running: RunningSubagent;
  try {
    // Stale-sidecar cleanup happens only after both in-process and
    // cross-process exclusivity have been established.
    rmSync(exitSidecarPath(params.sessionPath), { force: true });
    rmSync(contextUsagePath(params.sessionPath), { force: true });

    running = await host.runtime().launch(
      pi,
      plan,
      { name: plan.name, task: params.message ?? "resumed session" },
      durableStateDir,
      {
        lockPath: claim.lockPath,
        mapOutcome: (outcome) => resolveResumeOutcome(outcome, params.sessionPath, entryCountBefore),
      },
    );
  } catch (error: any) {
    const { message, code } = describeChildLaunchError(error);
    return errorResult(
      `Failed to launch Pi child for "${plan.name}": ${message}`,
      code,
    );
  } finally {
    claim.releaseReservation();
  }
  return {
    content: [{ type: "text" as const, text: `Session "${plan.name}" resumed.` }],
    details: {
      id: running.id,
      name: plan.name,
      paneId: running.paneId,
      sessionPath: params.sessionPath,
      liveAgentName: running.liveAgentName,
      status: "started",
    } satisfies ResumeToolDetails,
  };
}

export function registerResumeTool(pi: ExtensionAPI, host: ResumeHost): void {
  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description: RESUME_DESCRIPTION,
    promptSnippet: "Resume a child session; its result is delivered automatically.",
    parameters: ResumeParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentResume(pi, host, params, ctx as any);
    },

    renderCall(args, theme) {
      const name = (args as Partial<ResumeParams & { name: string }>).name ?? "Resume";
      return renderToolTitle(theme, name, "resuming session");
    },

    renderResult(result, _opts, theme) {
      const details = result.details as Partial<ResumeToolDetails>;
      return renderAckResult(result, theme, {
        acknowledged: details.status === "started",
        name: details.name ?? "Resume",
        suffix: "resumed",
      });
    },
  });
}

import type { AgentInfo } from "./herdr/client.ts";
import type { RunningSubagent } from "./watcher.ts";

export interface ActiveChildSnapshot {
  id: string;
  name: string;
  state: string;
  elapsedSeconds: number;
  sessionFile: string;
  paneId: string;
  terminalId?: string;
}

/** The identity fields that tie a launched child to a Herdr live agent. */
export interface ChildIdentity {
  liveAgentName: string;
  paneId: string;
  terminalId?: string;
}

/**
 * Canonical child-identity check, shared by live inspection, interruption, and
 * durable recovery: the same live-agent name, recognized as a Pi agent, in the
 * recorded pane — or in the same terminal after a pane move.
 */
export function hasMatchingActiveChildIdentity(
  identity: ChildIdentity,
  agent: AgentInfo,
): boolean {
  return (
    agent.name === identity.liveAgentName &&
    agent.kind === "pi" &&
    (agent.paneId === identity.paneId ||
      (!!identity.terminalId && agent.terminalId === identity.terminalId))
  );
}

export async function inspectActiveChildren(
  running: Iterable<RunningSubagent>,
  getAgent: (liveAgentName: string) => Promise<AgentInfo | null>,
  now = Date.now(),
): Promise<ActiveChildSnapshot[]> {
  const entries = [...running];
  const inspected = await Promise.all(
    entries.map(async (child) => {
      try {
        const agent = await getAgent(child.liveAgentName);
        if (!agent || !hasMatchingActiveChildIdentity(child, agent)) {
          return { child, stale: true as const };
        }
        return { child, agent, stale: false as const };
      } catch {
        return { child, agent: null, stale: false as const };
      }
    }),
  );

  const active: ActiveChildSnapshot[] = [];
  for (const result of inspected) {
    if (result.stale) continue;

    const snapshot: ActiveChildSnapshot = {
      id: result.child.id,
      name: result.child.name,
      state: result.agent?.status?.trim() || "unknown",
      elapsedSeconds: Math.max(0, Math.floor((now - result.child.startTime) / 1000)),
      sessionFile: result.child.sessionFile,
      paneId: result.agent?.paneId ?? result.child.paneId,
    };
    if (result.agent?.terminalId) snapshot.terminalId = result.agent.terminalId;
    active.push(snapshot);
  }

  return active;
}

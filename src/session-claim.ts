// Cross-process session claim: exactly one Pi process may own a child session
// file at a time. Every child launch — initial or resume — holds this lock for
// its lifecycle; it is released on a terminal outcome, or retained alongside
// the durable record when a launch failure leaves the child recoverable.
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface SessionLock {
  version: 1;
  id: string;
  liveAgentName: string;
  createdAt: string;
}

/** The on-disk suffix predates initial-launch locking; kept for compatibility. */
export function sessionLockPath(sessionFile: string): string {
  return `${sessionFile}.herdr-resume-lock`;
}

function readLock(path: string): SessionLock | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return value.version === 1 &&
      typeof value.id === "string" &&
      typeof value.liveAgentName === "string" &&
      typeof value.createdAt === "string"
      ? (value as unknown as SessionLock)
      : null;
  } catch {
    return null;
  }
}

/**
 * Atomically claim a session across Pi processes before any sidecar is removed.
 *
 * `isAgentActive` must FAIL CLOSED: a transport error while probing the
 * current holder's liveness must throw (refusing the claim), never report
 * "inactive" — otherwise a Herdr hiccup lets a claimant steal a live child's
 * session.
 */
export async function acquireSessionLock(
  sessionFile: string,
  lock: SessionLock,
  isAgentActive: (liveAgentName: string) => Promise<boolean>,
): Promise<string | null> {
  const path = sessionLockPath(sessionFile);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(lock)}\n`);
      } finally {
        closeSync(fd);
      }
      return path;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(path);
      // A missing/partial payload can be another process between open and
      // write. Treat it as owned; safety is more important than auto-reclaim.
      if (!existing) return null;
      const age = Date.now() - Date.parse(existing.createdAt);
      // A fresh lock covers the launch window before Herdr has registered the agent.
      if (age < 30_000 || (await isAgentActive(existing.liveAgentName))) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

export function releaseSessionLock(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

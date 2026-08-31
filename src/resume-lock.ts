import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface ResumeLock {
  version: 1;
  id: string;
  liveAgentName: string;
  createdAt: string;
}

export function resumeLockPath(sessionFile: string): string {
  return `${sessionFile}.herdr-resume-lock`;
}

function readLock(path: string): ResumeLock | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return value.version === 1 &&
      typeof value.id === "string" &&
      typeof value.liveAgentName === "string" &&
      typeof value.createdAt === "string"
      ? value as unknown as ResumeLock
      : null;
  } catch {
    return null;
  }
}

/** Atomically claim a session across Pi processes before any sidecar is removed. */
export async function acquireResumeLock(
  sessionFile: string,
  lock: ResumeLock,
  isAgentActive: (liveAgentName: string) => Promise<boolean>,
): Promise<string | null> {
  const path = resumeLockPath(sessionFile);
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
      if (age < 30_000 || await isAgentActive(existing.liveAgentName)) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

export function releaseResumeLock(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

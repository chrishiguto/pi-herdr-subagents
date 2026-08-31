// Durable per-child launch records: one JSON file per in-flight child so a
// reload/restart can reattach live children and honestly report gone ones.
//
// Delivery is at-least-once: a record is removed only after its outcome steer
// was handed to Pi. Session-scoped runtime generations ensure obsolete
// watchers retain records for the replacement generation to recover.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { hasMatchingActiveChildIdentity } from "./active-children.ts";
import { readExitSidecar } from "./child-protocol.ts";
import type { AgentInfo } from "./herdr/client.ts";

export const DURABLE_STATE_VERSION = 1 as const;

export interface DurableChildRecord {
  version: typeof DURABLE_STATE_VERSION;
  id: string;
  name: string;
  task: string;
  agent?: string;
  paneId: string;
  terminalId?: string;
  liveAgentName: string;
  sessionFile: string;
  lifecycleMode: "autonomous" | "interactive" | "manual";
  resumeLockPath?: string;
  createdAt: string;
}

export type RecoveryDecision =
  /** Sidecar present or agent identity still live: re-arm a watcher. */
  | { kind: "reattach"; record: DurableChildRecord }
  /** No signal and no live identity: report an unsignaled exit. */
  | { kind: "gone"; record: DurableChildRecord; closePane: boolean };

interface RecoveryClient {
  agentGet(target: string): Promise<AgentInfo | null>;
  paneGet(paneId: string): Promise<unknown | null>;
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`${label} must contain only letters, digits, _ or -.`);
}

function recordPath(dir: string, id: string): string {
  assertSafeId(id, "Durable child id");
  return join(dir, `${id}.json`);
}

function isRecord(value: unknown): value is DurableChildRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === DURABLE_STATE_VERSION &&
    typeof record.id === "string" &&
    SAFE_ID.test(record.id) &&
    typeof record.name === "string" &&
    typeof record.task === "string" &&
    (record.agent === undefined || typeof record.agent === "string") &&
    typeof record.paneId === "string" &&
    (record.terminalId === undefined || typeof record.terminalId === "string") &&
    typeof record.liveAgentName === "string" &&
    typeof record.sessionFile === "string" &&
    (record.lifecycleMode === "autonomous" ||
      record.lifecycleMode === "interactive" ||
      record.lifecycleMode === "manual") &&
    (record.resumeLockPath === undefined || typeof record.resumeLockPath === "string") &&
    typeof record.createdAt === "string"
  );
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx" });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function writeDurableRecord(dir: string, record: DurableChildRecord): void {
  if (!isRecord(record)) throw new Error("Invalid durable child record.");
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(recordPath(dir, record.id), record);
}

export function readDurableRecords(dir: string): DurableChildRecord[] {
  if (!existsSync(dir)) return [];
  const records: DurableChildRecord[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    try {
      const candidate: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (isRecord(candidate) && file === `${candidate.id}.json`) records.push(candidate);
    } catch {
      // A malformed or unsupported record never becomes a recovery candidate.
    }
  }
  return records;
}

export function removeDurableRecord(dir: string, childId: string): void {
  rmSync(recordPath(dir, childId), { force: true });
}

function hasSemanticSignal(record: DurableChildRecord): boolean {
  return readExitSidecar(record.sessionFile, record.id) !== null;
}

export function updateDurableChildLocation(
  dir: string,
  childId: string,
  paneId: string,
  terminalId?: string,
): void {
  const record = readDurableRecords(dir).find((candidate) => candidate.id === childId);
  if (!record) return;
  writeDurableRecord(dir, {
    ...record,
    paneId,
    ...(terminalId ? { terminalId } : {}),
  });
}

export async function recoverDurableChildren(
  dir: string,
  client: RecoveryClient,
): Promise<RecoveryDecision[]> {
  const decisions: RecoveryDecision[] = [];
  for (const record of readDurableRecords(dir)) {
    if (hasSemanticSignal(record)) {
      // The re-armed watcher settles immediately from the sidecar.
      decisions.push({ kind: "reattach", record });
      continue;
    }

    const agent = await client.agentGet(record.liveAgentName);
    if (agent && hasMatchingActiveChildIdentity(record, agent)) {
      decisions.push({ kind: "reattach", record });
      continue;
    }

    decisions.push({
      kind: "gone",
      record,
      closePane: (await client.paneGet(record.paneId)) !== null,
    });
  }
  return decisions;
}

/**
 * Remove a child's record and semantic sidecar after its outcome steer was
 * delivered. Delivery is at-least-once: a crash between delivery and this
 * cleanup redelivers the outcome on the next recovery pass.
 */
export function finalizeReportedChild(dir: string, childId: string, sessionFile: string): void {
  rmSync(`${sessionFile}.exit`, { force: true });
  removeDurableRecord(dir, childId);
}

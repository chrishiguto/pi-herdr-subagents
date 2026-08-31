// Session seeding (fork/lineage modes) and summary extraction.
//
// Session creation delegates header and branch semantics to Pi's SessionManager.
// Summary extraction remains crash-safe because Pi writes the child JSONL
// incrementally while it runs.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "standalone" | "lineage-only" | "fork";

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  /** Active orchestrator leaf. Undefined falls back to the last persisted entry. */
  parentLeafId?: string | null;
  childSessionFile: string;
  childCwd: string;
}): void {
  const childSessionDir = dirname(params.childSessionFile);
  mkdirSync(childSessionDir, { recursive: true });

  let manager: SessionManager;
  if (params.mode === "fork") {
    manager = SessionManager.open(
      params.parentSessionFile,
      childSessionDir,
      params.childCwd,
    );
    const leafId = params.parentLeafId === undefined
      ? manager.getLeafId()
      : params.parentLeafId;
    if (leafId !== null) {
      const branchedFile = manager.createBranchedSession(leafId);
      // SessionManager persists the branched session under its own generated
      // name once the branch contains an assistant message. Adopt that file at
      // the plan's deterministic path instead of writing an orphaned twin.
      if (branchedFile && existsSync(branchedFile)) {
        renameSync(branchedFile, params.childSessionFile);
        return;
      }
    } else {
      manager = SessionManager.create(params.childCwd, childSessionDir, {
        parentSession: params.parentSessionFile,
      });
    }
  } else {
    manager = SessionManager.create(params.childCwd, childSessionDir, {
      ...(params.mode === "lineage-only"
        ? { parentSession: params.parentSessionFile }
        : {}),
    });
  }

  const header = manager.getHeader();
  if (!header) throw new Error("Pi SessionManager did not create a session header.");
  const lines = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(params.childSessionFile, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/** getNewEntries, but an unreadable/absent session file yields no entries. */
export function getNewEntriesSafe(sessionFile: string, afterLine: number): SessionEntry[] {
  try {
    return getNewEntries(sessionFile, afterLine);
  } catch {
    return [];
  }
}

/**
 * Find the last assistant message text in a list of entries.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
  }
  return null;
}

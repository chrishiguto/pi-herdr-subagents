// Ported verbatim from pi-interactive-subagents test/test.ts ("session.ts"
// describe) — only import paths adapted. These tests lock in the version-3 session
// file format the child pi must accept (fork truncation at the last user message,
// session-header stripping, lineage header linkage) and the crash-safe summary
// extraction used by the completion watcher.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  getNewEntries,
  findLastAssistantMessage,
  seedSubagentSessionFile,
} from "../src/session.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "herdr-session-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("joins multiple non-empty text blocks with newline and skips empty ones", () => {
      const multiBlock = {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First block." },
            { type: "text", text: "   " },
            { type: "text", text: "Second block." },
          ],
        },
      };
      assert.equal(findLastAssistantMessage([multiBlock] as any[]), "First block.\nSecond block.");
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a standalone child with a current Pi header and no parent relationship", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const childFile = join(dir, "standalone-child.jsonl");

      seedSubagentSessionFile({
        mode: "standalone",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/standalone-cwd",
      });

      const entries = readFileSync(childFile, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(entries.length, 1);
      assert.deepEqual(
        { type: entries[0].type, version: entries[0].version, cwd: entries[0].cwd },
        { type: "session", version: 3, cwd: "/tmp/standalone-cwd" },
      );
      assert.equal("parentSession" in entries[0], false);
    });

    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("copies exactly the selected active parent branch for fork mode", () => {
      const alternateUser = {
        type: "message",
        id: "user-alt",
        parentId: "mc-001",
        message: { role: "user", content: [{ type: "text", text: "Alternate branch" }] },
      };
      const alternateAssistant = {
        type: "message",
        id: "asst-alt",
        parentId: "user-alt",
        message: { role: "assistant", content: [{ type: "text", text: "Alternate answer" }] },
      };
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
        alternateUser,
        alternateAssistant,
      ]);
      const childFile = join(dir, "fork-child.jsonl");
      const filesBefore = readdirSync(dir);

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        parentLeafId: "asst-alt",
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 4);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.deepEqual(entries.slice(1).map((entry) => entry.id), [
        "mc-001",
        "user-alt",
        "asst-alt",
      ]);
      assert.equal(entries.some((entry) => entry.id === "user-001"), false);
      assert.equal(entries.some((entry) => entry.id === "asst-001"), false);

      // The branched session must materialize only at the deterministic child
      // path — no orphaned twin from SessionManager's own file naming.
      const newFiles = readdirSync(dir).filter((name) => !filesBefore.includes(name));
      assert.deepEqual(newFiles, ["fork-child.jsonl"]);
    });

    it("seeds a version 3 header with a fresh id", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const childFile = join(dir, "header-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/header-cwd",
      });

      const header = JSON.parse(readFileSync(childFile, "utf8").trim().split("\n")[0]);
      assert.equal(header.version, 3);
      assert.ok(header.id, "header should have an id");
      assert.notEqual(header.id, SESSION_HEADER.id);
      assert.ok(header.timestamp);
      const currentPiSession = SessionManager.open(childFile, dir, "/tmp/header-cwd");
      assert.equal(currentPiSession.getHeader().version, 3);
      assert.equal(currentPiSession.getHeader().parentSession, parentFile);
    });

    it("keeps parent and child transcripts independent after launch in every mode", () => {
      for (const mode of ["standalone", "lineage-only", "fork"] as const) {
        const parentFile = join(dir, `${mode}-independent-parent.jsonl`);
        writeFileSync(
          parentFile,
          [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );
        const childFile = join(dir, `${mode}-independent-child.jsonl`);

        seedSubagentSessionFile({
          mode,
          parentSessionFile: parentFile,
          parentLeafId: "asst-001",
          childSessionFile: childFile,
          childCwd: `/tmp/${mode}-independent-cwd`,
        });

        const childSnapshot = readFileSync(childFile, "utf8");
        appendFileSync(
          parentFile,
          `${JSON.stringify({ type: "message", id: `parent-later-${mode}`, parentId: "asst-001", message: { role: "user", content: [{ type: "text", text: "Parent later" }] } })}\n`,
        );
        assert.equal(readFileSync(childFile, "utf8"), childSnapshot);

        appendFileSync(
          childFile,
          `${JSON.stringify({ type: "message", id: `child-later-${mode}`, parentId: mode === "fork" ? "asst-001" : null, message: { role: "user", content: [{ type: "text", text: "Delegated task" }] } })}\n`,
        );
        assert.equal(readFileSync(parentFile, "utf8").includes(`child-later-${mode}`), false);
      }
    });
  });

});

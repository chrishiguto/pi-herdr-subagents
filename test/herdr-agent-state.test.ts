import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createFakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const eventHandlers = new Map<string, Array<(data: any) => unknown>>();
  return {
    api: {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      events: {
        on(event: string, handler: (data: any) => unknown) {
          eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
          return () => {};
        },
      },
    } as any,
    async fire(event: string, eventData: any, ctx: any) {
      await Promise.all((handlers.get(event) ?? []).map((handler) => handler(eventData, ctx)));
    },
    emit(event: string, data: any) {
      for (const handler of eventHandlers.get(event) ?? []) handler(data);
    },
  };
}

describe("bundled herdr-agent-state port", () => {
  it("reports the Pi session and lifecycle states from the package runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-agent-state-"));
    const socketPath = join(root, "herdr.sock");
    const requests: any[] = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        requests.push(JSON.parse(buffer.slice(0, newline)));
        socket.end('{"ok":true}\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(() => server.close());
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p7";
    process.env.HERDR_SOCKET_PATH = socketPath;

    const { registerHerdrAgentState } = await import(
      `../src/herdr/agent-state.ts?test=${Date.now()}`
    );
    const fake = createFakePi();
    registerHerdrAgentState(fake.api);

    let idle = true;
    const ctx = {
      mode: "tui",
      isIdle: () => idle,
      sessionManager: {
        getSessionFile: () => "/tmp/pi-session.jsonl",
        getSessionId: () => "pi-session",
      },
    };

    await fake.fire("session_start", { reason: "startup" }, ctx);
    await waitFor(() => requests.some((request) => request.params?.state === "idle"));

    idle = false;
    await fake.fire("agent_start", {}, ctx);
    await waitFor(() => requests.some((request) => request.params?.state === "working"));

    fake.emit("herdr:blocked", { active: true, label: "Waiting for user" });
    await waitFor(() => requests.some((request) => request.params?.state === "blocked"));

    fake.emit("herdr:blocked", { active: false });
    idle = true;
    await fake.fire("agent_settled", {}, ctx);
    await waitFor(
      () => requests.filter((request) => request.params?.state === "idle").length >= 2,
    );

    const sessionReport = requests.find(
      (request) => request.method === "pane.report_agent_session",
    );
    assert.equal(sessionReport.params.pane_id, "w1:p7");
    assert.equal(sessionReport.params.source, "herdr:pi");
    assert.equal(sessionReport.params.agent_session_path, "/tmp/pi-session.jsonl");
    assert.equal(sessionReport.params.session_start_source, "startup");

    const blocked = requests.find((request) => request.params?.state === "blocked");
    assert.equal(blocked.params.message, "Waiting for user");
    assert.ok(
      requests
        .filter((request) => request.method === "pane.report_agent")
        .every((request) => request.params.agent === "pi"),
    );
  });
});

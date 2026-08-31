/**
 * HerdrEventStream — persistent ndJSON unix-socket client for herdr's
 * events.subscribe API. One global subscription to pane.exited, pane.closed,
 * pane.moved, and pane.agent_detected, dispatched locally to per-pane listeners.
 *
 * The ONLY raw-socket code in v1. Request/response ops go through the CLI
 * client (./client.ts); polling/reconcile logic belongs to callers — this
 * module only exposes the reconcile *hook* (fired after every subscription).
 * Herdr retains a bounded recent event ring, not a durable replay log, so a
 * snapshot/reconcile remains required after initial connect and reconnect.
 *
 * Verified protocol (Herdr >=0.8.2, protocol 20):
 *   → {"id":"sub1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"},{"type":"pane.moved"},{"type":"pane.agent_detected"}]}}\n
 *   ← {"id":"sub1","result":{"type":"subscription_started"}}
 *   ← {"data":{"pane_id":"w1:p4","released":true,"type":"pane_agent_detected"},"event":"pane_agent_detected"}
 * Note: pane.exited carries no process exit code, so disappearance is reported honestly.
 */
import net from "node:net";

export type HerdrPaneEvent =
  | {
      event: "pane_exited" | "pane_closed" | "pane_agent_released";
      paneId: string;
    }
  | {
      event: "pane_moved";
      /** Previous public pane id, used to route the move to existing watchers. */
      paneId: string;
      nextPaneId: string;
      terminalId?: string;
    };

export interface HerdrEventStream {
  /** Register a listener for a pane. Returns an unwatch function. */
  watch(paneId: string, listener: (ev: HerdrPaneEvent) => void): () => void;
  /**
   * Called after every successful subscribe (events may have been missed before
   * the initial subscription or while reconnecting). Returns an unsubscribe
   * function (watchers must unregister on completion).
   */
  onReconcile(cb: () => void): () => void;
  close(): void;
  /** True while subscribed (ack received, socket open). Diagnostic/test seam. */
  readonly connected: boolean;
}

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];

export function createHerdrEventStream(opts: {
  socketPath: string;
  signal: AbortSignal;
  backoffMs?: number[];
}): HerdrEventStream {
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const listeners = new Map<string, Set<(ev: HerdrPaneEvent) => void>>();
  const reconcileCallbacks: Array<() => void> = [];

  let socket: net.Socket | null = null;
  let closed = false;
  let connected = false;
  let attempt = 0;
  let requestCounter = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function handleLine(line: string, subscribeId: string): void {
    if (!line.trim()) return;
    let msg: {
      id?: string;
      result?: { type?: string };
      event?: string;
      data?: {
        pane_id?: string;
        previous_pane_id?: string;
        pane?: { pane_id?: string; terminal_id?: string };
        released?: boolean;
      };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // tolerate garbage lines
    }

    if (msg.id === subscribeId && msg.result?.type === "subscription_started") {
      connected = true;
      attempt = 0;
      for (const cb of [...reconcileCallbacks]) cb();
      return;
    }

    if (msg.event === "pane_moved") {
      const paneId = msg.data?.previous_pane_id;
      const nextPaneId = msg.data?.pane?.pane_id;
      if (!paneId || !nextPaneId) return;
      const paneListeners = listeners.get(paneId);
      if (!paneListeners) return;
      const ev: HerdrPaneEvent = {
        event: "pane_moved",
        paneId,
        nextPaneId,
        terminalId: msg.data?.pane?.terminal_id,
      };
      for (const listener of [...paneListeners]) listener(ev);
      return;
    }

    const event =
      msg.event === "pane_exited" || msg.event === "pane_closed"
        ? msg.event
        : msg.event === "pane_agent_detected" && msg.data?.released === true
          ? "pane_agent_released"
          : null;
    if (!event) return;

    const paneId = msg.data?.pane_id;
    if (!paneId) return;
    const paneListeners = listeners.get(paneId);
    if (!paneListeners) return;
    const ev: HerdrPaneEvent = { event, paneId };
    for (const listener of [...paneListeners]) listener(ev);
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function connect(): void {
    if (closed) return;
    const subscribeId = `sub${++requestCounter}`;
    let buffer = "";
    const sock = net.connect(opts.socketPath);
    socket = sock;

    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: subscribeId,
          method: "events.subscribe",
          params: {
            subscriptions: [
              { type: "pane.exited" },
              { type: "pane.closed" },
              { type: "pane.moved" },
              { type: "pane.agent_detected" },
            ],
          },
        })}\n`,
      );
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line, subscribeId);
      }
    });

    sock.on("error", () => {
      // "close" always follows "error"; reconnect is scheduled there.
    });

    sock.on("close", () => {
      connected = false;
      if (sock === socket) socket = null;
      scheduleReconnect();
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    connected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.destroy();
    socket = null;
  }

  if (opts.signal.aborted) {
    closed = true;
  } else {
    opts.signal.addEventListener("abort", close, { once: true });
    connect();
  }

  return {
    watch(paneId, listener) {
      let paneListeners = listeners.get(paneId);
      if (!paneListeners) {
        paneListeners = new Set();
        listeners.set(paneId, paneListeners);
      }
      paneListeners.add(listener);
      return () => {
        const set = listeners.get(paneId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) listeners.delete(paneId);
      };
    },
    onReconcile(cb) {
      reconcileCallbacks.push(cb);
      return () => {
        const idx = reconcileCallbacks.indexOf(cb);
        if (idx !== -1) reconcileCallbacks.splice(idx, 1);
      };
    },
    close,
    get connected() {
      return connected;
    },
  };
}

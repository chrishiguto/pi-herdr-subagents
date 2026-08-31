export const SUBAGENT_ACTIVITY_EVENT = "pi-herdr-subagents:activity";

/**
 * Best-effort transcript marker for a child lifecycle transition. Markers are
 * a debugging/history convenience; external durable state remains the
 * authority, so a failed append must never fail the lifecycle step itself.
 */
export function appendChildTranscriptMarker(
  pi: { appendEntry(customType: string, data?: unknown): void },
  state: "running" | "reported" | "retained",
  child: { id: string; name: string; sessionFile: string },
  extra?: Record<string, unknown>,
): void {
  try {
    pi.appendEntry("herdr-subagent", {
      version: 1,
      state,
      id: child.id,
      name: child.name,
      sessionFile: child.sessionFile,
      ...extra,
    });
  } catch {
    // Transcript history is useful but external durable state remains authoritative.
  }
}

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface SubagentActivityEvent {
  version: 1;
  id: string;
  owner: string;
  active: boolean;
}

function isActivityEvent(value: unknown): value is SubagentActivityEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.version === 1 &&
    typeof event.id === "string" &&
    typeof event.owner === "string" &&
    typeof event.active === "boolean";
}

export function publishSubagentActivity(
  events: Pick<EventBusLike, "emit">,
  id: string,
  owner: string,
  active: boolean,
): void {
  events.emit(SUBAGENT_ACTIVITY_EVENT, { version: 1, id, owner, active });
}

/** Track direct nested children through Pi's inter-extension event bus. */
export function createSubagentActivityTracker(events: Pick<EventBusLike, "on">) {
  const owners = new Map<string, string>();
  const unsubscribe = events.on(SUBAGENT_ACTIVITY_EVENT, (value) => {
    if (!isActivityEvent(value)) return;
    if (value.active) {
      owners.set(value.id, value.owner);
    } else if (owners.get(value.id) === value.owner) {
      owners.delete(value.id);
    }
  });
  return {
    count: () => owners.size,
    close() {
      unsubscribe();
      owners.clear();
    },
  };
}

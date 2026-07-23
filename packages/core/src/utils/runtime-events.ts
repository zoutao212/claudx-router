export type RuntimeEventLevel = "info" | "success" | "error";

export interface RuntimeEvent {
  id: number;
  timestamp: string;
  level: RuntimeEventLevel;
  requestId?: string;
  provider?: string;
  model?: string;
  message: string;
  detail?: string;
  durationMs?: number;
}

const maxEvents = 200;
let nextEventId = 1;
const events: RuntimeEvent[] = [];

export function recordRuntimeEvent(event: Omit<RuntimeEvent, "id" | "timestamp">): RuntimeEvent {
  const entry: RuntimeEvent = {
    id: nextEventId++,
    timestamp: new Date().toISOString(),
    ...event,
  };

  events.push(entry);
  if (events.length > maxEvents) {
    events.splice(0, events.length - maxEvents);
  }
  return entry;
}

export function getRuntimeEvents(limit = 100): RuntimeEvent[] {
  const count = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, maxEvents));
  return events.slice(-count).reverse();
}
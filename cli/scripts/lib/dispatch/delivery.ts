import { randomUUID } from "node:crypto";
import type { TaskCard } from "../shared/types.ts";

export const DELIVERY_STATES = ["queued", "sending", "submitted", "claimed", "uncertain"] as const;
export interface Delivery {
  id: string;
  state: typeof DELIVERY_STATES[number];
  role: string;
  phase: "dispatch" | "handoff";
  queued_at: string;
  sent_at?: string;
  pane_id?: string;
  session_id?: string;
  reason?: string;
}

export function deliveryFor(task: Pick<TaskCard, "meta">): Delivery | undefined {
  const value = task.meta["delivery"];
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task delivery record");
  const d = value as Delivery;
  if (typeof d.id !== "string" || !d.id || !DELIVERY_STATES.includes(d.state) ||
    typeof d.role !== "string" || !d.role || !["dispatch", "handoff"].includes(d.phase) ||
    typeof d.queued_at !== "string" || !Number.isFinite(Date.parse(d.queued_at)) ||
    [d.pane_id, d.session_id, d.reason].some((value) => value !== undefined && typeof value !== "string") ||
    d.sent_at !== undefined && (typeof d.sent_at !== "string" || !Number.isFinite(Date.parse(d.sent_at)))) {
    throw new Error("Invalid task delivery record");
  }
  return d;
}

export function newDelivery(role: string, phase: Delivery["phase"], now = new Date()): Delivery {
  return { id: randomUUID(), state: "queued", role, phase, queued_at: now.toISOString() };
}

export function waitingDelivery(task: TaskCard): boolean {
  return deliveryState(task) === "queued";
}

export function deliveryState(task: TaskCard): string | undefined {
  try { return deliveryFor(task)?.state; }
  catch { return "invalid"; }
}

export function completedDeliveries(task: TaskCard): string[] {
  const value = task.meta["completed_deliveries"];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

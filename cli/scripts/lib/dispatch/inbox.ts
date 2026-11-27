import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTaskInactive, TASK_BODY, type Project, type TaskCard } from "../shared/types.ts";
import { taskDescription, taskHandoffSummary } from "../tasks/records.ts";
import { deliveryFor, deliveryReasonLabel, type Delivery } from "./delivery.ts";

interface Receipt {
  id: string;
  role: string;
  sender?: string;
  subject: string;
  queued_at: string;
  phase?: Delivery["phase"];
  summary_ref?: string;
  summary_length?: number;
}

export function inboxReceipt(task: TaskCard, delivery: Delivery): Receipt {
  const { id, role, phase, sender, queued_at, summary_ref, summary_length } = delivery;
  const from = sender ?? (phase === "dispatch" ? "Project dispatch" : undefined);
  return { id, role, subject: task.title, queued_at, phase, ...(from ? { sender: from } : {}),
    ...(summary_ref && summary_length ? { summary_ref, summary_length } : {}) };
}

export function inboxReceipts(task: TaskCard): Receipt[] {
  const receipts = task.meta.inbox_receipts;
  return Array.isArray(receipts) ? receipts.filter((item): item is Receipt => item && typeof item === "object" &&
    [item.id, item.role, item.subject, item.queued_at].every(value => typeof value === "string")) : [];
}

const deliveryLabels = { queued: "Waiting to send", sending: "Sending", submitted: "Awaiting claim",
  claimed: "In progress", uncertain: "Needs reconciliation", failed: "Workspace request failed" };

export function inboxDeliveries(project: Project, includeRead: boolean, role?: string) {
  return project.tasks.flatMap(task => {
    const row = (receipt: Receipt, read: boolean) => ({
      id: task.id, delivery: receipt.id, role: receipt.role, source: "task",
      sender: receipt.sender ?? null, recipient: receipt.role, subject: receipt.subject, title: receipt.subject,
      received_at: receipt.queued_at, read, summary_ref: receipt.summary_ref, summary_length: receipt.summary_length,
      phase: receipt.phase,
    });
    const current = isTaskInactive(task) ? undefined : deliveryFor(task);
    return [
      ...(current && (!role || current.role === role) ? [{ ...row(inboxReceipt(task, current), false),
        state: current.state, label: deliveryLabels[current.state], reason: deliveryReasonLabel(current.reason ?? "") }] : []),
      ...(includeRead ? inboxReceipts(task).filter(item => !role || item.role === role).map(item => row(item, true)) : []),
    ];
  });
}

export function readInboxDelivery(project: Project, id: string) {
  const row = inboxDeliveries(project, true).find(item => item.delivery === id || item.id === id && !item.read);
  if (!row) return;
  const task = project.tasks.find(item => item.id === row.id)!;
  const { summary_ref, summary_length, phase, ...message } = row;
  const file = join(project.herdrDir, task.dir, TASK_BODY);
  const openCard = `Open task #${task.id} for details.`;
  // Older receipts recorded the sender before recording the delivery phase.
  const handoff = phase === "handoff" || (!phase && message.sender && message.sender !== "Project dispatch");
  if (!summary_ref && !summary_length && handoff) {
    return { ...message, body: `No handoff summary was provided. ${openCard}` };
  }
  let contents = "";
  try { contents = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (summary_ref || summary_length) {
    const summary = summary_ref && summary_length && taskHandoffSummary(contents, summary_ref, summary_length);
    return { ...message, body: summary || `Handoff summary unavailable. ${openCard}` };
  }
  return { ...message, body: taskDescription(contents) };
}

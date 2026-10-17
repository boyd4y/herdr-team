import { stamp } from "./records.ts";
export { appendRecord, stamp } from "./records.ts";
export { assignmentPrompt } from "./assignment.ts";
import { join } from "node:path";
import { cleanupIfDone, type CleanupResult } from "./cleanup.ts";
import type { Herdr } from "./herdr.ts";
import { randomUUID } from "node:crypto";
import { loadProject } from "./config.ts";
import { completedDeliveries, deliveryFor, newDelivery } from "./delivery.ts";
import { commitTaskTransition, flushTaskHistory, pumpQueue } from "./queue.ts";
import { withTeamLock } from "./runtime.ts";
import { refreshSidebar } from "./sidebar.ts";
import { findTask, TaskError } from "./task.ts";
import { TASK_BODY, isTerminal, isolatedAgentName, type Project, type TaskCard } from "./types.ts";

export interface HandoffResult {
  id: string;
  from: string;
  /** 交给谁；null 表示这是终态，没有下一步。 */
  to: string | null;
  status: string;
  previousStatus: string;
  /** 下游有没有真的收到 prompt。 */
  prompted: boolean;
  delivery?: string;
  queueState?: string;
  duplicate?: boolean;
  /** Whether this handoff saved a delivery summary in taskPath. */
  summarySaved: boolean;
  taskPath: string;
  /** 走到终态时才有的 worktree 回收结果。 */
  cleanup?: CleanupResult;
  /** 给人看的一句话说明。 */
  note: string;
}

/**
 * 任务负责人的逻辑名称（显示用途，不能直接作为跨项目发送目标）。
 *
 * 常驻角色 → 名字就是角色名；隔离角色 → `<role>-<id>`（每个任务一个 worktree、
 * 一个 agent）。所以同一个角色可以同时在多个任务上，互不打架。
 */
export function agentNameForTask(project: Project, card: TaskCard): string {
  const role = project.roles.find((r) => r.name === card.role);
  return role?.worktree === true ? isolatedAgentName(card.role, card.id) : card.role;
}

/**
 * 推进一个任务。
 *
 * `handoff` 是"还要交给谁"，不是"还剩几步"。队列空只说明**当前这个负责人是最后一个** ——
 * 所以队列空时不是拒绝，而是"它干完了，收尾"。
 */
export function handoff(
  project: Project, herdr: Herdr, id: string, now: Date = new Date(),
  options: { summary?: string; delivery?: string } = {},
): HandoffResult {
  if (!herdr.envOk()) throw new TaskError("Run handoff inside a Herdr pane (HERDR_ENV=1).");
  const result = withTeamLock(project, "queue", () => handoffLocked(loadProject(project.root), herdr, id, now, options));
  if (!result.duplicate) pumpQueue(project, herdr, now);
  if (result.delivery && !result.duplicate) {
    const current = findTask(loadProject(project.root), id), d = deliveryFor(current);
    if (d?.id === result.delivery) {
      result.queueState = d.state;
      result.prompted = ["submitted", "claimed"].includes(d.state);
      result.note += ` Delivery ${d.state}${d.reason ? `: ${d.reason}` : "."}`;
    }
  }
  return result;
}

function handoffLocked(
  project: Project, herdr: Herdr, id: string, now: Date,
  options: { summary?: string; delivery?: string },
): HandoffResult {
  flushTaskHistory(project, findTask(project, id));
  project = loadProject(project.root);
  const card = findTask(project, id);

  const currentDelivery = deliveryFor(card);
  const receipts = completedDeliveries(card);
  const taskPath = join(project.herdrDir, card.dir, TASK_BODY);
  if (options.delivery && receipts.includes(options.delivery)) {
    return { id, from: card.role, to: isTerminal(card.status) ? null : card.role, status: card.status,
      previousStatus: card.status, prompted: false, summarySaved: false, taskPath, duplicate: true,
      note: `Delivery ${options.delivery} was already handed off; no changes made.` };
  }
  if (currentDelivery && (options.delivery !== currentDelivery.id || currentDelivery.state !== "claimed")) {
    throw new TaskError("Claim the current delivery first, then hand off with its --delivery ID");
  }
  if (!currentDelivery && options.delivery) throw new TaskError("Stale delivery ID; no changes made");
  if (isTerminal(card.status)) {
    throw new TaskError(`${id} is already terminal (${card.status}); cannot hand off`);
  }

  if (!herdr.envOk()) throw new TaskError("Run handoff inside a Herdr pane (HERDR_ENV=1).");

  const summary = options.summary?.trim();
  if (summary !== undefined && !summary) throw new TaskError("Delivery summary cannot be empty; omit --summary to hand off without one");
  const summaryReceipt = { summarySaved: summary !== undefined, taskPath: join(project.herdrDir, card.dir, TASK_BODY) };
  const deliveryNote = summary === undefined ? " No delivery summary supplied." : " Delivery summary appended to task.md.";
  const operation = currentDelivery?.id ?? randomUUID();
  const completed = currentDelivery ? [...receipts, currentDelivery.id] : receipts;
  const persist = (patch: Record<string, unknown>, line: string, to: string) => {
    const text = summary === undefined ? line : `${line}\n\n### Delivery ${stamp(now)} · ${card.role} → ${to}\n\n${summary}\n`;
    commitTaskTransition(project, card, { ...patch, completed_deliveries: completed },
      `${text}\n<!-- team-operation:handoff-${operation} -->`);
  };

  const from = card.role;
  const previousStatus = card.status;

  if (card.handoff.length === 0) {
    // 最后一个负责人干完了 —— 没有下一步，整个任务收尾。
    const status = "done";
    persist({ status, delivery: null }, `- ${stamp(now)}  done  (${previousStatus} → ${status})`, "done");
    refreshSidebar(project, herdr);

    // 收尾就该把 worktree 收掉，否则每做一个任务就多留一个 checkout。
    const cleanup = cleanupIfDone(project, herdr, { ...card, status });
    const tail =
      cleanup.action === "removed"
        ? ` ${cleanup.note}`
        : cleanup.action === "absent"
          ? ""
          : ` ⚠ ${cleanup.note}`;

    return {
      id,
      from,
      to: null,
      status,
      previousStatus,
      prompted: false,
      cleanup,
      ...summaryReceipt,
      note: `${id} completed (${from} was the final owner).${tail}${deliveryNote}`,
    };
  }

  const next = card.handoff[0] as string;
  const rest = card.handoff.slice(1);
  const status = "review";
  const queued = newDelivery(next, "handoff", now);
  persist({ role: next, handoff: rest, status, delivery: queued },
    `- ${stamp(now)}  → ${next}  (${previousStatus} → ${status})`, next);
  refreshSidebar(project, herdr);
  return { id, from, to: next, status, previousStatus, prompted: false,
    ...summaryReceipt, delivery: queued.id, queueState: "queued",
    note: `${id} handed off to ${next}.${deliveryNote}` };
}

/** 派活说明：identity + 角色正文 + 任务目录 + 交棒要求。顺序固定。 */

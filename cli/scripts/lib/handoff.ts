import { acceptanceFor, assignedReviewFor, commitId, git, integrationFor, taskRepo, taskScoped, verifyCheckout } from "./execution.ts";
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
import { TASK_BODY, isTerminal, isolatedAgentName, worktreeBranch, type Project, type TaskCard } from "./types.ts";
import { assertPullRequest, prDecisionFor, pullRequestFor, publishTestedPullRequest, realGitHub, testResultFor, usesPullRequest, type GitHub } from "./pull-request.ts";
import { stepRole, taskWorkflow } from "./workflow.ts";
import { mergeTask } from "./integration.ts";

export interface HandoffOptions {
  summary?: string;
  delivery?: string;
  commit?: string;
  accept?: string;
  reject?: boolean;
  github?: GitHub;
}

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
  automaticMerge?: { state: "done" | "blocked"; reason?: string };
}

/**
 * 任务负责人的逻辑名称（显示用途，不能直接作为跨项目发送目标）。
 *
 * 常驻角色 → 名字就是角色名；隔离角色 → `<role>-<id>`（每个任务一个 worktree、
 * 一个 agent）。所以同一个角色可以同时在多个任务上，互不打架。
 */
export function agentNameForTask(project: Project, card: TaskCard): string {
  const role = project.roles.find((r) => r.name === card.role);
  return taskScoped(card, role) ? isolatedAgentName(card.role, card.id) : card.role;
}

/**
 * 推进一个任务。
 *
 * `handoff` 是"还要交给谁"，不是"还剩几步"。队列空只说明**当前这个负责人是最后一个** ——
 * 所以队列空时不是拒绝，而是"它干完了，收尾"。
 */
export function handoff(
  project: Project, herdr: Herdr, id: string, now: Date = new Date(),
  options: HandoffOptions = {},
): HandoffResult {
  if (!herdr.envOk()) throw new TaskError("Run handoff inside a Herdr pane (HERDR_ENV=1).");
  // Remote PR operations serialize this task, without holding every other task's queue lock.
  const result = withTeamLock(project, `handoff-${id}`, () => handoffLocked(loadProject(project.root), herdr, id, now, options));
  const acceptedTask = findTask(loadProject(project.root), id);
  if (!result.duplicate && result.queueState === "merge-queued" && usesPullRequest(acceptedTask) && taskWorkflow(acceptedTask)?.merge === "auto") {
    try {
      mergeTask(project, id, undefined, options.github);
      result.status = "done"; result.queueState = "merged"; result.automaticMerge = { state: "done" };
      result.note += " PR merged automatically at the approved commit.";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      withTeamLock(project, "queue", () => {
        const fresh = loadProject(project.root), task = findTask(fresh, id), item = integrationFor(task);
        if (item?.state === "queued") commitTaskTransition(fresh, task, { integration: { ...item, state: "blocked", reason } }, `- Automatic PR merge blocked: ${reason}`);
      });
      result.queueState = "merge-blocked"; result.automaticMerge = { state: "blocked", reason };
      result.note += ` Automatic merge blocked: ${reason}. Inspect before merge retry ${id}.`;
    }
  }
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
  options: HandoffOptions,
): HandoffResult {
  project = withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    flushTaskHistory(fresh, findTask(fresh, id));
    return loadProject(project.root);
  });
  const card = findTask(project, id);
  const originalMeta = JSON.stringify(card.meta);

  const currentDelivery = deliveryFor(card);
  const receipts = completedDeliveries(card);
  const taskPath = join(project.herdrDir, card.dir, TASK_BODY);
  if (options.delivery && receipts.includes(options.delivery)) {
    return { id, from: card.role, to: isTerminal(card.status) ? null : card.role, status: card.status,
      previousStatus: card.status, prompted: false, summarySaved: false, taskPath, duplicate: true,
      note: `Delivery ${options.delivery} was already handed off; no changes made.` };
  }
  if (integrationFor(card)) throw new TaskError("This task already awaits integration; use merge or explicitly reassign it for new review");
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
    withTeamLock(project, "queue", () => {
      const fresh = loadProject(project.root), current = findTask(fresh, id);
      if (JSON.stringify(current.meta) !== originalMeta) throw new TaskError("Task changed during handoff; inspect its delivery and PR before retrying");
      commitTaskTransition(fresh, current, { ...patch, completed_deliveries: completed },
        `${text}\n<!-- team-operation:handoff-${operation} -->`);
    });
  };

  const from = card.role;
  const previousStatus = card.status;
  if ([options.commit !== undefined, options.accept !== undefined, options.reject === true].filter(Boolean).length > 1) {
    throw new TaskError("Use only one of --commit, --accept, or --reject");
  }
  const review = assignedReviewFor(card), workflow = taskWorkflow(card);
  const prFlow = usesPullRequest(card), reviewingPR = prFlow && card.role === stepRole(card, "review");
  const currentStep = workflow?.steps.find((step) => step.role === card.role);
  if (review && review.reviewer !== card.role && currentStep && ["test", "review"].includes(currentStep.kind)) {
    throw new TaskError(`Task review assignment is inconsistent: owner ${card.role}, assigned reviewer ${review.reviewer}; ask lead to reconcile it`);
  }
  const github = options.github ?? realGitHub();
  const verifyPR = () => {
    const pr = pullRequestFor(card), tested = testResultFor(card);
    if (!pr || !tested || tested.role !== stepRole(card, "test") || !review || tested.commit !== review.commit || pr.commit !== review.commit) throw new TaskError("PR review requires a matching tested commit and pull request");
    if (git(taskRepo(project, card), "rev-parse", `refs/heads/${worktreeBranch(card)}`) !== pr.commit) throw new TaskError("Branch advanced after testing; retest and review its current commit");
    assertPullRequest(pr, github.get(pr), true);
    return pr;
  };
  let accepted = acceptanceFor(card);
  // A preceding test approval is not the current reviewer's approval.
  if (review?.reviewer === card.role && (accepted?.role !== card.role || accepted?.commit !== review.commit)) accepted = undefined;
  if (options.reject) {
    if (!review || card.role !== review.reviewer || !summary) throw new TaskError("Only the assigned reviewer can reject; include a defect summary");
    const queued = newDelivery(review.developer, "handoff", now);
    const decision = reviewingPR ? { commit: review.commit, role: card.role, state: "changes_requested",
      mode: github.decide(verifyPR(), "changes_requested", summary, operation) } : null;
    const developerIndex = workflow?.steps.findIndex((step) => step.role === review.developer) ?? -1;
    const reviewerIndex = workflow?.steps.findIndex((step) => step.role === card.role) ?? -1;
    const repeat = workflow && developerIndex >= 0 && reviewerIndex > developerIndex
      ? workflow.steps.slice(developerIndex + 1, reviewerIndex + 1).map((step) => step.role)
      : [review.reviewer];
    persist({ role: review.developer, handoff: [...repeat, ...card.handoff], status: "doing",
      delivery: queued, review: null, acceptance: null, integration: null, test_result: null, pr_decision: decision },
      `- Rejected ${review.commit}; returned to ${review.developer}`, review.developer);
    return { id, from, to: review.developer, status: "doing", previousStatus, prompted: false,
      ...summaryReceipt, delivery: queued.id, queueState: "queued", note: `${id} returned to ${review.developer} for fixes.${deliveryNote}` };
  }
  if (options.accept) {
    if (!review || card.role !== review.reviewer) throw new TaskError("Only the assigned reviewer can accept this commit");
    const commit = commitId(project, card, options.accept);
    if (commit !== review.commit) throw new TaskError("Acceptance must name the exact commit assigned for review");
    if (!summary) throw new TaskError("Acceptance requires a validation summary");
    {
      const trees = herdr.worktreeList(taskRepo(project, card)).filter((t) => t.branch === worktreeBranch(card));
      if (trees.length !== 1) throw new TaskError("Cannot identify the task review checkout");
      verifyCheckout(trees[0]!.path, commit);
    }
    if (prFlow && card.role === stepRole(card, "test")) {
      const next = stepRole(card, "review");
      if (!next || card.handoff[0] !== next) throw new TaskError("Testing must hand off to the selected PR reviewer");
      const pr = publishTestedPullRequest(project, card, commit, summary, github);
      const queued = newDelivery(next, "handoff", now);
      persist({ role: next, handoff: card.handoff.slice(1), status: "review", delivery: queued,
        test_result: { commit, role: card.role, summary }, pull_request: pr, acceptance: null, pr_decision: null, integration: null,
        review: { ...review, reviewer: next } }, `- Tests passed at ${commit}; PR ready: ${pr.url}`, next);
      return { id, from, to: next, status: "review", previousStatus, prompted: false, ...summaryReceipt,
        delivery: queued.id, queueState: "queued", note: `${id} tested at ${commit}; PR ${pr.url} queued for ${next}.${deliveryNote}` };
    }
    if (prFlow && !reviewingPR) throw new TaskError("Only the selected test and PR review stages can accept a version");
    if (reviewingPR) {
      const pr = verifyPR();
      const mode = github.decide(pr, "approved", summary, operation);
      accepted = { commit, role: card.role };
      // Keep the remote decision with the local merge gate; test success alone cannot enter it.
      card.meta.pr_decision = { commit, role: card.role, state: "approved", mode };
    } else accepted = { commit, role: card.role };
  } else if (review && card.role === review.reviewer && !accepted) {
    throw new TaskError("Review the assigned commit, then hand off with --accept SHA or --reject");
  }
  let reviewPatch: Record<string, unknown> = options.accept ? { review, acceptance: accepted,
    ...(currentStep?.kind === "test" ? { test_result: { commit: accepted!.commit, role: card.role, summary } } : {}),
    ...(reviewingPR ? { pr_decision: prDecisionFor(card) } : {}) } : {};
  if (options.commit) {
    const next = card.handoff[0];
    if (!next || next === card.role) throw new TaskError("A commit handoff requires a different next reviewer");
    const commit = commitId(project, card, options.commit);
    const repo = taskRepo(project, card);
    if (git(repo, "rev-parse", `refs/heads/${worktreeBranch(card)}`) !== commit) throw new TaskError("Submit the current task branch tip for review");
    reviewPatch = { execution: "task", review: { commit, developer: card.role, reviewer: next }, acceptance: null, integration: null, test_result: null, pr_decision: null };
  } else if (card.meta.execution === "task" && card.handoff[0] === (stepRole(card, "test") ?? "test") && !accepted) {
    throw new TaskError("Submit a committed version to test with --commit SHA");
  }

  if (card.handoff.length === 0 && accepted) {
    if (prFlow && !reviewingPR) throw new TaskError("PR review approval is required before merging");
    persist({ ...reviewPatch, status: "review", delivery: null, acceptance: accepted,
      integration: { state: "queued", commit: accepted.commit, queued_at: now.toISOString() } },
      `- Accepted ${accepted.commit}; queued for serial integration`, "merge queue");
    return { id, from, to: null, status: "review", previousStatus, prompted: false,
      ...summaryReceipt, queueState: "merge-queued", note: `${id} queued for merge at ${accepted.commit}.${deliveryNote}` };
  }

  if (card.handoff.length === 0) {
    if (prFlow) throw new TaskError("Complete testing and PR review before finishing this workflow");
    // 最后一个负责人干完了 —— 没有下一步，整个任务收尾。
    const status = "done";
    persist({ ...reviewPatch, status, delivery: null }, `- ${stamp(now)}  done  (${previousStatus} → ${status})`, "done");
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
  const nextStep = workflow?.steps.find((step) => step.role === next);
  if (!prFlow && review && accepted && (!workflow || nextStep && ["test", "review"].includes(nextStep.kind))) {
    reviewPatch = { ...reviewPatch, review: { ...review, reviewer: next }, acceptance: null };
  }
  persist({ ...reviewPatch, role: next, handoff: rest, status, delivery: queued },
    `- ${stamp(now)}  → ${next}  (${previousStatus} → ${status})`, next);
  refreshSidebar(project, herdr);
  return { id, from, to: next, status, previousStatus, prompted: false,
    ...summaryReceipt, delivery: queued.id, queueState: "queued",
    note: `${id} handed off to ${next}.${deliveryNote}` };
}

/** 派活说明：identity + 角色正文 + 任务目录 + 交棒要求。顺序固定。 */

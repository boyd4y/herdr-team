import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../team/project.ts";
import { assignmentPrompt } from "./assignment.ts";
import { AGENT_AWAITING_INPUT, deliveryFor, deliveryReasonLabel, deliveryState, newDelivery, type Delivery } from "./delivery.ts";
import { HerdrError, type Herdr } from "../runtime/herdr.ts";
import { taskScoped } from "../tasks/verification.ts";
import { appendRecord, stamp } from "../tasks/records.ts";
import { withTeamLock } from "../runtime/state.ts";
import { DeliveryRejected, sameReceiver, taskRuntime, type DeliveryTarget, type TaskRuntime } from "./runtime.ts";
import { findTask, TaskError, writeTaskMeta } from "../tasks/cards.ts";
import { TASK_BODY, TASK_META, isTaskInactive, type Project, type TaskCard } from "../shared/types.ts";
import { formatProblems, validateProject } from "../team/validate.ts";
import { dispatchFeature, featureKey, scopeFor } from "../team/features.ts";

export interface QueueOutcome { id: string; state: string; reason?: string }

/** A cached preflight can skip an empty queue; every actual pass reloads under the lock. */
export function needsQueuePass(project: Project): boolean {
  return project.tasks.some(task => typeof task.meta.pending_history === "string" && task.meta.pending_history.length > 0 ||
    !isTaskInactive(task) && ["queued", "sending", "submitted", "claimed", "invalid"].includes(deliveryState(task) ?? ""));
}

export function nextQueueDeadline(project: Project): number | undefined {
  let next = Infinity;
  for (const task of project.tasks) {
    if (isTaskInactive(task)) continue;
    try {
      const d = deliveryFor(task);
      if (d?.state === "submitted") next = Math.min(next, Date.parse(d.sent_at ?? d.queued_at) + 60_001);
    } catch { /* Validation reports malformed records; do not spin a deadline timer. */ }
  }
  return Number.isFinite(next) ? next : undefined;
}

/** The task metadata is the outbox. A pending history write can be replayed after a crash. */
export function flushTaskHistory(project: Project, task: TaskCard): void {
  const pending = task.meta["pending_history"];
  if (typeof pending !== "string" || !pending) return;
  const path = join(project.herdrDir, task.dir, TASK_BODY);
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  const marker = /<!-- team-operation:[^>]+ -->/.exec(pending)?.[0];
  if (!marker || !body.includes(marker)) appendRecord(project, { ...task, body }, pending);
  writeTaskMeta(project, task, { pending_history: null });
}

export function commitTaskTransition(project: Project, task: TaskCard, patch: Record<string, unknown>, record: string): void {
  const file = join(project.herdrDir, task.dir, TASK_META);
  const previous = readFileSync(file);
  writeTaskMeta(project, task, { ...patch, pending_history: record });
  try { flushTaskHistory(project, findTask(loadProject(project.root), task.id)); }
  catch (error) { writeFileSync(file, previous); throw error; }
}

export function enqueueTask(project: Project, id: string, now = new Date(), scope: DeliveryTarget = {}): QueueOutcome {
  return withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    const task = findTask(fresh, id);
    if (task.status !== "todo") throw new TaskError(`${id} is not todo; only todo tasks can be dispatched`);
    if (isTaskInactive(task)) throw new TaskError(`Restore task ${id} before dispatching it`);
    dispatchFeature(fresh, task, fresh.roles.find(role => role.name === task.role));
    const existing = deliveryFor(task);
    if (existing) return { id, state: existing.state, reason: existing.reason };
    const delivery = { ...newDelivery(task.role, "dispatch", now), ...scope };
    writeTaskMeta(fresh, task, { delivery });
    return { id, state: "queued" };
  });
}

function save(project: Project, task: TaskCard, delivery: Delivery, patch: Record<string, unknown> = {}): void {
  if (JSON.stringify(task.meta["delivery"]) !== JSON.stringify(delivery) || Object.keys(patch).length) writeTaskMeta(project, task, { ...patch, delivery });
}

/** Send only explicitly queued assignments. Existing todo cards are never enrolled automatically. */
export function pumpQueue(project: Project, backend: Herdr | TaskRuntime, now = new Date(), stopped = () => false): QueueOutcome[] {
  const runtime = taskRuntime(backend);
  if (!runtime.envOk()) throw new TaskError("Queue scheduling requires a verified Herdr caller");
  return withTeamLock(project, "queue", () => {
    if (stopped()) return [];
    let fresh = loadProject(project.root);
    const problems = validateProject(fresh);
    if (problems.length) throw new TaskError(formatProblems(problems));
    // Start fresh on every pass, then reread only when recovery changes records.
    if (fresh.tasks.some(task => typeof task.meta.pending_history === "string" && task.meta.pending_history.length > 0)) {
      for (const task of fresh.tasks) flushTaskHistory(fresh, task);
      fresh = loadProject(project.root);
    }
    for (const task of fresh.tasks) {
      const d = deliveryFor(task);
      if (d && !isTaskInactive(task)) runtime.assertDelivery(d);
    }
    let reconciled = false;
    for (const task of fresh.tasks) {
      const d = deliveryFor(task);
      if (!d || isTaskInactive(task)) continue;
      if (d.state === "sending" || d.state === "submitted" && now.getTime() - Date.parse(d.sent_at ?? d.queued_at) > 60_000) {
        save(fresh, task, { ...d, state: "uncertain", reason: "Delivery needs reconciliation; no automatic resend" });
        reconciled = true;
      }
      if (d.state === "claimed" && (d.pane_id || d.terminal)) {
        if (!runtime.alive(d)) {
          save(fresh, task, { ...d, state: "uncertain", reason: "Claimed agent disappeared or changed session; verify before retrying" });
          reconciled = true;
        }
      }
    }
    if (reconciled) fresh = loadProject(project.root);
    const pending = fresh.tasks.filter((task) => !isTaskInactive(task) && deliveryFor(task)?.state === "queued")
      .sort((a, b) => a.priority.localeCompare(b.priority) || deliveryFor(a)!.queued_at.localeCompare(deliveryFor(b)!.queued_at) || a.id.localeCompare(b.id));
    const outcomes: QueueOutcome[] = [];
    for (const original of pending) {
      if (stopped()) break;
      fresh = loadProject(project.root);
      let task = findTask(fresh, original.id);
      const d = deliveryFor(task)!;
      // Migrate only unsent work. Already-issued deliveries keep their original pane.
      if (task.meta.execution !== "task") {
        writeTaskMeta(fresh, task, { execution: "task" });
        fresh = loadProject(project.root);
        task = findTask(fresh, original.id);
      }
      const hold = (reason: string) => {
        save(fresh, task, { ...d, reason });
        outcomes.push({ id: task.id, state: "queued", reason });
      };
      if (d.role !== task.role) { hold("Assignment changed; cancel or requeue this delivery"); continue; }
      const waiting = task.dependsOn.filter((dep) => !fresh.tasks.some((t) => t.id === dep && t.status === "done"));
      if (waiting.length) { hold(`Waiting for ${waiting.join(", ")}`); continue; }
      const role = fresh.roles.find((r) => r.name === task.role);
      if (!role) { hold(`Role ${task.role} is unavailable`); continue; }
      const team = readFileSync(join(fresh.root, "TEAM.md"), "utf8");
      let receiver;
      try {
        const feature = dispatchFeature(fresh, task, role);
        const featureKeyForTask = feature && (task.meta.feature_dispatched !== true || task.meta.feature_workspace === true) && featureKey(feature);
        const occupied = featureKeyForTask && fresh.tasks.find(other => {
          if (other.id === task.id || isTaskInactive(other)) return false;
          const assignment = deliveryFor(other);
          if (other.status === "todo" && (!assignment || assignment.state === "queued")) return false;
          const scope = scopeFor(fresh, other);
          return scope && featureKey(scope) === featureKeyForTask;
        });
        if (occupied && d.phase === "dispatch" && task.status === "todo") {
          hold(`Feature ${featureKeyForTask} is processing #${occupied.id}`);
          continue;
        }
        if (feature && task.meta.feature_dispatched !== true) {
          // The first launch fixes the effective iteration, even when inherited
          // from an issue whose iteration can still change later.
          const legacy = fresh.tasks.some(other => other.id !== task.id && other.meta.feature_workspace !== true &&
            other.meta.feature === feature.feature && (other.meta.feature_dispatched === true || other.status !== "todo") &&
            scopeFor(fresh, other)?.iteration === feature.iteration);
          writeTaskMeta(fresh, task, { iteration: feature.iteration, feature_dispatched: true,
            ...(!legacy && d.phase === "dispatch" && task.status === "todo" ? { feature_workspace: true } : {}) });
          fresh = loadProject(project.root);
          task = findTask(fresh, task.id);
        }
        if (runtime.workspaceBusy?.(fresh, task)) { hold("Waiting for the previous feature session to settle"); continue; }
        receiver = runtime.receiver(fresh, role, task, d);
      }
      catch (error) { hold(`Agent startup failed: ${error instanceof Error ? error.message : String(error)}`); continue; }
      if (receiver) {
        const occupied = fresh.tasks.find((other) => other.id !== task.id && !isTaskInactive(other) &&
          sameReceiver(deliveryFor(other) ?? {}, receiver!.target) && deliveryFor(other)?.state !== "queued");
        if (occupied) {
          hold(deliveryFor(occupied)?.state === "uncertain" ? `Waiting to reconcile delivery #${occupied.id}` : `Session is processing #${occupied.id}`);
          continue;
        }
      }
      if (!receiver) { hold("Waiting for agent; run herdr-team up"); continue; }
      if (!receiver.canSubmit) {
        const status = receiver.status;
        const reason = status === "blocked" ? AGENT_AWAITING_INPUT : `Agent is ${status ?? "unknown"}`;
        hold(reason);
        continue;
      }
      const sending: Delivery = { ...d, ...runtime.scope, ...receiver.target, state: "sending", sent_at: now.toISOString(), reason: "" };
      save(fresh, task, sending);
      const args = `${task.id} --delivery ${d.id} --root ${teamCliPath(fresh.root)}`;
      const claim = `herdr-team task claim ${args}`;
      const handoff = `herdr-team task handoff ${args}`;
      const prompt = `${assignmentPrompt(team, role.body, task, fresh.root)}\nTeam root: ${fresh.root}\nTask file: ${join(fresh.herdrDir, task.dir, TASK_BODY)}\nDelivery ID: ${d.id}\nClaim command: ${claim}\nHandoff base command: ${handoff}\nThese commands identify this delivery; use the skill to choose the result options and next action.`;
      try {
        Object.assign(sending, receiver.submit(prompt));
      }
      catch (error) {
        const rejected = error instanceof DeliveryRejected || error instanceof HerdrError && ["agent_blocked", "agent_not_ready", "agent_not_found", "pane_not_found", "empty_agent_prompt"].includes(error.code ?? "");
        const state = rejected ? "queued" : "uncertain";
        const reason = error instanceof HerdrError
          ? `Herdr submission failed (${error.code ?? "unknown"}); inspect the receiving agent before retrying`
          : error instanceof Error ? error.message : String(error);
        save(fresh, task, { ...sending, state, reason });
        outcomes.push({ id: task.id, state, reason });
        continue;
      }
      const submitted: Delivery = { ...sending, state: "submitted" };
      const status = d.phase === "dispatch" ? "doing" : task.status;
      commitTaskTransition(fresh, task, { delivery: submitted, status },
        `- ${stamp(now)}  submitted ${d.id}  (${task.status} → ${status})\n<!-- team-operation:submit-${d.id} -->`);
      outcomes.push({ id: task.id, state: "submitted" });
      // Release promptly so the receiving agent can claim before other startups.
      break;
    }
    runtime.refresh(fresh);
    return outcomes;
  });
}

export function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** Team command templates target PowerShell on Windows and the project shell on Unix. */
export function teamCliPath(value: string, platform = process.platform): string {
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : shellQuote(value);
}

export function claimTask(project: Project, id: string, deliveryId: string, authorize?: (task: TaskCard, delivery: Delivery) => void): { id: string; delivery: string; duplicate: boolean } {
  return withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    const task = findTask(fresh, id);
    const d = deliveryFor(task);
    if (!d || d.id !== deliveryId || d.role !== task.role || isTaskInactive(task)) throw new TaskError("Stale or invalid delivery ID; do not start this task");
    authorize?.(task, d);
    if (d.state === "claimed") return { id, delivery: d.id, duplicate: true };
    if (!["submitted", "uncertain"].includes(d.state)) throw new TaskError(`Cannot claim a ${d.state} delivery`);
    save(fresh, task, { ...d, state: "claimed", reason: "" }, d.phase === "dispatch" ? { status: "doing" } : {});
    return { id, delivery: d.id, duplicate: false };
  });
}

export function retryDelivery(project: Project, id: string, runtime?: TaskRuntime): QueueOutcome {
  return withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root), task = findTask(fresh, id), d = deliveryFor(task);
    if (!d || d.state !== "uncertain" || isTaskInactive(task)) throw new TaskError("Only uncertain deliveries can be retried; first verify that the old assignment is not running");
    runtime?.assertDelivery(d);
    const replacement = { ...newDelivery(task.role, d.phase), ...runtime?.scope,
      ...(d.sender === undefined ? {} : { sender: d.sender }),
      ...(d.summary_ref && d.summary_length ? { summary_ref: d.summary_ref, summary_length: d.summary_length } : {}) };
    writeTaskMeta(fresh, task, { delivery: replacement });
    return { id, state: "queued" };
  });
}

export function queueRows(project: Project): Array<{ id: string; role: string; state: string; delivery: string; reason: string }> {
  return project.tasks.filter((t) => !isTaskInactive(t) && deliveryFor(t)).map((t) => {
    const d = deliveryFor(t)!;
    return { id: t.id, role: t.role, state: d.state, delivery: d.id, reason: deliveryReasonLabel(d.reason ?? "") };
  });
}

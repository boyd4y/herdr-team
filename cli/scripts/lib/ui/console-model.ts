import { basename } from "node:path";
import { sanitize } from "../shared/text.ts";
import { reviewFor, taskScoped } from "../tasks/verification.ts";
import { roleAgents, projectAgents } from "../dispatch/team-scope.ts";
import { deliveryState } from "../dispatch/delivery.ts";
import type { AgentInfo, Herdr } from "../runtime/herdr.ts";
import { findInconsistencies, roleStatusesFrom, integrationStatus, formatReport, formatTaskDetail, type Inconsistency, type RoleStatus } from "./status.ts";
import { isTerminal, type Project, type TaskCard } from "../shared/types.ts";
import { validateProject } from "../team/validate.ts";

export function fuzzyScore(text: string, query: string): number | null {
  const fold = (s: string): string[] => Array.from(s.replace(/[A-Z]/g, (ch) => ch.toLowerCase()));
  const needle = fold(query);
  if (needle.length === 0) return 0;
  const haystack = fold(text);
  let previous: number[] = [];
  for (let i = 0; i < needle.length; i++) {
    const current = Array<number>(haystack.length).fill(-Infinity);
    let bestGap = -Infinity;
    for (let j = 0; j < haystack.length; j++) {
      // Carry the best preceding match so each query code point scans the text once.
      if (j > 0) bestGap = Math.max(bestGap, (previous[j - 1] ?? -Infinity) + j);
      if (needle[i] !== haystack[j]) continue;
      current[j] = i === 0 ? 10 - j : 10 + Math.max(
        (previous[j - 1] ?? -Infinity) + 15, bestGap - j,
      );
    }
    previous = current;
  }
  const best = previous.reduce((a, b) => Math.max(a, b), -Infinity);
  return best === -Infinity ? null : best;
}

export function filterTasks(tasks: TaskCard[], query: string): TaskCard[] {
  if (query === "") return [...tasks].sort(byNewestId);
  return tasks.flatMap((task) => {
    const scores = [task.id, task.title, task.role]
      .map((field) => fuzzyScore(field, query))
      .filter((score): score is number => score !== null);
    return scores.length === 0 ? [] : [{ task, score: Math.max(...scores) }];
  }).sort((a, b) => b.score - a.score || byNewestId(a.task, b.task))
    .map(({ task }) => task);
}

/** Keep the selected task across refreshes; fall back to the closest visible index. */
export function resolveSelection(
  prev: { id: string | null; index: number },
  visible: TaskCard[],
): number {
  if (visible.length === 0) return -1;
  const byId = visible.findIndex((t) => t.id === prev.id);
  if (byId >= 0) return byId;
  return Math.min(Math.max(prev.index, 0), visible.length - 1);
}

export interface ConsoleState {
  showAll: boolean;
  query: string;
  selectedId: string | null;
  selectedIndex: number;
  loadError: string | null;
}

export interface ConsoleModel {
  projectName: string;
  /** Project-wide delivery counts, independent of search and --all. */
  pending: PendingCounts;
  taskAgents: Map<string, AgentInfo>;
  now: string;
  observedAt: number;
  showAll: boolean;
  query: string;
  candidateCount: number;
  tasks: TaskCard[];
  roles: RoleStatus[];
  inconsistencies: Inconsistency[];
  problems: string[];
  herdrOk: boolean;
  loadError: string | null;
  selectedIndex: number;
}

function byNewestId(a: TaskCard, b: TaskCard): number {
  return b.id.localeCompare(a.id);
}

export function buildModel(
  project: Project,
  herdr: Herdr,
  state: ConsoleState,
  now: string,
): ConsoleModel {
  let agents: AgentInfo[] = [];
  let herdrOk = true;
  try {
    agents = projectAgents(project, herdr);
  } catch {
    herdrOk = false;
  }

  return modelFromAgents(project, agents, state, now, herdrOk);
}

/** Shared data projection for the live reader and the in-memory sample. */
export function modelFromAgents(project: Project, agents: AgentInfo[], state: ConsoleState, now: string, herdrOk = true, observedAt = Date.now()): ConsoleModel {
  const taskAgents = new Map<string, AgentInfo>();
  for (const task of project.tasks) {
    const role = project.roles.find((r) => r.name === task.role);
    if (role === undefined) continue;
    const matches = roleAgents(project, agents, role, taskScoped(task, role) ? task.id : undefined);
    if (matches.length === 1) taskAgents.set(task.id, matches[0]!);
  }

  return {
    projectName: basename(project.root),
    pending: pendingCounts(project.tasks),
    taskAgents,
    now,
    observedAt,
    ...selectTasks(project, state),
    roles: roleStatusesFrom(project, agents).map((role) => ({
      ...role,
      current: role.current ?? project.tasks.filter((task) => task.role === role.role &&
        !isTerminal(task.status) && task.status !== "todo").map((task) => task.id),
    })),
    // An unavailable service must not manufacture missing-agent warnings.
    inconsistencies: herdrOk ? findInconsistencies(project, agents) : [],
    problems: validateProject(project).map((p) => `${p.file} [rule ${p.rule}] ${p.message}`),
    herdrOk,
    loadError: state.loadError,
  };
}

export type FlowState = "done" | "running" | "waiting" | "sending" | "blocked" | "idle" | "cancelled";
export interface FlowNode { kind: "role" | "integration"; role: string; label: string; state: FlowState; model: string }
export interface TaskFlow { nodes: FlowNode[]; current: number }

/** Only recorded participants and remaining assignments form a path, never a role preset. */
export function taskFlow(task: TaskCard, project: Project, model: ConsoleModel): TaskFlow {
  let past: string[] = [];
  try {
    const review = reviewFor(task);
    if (review) past = [review.developer, ...(review.reviewers ?? [review.reviewer])];
  } catch { /* Malformed records are surfaced by the health banner. */ }
  if (past.at(-1) !== task.role) past.push(task.role);
  let current = past.length - 1;
  const participants = [...past, ...(isTerminal(task.status) ? [] : task.handoff)];
  const integration = integrationStatus(task);
  if (integration) { participants.push("merge"); current = participants.length - 1; }
  const live = model.taskAgents.get(task.id);
  const delivery = deliveryState(task);
  const blocked = task.status === "blocked" || live?.agent_status === "blocked" ||
    ["uncertain", "invalid"].includes(delivery ?? "") || ["blocked", "invalid"].includes(integration?.state ?? "");
  let active: FlowState = "idle";
  if (isTerminal(task.status)) active = task.status === "done" ? "done" : "cancelled";
  else if (blocked) active = "blocked";
  else if (integration) active = integration.state === "running" || integration.state === "done" ? integration.state : "waiting";
  else if (delivery === "sending" || delivery === "submitted") active = "sending";
  else if (delivery === "queued") active = "waiting";
  else if (live?.agent_status === "working") active = "running";
  const labels: Record<FlowState, string> = { done: "Done", running: "Running", waiting: "Waiting", sending: "Delivering", blocked: "Needs input", idle: delivery === "claimed" ? "Claimed" : "Ready", cancelled: "Cancelled" };
  return { current, nodes: participants.map((name, i) => {
    const kind = integration && i === participants.length - 1 ? "integration" : "role";
    const role = kind === "role" && project.roles.find(role => role.name === name);
    const state = i < current || task.status === "done" ? "done" : i === current ? active : "waiting";
    return { kind, role: name, state, label: i > current ? "Next" : labels[state],
      model: kind === "integration" ? "serial integration" : role ? `${role.kind} · ${role.model ?? "default"}` : "unconfigured role" };
  }) };
}

export function selectTasks(project: Project, state: ConsoleState) {
  const candidates = project.tasks.filter((task) => state.showAll || !isTerminal(task.status));
  const tasks = filterTasks(candidates, state.query);
  return { showAll: state.showAll, query: state.query, candidateCount: candidates.length, tasks,
    selectedIndex: resolveSelection({ id: state.selectedId, index: state.selectedIndex }, tasks) };
}

interface PendingCounts {
  waiting: number;
  delivering: number;
  claimed: number;
  integration: number;
}

function pendingCounts(tasks: TaskCard[]): PendingCounts {
  const counts = { waiting: 0, delivering: 0, claimed: 0, integration: 0 };
  for (const task of tasks) {
    if (isTerminal(task.status)) continue;
    const integration = integrationStatus(task);
    if (integration && integration.state !== "done") {
      counts.integration++;
      continue;
    }
    switch (deliveryState(task)) {
      case "queued": counts.waiting++; break;
      case "sending":
      case "submitted": counts.delivering++; break;
      case "claimed": counts.claimed++; break;
    }
  }
  return counts;
}

const LINE_STATUS_ORDER = ["doing", "review", "todo"] as const;

const NEEDS_ATTENTION = new Set(["blocked", "agent-missing", "maybe-finished", "delivery-uncertain", "integration-blocked", "agent-ambiguous"]);

export function formatStatusLine(model: ConsoleModel, tasks: readonly TaskCard[] = model.tasks): string {
  const counts = LINE_STATUS_ORDER.map((status) => ({
    status,
    count: tasks.filter((t) => t.status === status).length,
  }))
    .filter((c) => c.count > 0)
    .map((c) => `${c.count} ${c.status}`);

  const attention = new Set<string>();
  for (const task of tasks) {
    if (task.status === "blocked") attention.add(task.id);
  }
  for (const item of model.inconsistencies) {
    if (item.id !== undefined && NEEDS_ATTENTION.has(item.kind)) attention.add(item.id);
  }

  const tail: string[] = [];
  if (model.pending.waiting > 0) tail.push(`${model.pending.waiting} queued`);
  if (attention.size > 0) tail.push(`${attention.size} blocked`);
  if (model.problems.length > 0) tail.push(`${model.problems.length} ✗`);
  if (!model.herdrOk) tail.push("herdr ✗");

  const body = [counts.join(" "), ...tail].filter((s) => s !== "").join(" · ");
  return body === "" ? "" : `team: ${body}`;
}

export function renderStatusLine(project: Project, herdr: Herdr): string {
  const state = initialState();
  return formatStatusLine(buildModel(project, herdr, state, ""));
}

export function initialState(showAll = false): ConsoleState {
  return { showAll, query: "", selectedId: null, selectedIndex: 0, loadError: null };
}

/** Plain, read-only output for pipelines and --once; no terminal ownership. */
export function renderOnce(project: Project, herdr: Herdr, opts: { showAll: boolean }): string {
  const model = buildModel(project, herdr, initialState(opts.showAll), "");
  return formatConsoleFrame(model);
}

export function formatConsoleFrame(model: ConsoleModel): string {
  const report = formatReport({ tasks: model.tasks, roles: model.roles, inconsistencies: model.inconsistencies });
  const problems = model.problems.length ? `\nVALIDATION\n${model.problems.join("\n")}\n` : "";
  const selected = model.tasks[model.selectedIndex];
  const detail = selected ? `\nDETAIL\n${formatTaskDetail(selected)}\n` : "";
  return sanitize(`Team Console · ${model.projectName}\n${formatStatusLine(model)}\n\n${report.replace(/^tasks$/m, "TASKS").replace(/^roles$/m, "ROLES")}\n${problems}${detail}`, true);
}

import { integrationFor, taskScoped } from "../tasks/verification.ts";
import { roleAgents, projectAgents } from "../dispatch/team-scope.ts";
import type { AgentInfo, Herdr } from "../runtime/herdr.ts";
import { padTo, truncate } from "../shared/text.ts";
import { deliveryState, waitingDelivery } from "../dispatch/delivery.ts";
import {
  isTerminal,
  isolatedAgentName,
  worktreeBranch,
  type Project,
  type RoleCard,
  type TaskCard,
} from "../shared/types.ts";

export interface RoleStatus {
  role: string;
  /** 常驻角色是角色名；隔离角色每任务一个，这里为 null。 */
  agent: string | null;
  herdrStatus: string;
  paneId: string | null;
  /** true = 这个角色按任务开 worktree，没有常驻 agent。 */
  worktree: boolean;
  current?: string[];
  queued?: number;
}

export interface Inconsistency {
  kind: string;
  /** 涉及的任务 id。**别去解析 message 拿这个** —— 那是给人看的散文，会改。 */
  id?: string;
  message: string;
}

export interface StatusReport {
  tasks: TaskCard[];
  roles: RoleStatus[];
  inconsistencies: Inconsistency[];
}

/** Read-only views expose malformed records; mutation paths retain strict validation. */
export function integrationStatus(task: TaskCard) {
  try { return integrationFor(task); }
  catch { return { state: "invalid" as const }; }
}

function loadAgents(project: Project, herdr: Herdr): AgentInfo[] {
  try {
    return projectAgents(project, herdr);
  } catch {
    // Herdr 没跑不算致命 —— 仍然报任务侧，只是角色侧空着。
    return [];
  }
}

/**
 * 已经拿到 agent 列表时的版本。
 *
 * 轮流问 Herdr 很贵（每次一个子进程），`buildReport` 和 Console 都先取一次
 * 列表再走这里，免得同一帧里问两遍。
 */
export function roleStatusesFrom(project: Project, agents: AgentInfo[]): RoleStatus[] {
  return project.roles.map((role) => {
    const owned = project.tasks.filter((t) => t.role === role.name && !isTerminal(t.status));
    const queue = owned.some((t) => deliveryState(t)) ? {
      current: owned.filter((t) => !integrationStatus(t) && !waitingDelivery(t) && (deliveryState(t) || t.status !== "todo")).map((t) => t.id),
      queued: owned.filter(waitingDelivery).length,
    } : {};
    if (role.name !== "lead" && (role.worktree || owned.some((t) => taskScoped(t)))) {
      // 隔离角色的 agent 跟着任务走，没有常驻的那个。
      return { role: role.name, agent: null, herdrStatus: "per-task", paneId: null, worktree: true, ...queue };
    }
    const matches = roleAgents(project, agents, role);
    const live = matches.length === 1 ? matches[0] : undefined;
    return {
      role: role.name,
      agent: live?.name ?? null,
      herdrStatus: matches.length > 1 ? "ambiguous" : live?.agent_status ?? "absent",
      paneId: live?.pane_id ?? null,
      worktree: false,
      ...queue,
    };
  });
}

/** 任务写的状态 和 Herdr 里真实状态 对不上的地方。 */
export function findInconsistencies(
  project: Project,
  agents: AgentInfo[],
): Inconsistency[] {
  const out: Inconsistency[] = [];

  for (const task of project.tasks) {
    if (isTerminal(task.status)) continue;
    const integration = integrationStatus(task);
    if (integration) {
      if (integration.state === "blocked") out.push({ kind: "integration-blocked", id: task.id, message: `${task.id}: integration blocked; inspect merge list before retrying` });
      continue;
    }
    const delivery = deliveryState(task);
    if (delivery === "queued") continue;
    if (delivery === "uncertain" || delivery === "invalid") {
      out.push({ kind: "delivery-uncertain", id: task.id, message: `${task.id}: delivery needs reconciliation; automatic resend paused` });
      continue;
    }
    if (delivery === "submitted") {
      out.push({ kind: "awaiting-claim", id: task.id, message: `${task.id}: submitted, waiting for the agent to claim it` });
      continue;
    }
    const role = project.roles.find((r) => r.name === task.role);
    if (role === undefined) continue;

    const agentName = taskScoped(task, role) ? isolatedAgentName(role.name, task.id) : task.role;
    const matches = roleAgents(project, agents, role, taskScoped(task, role) ? task.id : undefined);
    if (matches.length > 1) {
      out.push({ kind: "agent-ambiguous", id: task.id, message: `${task.id}: multiple agents match ${agentName}; resolve the assignment before dispatch` });
      continue;
    }
    const live = matches[0];
    const status = live?.agent_status ?? "absent";

    if (task.status === "doing") {
      if (live === undefined) {
        const where = role.worktree ? `(worktree agent ${agentName}) ` : "";
        out.push({
          kind: "agent-missing",
          id: task.id,
          message: `${task.id} is doing, but ${role.name} ${where}has no running agent`,
        });
      } else if (status === "blocked") {
        out.push({ kind: "blocked", id: task.id, message: `${task.id}: ${role.name} is waiting for input (blocked)` });
      } else if (status === "idle" || status === "done") {
        out.push({
          kind: "maybe-finished",
          id: task.id,
          message: `${task.id} is doing, but ${role.name} is idle; it may have finished without a handoff`,
        });
      }
    }

    if (task.status === "todo" && status === "working") {
      out.push({ kind: "unregistered", id: task.id, message: `${task.id} is todo, but ${role.name} is already running` });
    }
  }

  return out;
}

export function buildReport(project: Project, herdr: Herdr, includeTerminal: boolean): StatusReport {
  const tasks = project.tasks
    .filter((t) => includeTerminal || !isTerminal(t.status))
    .sort((a, b) => (a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority.localeCompare(b.priority)));
  // 只问 Herdr 一次 —— 下面两处都用这同一份列表。
  const agents = loadAgents(project, herdr);
  const roles = roleStatusesFrom(project, agents);
  return { tasks, roles, inconsistencies: findInconsistencies(project, agents) };
}

/** 超宽时截断，再补齐到指定显示宽度。宽度口径统一在 text.ts。 */
function pad(value: string, width: number): string {
  return padTo(truncate(value, width), width);
}

/** 纯任务列表 —— 只看卡片，不问 Herdr。 */
export function formatTasks(tasks: TaskCard[], roles: RoleCard[]): string {
  if (tasks.length === 0) return "(no active tasks; use --all to include terminal tasks)";

  const lines = [
    `  ${pad("id", 6)}${pad("title", 30)}${pad("priority", 10)}${pad("status", 10)}${pad("role", 16)}branch`,
  ];
  for (const t of tasks) {
    const role = roles.find((r) => r.name === t.role);
    const branch = taskScoped(t, role) ? worktreeBranch(t) : "—";
    lines.push(
      `  ${pad(t.id, 6)}${pad(t.title, 30)}${pad(t.priority, 10)}${pad(t.status, 10)}${pad(t.role, 16)}${branch}`,
    );
  }
  return lines.join("\n");
}

/** 单张任务详情不截断标题，正文按原文附在元数据之后。 */
export function formatTaskDetail(task: TaskCard): string {
  const integration = integrationStatus(task);
  return [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `priority: ${task.priority}`,
    `status: ${task.status}`,
    `role: ${task.role}`,
    `handoff: [${task.handoff.join(", ")}]`,
    `dependsOn: [${task.dependsOn.join(", ")}]`,
    `repo: ${task.repo}`,
    `dir: ${task.dir}`,
    ...(integration ? [`integration: ${integration.state}${"commit" in integration ? ` ${integration.commit}` : ""}`] : []),
    ...(deliveryState(task) ? [`delivery: ${deliveryState(task)}`] : []),
    "",
    task.body,
  ].join("\n");
}

export function formatReport(report: StatusReport): string {
  const lines: string[] = [];

  // 列头与 JSON 的字段名一致 —— 同一个概念在两种输出里叫同一个词。
  lines.push("tasks");
  if (report.tasks.length === 0) {
    lines.push("  (no active tasks)");
  } else {
    lines.push(`  ${pad("id", 6)}${pad("title", 28)}${pad("priority", 10)}${pad("status", 10)}${pad("role", 16)}delivery`);
    for (const t of report.tasks) {
      lines.push(`  ${pad(t.id, 6)}${pad(t.title, 28)}${pad(t.priority, 10)}${pad(t.status, 10)}${pad(t.role, 16)}${integrationStatus(t) ? `merge-${integrationStatus(t)!.state}` : deliveryState(t) ?? "—"}`);
    }
  }

  lines.push("");
  lines.push("roles");
  if (report.roles.length === 0) {
    lines.push("  (no roles)");
  } else {
    lines.push(`  ${pad("role", 16)}${pad("agent", 16)}${pad("herdrStatus", 14)}paneId`);
    for (const r of report.roles) {
      lines.push(
        `  ${pad(r.role, 16)}${pad(r.agent ?? "—", 16)}${pad(r.herdrStatus, 14)}${r.paneId ?? "—"}${r.current ? `  active ${r.current.join(",") || "—"}  queued ${r.queued ?? 0}` : ""}`,
      );
    }
  }

  lines.push("");
  lines.push("inconsistencies");
  if (report.inconsistencies.length === 0) {
    lines.push("  (none)");
  } else {
    for (const i of report.inconsistencies) lines.push(`  ⚠ [${i.kind}] ${i.message}`);
  }

  return lines.join("\n");
}

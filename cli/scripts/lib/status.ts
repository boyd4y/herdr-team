import { findRoleAgent, projectAgents } from "./team-scope.ts";
import type { AgentInfo, Herdr } from "./herdr.ts";
import { padTo, truncate } from "./text.ts";
import {
  isTerminal,
  isolatedAgentName,
  worktreeBranch,
  type Project,
  type RoleCard,
  type TaskCard,
} from "./types.ts";

export interface RoleStatus {
  role: string;
  /** 常驻角色是角色名；隔离角色每任务一个，这里为 null。 */
  agent: string | null;
  herdrStatus: string;
  paneId: string | null;
  /** true = 这个角色按任务开 worktree，没有常驻 agent。 */
  worktree: boolean;
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
 * 轮流问 Herdr 很贵（每次一个子进程），`buildReport` 和 `watch` 都先取一次
 * 列表再走这里，免得同一帧里问两遍。
 */
export function roleStatusesFrom(project: Project, agents: AgentInfo[]): RoleStatus[] {
  return project.roles.map((role) => {
    if (role.worktree) {
      // 隔离角色的 agent 跟着任务走，没有常驻的那个。
      return { role: role.name, agent: null, herdrStatus: "per-task", paneId: null, worktree: true };
    }
    const live = findRoleAgent(project, agents, role);
    return {
      role: role.name,
      agent: live?.name ?? null,
      herdrStatus: live?.agent_status ?? "absent",
      paneId: live?.pane_id ?? null,
      worktree: false,
    };
  });
}

export function roleStatuses(project: Project, herdr: Herdr): RoleStatus[] {
  return roleStatusesFrom(project, loadAgents(project, herdr));
}

/** 任务写的状态 和 Herdr 里真实状态 对不上的地方。 */
export function findInconsistencies(
  project: Project,
  agents: AgentInfo[],
): Inconsistency[] {
  const out: Inconsistency[] = [];

  for (const task of project.tasks) {
    if (isTerminal(task.status)) continue;
    const role = project.roles.find((r) => r.name === task.role);
    if (role === undefined) continue;

    const agentName = role.worktree ? isolatedAgentName(role.name, task.id) : task.role;
    const live = findRoleAgent(project, agents, role, role.worktree ? task.id : undefined);
    const status = live?.agent_status ?? "absent";

    if (task.status === "doing") {
      if (live === undefined) {
        const where = role.worktree ? `（worktree agent ${agentName}）` : "";
        out.push({
          kind: "agent-missing",
          id: task.id,
          message: `${task.id} 是 doing，但 ${role.name} ${where}没有存活 agent`,
        });
      } else if (status === "blocked") {
        out.push({ kind: "blocked", id: task.id, message: `${task.id} 的 ${role.name} 在等你（blocked）` });
      } else if (status === "idle" || status === "done") {
        out.push({
          kind: "maybe-finished",
          id: task.id,
          message: `${task.id} 是 doing，但 ${role.name} 空闲 —— 可能干完了没交棒`,
        });
      }
    }

    if (task.status === "todo" && status === "working") {
      out.push({ kind: "unregistered", id: task.id, message: `${task.id} 还是 todo，但 ${role.name} 已经在跑` });
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
  if (tasks.length === 0) return "（没有未结束的任务。加 --all 看全部）";

  const lines = [
    `  ${pad("id", 6)}${pad("title", 30)}${pad("priority", 10)}${pad("status", 10)}${pad("role", 16)}branch`,
  ];
  for (const t of tasks) {
    const role = roles.find((r) => r.name === t.role);
    const branch = role?.worktree === true ? worktreeBranch(t) : "—";
    lines.push(
      `  ${pad(t.id, 6)}${pad(t.title, 30)}${pad(t.priority, 10)}${pad(t.status, 10)}${pad(t.role, 16)}${branch}`,
    );
  }
  return lines.join("\n");
}

/** 单张任务详情不截断标题，正文按原文附在元数据之后。 */
export function formatTaskDetail(task: TaskCard): string {
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
    "",
    task.body,
  ].join("\n");
}

export function formatReport(report: StatusReport): string {
  const lines: string[] = [];

  // 列头与 JSON 的字段名一致 —— 同一个概念在两种输出里叫同一个词。
  lines.push("tasks");
  if (report.tasks.length === 0) {
    lines.push("  （没有未完成的任务）");
  } else {
    lines.push(`  ${pad("id", 6)}${pad("title", 28)}${pad("priority", 10)}${pad("status", 10)}role`);
    for (const t of report.tasks) {
      lines.push(`  ${pad(t.id, 6)}${pad(t.title, 28)}${pad(t.priority, 10)}${pad(t.status, 10)}${t.role}`);
    }
  }

  lines.push("");
  lines.push("roles");
  if (report.roles.length === 0) {
    lines.push("  （没有角色）");
  } else {
    lines.push(`  ${pad("role", 16)}${pad("agent", 16)}${pad("herdrStatus", 14)}paneId`);
    for (const r of report.roles) {
      lines.push(
        `  ${pad(r.role, 16)}${pad(r.agent ?? "—", 16)}${pad(r.herdrStatus, 14)}${r.paneId ?? "—"}`,
      );
    }
  }

  lines.push("");
  lines.push("inconsistencies");
  if (report.inconsistencies.length === 0) {
    lines.push("  （无）");
  } else {
    for (const i of report.inconsistencies) lines.push(`  ⚠ [${i.kind}] ${i.message}`);
  }

  return lines.join("\n");
}

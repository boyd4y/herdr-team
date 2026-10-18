import { basename } from "node:path";
import { sanitize } from "../shared/text.ts";
import { integrationFor, taskScoped } from "../tasks/verification.ts";
import { findRoleAgent, projectAgents } from "../dispatch/team-scope.ts";
import { deliveryState } from "../dispatch/delivery.ts";
import type { AgentInfo, Herdr } from "../runtime/herdr.ts";
import { findInconsistencies, roleStatusesFrom, formatReport, formatTaskDetail, type Inconsistency, type RoleStatus } from "./status.ts";
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
      // previous[k] - (j-k-1)，维护最大值使每个查询码点只扫一遍文本。
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

/** 字段各自匹配，不跨字段拼接；不搜索正文，也不改变输入数组。 */
export function filterTasks(tasks: TaskCard[], query: string): TaskCard[] {
  if (query === "") return [...tasks].sort(byPriorityThenId);
  return tasks.flatMap((task) => {
    const scores = [task.id, task.title, task.role]
      .map((field) => fuzzyScore(field, query))
      .filter((score): score is number => score !== null);
    return scores.length === 0 ? [] : [{ task, score: Math.max(...scores) }];
  }).sort((a, b) => b.score - a.score || byPriorityThenId(a.task, b.task))
    .map(({ task }) => task);
}

// ------------------------------------------------------------------ 选中

/**
 * 定下一个选中项。
 *
 * 按 **id** 找而不是按下标 —— 刷新后列表重排（改了优先级、切换了 `a`）光标
 * 也要黏在同一张卡上。id 不在了就回落到**下标**而不是回 0：操作者本来在看第 4 行，
 * 下一个最佳猜测是「还在第 4 行附近」，不是「跳回顶部」。
 */
export function resolveSelection(
  prev: { id: string | null; index: number },
  visible: TaskCard[],
): number {
  if (visible.length === 0) return -1;
  const byId = visible.findIndex((t) => t.id === prev.id);
  if (byId >= 0) return byId;
  return Math.min(Math.max(prev.index, 0), visible.length - 1);
}

// ------------------------------------------------------------------ 模型

export interface ConsoleState {
  showAll: boolean;
  query: string;
  searching: boolean;
  selectedId: string | null;
  selectedIndex: number;
  /** 读 `.herdr/` 失败时的报错 —— 保住上一帧的数据，但要让用户看见。 */
  loadError: string | null;
}

export interface ConsoleModel {
  projectName: string;
  /** Project-wide delivery counts, independent of search and --all. */
  pending: PendingCounts;
  taskAgents: Map<string, AgentInfo>;
  /** 已格式化好的时钟，由驱动传进来 —— 渲染里读时钟就没法测了。 */
  now: string;
  intervalSeconds: number;
  showAll: boolean;
  query: string;
  searching: boolean;
  /** 搜索之前、按 showAll 筛过的任务数。 */
  candidateCount: number;
  /** 已过滤并按匹配分数、priority、id 排序；空查询时只按 priority、id。 */
  tasks: TaskCard[];
  openCount: number;
  totalCount: number;
  roles: RoleStatus[];
  inconsistencies: Inconsistency[];
  /** 已格式化成 "file [rule N] message"。 */
  problems: string[];
  herdrOk: boolean;
  loadError: string | null;
  selectedIndex: number;
}

function byPriorityThenId(a: TaskCard, b: TaskCard): number {
  return a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority.localeCompare(b.priority);
}

/**
 * 一次带健康检查的加载。
 *
 * **`herdrOk` 这个闸门是必需的**：`findInconsistencies` 完全从 agent 列表推导，
 * 而 `agent list` 失败时会返回空列表 —— 照算的话会给**每张 doing 卡**伪造一条
 * 「没有存活 agent」。一次性 `status` 里这只是小噪音，2 秒轮询就是满屏假警报。
 */
export function buildModel(
  project: Project,
  herdr: Herdr,
  state: ConsoleState,
  now: string,
  intervalSeconds: number,
): ConsoleModel {
  let agents: AgentInfo[] = [];
  let herdrOk = true;
  try {
    agents = projectAgents(project, herdr);
  } catch {
    herdrOk = false;
  }

  const openCount = project.tasks.filter((t) => !isTerminal(t.status)).length;
  const candidates = project.tasks.filter((t) => state.showAll || !isTerminal(t.status));
  const tasks = filterTasks(candidates, state.query);

  const selectedIndex = resolveSelection({ id: state.selectedId, index: state.selectedIndex }, tasks);
  const taskAgents = new Map<string, AgentInfo>();
  for (const task of project.tasks) {
    const role = project.roles.find((r) => r.name === task.role);
    if (role === undefined) continue;
    const agent = findRoleAgent(project, agents, role, taskScoped(task, role) ? task.id : undefined);
    if (agent !== undefined) taskAgents.set(task.id, agent);
  }

  return {
    projectName: basename(project.root),
    pending: pendingCounts(project.tasks),
    taskAgents,
    now,
    intervalSeconds,
    showAll: state.showAll,
    query: state.query,
    searching: state.searching,
    candidateCount: candidates.length,
    tasks,
    openCount,
    totalCount: project.tasks.length,
    roles: roleStatusesFrom(project, agents).map((role) => ({
      ...role,
      current: role.current ?? project.tasks.filter((task) => task.role === role.role &&
        !isTerminal(task.status) && task.status !== "todo").map((task) => task.id),
    })),
    inconsistencies: herdrOk ? findInconsistencies(project, agents) : [],
    problems: validateProject(project).map((p) => `${p.file} [rule ${p.rule}] ${p.message}`),
    herdrOk,
    loadError: state.loadError,
    selectedIndex,
  };
}

interface PendingCounts {
  waiting: number;
  delivering: number;
  claimed: number;
  needsYou: number;
  integration: number;
}

function pendingCounts(tasks: TaskCard[]): PendingCounts {
  const counts = { waiting: 0, delivering: 0, claimed: 0, needsYou: 0, integration: 0 };
  for (const task of tasks) {
    const integration = integrationFor(task);
    if (integration && integration.state !== "done") {
      counts.integration++;
      if (integration.state === "blocked") counts.needsYou++;
      continue;
    }
    switch (deliveryState(task)) {
      case "queued": counts.waiting++; break;
      case "sending":
      case "submitted": counts.delivering++; break;
      case "claimed": counts.claimed++; break;
      case "uncertain":
      case "invalid": counts.needsYou++; break;
    }
  }
  return counts;
}

const LINE_STATUS_ORDER = ["doing", "review", "todo"] as const;

/**
 * 哪些不一致算「要你处理」。
 *
 * `unregistered`（todo 卡已经在跑）不算 —— 那是提醒不是问题，拿它占标签栏只会变噪音。
 */
const NEEDS_ATTENTION = new Set(["blocked", "agent-missing", "maybe-finished", "delivery-uncertain"]);

/**
 * 标签栏那一行，形状：`team: 1 doing 2 todo · 2 queued · 1 blocked · 1 ✗`
 *
 * - 前半段：未结束的卡按 doing / review / todo 计数，只列非零的
 * - `queued`：全项目 queued 投递数，非零时紧跟任务状态计数
 * - `blocked`：**卡住、等你处理的卡**。按卡去重 —— 卡片自己写着 blocked，
 *   或者 agent 在等你 / agent 掉了 / 干完没交棒，同一张卡只算一次
 * - `✗`：`.herdr/` 的校验问题数。**必须露出来** —— 坏卡会被静默跳过，
 *   不报的话你只会看到数字悄悄变小，而不知道为什么
 *
 * **全静默时返回空串**：和 `herdr-projects needs-you --line` 一个规矩，
 * 没事就不占标签栏。
 */
export function formatStatusLine(model: ConsoleModel): string {
  const counts = LINE_STATUS_ORDER.map((status) => ({
    status,
    count: model.tasks.filter((t) => t.status === status).length,
  }))
    .filter((c) => c.count > 0)
    .map((c) => `${c.count} ${c.status}`);

  const attention = new Set<string>();
  for (const task of model.tasks) {
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

/** 给标签栏用：读一遍、格式化一行。读不到 `.herdr/` 是调用方的事。 */
export function renderStatusLine(project: Project, herdr: Herdr): string {
  const state: ConsoleState = {
    showAll: false,
    query: "",
    searching: false,
    selectedId: null,
    selectedIndex: 0,
    loadError: null,
  };
  return formatStatusLine(buildModel(project, herdr, state, "", 0));
}

export function initialState(showAll = false): ConsoleState {
  return { showAll, query: "", searching: false, selectedId: null, selectedIndex: 0, loadError: null };
}

/** Plain, read-only output for pipelines and --once; no terminal ownership. */
export function renderOnce(project: Project, herdr: Herdr, opts: { showAll: boolean; intervalSeconds: number }): string {
  const model = buildModel(project, herdr, initialState(opts.showAll), "", opts.intervalSeconds);
  const report = formatReport({ tasks: model.tasks, roles: model.roles, inconsistencies: model.inconsistencies });
  const problems = model.problems.length ? `\nVALIDATION\n${model.problems.join("\n")}\n` : "";
  const selected = model.tasks[model.selectedIndex];
  const detail = selected ? `\nDETAIL\n${formatTaskDetail(selected)}\n` : "";
  return sanitize(`Team Console · ${model.projectName}\n${formatStatusLine(model)}\n\n${report.replace(/^tasks$/m, "TASKS").replace(/^roles$/m, "ROLES")}\n${problems}${detail}`, true);
}

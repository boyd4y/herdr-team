import { projectAgents } from "./team-scope.ts";
import { deliveryFor, deliveryState } from "./delivery.ts";
/**
 * Team Console renderer and terminal loop。
 *
 * 分三层：
 *   - 纯渲染 `renderFrame` / `computeLayout`（不碰 IO、不读时钟）
 *   - 纯解析 `parseKeys` / `flushCarry` / `resolveSelection`
 *   - 薄驱动 `runWatch`，终端交互全在 `Terminal` 接口后面
 *
 * 这么分的理由和 `herdr.ts` 抽 `Herdr` 接口一样：测试塞个假实现就能离线把
 * 整个循环跑完 —— 按键、刷新、resize 都能断言。
 *
 * **本模块不许有模块级副作用。** `realTerminal()` 只能在 `cmdConsole` 里构造，
 * 否则 `bun test` 一 import 就把 stdin 抢走。
 */

import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentInfo, Herdr } from "./herdr.ts";
import {
  findInconsistencies,
  roleStatusesFrom,
  type Inconsistency,
  type RoleStatus,
} from "./status.ts";
import { displayWidth, padTo, sanitize, truncate, wrapTo } from "./text.ts";
import { isTerminal, worktreeBranch, type Project, type TaskCard } from "./types.ts";
import { validateProject } from "./validate.ts";

// ------------------------------------------------------------------ 键

export type Key =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "page-up" }
  | { kind: "page-down" }
  | { kind: "refresh" }
  | { kind: "toggle-all" }
  | { kind: "quit" }
  | { kind: "escape" }
  | { kind: "enter" }
  | { kind: "backspace" }
  | { kind: "text"; text: string }
  | { kind: "resize" }
  | { kind: "ignore" };

/** 多字节转义序列。`\x1bO…` 是 DECCKM 应用光标模式，tmux 会发这种。 */
const SEQUENCES: readonly (readonly [string, Key])[] = [
  ["\x1b[A", { kind: "up" }],
  ["\x1bOA", { kind: "up" }],
  ["\x1b[B", { kind: "down" }],
  ["\x1bOB", { kind: "down" }],
  ["\x1b[5~", { kind: "page-up" }],
  ["\x1b[6~", { kind: "page-down" }],
];

const SINGLES: Record<string, Key> = {
  // raw mode 关了 ISIG，Ctrl-C 是一个字节，不是信号。
  "\x03": { kind: "quit" },
  "\r": { kind: "enter" },
  "\n": { kind: "enter" },
  "\x7f": { kind: "backspace" },
  "\x08": { kind: "backspace" },
};

/** 字母命令留到驱动解释，才能在同一口 `/query\rj` 里切换输入态。 */
const COMMANDS: Record<string, Key> = {
  q: { kind: "quit" }, k: { kind: "up" }, j: { kind: "down" },
  r: { kind: "refresh" }, a: { kind: "toggle-all" },
};

/**
 * 把一次 read 的内容解析成按键。
 *
 * 两个必须处理的现实情况：
 *   1. 一次 read 里可能挤进好几个键（按键重复、粘贴）。
 *   2. **一个序列可能被拆到两次 read**（先 `\x1b` 再 `[A`）。所以收尾处若是个
 *      还没配成序列的前缀，就把 `carry` 带回给下一次 —— 否则那半截会被当成裸
 *      Esc，**按一下方向键就把看板关了**。
 */
export function parseKeys(chunk: string, carry = ""): { keys: Key[]; carry: string } {
  const input = carry + chunk;
  const keys: Key[] = [];
  let i = 0;

  while (i < input.length) {
    const rest = input.slice(i);

    if (rest.startsWith("\x1b")) {
      const hit = SEQUENCES.find(([seq]) => rest.startsWith(seq));
      if (hit !== undefined) {
        keys.push(hit[1]);
        i += hit[0].length;
        continue;
      }
      // 还可能是某个序列的开头 —— 攒着，等下一次 read。
      if (SEQUENCES.some(([seq]) => seq.startsWith(rest))) {
        return { keys, carry: rest };
      }
      // 后面还有别的字符，说明这个 ESC 不是序列前缀。
      if (rest.length > 1) {
        keys.push({ kind: "escape" });
        i += 1;
        continue;
      }
      // 孤零零一个 ESC 收尾 —— 是 Esc 还是序列开头，只有等下一口才知道。
      return { keys, carry: rest };
    }

    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    keys.push(SINGLES[ch] ?? (
      /[\x00-\x1f\x7f-\x9f]/.test(ch) ? { kind: "ignore" } : { kind: "text", text: ch }
    ));
    i += ch.length;
  }

  return { keys, carry: "" };
}

/**
 * 超时后给没配成序列的 `carry` 收尾。
 *
 * 只有「等了一会儿没有下文」才能判定那个孤立的 ESC 是 Esc 键 —— 这个时间判断
 * 属于终端层（`realTerminal` 里那个定时器），不属于纯解析，所以单拎出来。
 */
export function flushCarry(carry: string): Key[] {
  return carry === "\x1b" ? [{ kind: "escape" }] : [];
}

// ------------------------------------------------------------------ 搜索

/** 子序列匹配，分数越高越好；偏好靠前且连续的匹配。只折叠 ASCII 大小写。 */
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

export interface WatchState {
  showAll: boolean;
  query: string;
  searching: boolean;
  selectedId: string | null;
  selectedIndex: number;
  detailScroll: number;
  /** 读 `.herdr/` 失败时的报错 —— 保住上一帧的数据，但要让用户看见。 */
  loadError: string | null;
}

export interface WatchModel {
  projectName: string;
  consoleMode?: boolean;
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
  detailScroll: number;
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
  state: WatchState,
  now: string,
  intervalSeconds: number,
): WatchModel {
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

  return {
    projectName: basename(project.root),
    now,
    intervalSeconds,
    showAll: state.showAll,
    query: state.query,
    searching: state.searching,
    candidateCount: candidates.length,
    tasks,
    openCount,
    totalCount: project.tasks.length,
    roles: roleStatusesFrom(project, agents),
    inconsistencies: herdrOk ? findInconsistencies(project, agents) : [],
    problems: validateProject(project).map((p) => `${p.file} [rule ${p.rule}] ${p.message}`),
    herdrOk,
    loadError: state.loadError,
    selectedIndex,
    detailScroll: state.detailScroll,
  };
}

// ------------------------------------------------------------------ 渲染

const MIN_WIDTH = 40;
/** 详情块固定占的行数：分隔线 + 3 行字段 + task.md 表头 + 空行。 */
const DETAIL_CHROME = 6;
/** 没有选中项时，整帧的固定开销：标题栏 + 两个空行 + 两个表头 + 空行 + 底栏。 */
const FIXED_NO_DETAIL = 7;
const MIN_TASKS = 3;
const MIN_ROLES = 1;
const TASKS_FIXED_COLS = 25;
const BODY_INDENT = 2;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

export interface FrameOpts {
  width: number;
  height: number;
  color: boolean;
}

export interface Layout {
  taskRows: number;
  roleRows: number;
  bodyRows: number;
  bannerRows: number;
  tooSmall: boolean;
  minHeight: number;
}

function style(text: string, code: string | undefined, color: boolean): string {
  return color && code !== undefined ? `${code}${text}${RESET}` : text;
}

/**
 * 一个**定宽**单元格：先按宽度定死（截断 + 补空格），**再**上色。
 *
 * 顺序反了宽度就错 —— ANSI 码会被算进显示列数，整张表跟着错位。所以整帧的
 * 不变量「每行显示宽度 ≤ 终端宽度」靠这里按构造保证，而不是事后去截断
 * （事后截断会把着色后的字符串切坏）。
 */
function cell(text: string, width: number, code?: string, color = false): string {
  if (width <= 0) return "";
  return style(padTo(truncate(text, width), width), code, color);
}

function statusStyle(status: string): string | undefined {
  switch (status) {
    case "doing":
      return CYAN;
    case "review":
      return MAGENTA;
    case "blocked":
      return YELLOW;
    case "done":
    case "cancelled":
      return DIM;
    default:
      return undefined; // todo 不加样式
  }
}

function priorityStyle(priority: string): string | undefined {
  if (priority === "P0") return RED;
  if (priority === "P1") return YELLOW;
  return undefined;
}

/** 正文折行 —— 渲染和驱动（算滚动上限）共用这一份，别各写一遍。 */
export function bodyLines(task: TaskCard, width: number): string[] {
  // 正文保留换行（keepNewlines），段与段之间的空行是有意义的结构。
  return wrapTo(sanitize(task.body, true), Math.max(1, width - BODY_INDENT));
}

/** 警告横幅：每种最多一行。返回的是「行数」，内容在 renderFrame 里拼。 */
function bannerEntries(model: WatchModel): { glyph: string; text: string; code?: string }[] {
  const out: { glyph: string; text: string; code?: string }[] = [];

  if (model.loadError !== null) {
    out.push({ glyph: "⚠", text: `Failed to load .herdr/: ${model.loadError}`, code: YELLOW });
  }
  if (!model.herdrOk) {
    out.push({
      glyph: "⚠",
      text: "Herdr is unavailable; role status missing. Run `herdr-team status` for details",
      code: YELLOW,
    });
  }
  const first = model.inconsistencies[0];
  if (first !== undefined) {
    const more = model.inconsistencies.length > 1 ? `(${model.inconsistencies.length} total)` : "";
    out.push({ glyph: "⚠", text: `[${first.kind}] ${first.message}${more}`, code: YELLOW });
  }
  const problem = model.problems[0];
  if (problem !== undefined) {
    const more = model.problems.length > 1 ? `(${model.problems.length} total; run validate)` : "";
    out.push({ glyph: "✗", text: `${problem}${more}`, code: RED });
  }

  return out;
}

export function computeLayout(model: WatchModel, opts: FrameOpts): Layout {
  const hasDetail = model.selectedIndex >= 0 && model.tasks[model.selectedIndex] !== undefined;
  // 横幅后面还要跟一个空行收尾，所以有条目时是 N+1。
  const entries = bannerEntries(model).length;
  const bannerRows = entries > 0 ? entries + 1 : 0;
  // 「（没有任务）」/「（没有角色）」各占一行，也**必须**进预算 ——
  // 漏掉它，空列表 + 多角色的组合就会比终端高一行的帧撞出去，画面失同步。
  const emptyRows = (model.tasks.length === 0 ? 1 : 0) + (model.roles.length === 0 ? 1 : 0);
  const fixed = (hasDetail ? FIXED_NO_DETAIL + DETAIL_CHROME : FIXED_NO_DETAIL) + emptyRows +
    (model.searching ? 1 : 0);
  const minHeight = fixed + bannerRows + MIN_TASKS + MIN_ROLES + (hasDetail ? 1 : 0);

  if (opts.width < MIN_WIDTH || opts.height < minHeight) {
    return { taskRows: 0, roleRows: 0, bodyRows: 0, bannerRows, tooSmall: true, minHeight };
  }

  let avail = opts.height - fixed - bannerRows;
  const taskCount = model.tasks.length;
  const roleCount = model.roles.length;

  // 先给正文留一块，剩下的按 6:4 分给任务和角色区，各自再按内容封顶。
  const bodyRows = hasDetail
    ? Math.max(1, Math.min(Math.floor(avail * 0.4), avail - (MIN_TASKS + MIN_ROLES)))
    : 0;
  avail -= bodyRows;

  const taskRows = Math.max(
    Math.min(MIN_TASKS, taskCount),
    Math.min(Math.floor(avail * 0.6), Math.max(0, avail - MIN_ROLES), taskCount),
  );
  avail -= taskRows;
  const roleRows = Math.max(0, Math.min(avail, roleCount));

  return { taskRows, roleRows, bodyRows, bannerRows, tooSmall: false, minHeight };
}

/** 窗口起点：让选中行始终留在可见区里。 */
function windowOffset(selected: number, count: number, rows: number): number {
  if (rows <= 0 || count <= rows) return 0;
  let offset = 0;
  if (selected >= rows) offset = selected - rows + 1;
  return Math.min(offset, Math.max(0, count - rows));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * 渲染一屏。
 *
 * **纯函数**：不读时钟、不碰 IO。`model.now` 是外面格式化好传进来的，
 * 否则每次布局测试都会随当前时间抖动。
 *
 * 不变量：返回的每一行显示宽度 **恰为** `width`（按构造保证，见 `cell`）。
 * 有一行软折行终端就会滚动，`\x1b[H` + 逐行重绘立刻失同步、画面渐进式烂掉。
 */
export function renderFrame(model: WatchModel, opts: FrameOpts): string[] {
  const { width, color } = opts;
  const layout = computeLayout(model, opts);

  if (layout.tooSmall) {
    return [
      cell(
        ` Terminal too small: need ≥ ${MIN_WIDTH}×${layout.minHeight}; current ${width}×${opts.height}`,
        width,
        YELLOW,
        color,
      ),
      cell(" q quit", width, DIM, color),
    ];
  }

  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
  };
  const blank = (): void => push(cell("", width));

  // --- 标题栏
  const badge = model.herdrOk ? "" : "   herdr ✗";
  const left = ` ${model.consoleMode ? "Team Console" : "herdr-team"} · ${model.projectName}${badge}`;
  const rate = model.intervalSeconds === 0 ? "manual" : `${model.intervalSeconds}s`;
  const right = `⟳${rate}  ${model.now} `;
  const rightW = Math.min(displayWidth(right), Math.max(0, width - 8));
  push(cell(left, width - rightW, BOLD, color) + cell(right, rightW, DIM, color));
  blank();

  // --- 任务
  const filtering = model.searching || model.query !== "";
  const matches = `  (${model.tasks.length}/${model.candidateCount})`;
  const counts = filtering
    ? ` /${truncate(sanitize(model.query), Math.max(0, width - 14 - displayWidth(matches)))}${matches}`
    : ` ${model.openCount} open / ${model.totalCount} total`;
  const countsW = Math.min(displayWidth(counts), Math.max(0, width - 12));
  const offset = windowOffset(model.selectedIndex, model.tasks.length, layout.taskRows);
  const hidden = model.tasks.length - layout.taskRows;
  const up = offset > 0 ? `↑${offset}` : "";
  const down = hidden > offset ? `↓${hidden - offset}` : "";
  const marks = [up, down].filter((m) => m !== "").join(" ");
  push(
    cell(` TASKS   ${marks}`, width - countsW, BOLD, color) +
      cell(counts, countsW, DIM, color),
  );

  if (model.searching) {
    push(cell(` / ${sanitize(model.query)}▏`, width, CYAN, color));
  }

  if (model.tasks.length === 0) {
    push(cell(filtering ? "  (no matching tasks; Esc clears the filter)" : "  (no tasks; press a to include terminal tasks)", width, DIM, color));
  }
  for (let i = offset; i < offset + layout.taskRows; i++) {
    const task = model.tasks[i];
    if (task === undefined) break;
    push(taskRow(task, model, i === model.selectedIndex, width, color));
  }
  blank();

  // --- 角色
  const roleHidden = model.roles.length - layout.roleRows;
  const roleMark = roleHidden > 0 ? `⋯ ${roleHidden} roles hidden` : "";
  push(
    cell(" ROLES", width - Math.min(displayWidth(roleMark), Math.max(0, width - 12)), BOLD, color) +
      cell(roleMark, Math.min(displayWidth(roleMark), Math.max(0, width - 12)), DIM, color),
  );
  if (model.roles.length === 0) {
    push(cell("  (no roles)", width, DIM, color));
  }
  for (const role of model.roles.slice(0, layout.roleRows)) {
    push(roleRow(role, width, color));
  }
  blank();

  // --- 警告横幅（每种一行，见 bannerEntries）
  const entries = bannerEntries(model);
  for (const entry of entries) {
    push(cell(` ${entry.glyph} ${entry.text}`, width, entry.code, color));
  }
  if (entries.length > 0) blank();

  // --- 详情
  const selected = model.tasks[model.selectedIndex];
  if (selected !== undefined) {
    const head = sanitize(` ── ${selected.id} · ${selected.title} `);
    push(cell(head + "─".repeat(Math.max(0, width - displayWidth(head))), width, BOLD, color));
    push(
      cell(
        ` priority ${selected.priority}   status ${selected.status}   role ${selected.role}   repo ${selected.repo}`,
        width,
      ),
    );
    const handoff = selected.handoff.length > 0 ? selected.handoff.join(" → ") : "—";
    const deps = selected.dependsOn.length > 0 ? selected.dependsOn.join(", ") : "—";
    push(cell(` handoff  ${handoff}        depends_on ${deps}`, width));
    const role = model.roles.find((r) => r.role === selected.role);
    const branch = role?.worktree === true ? worktreeBranch(selected) : "—";
    let delivery = deliveryState(selected) ?? "";
    try { const d = deliveryFor(selected); if (d?.reason) delivery += `: ${d.reason}`; } catch { /* Validation banner explains malformed records. */ }
    push(cell(` branch   ${branch}${delivery ? `   delivery ${delivery}` : ""}`, width, DIM, color));

    const mdHead = " ── task.md ";
    push(cell(mdHead + "─".repeat(Math.max(0, width - displayWidth(mdHead))), width, DIM, color));

    const body = bodyLines(selected, width);
    const maxScroll = Math.max(0, body.length - layout.bodyRows);
    const scroll = clamp(model.detailScroll, 0, maxScroll);
    for (const line of body.slice(scroll, scroll + layout.bodyRows)) {
      push(cell(`  ${line}`, width));
    }
    blank();
  }

  // --- 底栏
  const scrollable = model.selectedIndex >= 0 && model.tasks[model.selectedIndex] !== undefined;
  const hint = model.searching
    ? " Search   Backspace delete   Enter keep   Esc clear   Ctrl-C quit "
    : scrollable
      ? " ↑↓ select   PgUp/PgDn scroll   / search   r refresh   a all   q quit "
      : " ↑↓ select   / search   r refresh   a all   q quit ";
  push(cell(hint, width, DIM, color));

  return lines;
}

/** 一列任务的显示宽度核算：gutter2 + 标记2 + id4 + 空格 + 优先级2 + 空格 + 状态5 + 空格 + 角色6 + 空格。 */
function taskRow(task: TaskCard, model: WatchModel, selected: boolean, width: number, color: boolean): string {
  const gutter = selected ? "  › " : "    ";
  const head =
    gutter +
    `${cell(sanitize(task.id), 4)} ${cell(sanitize(task.priority), 2, priorityStyle(task.priority), color)} ` +
    `${cell(task.status, 5, statusStyle(task.status), color)} ${cell(sanitize(task.role), 6)} `;

  const rest = width - TASKS_FIXED_COLS;
  const role = model.roles.find((r) => r.role === task.role);
  const branch = role?.worktree === true ? worktreeBranch(task) : "—";
  const delivery = deliveryState(task);
  const title = `${delivery ? `[${delivery}] ` : ""}${sanitize(task.title)}`;

  if (rest < 24) {
    return head + cell(title, Math.max(0, width - TASKS_FIXED_COLS), undefined, color);
  }
  const branchW = Math.min(28, Math.floor(rest * 0.45));
  const titleW = rest - branchW - 1;
  return (
    head +
    cell(title, titleW, selected ? BOLD : undefined, color) +
    " " +
    cell(branch, branchW, DIM, color)
  );
}

const ROLE_FIXED_COLS = 29; // 缩进2 + 角色8 + agent10 + herdrStatus9

function roleRow(role: RoleStatus, width: number, color: boolean): string {
  const head =
    `  ${cell(sanitize(role.role), 8, BOLD, color)}` +
    `${cell(sanitize(role.agent ?? "—"), 10, DIM, color)}` +
    `${cell(role.herdrStatus, 9, role.worktree ? DIM : undefined, color)}`;

  // 隔离角色没有常驻 agent 也没有 pane，那两列天生是空的 —— 说清楚，
  // 免得被当成「agent 掉了」。
  const note = role.current !== undefined
    ? `active ${role.current.map((id) => `#${id}`).join(",") || "—"}  queued ${role.queued ?? 0}`
    : role.worktree ? "starts on dispatch" : "";
  const tail = [role.paneId ?? "", note].filter((s) => s !== "").join("   ");
  return head + cell(tail, Math.max(0, width - ROLE_FIXED_COLS), DIM, color);
}

/** 渲染成可直接打印的文本（`--once` / 非 TTY 用）。 */
export function frameText(frame: string[]): string {
  return `${frame.map((line) => line.replace(/[ ]+$/, "")).join("\n")}\n`;
}

// ------------------------------------------------------------------ 标签栏单行

/**
 * 单行里按状态计数的顺序 —— 固定，免得数字左右乱跳。
 *
 * **故意不含 `blocked`**：卡住的卡归后面那个 `blocked` 计数器管。两处都列的话
 * 就会打出 `team: 1 doing 1 blocked · 2 blocked` 这种同一个词两个意思的东西。
 */
const LINE_STATUS_ORDER = ["doing", "review", "todo"] as const;

/**
 * 哪些不一致算「要你处理」。
 *
 * `unregistered`（todo 卡已经在跑）不算 —— 那是提醒不是问题，拿它占标签栏只会变噪音。
 */
const NEEDS_ATTENTION = new Set(["blocked", "agent-missing", "maybe-finished", "delivery-uncertain"]);

/**
 * 标签栏那一行，形状：`team: 1 doing 2 todo · 1 blocked · 1 ✗`
 *
 * - 前半段：未结束的卡按 doing / review / todo 计数，只列非零的
 * - `blocked`：**卡住、等你处理的卡**。按卡去重 —— 卡片自己写着 blocked，
 *   或者 agent 在等你 / agent 掉了 / 干完没交棒，同一张卡只算一次
 * - `✗`：`.herdr/` 的校验问题数。**必须露出来** —— 坏卡会被静默跳过，
 *   不报的话你只会看到数字悄悄变小，而不知道为什么
 *
 * **全静默时返回空串**：和 `herdr-projects needs-you --line` 一个规矩，
 * 没事就不占标签栏。
 */
export function formatStatusLine(model: WatchModel): string {
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
  if (attention.size > 0) tail.push(`${attention.size} blocked`);
  if (model.problems.length > 0) tail.push(`${model.problems.length} ✗`);
  if (!model.herdrOk) tail.push("herdr ✗");

  const body = [counts.join(" "), ...tail].filter((s) => s !== "").join(" · ");
  return body === "" ? "" : `team: ${body}`;
}

/** 给标签栏用：读一遍、格式化一行。读不到 `.herdr/` 是调用方的事。 */
export function renderStatusLine(project: Project, herdr: Herdr): string {
  const state: WatchState = {
    showAll: false,
    query: "",
    searching: false,
    selectedId: null,
    selectedIndex: 0,
    detailScroll: 0,
    loadError: null,
  };
  return formatStatusLine(buildModel(project, herdr, state, "", 0));
}

export interface OnceOpts {
  width: number;
  height: number;
  color: boolean;
  showAll: boolean;
  intervalSeconds: number;
  consoleMode?: boolean;
}

/**
 * 只渲染一帧，不碰终端状态。
 *
 * 这是 `--once` 和非 TTY 的路径：不进备屏、不进 raw mode，所以永远不会把
 * 终端留在半路，也不需要真终端就能跑通整条渲染路径。**渲染里读时钟是故意的** ——
 * 它不是 `renderFrame`，是驱动这一侧的东西。
 */
export function renderOnce(project: Project, herdr: Herdr, opts: OnceOpts): string {
  const state: WatchState = {
    showAll: opts.showAll,
    query: "",
    searching: false,
    selectedId: null,
    selectedIndex: 0,
    detailScroll: 0,
    loadError: null,
  };
  const model = buildModel(project, herdr, state, clock(), opts.intervalSeconds);
  model.consoleMode = opts.consoleMode;
  return frameText(renderFrame(model, { width: opts.width, height: opts.height, color: opts.color }));
}

// ------------------------------------------------------------------ 终端

export interface Terminal {
  size(): { width: number; height: number };
  write(text: string): void;
  /** 进备屏 + 隐藏光标。 */
  enter(): void;
  /** 显示光标 + 退备屏。幂等。 */
  leave(): void;
  setRawMode(on: boolean): void;
  /** 等一个事件；`null` = 定时器到点。`ms <= 0` 表示只等按键。 */
  nextEvent(ms: number): Promise<Key | null>;
}

/** 孤立 ESC 等多久才判定它是 Esc 键。 */
const ESC_MS = 40;

/**
 * 定终端尺寸。
 *
 * **不能只用 `??`** —— pty 没有尺寸时 `columns` 会是 `0` 而不是 `undefined`（`script(1)`
 * 那种没有控制终端的场景就会这样），`0 ?? 80` 还是 `0`，整帧宽度直接归零、画出一屏空白。
 * 所以「拿不到」要按 `> 0` 判。
 *
 * 退路顺序：终端自己报的 → `COLUMNS`/`LINES`（这是给这类场景留的惯例变量）→ 80×24。
 */
export function resolveSize(
  columns: number | undefined,
  rows: number | undefined,
  env: Record<string, string | undefined>,
): { width: number; height: number } {
  const fromEnv = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const pick = (a: number | undefined, b: number | undefined, fallback: number): number =>
    a !== undefined && a > 0 ? a : (b ?? fallback);
  return {
    width: pick(columns, fromEnv("COLUMNS"), 80),
    height: pick(rows, fromEnv("LINES"), 24),
  };
}

export function realTerminal(): Terminal {
  const input = process.stdin;
  const output = process.stdout;
  // 一个中文码点的 UTF-8 字节也可能被拆到两口 data，不能逐口 toString。
  const decoder = new StringDecoder("utf8");

  let carry = "";
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: Key[] = [];
  let resolveNext: ((key: Key | null) => void) | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (key: Key | null): void => {
    const resolve = resolveNext;
    resolveNext = null;
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    resolve?.(key);
  };

  const deliver = (keys: Key[]): void => {
    for (const key of keys) {
      if (resolveNext !== null) settle(key);
      else queue.push(key);
    }
  };

  const onData = (chunk: Buffer): void => {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    const parsed = parseKeys(decoder.write(chunk), carry);
    carry = parsed.carry;
    deliver(parsed.keys);

    // 只有一个孤立的 ESC 才需要等 —— 它可能是还没收完的序列开头。
    if (carry === "\x1b") {
      escTimer = setTimeout(() => {
        escTimer = null;
        carry = "";
        deliver(flushCarry("\x1b"));
      }, ESC_MS);
    }
  };

  const onResize = (): void => deliver([{ kind: "resize" }]);

  return {
    size: () => resolveSize(output.columns, output.rows, process.env),

    write: (text) => {
      output.write(text);
    },

    enter: () => {
      input.on("data", onData);
      input.resume();
      process.on("SIGWINCH", onResize);
      output.write("\x1b[?1049h\x1b[?25l");
    },

    leave: () => {
      input.off("data", onData);
      process.off("SIGWINCH", onResize);
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      output.write("\x1b[?25h\x1b[?1049l");
    },

    setRawMode: (on) => {
      if (input.isTTY) input.setRawMode(on);
      if (!on) input.pause();
    },

    nextEvent: (ms) => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<Key | null>((resolve) => {
        resolveNext = resolve;
        // ms <= 0 = 只手动刷新：不挂定时器，一直等到有按键为止。
        if (ms > 0) waitTimer = setTimeout(() => settle(null), ms);
      });
    },
  };
}

// ------------------------------------------------------------------ 驱动

export interface WatchDeps {
  consoleMode?: boolean;
  io: Terminal;
  /** 首帧的数据。由调用方先读好 —— 读失败就在进备屏之前报错退出，不留半屏。 */
  initial: Project;
  /** 后续刷新的读取；抛错不会杀循环，只会在横幅里报出来。 */
  load: () => Project;
  herdr: Herdr;
  intervalMs: number;
  intervalSeconds: number;
  showAll: boolean;
  color: boolean;
  /** 只给测试用：跑完这么多帧就收工，防止驱动 bug 把测试挂死。 */
  maxFrames?: number;
  tick?: () => void;
  shouldQuit?: () => boolean;
}

/**
 * 画一帧。
 *
 * `\r\n` 而不是 `\n`：raw mode 下裸换行只下移不回到第 0 列，每行会往右漂。
 * `\x1b[K` 放在内容**前面**：这样上一帧更长的行留下的尾巴才擦得掉。
 * 搜索可能让帧变短，最后用 `\x1b[J` 擦掉上一帧剩余的详情和任务。
 */
function paint(io: Terminal, frame: string[]): void {
  io.write(`\x1b[H${frame.map((line) => `\x1b[K${line}`).join("\r\n")}\x1b[J`);
}

function clock(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const PAGE = 10;

/**
 * 跑看板。
 *
 * 清理只在一个地方：下面的 `finally`。所以 `cmdConsole` **绝不能**自己调
 * `process.exit()` —— 那样会赶在还原终端之前把进程杀掉，用户的终端就留在
 * raw mode 里了。这也是 `main` 得是 async 的原因。
 */
export async function runWatch(deps: WatchDeps): Promise<number> {
  const { io, herdr, intervalMs } = deps;
  const state: WatchState = {
    showAll: deps.showAll,
    query: "",
    searching: false,
    selectedId: null,
    selectedIndex: 0,
    detailScroll: 0,
    loadError: null,
  };

  const reload = (fallback: Project): Project => {
    try {
      const next = deps.load();
      state.loadError = null;
      return next;
    } catch (error) {
      state.loadError = error instanceof Error ? error.message : String(error);
      return fallback;
    }
  };

  let project = deps.initial;
  let quitting = false;
  const onSignal = (): void => {
    quitting = true;
  };

  const maxFrames = deps.maxFrames ?? Number.POSITIVE_INFINITY;

  io.setRawMode(true);
  io.enter();
  try {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    let nextTick = 0;
    for (let frame = 0; frame < maxFrames && !quitting && !deps.shouldQuit?.(); frame += 1) {
      if (deps.tick && Date.now() >= nextTick) {
        try { deps.tick(); project = reload(project); }
        catch (error) { state.loadError = error instanceof Error ? error.message : String(error); }
        nextTick = Date.now() + Math.max(1000, intervalMs);
      }
      const { width, height } = io.size(); // 每帧重读：SIGWINCH 没接上也能跟上缩放
      const model = buildModel(project, herdr, state, clock(), deps.intervalSeconds);
      if (deps.tick || deps.consoleMode) model.consoleMode = true;
      const opts = { width, height, color: deps.color };
      const layout = computeLayout(model, opts);

      paint(io, renderFrame(model, opts));

      // 把解析后的选中状态写回 —— 消失的 id 只查一次，不会一直留着。
      state.selectedIndex = model.selectedIndex;
      state.selectedId = model.tasks[model.selectedIndex]?.id ?? null;

      let ev = await io.nextEvent(intervalMs);
      if (ev === null) {
        project = reload(project);
        continue;
      }

      if (ev.kind === "escape") {
        if (state.searching || state.query !== "") {
          state.query = "";
          state.searching = false;
          state.detailScroll = 0;
        } else quitting = true;
        continue;
      }
      if (ev.kind === "enter") {
        state.searching = false;
        continue;
      }
      if (ev.kind === "backspace") {
        if (state.searching) {
          state.query = Array.from(state.query).slice(0, -1).join("");
          state.detailScroll = 0;
        }
        continue;
      }
      if (ev.kind === "text") {
        if (state.searching) {
          state.query += ev.text;
          state.detailScroll = 0;
          continue;
        }
        if (ev.text === "/") {
          state.searching = true;
          continue;
        }
        ev = COMMANDS[ev.text] ?? { kind: "ignore" };
      }

      switch (ev.kind) {
        case "quit":
          quitting = true;
          break;
        case "resize":
          // 缩小后新高度以下还留着旧帧，逐行 \x1b[K 只清写得着的行 —— 得整屏清。
          io.write("\x1b[2J");
          break;
        case "refresh":
          project = reload(project);
          break;
        case "toggle-all":
          state.showAll = !state.showAll;
          break;
        case "up":
        case "down": {
          const count = model.tasks.length;
          if (count > 0) {
            const next = clamp(model.selectedIndex + (ev.kind === "up" ? -1 : 1), 0, count - 1);
            if (next !== model.selectedIndex) state.detailScroll = 0;
            state.selectedIndex = next;
            state.selectedId = model.tasks[next]?.id ?? null;
          }
          break;
        }
        case "page-up":
        case "page-down": {
          const task = model.tasks[model.selectedIndex];
          if (task !== undefined) {
            const body = bodyLines(task, width);
            const max = Math.max(0, body.length - layout.bodyRows);
            state.detailScroll = clamp(
              state.detailScroll + (ev.kind === "page-down" ? PAGE : -PAGE),
              0,
              max,
            );
          }
          break;
        }
        default:
          break;
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    io.leave();
    io.setRawMode(false);
  }

  return 0;
}

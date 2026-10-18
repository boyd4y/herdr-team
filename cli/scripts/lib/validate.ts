import {
  ID_RE,
  KINDS,
  NAME_RE,
  PRIORITIES,
  SLUG_MAX,
  SLUG_RE,
  STATUSES,
  isTerminal,
  splitTaskDir,
  type Problem,
  type Project,
  type RoleCard,
  type TaskCard,
} from "./types.ts";

import { acceptanceFor, integrationFor, reviewFor } from "./execution.ts";
import { deliveryFor } from "./delivery.ts";
import { pullRequestFor, testResultFor, prDecisionFor } from "./pull-request.ts";
import { readWorkflow, taskWorkflow } from "./workflow.ts";

const TITLE_MAX = 80;

/** 相对项目根、且不逃逸。返回错误说明，合法时返回 null。 */
function cwdProblem(cwd: string): string | null {
  if (cwd.startsWith("/") || cwd.startsWith("~")) return "must be relative to the project root";
  let depth = 0;
  for (const part of cwd.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return "path escapes the project root (too many .. segments)";
    } else {
      depth += 1;
    }
  }
  return null;
}

/** 元数据里这个键写了、但读不出合法值 —— 记一条，并说清是缺了还是类型不对。 */
function checkString(
  card: { meta: Record<string, unknown> },
  key: string,
  value: string,
  rule: string,
  at: (rule: string, message: string) => void,
): void {
  if (card.meta[key] === undefined) {
    at("1", `Missing required field ${key}`);
    return;
  }
  if (value === "") {
    at(rule, `${key} must be a string`);
  }
}

function validateRole(r: RoleCard, seen: Set<string>, out: Problem[]): void {
  const at = (rule: string, message: string) => out.push({ file: r.dir, rule, message });

  // 角色名就是目录名 —— 路径即身份，元数据里不重复存。
  if (!NAME_RE.test(r.name)) at("3", `Role directory name "${r.name}" must match ${NAME_RE}`);
  if (seen.has(r.name)) at("3", `Duplicate role name "${r.name}"`);
  seen.add(r.name);

  checkString(r, "kind", r.kind, "2", at);
  if (r.kind !== "" && !(KINDS as readonly string[]).includes(r.kind)) {
    at("2", `Unsupported kind "${r.kind}"`);
  }

  if (r.cwd !== undefined) {
    const bad = cwdProblem(r.cwd);
    if (bad !== null) at("8", `cwd "${r.cwd}" ${bad}`);
  }

  if (r.meta["args"] !== undefined && r.args === undefined) at("1", "args must be a list of strings");
  if (r.meta["env"] !== undefined && r.env === undefined) at("1", "env must map strings to strings");
  if (r.meta["model"] !== undefined && r.model === undefined) at("1", "model must be a string");
  if (r.meta["worktree"] !== undefined && typeof r.meta["worktree"] !== "boolean") {
    at("1", "worktree must be true or false");
  }
}

function validateTask(t: TaskCard, roles: Set<string>, ids: Set<string>, out: Problem[]): void {
  const at = (rule: string, message: string) => out.push({ file: t.dir, rule, message });
  try {
    const delivery = deliveryFor(t);
    reviewFor(t); acceptanceFor(t); integrationFor(t);
    taskWorkflow(t); pullRequestFor(t); testResultFor(t); prDecisionFor(t);
    if (t.meta.execution !== undefined && t.meta.execution !== "task") at("1", "execution must be task when present");
    if (delivery && delivery.role !== t.role) at("1", "delivery role does not match task owner");
  } catch (error) { at("1", error instanceof Error ? error.message : String(error)); }

  // id 与 slug 来自目录名 —— 从路径解析，不存在"和元数据不一致"这回事。
  const dirName = t.dir.replace(/^tasks\//, "");
  const split = splitTaskDir(dirName);
  if (split === null) {
    at("4b", `Directory name must be <4-digit-id>-<slug>; received "${dirName}"`);
  } else {
    if (!ID_RE.test(split.id)) at("4", `id "${split.id}" must match ^[0-9]{4}$`);
    if (!SLUG_RE.test(split.slug)) at("4b", `slug "${split.slug}" must be lowercase kebab-case`);
    if (split.slug.length > SLUG_MAX) at("4b", `slug length ${split.slug.length} exceeds ${SLUG_MAX}`);
    if (ids.has(split.id)) at("4", `Duplicate task id "${split.id}"`);
    ids.add(split.id);
  }

  checkString(t, "title", t.title, "1", at);
  checkString(t, "priority", t.priority, "2", at);
  checkString(t, "status", t.status, "2", at);
  checkString(t, "role", t.role, "5", at);
  if (t.title.length > TITLE_MAX) at("1", `title length ${t.title.length} exceeds ${TITLE_MAX}`);

  if (t.priority !== "" && !(PRIORITIES as readonly string[]).includes(t.priority)) {
    at("2", `Unsupported priority "${t.priority}"`);
  }
  if (t.status !== "" && !(STATUSES as readonly string[]).includes(t.status)) {
    at("2", `Unsupported status "${t.status}"`);
  }

  // 终态任务不再被派活，它的 role / handoff 只是历史记录。
  // 角色后来改名或删掉了，不该让一条已经完成的记录永远报错。
  if (!isTerminal(t.status)) {
    if (t.role !== "" && !roles.has(t.role)) at("5", `role "${t.role}" does not resolve to a role`);
    for (const h of t.handoff) {
      if (!roles.has(h)) at("5", `handoff entry "${h}" does not resolve to a role`);
    }
  }

  if (t.meta["handoff"] !== undefined && !Array.isArray(t.meta["handoff"])) {
    at("1", "handoff must be a list of role names");
  }
  if (t.meta["depends_on"] !== undefined && !Array.isArray(t.meta["depends_on"])) {
    at("1", "depends_on must be a list of task IDs");
  }

  // repo 决定在哪儿开 worktree，逃逸出去就等于在项目外动别人的仓库。
  if (t.meta["repo"] !== undefined && t.repo === "") {
    at("1", "repo must be a string");
  } else if (t.repo !== ".") {
    const bad = cwdProblem(t.repo);
    if (bad !== null) at("8", `repo "${t.repo}" ${bad}`);
  }
}

type DependencyTask = Pick<TaskCard, "id" | "dir" | "dependsOn">;

/** depends_on 的环检测。返回处于环上的 id。 */
function findCycles(tasks: readonly DependencyTask[]): string[] {
  const graph = new Map<string, string[]>();
  for (const t of tasks) graph.set(t.id, t.dependsOn);

  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 在栈上 2 已完成
  const onCycle = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      const from = stack.indexOf(id);
      for (const node of stack.slice(from)) onCycle.add(node);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const next of graph.get(id) ?? []) {
      if (graph.has(next)) visit(next, stack);
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of graph.keys()) visit(id, []);
  return [...onCycle];
}

export function validateProject(project: Project): Problem[] {
  const out: Problem[] = [...project.problems];
  try { readWorkflow(project); }
  catch (error) { out.push({ file: "workflow.json", rule: "1", message: error instanceof Error ? error.message : String(error) }); }

  if (!project.hasIdentity) {
    out.push({ file: ".herdr", rule: "9", message: "identity.md is missing" });
  }

  const roleNames = new Set<string>();
  for (const r of project.roles) validateRole(r, roleNames, out);

  const ids = new Set<string>();
  for (const t of project.tasks) validateTask(t, roleNames, ids, out);

  out.push(...validateTaskDependencies(project.tasks));
  return out;
}

/** 全量校验与写盘前的候选图共用依赖引用、环检测。 */
export function validateTaskDependencies(tasks: readonly DependencyTask[]): Problem[] {
  const out: Problem[] = [];
  const byId = new Map(tasks.filter((t) => t.id !== "").map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) {
        out.push({ file: t.dir, rule: "6", message: `depends_on entry "${dep}" does not resolve to a task` });
      }
    }
  }

  for (const id of findCycles(tasks)) {
    const t = byId.get(id);
    if (t !== undefined) out.push({ file: t.dir, rule: "7", message: `depends_on cycle includes ${id}` });
  }

  return out;
}

export function formatProblems(problems: Problem[]): string {
  if (problems.length === 0) return "✓ .herdr/ validation passed";
  // 标签用英文，和 JSON 的字段名对齐；message 是散文，保持中文。
  const lines = problems.map((p) => `  ${p.file}  [rule ${p.rule}]  ${p.message}`);
  return [`✗ Found ${problems.length} problems:`, ...lines].join("\n");
}

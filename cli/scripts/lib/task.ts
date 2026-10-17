import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ID_RE,
  PRIORITIES,
  SLUG_MAX,
  SLUG_RE,
  TASK_BODY,
  TASK_META,
  isTerminal,
  type Project,
  type TaskCard,
} from "./types.ts";
import { emitYaml } from "./yaml.ts";
import { formatProblems, validateTaskDependencies } from "./validate.ts";
import { integrationFor } from "./execution.ts";
import { loadProject } from "./config.ts";
import { withTeamLock } from "./runtime.ts";

/** 元数据里键的顺序，写出去时保持稳定，diff 才好看。 */
export const TASK_FIELD_ORDER = ["title", "priority", "status", "role", "handoff", "depends_on"];

const ID_CEILING = 9999;

export class TaskError extends Error {}

/**
 * 下一个可用 id：现存任务和 .retired-ids **都要看**。
 * 只看现存的话，删掉当前最大的 id 之后下一个又会算出同一个号。
 */
export function nextId(project: Project): string {
  const used = [...project.tasks.map((t) => t.id), ...project.retiredIds]
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const max = used.length > 0 ? Math.max(...used) : 0;
  if (max >= ID_CEILING) {
    throw new TaskError(`Task IDs exhausted (${max} >= ${ID_CEILING}); manual intervention required`);
  }
  return String(max + 1).padStart(4, "0");
}

/** 把英文标题折成 kebab-case slug。含非 ASCII 时返回 null —— 那需要人来译。 */
export function deriveSlug(title: string): string | null {
  if (!/^[\x20-\x7E]+$/.test(title)) return null;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return null;
  if (slug.length <= SLUG_MAX) return slug;
  // 超长就断在词边界上，不要切出半个词
  const cut = slug.slice(0, SLUG_MAX + 1);
  const at = cut.lastIndexOf("-");
  return (at > 0 ? cut.slice(0, at) : slug.slice(0, SLUG_MAX)).replace(/-+$/, "");
}

export function roleNames(project: Project): string[] {
  return project.roles.map((r) => r.name);
}

function assertRole(project: Project, role: string, field: string): void {
  const names = roleNames(project);
  if (!names.includes(role)) {
    const available = names.length > 0 ? names.join(", ") : "(no roles in this project)";
    throw new TaskError(`${field} "${role}" does not resolve to a role. Available: ${available}`);
  }
}

export function findTask(project: Project, id: string): TaskCard {
  const card = project.tasks.find((t) => t.id === id);
  if (card === undefined) {
    const known = project.tasks.map((t) => t.id).join(", ") || "(no tasks)";
    throw new TaskError(`Task ${id} not found. Available: ${known}`);
  }
  return card;
}

/** 把候选卡放进内存中的依赖图，校验通过后才允许写盘。 */
function assertDependencies(project: Project, candidate: Pick<TaskCard, "id" | "dir" | "dependsOn">): void {
  const tasks = [...project.tasks.filter((t) => t.id !== candidate.id), candidate];
  const problems = validateTaskDependencies(tasks);
  if (problems.length > 0) throw new TaskError(formatProblems(problems));
}

function writeBody(dir: string, body: string): void {
  const path = join(dir, TASK_BODY);
  const text = body.replace(/^\n+/, "").replace(/\s*$/, "");
  writeFileSync(path, text === "" ? "" : `${text}\n`);
}

/** 只重写元数据文件 —— 散文一个字都不碰。 */
export function writeTaskMeta(project: Project, card: TaskCard, patch: Record<string, unknown>): void {
  const dir = join(project.herdrDir, card.dir);
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, TASK_META);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, emitYaml({ ...card.meta, ...patch }, TASK_FIELD_ORDER), { flag: "wx" });
    renameSync(temporary, destination);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export interface CreateOptions {
  title: string;
  role: string;
  handoff: string[];
  dependsOn?: string[];
  priority: string;
  body: string;
  slug?: string;
}

export interface CreatedTask {
  id: string;
  /** 相对 .herdr/ 的目录，如 `tasks/0001-fix-login`。 */
  dir: string;
  path: string;
}

export function createTask(project: Project, opts: CreateOptions): CreatedTask {
  const title = opts.title.trim();
  if (title === "") throw new TaskError("title cannot be empty");
  if (title.length > 80) throw new TaskError(`title length ${title.length} exceeds 80`);

  assertRole(project, opts.role, "role");
  for (const h of opts.handoff) assertRole(project, h, "handoff entry");

  if (!(PRIORITIES as readonly string[]).includes(opts.priority)) {
    throw new TaskError(`priority "${opts.priority}" must be one of ${PRIORITIES.join(" / ")}`);
  }

  const slug = opts.slug ?? deriveSlug(title);
  if (slug === null) {
    throw new TaskError(
      "Cannot derive an ASCII slug from this title. Supply --slug in lowercase kebab-case.",
    );
  }
  if (!SLUG_RE.test(slug)) throw new TaskError(`slug "${slug}" must match ${SLUG_RE}`);
  if (slug.length > SLUG_MAX) throw new TaskError(`slug length ${slug.length} exceeds ${SLUG_MAX}`);

  const id = nextId(project);
  const dirName = `${id}-${slug}`;
  const dir = join(project.herdrDir, "tasks", dirName);
  if (existsSync(dir)) throw new TaskError(`tasks/${dirName} already exists`);

  const dependsOn = opts.dependsOn ?? [];
  assertDependencies(project, { id, dir: `tasks/${dirName}`, dependsOn });

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, TASK_META),
    emitYaml(
      {
        title,
        priority: opts.priority,
        status: "todo",
        execution: "task",
        role: opts.role,
        handoff: opts.handoff,
        depends_on: dependsOn,
      },
      TASK_FIELD_ORDER,
    ),
  );
  writeBody(dir, opts.body);

  return { id, dir: `tasks/${dirName}`, path: dir };
}

export interface EditOptions {
  title?: string;
  role?: string;
  handoff?: string[];
  dependsOn?: string[];
  priority?: string;
  status?: string;
  body?: string;
}

/**
 * 改一个任务。
 *
 * 只有 `todo`（还没派出去）能随便改。已经在跑的改派会让人和 agent 对不上，
 * 所以必须显式 `--force`。
 */
export function editTask(
  project: Project,
  id: string,
  patch: EditOptions,
  force: boolean,
): { dir: string } {
  return withTeamLock(project, "queue", () => editTaskLocked(loadProject(project.root), id, patch, force));
}

function editTaskLocked(project: Project, id: string, patch: EditOptions, force: boolean): { dir: string } {
  const card = findTask(project, id);

  if (integrationFor(card)?.state === "running") throw new TaskError("Integration is running; wait for it to finish before editing this task");
  if (isTerminal(card.status)) {
    throw new TaskError(`${id} is terminal (${card.status}); create a new task instead of editing it`);
  }
  if (card.status !== "todo" && !force) {
    throw new TaskError(
      `${id} is ${card.status}, not todo; it may already be dispatched. Use --force to edit it.`,
    );
  }

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title === "") throw new TaskError("title cannot be empty");
    if (title.length > 80) throw new TaskError(`title length ${title.length} exceeds 80`);
  }
  if (patch.role !== undefined) assertRole(project, patch.role, "role");
  for (const h of patch.handoff ?? []) assertRole(project, h, "handoff entry");
  if (patch.priority !== undefined && !(PRIORITIES as readonly string[]).includes(patch.priority)) {
    throw new TaskError(`priority "${patch.priority}" must be one of ${PRIORITIES.join(" / ")}`);
  }
  if (patch.dependsOn !== undefined) {
    assertDependencies(project, { ...card, dependsOn: patch.dependsOn });
  }

  const meta: Record<string, unknown> = {};
  if (patch.title !== undefined) meta["title"] = patch.title.trim();
  if (patch.role !== undefined) meta["role"] = patch.role;
  if (patch.handoff !== undefined) meta["handoff"] = patch.handoff;
  if (patch.dependsOn !== undefined) meta["depends_on"] = patch.dependsOn;
  if (patch.priority !== undefined) meta["priority"] = patch.priority;
  if (patch.status !== undefined) meta["status"] = patch.status;
  if (patch.role !== undefined && patch.role !== card.role || patch.status === "todo" || patch.status === "cancelled") {
    meta["delivery"] = null;
    meta["review"] = null;
    meta["acceptance"] = null;
    meta["integration"] = null;
  }
  if (Object.keys(meta).length > 0) writeTaskMeta(project, card, meta);

  // 正文只在显式给了 --body 时才动。
  if (patch.body !== undefined) writeBody(join(project.herdrDir, card.dir), patch.body);

  return { dir: card.dir };
}

/** 读一个 item 目录的元数据，用于测试和调试。 */
export function readMeta(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return require("./yaml.ts").parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
}

export { ID_RE };

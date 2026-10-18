import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  ROLE_BODY,
  ROLE_META,
  TASK_BODY,
  TASK_META,
  splitTaskDir,
  type Problem,
  type Project,
  type RoleCard,
  type TaskCard,
} from "./types.ts";
import { parseYaml } from "./yaml.ts";

/** 项目至少有一个团队配置标记；Herdr 自己的 projects/、worktrees/ 不算。 */
function hasTeamConfig(root: string): boolean {
  return ["identity.md", "roles", "tasks", "workflow.md", "workflow.json"].some((name) => existsSync(join(root, ".herdr", name)));
}

/** 从 start 向上找含团队配置的目录；找不到返回 null。 */
function walkUpForHerdr(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (hasTeamConfig(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 这个目录所属的 **git 主检出**根。
 *
 * `--git-common-dir` 在任何 linked worktree 里都指向**主**仓库的 `.git`，
 * 它的父目录就是主检出 —— 也就活着的 `.herdr/` 所在的地方。
 * 不在 git 里（或没装 git）就返回 null。
 */
function mainCheckoutRoot(dir: string): string | null {
  try {
    // 用 node:child_process 而不是 Bun.spawnSync —— 前者更经得起反复调用
    // （跑测试时段错误过一次，Bun 自己报的 "bug in Bun"）。
    const proc = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (proc.status !== 0 || proc.stdout === null) return null;
    const common = proc.stdout.trim();
    if (common === "") return null;
    return dirname(resolve(dir, common));
  } catch {
    return null;
  }
}

/**
 * 定项目根。
 *
 * **worktree 里的 `.herdr/` 是 HEAD 的检出 —— 一份过期的副本。** 隔离 agent 在
 * 自己的 worktree 里跑 `herdr-team handoff`，看到的是切出来那一刻的卡片，
 * 刚建的任务根本不在里面。所以：**只要发现自己在 linked worktree 里，
 * 就用主检出的 `.herdr/`** —— 那才是活的。
 */
export function findRoot(start: string): string | null {
  const local = walkUpForHerdr(start);
  const main = mainCheckoutRoot(start);

  const chosen =
    main !== null &&
    (local === null || canonical(main) !== canonical(local)) &&
    hasTeamConfig(main)
      ? main
      : local;

  return chosen === null ? null : canonical(chosen);
}

/**
 * 规范路径。
 *
 * macOS 上 `/var` 和 `/private/var` 是同一个地方，但字符串不相等 ——
 * `git rev-parse` 给一个、`mkdtemp` 给另一个。不归一化的话，调用方拿两条
 * 路径一比较就"莫名不等"。
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 一级子目录，跳过以 . 开头的，已排序。 */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function readBody(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => (typeof x === "string" ? x : String(x)));
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return out;
}

/** 读一个 item 目录的元数据。缺失或不是映射时记一条问题并返回 null。 */
function readMeta(
  itemDir: string,
  metaName: string,
  rel: string,
  rule: string,
  problems: Problem[],
): Record<string, unknown> | null {
  const path = join(itemDir, metaName);
  if (!existsSync(path)) {
    problems.push({ file: rel, rule, message: `Missing ${metaName}` });
    return null;
  }
  const meta = parseYaml(readFileSync(path, "utf8"));
  if (meta === null) {
    problems.push({ file: `${rel}/${metaName}`, rule, message: "Invalid YAML mapping" });
    return null;
  }
  return meta;
}

function loadRoles(herdrDir: string, problems: Problem[]): RoleCard[] {
  const base = join(herdrDir, "roles");
  const out: RoleCard[] = [];

  for (const name of subdirs(base)) {
    const rel = `roles/${name}`;
    const itemDir = join(base, name);
    const meta = readMeta(itemDir, ROLE_META, rel, "3", problems);
    if (meta === null) continue;

    out.push({
      dir: rel,
      name,
      meta,
      kind: asString(meta["kind"]) ?? "",
      model: asString(meta["model"]),
      cwd: asString(meta["cwd"]),
      args: asStringList(meta["args"]),
      env: asStringMap(meta["env"]),
      worktree: meta["worktree"] === true,
      body: readBody(join(itemDir, ROLE_BODY)),
    });
  }
  return out;
}

function loadTasks(herdrDir: string, problems: Problem[]): TaskCard[] {
  const base = join(herdrDir, "tasks");
  const out: TaskCard[] = [];

  for (const name of subdirs(base)) {
    const rel = `tasks/${name}`;
    const itemDir = join(base, name);
    const meta = readMeta(itemDir, TASK_META, rel, "4", problems);
    if (meta === null) continue;

    const split = splitTaskDir(name);
    out.push({
      dir: rel,
      id: split?.id ?? "",
      slug: split?.slug ?? "",
      meta,
      title: asString(meta["title"]) ?? "",
      priority: asString(meta["priority"]) ?? "",
      status: asString(meta["status"]) ?? "",
      role: asString(meta["role"]) ?? "",
      handoff: asStringList(meta["handoff"]) ?? [],
      dependsOn: asStringList(meta["depends_on"]) ?? [],
      repo: asString(meta["repo"]) ?? ".",
      body: readBody(join(itemDir, TASK_BODY)),
    });
  }
  return out;
}

/** .retired-ids 一行一个；文件不存在就是空。 */
export function loadRetiredIds(herdrDir: string): string[] {
  const path = join(herdrDir, ".retired-ids");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function loadProject(root: string): Project {
  const herdrDir = join(root, ".herdr");
  const problems: Problem[] = [];
  return {
    root,
    herdrDir,
    hasIdentity: existsSync(join(herdrDir, "identity.md")),
    roles: loadRoles(herdrDir, problems),
    tasks: loadTasks(herdrDir, problems),
    retiredIds: loadRetiredIds(herdrDir),
    problems,
  };
}

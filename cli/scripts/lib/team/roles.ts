import { rolePrompt } from "./templates.ts";
import { reviewFor } from "../tasks/verification.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KINDS, NAME_RE, ROLE_BODY, ROLE_META, isTerminal, type Project, type RoleCard } from "../shared/types.ts";
import { emitYaml, parseYaml } from "../shared/yaml.ts";

/** 角色元数据里键的顺序。**不含 `name`** —— 角色名就是目录名。 */
export const ROLE_FIELD_ORDER = ["kind", "model", "worktree", "cwd", "args", "env"];

export class RoleError extends Error {}

export interface AddRoleOptions {
  name: string;
  /** 新角色必填；--force 更新时省略则保留。 */
  kind?: string;
  model?: string;
  worktree?: boolean;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  body?: string;
  /** 更新已有角色的显式字段；提供 body 时替换 prompt.md，省略则保留。 */
  force?: boolean;
}

export interface AddRoleResult {
  name: string;
  dir: string;
  action: "added" | "overwrote";
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new RoleError(`Role name "${name}" must match ${NAME_RE} (start with a lowercase letter; use letters, digits and hyphens)`);
  }
}

/**
 * 加一个角色 —— 运行期也能加，不用重跑 init。
 *
 * `up` 读的就是 `.herdr/roles/`，所以写完下一次 `up` 就会把它一起拉起来、
 * 一起上报状态。**不需要在别处登记。**
 */
export function addRole(project: Project, opts: AddRoleOptions): AddRoleResult {
  assertName(opts.name);
  const rel = `roles/${opts.name}`;
  const dir = join(project.herdrDir, rel);
  const metaPath = join(dir, ROLE_META);
  const existed = existsSync(metaPath);
  if (existed && opts.force !== true) {
    throw new RoleError(
      `Role "${opts.name}" already exists. Use --force to update; use --force --body or --body-file to replace responsibilities, otherwise prompt.md is preserved.`,
    );
  }

  const meta = existed ? parseYaml(readFileSync(metaPath, "utf8")) : {};
  if (meta === null) throw new RoleError(`Role "${opts.name}" has an invalid YAML mapping in ${ROLE_META}`);
  const kind = opts.kind ?? meta["kind"];
  if (kind === undefined) throw new RoleError("--kind is required for new roles (codex / claude / grok / kimi ...)");
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    throw new RoleError(`Unsupported kind "${kind}"`);
  }
  meta["kind"] = kind;
  if (opts.model !== undefined) meta["model"] = opts.model;
  if (opts.worktree !== undefined) meta["worktree"] = opts.worktree;
  if (opts.cwd !== undefined) meta["cwd"] = opts.cwd;
  if (opts.args !== undefined) meta["args"] = opts.args;
  if (opts.env !== undefined) {
    if (Object.keys(opts.env).length > 0) meta["env"] = opts.env;
    else delete meta["env"];
  }
  mkdirSync(dir, { recursive: true });
  // 只改职责时连元数据的格式与注释也保留。
  if (!existed || ROLE_FIELD_ORDER.some((key) => opts[key as keyof AddRoleOptions] !== undefined)) {
    writeFileSync(metaPath, emitYaml(meta, ROLE_FIELD_ORDER));
  }

  // 缺失时补齐；已有正文只有在 --force 且显式提供 body 时才替换。
  const bodyPath = join(dir, ROLE_BODY);
  if (!existsSync(bodyPath) || opts.force === true) {
    if (!existsSync(bodyPath)) {
      writeFileSync(bodyPath, opts.body === undefined ? rolePrompt(opts.name) : `${opts.body.replace(/\s*$/, "")}\n`);
    } else if (opts.body !== undefined) {
      writeFileSync(bodyPath, `${opts.body.replace(/\s*$/, "")}\n`);
    }
  }

  return { name: opts.name, dir: rel, action: existed ? "overwrote" : "added" };
}

/** 谁还在用这个角色？只算**没结束**的任务 —— 终态任务里的引用是历史。 */
export function tasksUsingRole(project: Project, name: string): string[] {
  return project.tasks
    .filter((t) => !isTerminal(t.status))
    .filter((t) => t.role === name || t.handoff.includes(name) || reviewFor(t)?.developer === name || reviewFor(t)?.reviewers?.includes(name))
    .map((t) => t.id);
}

export interface RemoveRoleResult {
  name: string;
  dir: string;
}

/**
 * 删一个角色。
 *
 * 还有没结束的任务在用它就拒绝 —— 删了那些任务就指向一个不存在的角色，
 * 校验会一直报错，而且 `up` 派活时会找不到人。
 */
export function removeRole(project: Project, name: string, force = false): RemoveRoleResult {
  assertName(name);

  const role: RoleCard | undefined = project.roles.find((r) => r.name === name);
  if (role === undefined) {
    const known = project.roles.map((r) => r.name).join(", ") || "(no roles)";
    throw new RoleError(`Unknown role "${name}". Available: ${known}`);
  }

  if (!force) {
    const used = tasksUsingRole(project, name);
    if (used.length > 0) {
      throw new RoleError(
        `${used.length} active tasks still reference "${name}" (${used.join(", ")}).` +
          `Finish, cancel, or reassign them first. Use --force to remove the role anyway.`,
      );
    }
  }

  rmSync(join(project.herdrDir, role.dir), { recursive: true, force: true });
  return { name, dir: role.dir };
}

/** 给人看的一行：角色名、类型、模型、是否隔离。 */
export function describeRole(role: RoleCard): string {
  const bits = [role.kind, role.model ?? "default"];
  if (role.worktree) bits.push("worktree");
  return `${role.name.padEnd(10)}${bits.join("  ")}`;
}

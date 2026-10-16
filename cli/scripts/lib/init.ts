import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KINDS, NAME_RE, ROLE_BODY, ROLE_META, type Project } from "./types.ts";
import { emitYaml } from "./yaml.ts";

/** 角色元数据里键的顺序。**不含 `name`** —— 角色名就是目录名，不重复存。 */
export const ROLE_FIELD_ORDER = ["kind", "model", "worktree", "cwd", "args", "env"];

const IDENTITY_TEMPLATE = `# 我是谁

<一句话说明自己是谁、主要做什么>

## 代码风格

- <改完要跑什么、提交习惯等>

## 偏好

- <agent 该遵守的通用偏好>
`;

const DEFAULT_ROLE_BODY = "你负责这件事。\n\n完成后运行 `herdr-team handoff <id>` 交棒，不要自己改任务卡。\n";

export class InitError extends Error {}

export interface RoleSpec {
  name: string;
  kind: string;
  model?: string;
  /** 显示短名和启动参数分开写着 —— 这里只放 `kind` / `args` / `env`。 */
  /** true = 按任务开 worktree 隔离；缺省 = 常驻项目 workspace。 */
  worktree?: boolean;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  body?: string;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  roleMetadataWritten: string[];
  roleBodiesWritten: string[];
  roleBodiesPreserved: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InitError("角色定义必须是 JSON 对象数组");
  }
  return value as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v === "") throw new InitError(`角色定义缺少字符串字段 ${key}`);
  return v;
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new InitError(`角色字段 ${key} 必须是字符串`);
  return v;
}

/** 解析角色定义。接受数组或 `{roles: [...]}`。 */
export function parseRoleSpecs(input: string): RoleSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new InitError(`角色定义不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(parsed) ? parsed : (asRecord(parsed)["roles"] ?? null);
  if (!Array.isArray(list)) throw new InitError("角色定义必须是数组，或含 roles 数组的对象");

  return list.map((raw) => {
    const rec = asRecord(raw);
    const name = requireString(rec, "name");
    const kind = requireString(rec, "kind");
    if (!NAME_RE.test(name)) throw new InitError(`角色名 "${name}" 必须匹配 ${NAME_RE}`);
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new InitError(`角色 "${name}" 的 kind "${kind}" 不在枚举内`);
    }
    const argsRaw = rec["args"];
    if (argsRaw !== undefined && !Array.isArray(argsRaw)) {
      throw new InitError(`角色 "${name}" 的 args 必须是字符串数组`);
    }
    const envRaw = rec["env"];
    if (envRaw !== undefined && (envRaw === null || typeof envRaw !== "object" || Array.isArray(envRaw))) {
      throw new InitError(`角色 "${name}" 的 env 必须是字符串映射`);
    }

    const worktreeRaw = rec["worktree"];
    if (worktreeRaw !== undefined && typeof worktreeRaw !== "boolean") {
      throw new InitError(`角色 "${name}" 的 worktree 必须是 true 或 false`);
    }

    return {
      name,
      kind,
      model: optionalString(rec, "model"),
      worktree: worktreeRaw === true,
      cwd: optionalString(rec, "cwd"),
      args: argsRaw === undefined ? undefined : (argsRaw as unknown[]).map((a) => String(a)),
      env:
        envRaw === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(envRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            ),
      body: optionalString(rec, "body"),
    };
  });
}

/**
 * 建骨架。默认跳过已有角色；force 只重写元数据，始终保留已有正文。
 * 用户的 `.herdr/` 里可能有手写的身份说明或角色，不能被 init 冲掉。
 */
export function init(project: Project, roleSpecs: RoleSpec[], force = false): InitResult {
  const created: string[] = [];
  const skipped: string[] = [];

  mkdirSync(project.herdrDir, { recursive: true });

  const identityPath = join(project.herdrDir, "identity.md");
  if (existsSync(identityPath)) {
    skipped.push("identity.md");
  } else {
    writeFileSync(identityPath, IDENTITY_TEMPLATE);
    created.push("identity.md");
  }

  for (const dir of ["roles", "tasks"]) {
    const full = join(project.herdrDir, dir);
    mkdirSync(full, { recursive: true });
    // 空目录 Git 不跟踪，放个 .gitkeep（它不以 . 开头？—— 它以，所以不会被当成角色/任务）
    const keep = join(full, ".gitkeep");
    if (existsSync(keep)) skipped.push(`${dir}/.gitkeep`);
    else {
      writeFileSync(keep, "");
      created.push(`${dir}/.gitkeep`);
    }
  }

  const roleMetadataWritten: string[] = [];
  const roleBodiesWritten: string[] = [];
  const roleBodiesPreserved: string[] = [];
  for (const spec of roleSpecs) {
    const rel = `roles/${spec.name}`;
    const dir = join(project.herdrDir, rel);
    const metaPath = join(dir, ROLE_META);

    if (existsSync(metaPath) && !force) {
      skipped.push(rel);
      continue;
    }

    mkdirSync(dir, { recursive: true });

    const meta: Record<string, unknown> = { kind: spec.kind };
    if (spec.model !== undefined) meta["model"] = spec.model;
    if (spec.worktree === true) meta["worktree"] = true;
    if (spec.cwd !== undefined) meta["cwd"] = spec.cwd;
    if (spec.args !== undefined) meta["args"] = spec.args;
    if (spec.env !== undefined) meta["env"] = spec.env;
    writeFileSync(metaPath, emitYaml(meta, ROLE_FIELD_ORDER));
    roleMetadataWritten.push(`${rel}/${ROLE_META}`);

    const bodyPath = join(dir, ROLE_BODY);
    if (!existsSync(bodyPath)) {
      writeFileSync(bodyPath, spec.body === undefined ? DEFAULT_ROLE_BODY : `${spec.body.replace(/\s*$/, "")}\n`);
      roleBodiesWritten.push(`${rel}/${ROLE_BODY}`);
    } else {
      roleBodiesPreserved.push(`${rel}/${ROLE_BODY}`);
      skipped.push(`${rel}/${ROLE_BODY}`);
    }
  }

  return { created, skipped, roleMetadataWritten, roleBodiesWritten, roleBodiesPreserved };
}

export function readRolesFile(path: string): string {
  if (path === "-") return readFileSync(0, "utf8");
  if (!existsSync(path)) throw new InitError(`找不到 ${path}`);
  return readFileSync(path, "utf8");
}

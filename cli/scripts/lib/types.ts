/** Herdr 支持的 agent 类型。与 references/herdr-format.md 的 kind 枚举一致。 */
export const KINDS = [
  "claude", "codex", "gemini", "cursor", "devin", "opencode", "copilot",
  "grok", "kimi", "droid", "amp", "qwen", "cline", "kiro", "pi", "agy",
  "omp", "mastracode", "hermes", "kilo", "qodercli", "letta", "maki", "muse",
] as const;

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const STATUSES = ["todo", "doing", "review", "done", "blocked", "cancelled"] as const;
export const TERMINAL_STATUSES = ["done", "cancelled"] as const;

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ID_RE = /^[0-9]{4}$/;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 40;

/**
 * 元数据与散文分开放 —— 学 openspec：一个 item 一个目录，
 * 元数据在点文件里，正文是纯 Markdown。
 *
 *   roles/dev/.role.yaml      元数据
 *   roles/dev/prompt.md       散文
 *   tasks/0001-x/.task.yaml   元数据
 *   tasks/0001-x/task.md      散文
 *
 * 这样代码只碰结构化文件，散文一个字都不动 —— 没有 frontmatter 那种
 * 「读—改—写」的往返损耗。
 */
export const ROLE_META = ".role.yaml";
export const ROLE_BODY = "prompt.md";
export const TASK_META = ".task.yaml";
export const TASK_BODY = "task.md";

export interface RoleCard {
  /** 相对 .herdr/ 的目录，如 `roles/dev`。也是报错时指的位置。 */
  dir: string;
  /** 目录名 —— 就是角色名。 */
  name: string;
  meta: Record<string, unknown>;
  kind: string;
  model?: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Skip the resident conversation tab, except lead which is always resident. */
  worktree: boolean;
  /** prompt.md 的内容；文件不存在时为空串。 */
  body: string;
}

export interface TaskCard {
  dir: string;
  /** 目录名 —— `<id>-<slug>`。 */
  id: string;
  slug: string;
  meta: Record<string, unknown>;
  title: string;
  priority: string;
  status: string;
  role: string;
  handoff: string[];
  dependsOn: string[];
  /** 开 worktree 用的仓库，相对项目根。缺省 `.`（项目根本身）。 */
  repo: string;
  body: string;
}

/** 隔离角色的 agent 名：`dev` + `0001` → `dev-0001`。 */
export function isolatedAgentName(role: string, id: string): string {
  return `${role}-${id}`;
}

/** 隔离任务的分支名 —— 一眼看出是哪个 feature。 */
export function worktreeBranch(card: { id: string; slug: string }): string {
  return `feat/${card.id}-${card.slug}`;
}

export interface Problem {
  /** 相对 .herdr/ 的路径；项目级问题用 "."。 */
  file: string;
  /** 校验规则编号，对应 herdr-format.md 的规则表。 */
  rule: string;
  message: string;
}

export interface Project {
  root: string;
  herdrDir: string;
  hasIdentity: boolean;
  roles: RoleCard[];
  tasks: TaskCard[];
  retiredIds: string[];
  problems: Problem[];
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** `0001-fix-login` → `{ id: "0001", slug: "fix-login" }`，不合规时返回 null。 */
export function splitTaskDir(dirName: string): { id: string; slug: string } | null {
  const m = /^([0-9]{4})-(.+)$/.exec(dirName);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { id: m[1], slug: m[2] };
}

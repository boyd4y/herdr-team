/**
 * herdr CLI 的薄封装。
 *
 * 抽成接口是为了测试能塞假实现 —— 不然 status/up/handoff 全都没法离线测。
 */

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface AgentInfo {
  name?: string;
  display_agent?: string;
  agent?: string;
  agent_status?: string;
  pane_id?: string;
  tab_id?: string;
  workspace_id?: string;
  tokens?: Record<string, string>;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
  pane_count: number;
  agent_status?: string;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  pane_count: number;
  tab_count: number;
}

export interface WorktreeInfo {
  branch: string;
  label?: string;
  path: string;
  is_linked_worktree?: boolean;
  /** 这个 checkout 当前开着的话，是哪个 workspace。 */
  open_workspace_id?: string | null;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string;
  agent_status?: string;
}

export interface Herdr {
  /** 本进程是否跑在 Herdr 的 pane 里。Herdr 自己的规范要求从外部不要控制它的会话。 */
  envOk(): boolean;
  workspaceList(): WorkspaceInfo[];
  workspaceCreate(
    label: string,
    cwd: string,
    env: Record<string, string>,
  ): { workspaceId: string; tabId: string; paneId: string };
  workspaceClose(workspaceId: string): void;
  tabList(workspaceId?: string): TabInfo[];
  tabCreate(
    workspaceId: string,
    label: string,
    cwd: string,
    env: Record<string, string>,
  ): { tabId: string; paneId: string };
  worktreeCreate(
    repoPath: string,
    branch: string,
    label: string,
  ): { workspaceId: string; tabId: string; paneId: string };
  worktreeList(repoPath: string): WorktreeInfo[];
  worktreeRemove(workspaceId: string, force?: boolean): void;
  tabRename(tabId: string, label: string): void;
  paneList(workspaceId?: string): PaneInfo[];
  /**
   * UI 焦点所在的 pane。
   *
   * 给「没有 pane 上下文」的场景用 —— 比如 Herdr 标签栏那种跑在服务器进程里的
   * 命令，它的 cwd 是服务器启动目录，不是你在看的那个项目。
   */
  paneCurrent(): { paneId: string; cwd: string | null };
  paneClose(paneId: string): void;
  workspaceCloseGroup(workspaceId: string): void;
  agentList(): AgentInfo[];
  agentStart(name: string, kind: string, paneId: string, args: string[]): void;
  /** 默认只提交输入；dispatch 可选择等待首次 working / blocked，调用上限 8 秒。 */
  agentPrompt(target: string, text: string, options?: { waitForActivity: boolean }): void;
  reportMetadata(paneId: string, source: string, displayAgent: string): void;
  reportTokens(paneId: string, source: string, tokens: Record<string, string>, ttlMs: number): void;
}

interface RawResult {
  result?: Record<string, unknown>;
}

/** 角色卡的 env 展开成 `--env K=V`，钉在 pane 上。 */
function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

function unwrap<T>(json: unknown, key: string, args: string[]): T[] {
  const r = (json as RawResult).result;
  const list = r?.[key];
  if (!Array.isArray(list)) {
    throw new HerdrError(`herdr ${args.join(" ")} 返回里没有 result.${key}`, args);
  }
  return list as T[];
}

export interface SpawnFn {
  (args: string[]): { code: number; stdout: string; stderr: string };
}

/** 只认 Herdr 的结构化错误码，不从 prompt 或错误说明中猜测。 */
function errorCode(output: string): string | undefined {
  try {
    const code: unknown = JSON.parse(output)?.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export const defaultSpawn: SpawnFn = (args) => {
  const proc = Bun.spawnSync(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
};

export function realHerdr(spawn: SpawnFn = defaultSpawn): Herdr {
  const run = (args: string[]): string => {
    let proc: { code: number; stdout: string; stderr: string };
    try {
      proc = spawn(args);
    } catch (error) {
      throw new HerdrError(
        `跑不了 herdr（PATH 里有吗？）：${error instanceof Error ? error.message : String(error)}`,
        args,
      );
    }
    if (proc.code !== 0) {
      const detail = proc.stderr.trim() || proc.stdout.trim() || `退出码 ${proc.code}`;
      throw new HerdrError(
        `herdr ${args.join(" ")} 失败：${detail}`,
        args,
        errorCode(proc.stderr) ?? errorCode(proc.stdout),
      );
    }
    return proc.stdout;
  };

  const json = <T,>(args: string[]): T => {
    const text = run(args);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HerdrError(`herdr ${args.join(" ")} 的输出不是 JSON：${text.slice(0, 200)}`, args);
    }
  };

  return {
    envOk: () => process.env["HERDR_ENV"] === "1",

    workspaceList: () => unwrap<WorkspaceInfo>(json(["workspace", "list"]), "workspaces", ["workspace", "list"]),

    workspaceCreate: (label, cwd, env) => {
      const args = ["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus", ...envFlags(env)];
      const raw = (json(args) as RawResult).result ?? {};
      const workspaceId = (raw["workspace"] as { workspace_id?: string } | undefined)?.workspace_id;
      const tabId = (raw["tab"] as { tab_id?: string } | undefined)?.tab_id;
      const paneId = (raw["root_pane"] as { pane_id?: string } | undefined)?.pane_id;
      if (!workspaceId || !tabId || !paneId) {
        throw new HerdrError("workspace create 没返回完整的 workspace/tab/root_pane", args);
      }
      return { workspaceId, tabId, paneId };
    },

    workspaceClose: (workspaceId) => void run(["workspace", "close", workspaceId]),

    tabList: (workspaceId) =>
      unwrap<TabInfo>(
        json(workspaceId ? ["tab", "list", "--workspace", workspaceId] : ["tab", "list"]),
        "tabs",
        ["tab", "list"],
      ),

    tabCreate: (workspaceId, label, cwd, env) => {
      const args = [
        "tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", cwd,
        "--no-focus", ...envFlags(env),
      ];
      const raw = (json(args) as RawResult).result ?? {};
      const tabId = (raw["tab"] as { tab_id?: string } | undefined)?.tab_id;
      const paneId = (raw["root_pane"] as { pane_id?: string } | undefined)?.pane_id;
      if (!tabId || !paneId) throw new HerdrError("tab create 没返回 tab/root_pane", args);
      return { tabId, paneId };
    },

    worktreeCreate: (repoPath, branch, label) => {
      const args = ["worktree", "create", "--cwd", repoPath, "--branch", branch, "--label", label, "--no-focus"];
      const raw = (json(args) as RawResult).result ?? {};
      const workspaceId = (raw["workspace"] as { workspace_id?: string } | undefined)?.workspace_id;
      const tabId = (raw["tab"] as { tab_id?: string } | undefined)?.tab_id;
      const paneId = (raw["root_pane"] as { pane_id?: string } | undefined)?.pane_id;
      if (!workspaceId || !tabId || !paneId) {
        throw new HerdrError("worktree create 没返回完整的 workspace/tab/root_pane", args);
      }
      return { workspaceId, tabId, paneId };
    },

    // 返回里套了一层 result.worktrees，和别的 list 不一样。
    worktreeList: (repoPath) =>
      unwrap<WorktreeInfo>(json(["worktree", "list", "--cwd", repoPath]), "worktrees", ["worktree", "list"]),

    worktreeRemove: (workspaceId, force = false) => {
      const args = ["worktree", "remove", "--workspace", workspaceId];
      if (force) args.push("--force");
      run(args);
    },

    tabRename: (tabId, label) => void run(["tab", "rename", tabId, label]),

    paneClose: (paneId) => void run(["pane", "close", paneId]),

    // 关掉「主 workspace + 挂在它下面的 worktree workspace」整组。
    workspaceCloseGroup: (workspaceId) => void run(["workspace", "close", workspaceId, "--group"]),

    paneList: (workspaceId) =>
      unwrap<PaneInfo>(
        json(workspaceId ? ["pane", "list", "--workspace", workspaceId] : ["pane", "list"]),
        "panes",
        ["pane", "list"],
      ),

    paneCurrent: () => {
      const args = ["pane", "current"];
      const raw = (json(args) as RawResult).result ?? {};
      const pane = raw["pane"] as { pane_id?: string; cwd?: string } | undefined;
      if (pane?.pane_id === undefined) throw new HerdrError("pane current 没返回 pane", args);
      return { paneId: pane.pane_id, cwd: pane.cwd ?? null };
    },

    agentList: () => unwrap<AgentInfo>(json(["agent", "list"]), "agents", ["agent", "list"]),

    agentStart: (name, kind, paneId, extraArgs) => {
      const args = ["agent", "start", name, "--kind", kind, "--pane", paneId];
      if (extraArgs.length > 0) args.push("--", ...extraArgs);
      run(args);
    },

    agentPrompt: (target, text, options) => {
      const args = ["agent", "prompt", target, text];
      if (options?.waitForActivity) {
        // 给 Herdr 内置的 5 秒活动窗口留余量，不等整轮结束。
        args.push("--wait", "--until", "working", "--until", "blocked", "--timeout", "8000");
      }
      run(args);
    },

    reportMetadata: (paneId, source, displayAgent) =>
      void run([
        "pane", "report-metadata", paneId,
        "--source", source,
        "--display-agent", displayAgent,
        "--clear-state-labels",
      ]),

    reportTokens: (paneId, source, tokens, ttlMs) =>
      void run([
        "pane", "report-metadata", paneId,
        "--source", source,
        "--ttl-ms", String(ttlMs),
        ...Object.entries(tokens).flatMap(([key, value]) => ["--token", `${key}=${value}`]),
      ]),
  };
}

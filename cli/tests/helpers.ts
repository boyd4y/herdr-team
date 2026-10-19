import { loadProject } from "../scripts/lib/team/project.ts";
import { deliveryFor } from "../scripts/lib/dispatch/delivery.ts";
import { claimTask } from "../scripts/lib/dispatch/queue.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import { ROLE_BODY, ROLE_META, TASK_BODY, TASK_META } from "../scripts/lib/shared/types.ts";
import { emitYaml } from "../scripts/lib/shared/yaml.ts";
import { badgeTokens, type AgentInfo, type Herdr, type PaneInfo, type TabInfo, type WorkspaceInfo } from "../scripts/lib/runtime/herdr.ts";

/**
 * **测试绝不能碰用户真实的信任表。**
 *
 * `up` 会把目录写进 `~/.grok/trusted_folders.toml`、`~/.codex/config.toml`、
 * `~/.claude.json` —— 跑一次测试就往人家真配置里塞几十条临时路径。
 * 在导入期就把覆盖目录指到临时处。
 */
process.env["HERDR_TEAM_TRUST_HOME"] = mkdtempSync(join(tmpdir(), "herdr-team-trusthome-"));
// Never write native session references into the user's real plugin state.
process.env["HERDR_PLUGIN_STATE_DIR"] = mkdtempSync(join(tmpdir(), "herdr-team-state-"));
// Recovery tests must never inspect the user's real conversation stores.
process.env["CLAUDE_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "herdr-team-claude-"));
process.env["CODEX_HOME"] = mkdtempSync(join(tmpdir(), "herdr-team-codex-"));

let fixtureProjectRoot = "/tmp/myproj";

const ROLE_ORDER = ["kind", "model", "worktree", "cwd", "args", "env"];
const TASK_ORDER = ["title", "priority", "status", "role", "handoff", "depends_on", "repo"];

export interface Fixture {
  root: string;
  cleanup: () => void;
}

/** 建一个临时项目目录。`withIdentity=false` 时不建 identity.md（给 init 测试用）。 */
export function makeProject(dirName = "myproj", withIdentity = true): Fixture {
  const base = mkdtempSync(join(tmpdir(), "herdr-team-test-"));
  const root = join(base, dirName);
  mkdirSync(join(root, ".herdr"), { recursive: true });
  if (withIdentity) writeFileSync(join(root, ".herdr", "identity.md"), "# 我是谁\n");
  fixtureProjectRoot = root;
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** 真正空的 .herdr/ —— 连 identity.md 都没有。 */
export function makeBareProject(dirName = "myproj"): Fixture {
  return makeProject(dirName, false);
}

/** 写一个角色：`roles/<name>/.role.yaml` + `roles/<name>/prompt.md`。 */
export function writeRole(
  root: string,
  name: string,
  meta: Record<string, unknown>,
  body = "你是这个角色。",
): void {
  const dir = join(root, ".herdr", "roles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ROLE_META), emitYaml(meta, ROLE_ORDER));
  writeFileSync(join(dir, ROLE_BODY), `${body}\n`);
}

/** 写一个任务：`tasks/<dir>/.task.yaml` + `tasks/<dir>/task.md`。 */
export function writeTask(
  root: string,
  dir: string,
  meta: Record<string, unknown>,
  body = "任务描述",
): void {
  const full = join(root, ".herdr", "tasks", dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, TASK_META), emitYaml(meta, TASK_ORDER));
  writeFileSync(join(full, TASK_BODY), `${body}\n\n## 流转记录\n`);
}

/** 直接写元数据文件的原始文本 —— 用来构造非法 YAML。 */
export function writeRaw(root: string, rel: string, text: string): void {
  const path = join(root, ".herdr", rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

export function taskMeta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "一个任务", priority: "P2", status: "todo", role: "dev", handoff: [], depends_on: [], ...over };
}

export function roleMeta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "codex", ...over };
}

/** 建两个角色：**隔离的 dev** + 常驻的 docs。 */
export function twoRoles(root: string): void {
  writeRole(root, "dev", roleMeta({ model: "sol-6.1", worktree: true, args: ["-m", "gpt-6.1-sol"] }), "你是开发者。");
  writeRole(root, "docs", roleMeta({ kind: "claude", model: "sonnet", env: { ANTHROPIC_MODEL: "sonnet" } }), "你是文档。");
}

/** 两个都常驻 —— 给只关心 tab 行为的测试用。 */
export function twoResidentRoles(root: string): void {
  writeRole(root, "dev", roleMeta({ model: "sol-6.1", args: ["-m", "gpt-6.1-sol"] }), "你是开发者。");
  writeRole(root, "docs", roleMeta({ kind: "claude", model: "sonnet", env: { ANTHROPIC_MODEL: "sonnet" } }), "你是文档。");
}

// ---------------------------------------------------------------- 假 herdr

export interface FakeState {
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  envOk: boolean;
  /** 让 worktreeRemove 抛错，模拟 git 拒绝脏 checkout。 */
  removeFails?: boolean;
  /** UI 焦点 pane 的 cwd；给 `--follow` 那类场景用。 */
  focusedCwd?: string;
}

export interface FakeHerdr extends Herdr {
  calls: string[];
  state: FakeState;
  /** 每个 worktree workspace 用的分支。 */
  branches: Map<string, string>;
  /** 直接塞一个"已在跑"的 agent。 */
  live(name: string, paneId?: string): void;
}

export function fakeHerdr(partial: Partial<FakeState> = {}): FakeHerdr {
  const state: FakeState = {
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
    envOk: true,
    ...partial,
  };
  const projectRoot = fixtureProjectRoot;
  const calls: string[] = [];
  const branches = new Map<string, string>();
  const repositories = new Map<string, string>();
  let counter = 100;

  return {
    calls,
    state,
    branches,
    live(name, paneId = `w1:p${state.agents.length + 1}`) {
      state.agents.push({ name, agent_status: "idle", pane_id: paneId, tokens: { team_project: projectKey({ root: projectRoot }) } });
    },
    envOk: () => state.envOk,
    workspaceList: () => state.workspaces,
    workspaceCreate: (label, cwd, env) => {
      calls.push(`workspace create ${label} cwd=${cwd} env=${JSON.stringify(env)}`);
      counter += 1;
      const id = `w${counter}`;
      state.workspaces.push({ workspace_id: id, label, pane_count: 1, tab_count: 1 });
      state.tabs.push({ tab_id: `${id}:t1`, workspace_id: id, label: "1", pane_count: 1 });
      state.panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, cwd });
      return { workspaceId: id, tabId: `${id}:t1`, paneId: `${id}:p1` };
    },
    workspaceClose: (id) => calls.push(`workspace close ${id}`),
    tabList: (ws) => state.tabs.filter((t) => ws === undefined || t.workspace_id === ws),
    tabCreate: (ws, label, cwd, env) => {
      calls.push(`tab create ${label} cwd=${cwd} env=${JSON.stringify(env)}`);
      counter += 1;
      const tabId = `${ws}:t${counter}`;
      state.tabs.push({ tab_id: tabId, workspace_id: ws, label, pane_count: 1 });
      state.panes.push({ pane_id: `${ws}:p${counter}`, tab_id: tabId, workspace_id: ws, cwd });
      return { tabId, paneId: `${ws}:p${counter}` };
    },
    worktreeCreate: (repoPath, branch, label) => {
      calls.push(`worktree create repo=${repoPath} branch=${branch} label=${label}`);
      counter += 1;
      const id = `w${counter}`;
      // worktree 是挂在源 workspace 下的一个普通 workspace
      state.workspaces.push({ workspace_id: id, label, pane_count: 1, tab_count: 1 });
      state.tabs.push({ tab_id: `${id}:t1`, workspace_id: id, label, pane_count: 1 });
      state.panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, cwd: repoPath });
      branches.set(id, branch);
      repositories.set(id, repoPath);
      return { workspaceId: id, tabId: `${id}:t1`, paneId: `${id}:p1` };
    },
    worktreeList: (repoPath) => {
      // 只管我们自己建的那几个 —— 主 checkout 不参与。
      return [...branches.entries()].filter(([id]) => !repositories.has(id) || repositories.get(id) === repoPath).map(([workspaceId, branch]) => ({
        branch,
        path: `/tmp/worktrees/${branch}`,
        is_linked_worktree: true,
        open_workspace_id: state.workspaces.some((w) => w.workspace_id === workspaceId)
          ? workspaceId
          : null,
      }));
    },
    worktreeRemove: (workspaceId, force = false) => {
      calls.push(`worktree remove ${workspaceId}${force ? " force" : ""}`);
      // 模拟 git 拒绝脏 checkout
      if (state.removeFails && !force) {
        throw new Error("contains modified or untracked files");
      }
      state.workspaces = state.workspaces.filter((w) => w.workspace_id !== workspaceId);
      branches.delete(workspaceId);
    },
    tabRename: (tabId, label) => {
      calls.push(`tab rename ${tabId} ${label}`);
      const tab = state.tabs.find((t) => t.tab_id === tabId);
      if (tab !== undefined) tab.label = label;
    },
    paneList: (ws) => state.panes.filter((p) => ws === undefined || p.workspace_id === ws),
    paneCurrent: () => ({
      paneId: state.panes[0]?.pane_id ?? "w1:p1",
      cwd: state.focusedCwd ?? null,
    }),
    paneClose: (paneId) => {
      calls.push(`pane close ${paneId}`);
      state.agents = state.agents.filter((a) => a.pane_id !== paneId);
    },
    tabFocus: (tabId) => { calls.push(`tab focus ${tabId}`); },
    pluginPaneOpen: (workspaceId, cwd, focus) => {
      calls.push(`plugin pane open console workspace=${workspaceId} cwd=${cwd} focus=${focus}`);
      counter++;
      const paneId = `${workspaceId}:p${counter}`, tabId = `${workspaceId}:t${counter}`;
      state.tabs.push({ tab_id: tabId, workspace_id: workspaceId, label: "1", pane_count: 1 });
      state.panes.push({ pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, cwd });
      return { paneId, tabId };
    },
    paneRun: (paneId, command) => {
      calls.push(`pane run ${paneId} ${command}`);
    },
    paneIsShell: (paneId) => !state.agents.some((a) => a.pane_id === paneId),
    workspaceCloseGroup: (workspaceId) => {
      calls.push(`workspace close ${workspaceId} --group`);
      state.workspaces = state.workspaces.filter((w) => w.workspace_id !== workspaceId);
    },
    agentList: () => state.agents,
    agentStart: (name, kind, paneId, args) => {
      calls.push(`agent start ${name} kind=${kind} pane=${paneId} args=${JSON.stringify(args)}`);
      state.agents.push({ name, agent: kind, agent_status: "idle", pane_id: paneId,
        workspace_id: state.panes.find((p) => p.pane_id === paneId)?.workspace_id,
        tab_id: state.panes.find((p) => p.pane_id === paneId)?.tab_id,
        tokens: { team_project: projectKey({ root: projectRoot }) } });
    },
    agentPrompt: (target, text) => calls.push(`agent prompt ${target} ${text.slice(0, 40)}`),
    reportWorkspaceMetadata: (id, tokens) => {
      calls.push(`report-workspace ${id}`);
      const workspace = state.workspaces.find((w) => w.workspace_id === id);
      if (workspace) {
        workspace.tokens ??= {};
        for (const [key, value] of Object.entries(tokens)) {
          if (value === null) delete workspace.tokens[key];
          else workspace.tokens[key] = value;
        }
      }
    },
    reportBadge: (scope, id, badge, colorSlot = 0, label) => {
      calls.push(`report-badge ${scope} ${id} ${badge}`);
      const target = scope === "workspace" ? state.workspaces.find((w) => w.workspace_id === id) : state.agents.find((a) => a.pane_id === id);
      if (target) {
        target.tokens ??= {};
        for (const [key, value] of Object.entries(badgeTokens(badge, colorSlot, label))) {
          if (value === null) delete target.tokens[key];
          else target.tokens[key] = value;
        }
      }
    },
    reportMetadata: (paneId, source, displayAgent, tokens = {}) => {
      calls.push(`report-metadata ${paneId} ${displayAgent}`);
      const agent = state.agents.find((a) => a.pane_id === paneId);
      if (agent !== undefined) {
        agent.display_agent = displayAgent;
        agent.tokens ??= {};
        for (const [key, value] of Object.entries(tokens)) {
          if (value === null) delete agent.tokens[key];
          else agent.tokens[key] = value;
        }
      }
      const pane = state.panes.find((p) => p.pane_id === paneId);
      if (pane) {
        pane.tokens ??= {};
        for (const [key, value] of Object.entries(tokens)) {
          if (value === null) delete pane.tokens[key];
          else pane.tokens[key] = value;
        }
      }
    },
  };
}

/** 一个 workspace，里面 dev / docs 两个 tab 和已启动的 agent。 */
export function runningWorkspace(label = "myproj"): FakeHerdr {
  const herdr = fakeHerdr({
    workspaces: [{ workspace_id: "w1", label, pane_count: 2, tab_count: 2 }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "dev", pane_count: 1 },
      { tab_id: "w1:t2", workspace_id: "w1", label: "docs", pane_count: 1 },
    ],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: fixtureProjectRoot },
      { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", cwd: fixtureProjectRoot },
    ],
  });
  herdr.live("dev", "w1:p1");
  herdr.live("docs", "w1:p2");
  return herdr;
}

/** Simulate the agent acknowledging the exact assignment received in its prompt. */
export function claimCurrent(root: string, id = "0001"): string {
  const project = loadProject(root);
  const delivery = deliveryFor(project.tasks.find((t) => t.id === id)!);
  if (!delivery) throw new Error("Expected an active delivery");
  claimTask(project, id, delivery.id);
  return delivery.id;
}

/** A native report backed by a saved Codex user message. */
export function persistedCodexSession(value = "session-123") {
  const dir = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "19");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-10-19T10-00-00-${value}.jsonl`),
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}\n');
  return { source: "herdr:codex", agent: "codex", kind: "id" as const, value };
}

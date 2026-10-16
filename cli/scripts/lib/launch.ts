import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HerdrError, type Herdr } from "./herdr.ts";
import { refreshSidebar, reportRoleSidebar } from "./sidebar.ts";
import { appendRecord, assignmentPrompt, stamp, startupPrompt } from "./handoff.ts";
import { findTask, writeTaskMeta } from "./task.ts";
import {
  isTerminal,
  isolatedAgentName,
  worktreeBranch,
  type Project,
  type RoleCard,
  type TaskCard,
} from "./types.ts";

export class LaunchError extends Error {}

export interface RoleOutcome {
  role: string;
  /** 常驻角色落在项目 workspace 的 tab；隔离角色不预起，这里为 null。 */
  tab: string | null;
  paneId: string | null;
  action: "started" | "reused" | "deferred" | "failed";
  /** 显示名上报成功了吗。**deferred 的角色是 null** —— 它压根没起，谈不上上报。 */
  reported: boolean | null;
  /** action 是 failed 时，失败原因。 */
  failure?: string;
}

export interface DispatchOutcome {
  id: string;
  role: string;
  action: "dispatched" | "waiting-on-deps" | "no-agent";
  reason?: string;
  /** 隔离角色才会开 worktree。 */
  branch?: string;
  workspaceId?: string;
}

export interface UpResult {
  workspaceId: string;
  workspaceLabel: string;
  workspaceAction: "created" | "reused";
  roles: RoleOutcome[];
}

/** 项目名 → workspace label。用户可能已经手动为这个项目开过 workspace。 */
export function workspaceLabelFor(project: Project): string {
  return basename(project.root);
}

/** 一个任务该由谁做：常驻角色用角色名，隔离角色用 `<role>-<id>`。 */
export function agentNameFor(project: Project, card: TaskCard): string {
  const role = project.roles.find((r) => r.name === card.role);
  return role?.worktree === true ? isolatedAgentName(card.role, card.id) : card.role;
}

function resolveWorkspace(herdr: Herdr, label: string): string | null {
  const matches = herdr.workspaceList().filter((w) => w.label === label);
  if (matches.length > 1) {
    const ids = matches.map((m) => m.workspace_id).join(", ");
    throw new LaunchError(
      `有 ${matches.length} 个 label 为 "${label}" 的 workspace（${ids}）。停下来问用户，不要猜。`,
    );
  }
  return matches[0]?.workspace_id ?? null;
}

/** 常驻角色在项目 workspace 里的 pane。先按 tab label 找，找不到就建。 */
function residentPane(
  herdr: Herdr,
  workspaceId: string,
  role: RoleCard,
  projectRoot: string,
): { paneId: string; tabId: string } {
  const tab = herdr.tabList(workspaceId).find((t) => t.label === role.name);
  if (tab !== undefined) {
    const panes = herdr
      .paneList(workspaceId)
      .filter((p) => p.tab_id === tab.tab_id)
      .sort((a, b) => a.pane_id.localeCompare(b.pane_id));
    const root = panes[0];
    if (root === undefined) throw new LaunchError(`tab "${role.name}" 里没有 pane`);
    return { paneId: root.pane_id, tabId: tab.tab_id };
  }

  // 新 tab 不继承 workspace 的 cwd，必须显式给。
  const cwd = role.cwd === undefined ? projectRoot : join(projectRoot, role.cwd);
  const made = herdr.tabCreate(workspaceId, role.name, cwd, role.env ?? {});
  return { paneId: made.paneId, tabId: made.tabId };
}

function liveAgentNames(herdr: Herdr): Set<string> {
  return new Set(herdr.agentList().map((a) => a.name).filter((n): n is string => n !== undefined));
}

export function up(project: Project, herdr: Herdr): UpResult {
  if (!herdr.envOk()) {
    throw new LaunchError(
      "这个命令要在 Herdr 的 pane 里跑（HERDR_ENV=1）。\n" +
        "Herdr 的规范要求：从外部不要控制它的会话 —— 外部调用分不清哪个 pane 属于用户。",
    );
  }

  const roles = project.roles;
  if (roles.length === 0) throw new LaunchError("没有角色，先跑 init");

  const label = workspaceLabelFor(project);
  const existing = resolveWorkspace(herdr, label);

  let workspaceId: string;
  let workspaceAction: "created" | "reused";
  let createdRoot: { tabId: string; paneId: string } | null = null;

  if (existing === null) {
    const first = roles[0] as RoleCard;
    const made = herdr.workspaceCreate(label, project.root, first.env ?? {});
    workspaceId = made.workspaceId;
    workspaceAction = "created";
    createdRoot = { tabId: made.tabId, paneId: made.paneId };
  } else {
    workspaceId = existing;
    workspaceAction = "reused";
  }

  const live = liveAgentNames(herdr);
  const outcomes: RoleOutcome[] = [];
  let residentIndex = 0;

  for (const role of roles) {
    if (role.worktree) {
      // 隔离角色不预起 —— 来活了才在它自己的 worktree 里出现。
      outcomes.push({ role: role.name, tab: null, paneId: null, action: "deferred", reported: null });
      continue;
    }

    let paneId: string;
    let tabId: string;
    if (residentIndex === 0 && createdRoot !== null) {
      // workspace create 自带的 root tab 直接给第一个常驻角色，省一个 tab。
      tabId = createdRoot.tabId;
      paneId = createdRoot.paneId;
      herdr.tabRename(tabId, role.name);
    } else {
      const got = residentPane(herdr, workspaceId, role, project.root);
      paneId = got.paneId;
      tabId = got.tabId;
    }
    residentIndex += 1;

    // **一个角色起不来不该把整个 up 崩掉。** Herdr 有时会说 pane "不是可用的 shell"
    // （比如刚关停完、状态还没跟上）—— 记下来继续，让用户自己决定怎么办。
    const alreadyLive = live.has(role.name);
    let failure: string | undefined;
    if (!alreadyLive) {
      try {
        herdr.agentStart(role.name, role.kind, paneId, role.args ?? []);
        // 常驻角色不等任务 —— 起来就得知道自己是谁，否则只是个裸 TUI。
        // （**只在刚起的时候发**；已经在跑的 agent 重发会打断它手头的事。）
        herdr.agentPrompt(
          role.name,
          startupPrompt(readIdentity(project), role.body, role.name),
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }

    // 已存在的 agent **也要**重新上报 —— 名字或 model 改过时，不重报就永远不生效。
    let reported: boolean | null = true;
    if (failure === undefined) {
      try {
        reportRoleSidebar(project, herdr, paneId, role);
      } catch {
        reported = false;
      }
    } else {
      reported = null;
    }

    outcomes.push({
      role: role.name,
      tab: tabId,
      paneId,
      action: failure !== undefined ? "failed" : alreadyLive ? "reused" : "started",
      reported,
      ...(failure !== undefined ? { failure } : {}),
    });
  }

  return { workspaceId, workspaceLabel: label, workspaceAction, roles: outcomes };
}

/** 按 priority 升序、同优先级按 id 升序派活。 */
export function dispatch(project: Project, herdr: Herdr, id?: string): DispatchOutcome[] {
  // 指定任务时先报错，不能静默跳过，也不能在报错前动 Herdr。
  const selected = id === undefined ? undefined : findTask(project, id);
  if (selected !== undefined && selected.status !== "todo") {
    throw new LaunchError(`${id} 当前状态是 ${selected.status}，只能派 todo 的任务`);
  }
  if (!herdr.envOk()) throw new LaunchError("这个命令要在 Herdr 的 pane 里跑（HERDR_ENV=1）。");

  const live = liveAgentNames(herdr);
  const done = new Set(project.tasks.filter((t) => isTerminal(t.status)).map((t) => t.id));

  const pending = project.tasks
    .filter((t) => t.status === "todo")
    .filter((t) => id === undefined || t.id === id)
    .sort((a, b) =>
      a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority.localeCompare(b.priority),
    );

  const out: DispatchOutcome[] = [];

  for (const task of pending) {
    const blocked = task.dependsOn.filter((d) => !done.has(d));
    if (blocked.length > 0) {
      out.push({ id: task.id, role: task.role, action: "waiting-on-deps", reason: `等 ${blocked.join(", ")}` });
      continue;
    }

    const role = project.roles.find((r) => r.name === task.role);
    if (role === undefined) {
      out.push({ id: task.id, role: task.role, action: "no-agent", reason: `角色 ${task.role} 不存在` });
      continue;
    }

    let agentName = task.role;
    let branch: string | undefined;
    let workspaceId: string | undefined;

    if (role.worktree) {
      // 每个隔离任务一个 worktree + 一个新 workspace（挂在项目 workspace 下成组）。
      branch = worktreeBranch(task);
      const repoPath = join(project.root, task.repo);
      if (!existsSync(repoPath)) {
        out.push({ id: task.id, role: task.role, action: "no-agent", reason: `仓库 ${task.repo} 不存在` });
        continue;
      }

      agentName = isolatedAgentName(task.role, task.id);
      if (!live.has(agentName)) {
        try {
          // workspace 的名字用**分支名**（= feature 名），不是任务标题 ——
          // 侧边栏里一眼就知道这是哪个 feature 的工作区。
          const trees = herdr.worktreeList(repoPath).filter((t) => t.branch === branch);
          if (trees.length > 1) throw new LaunchError(`${branch} 对应多个 worktree，请 lead 确认`);
          const existing = trees[0];
          let paneId: string;
          if (existing !== undefined) {
            // 上次 agent 启动失败可能已留下 checkout；复用它，不能再建同名分支。
            const open = existing.open_workspace_id;
            if (!open) throw new LaunchError(`${branch} 的 worktree 已存在但 workspace 已关闭，请 lead 重新打开后再 dispatch`);
            workspaceId = open;
            const pane = herdr.paneList(open).sort((a, b) => a.pane_id.localeCompare(b.pane_id))[0];
            if (pane === undefined) throw new LaunchError(`${branch} 的 workspace 没有 pane，请 lead 检查`);
            paneId = pane.pane_id;
          } else {
            const made = herdr.worktreeCreate(repoPath, branch, branch);
            workspaceId = made.workspaceId;
            paneId = made.paneId;
          }

          herdr.agentStart(agentName, role.kind, paneId, role.args ?? []);
          try {
            reportRoleSidebar(project, herdr, paneId, role, task.id);
          } catch {
            // 上报失败不影响干活。
          }
        } catch (error) {
          // 任务停在 todo；下次 dispatch 复用已建的 worktree，再试启动 agent。
          const why = error instanceof Error ? error.message : String(error);
          out.push({ id: task.id, role: task.role, action: "no-agent", reason: `起 worktree/agent 失败：${why}` });
          continue;
        }
      }
    } else if (!live.has(agentName)) {
      out.push({ id: task.id, role: task.role, action: "no-agent", reason: `角色 ${task.role} 没有存活 agent` });
      continue;
    }

    // 尽量等到活动再写 doing，缩短启动期间 idle 被误报为没交棒的窗口。
    // 观察超时不代表输入被拒；不重发，照常记派出，并把未确认告知调用方。
    let reason: string | undefined;
    try {
      herdr.agentPrompt(agentName, assignmentPrompt(readIdentity(project), role.body, task), { waitForActivity: true });
    } catch (error) {
      if (!(error instanceof HerdrError) ||
          (error.code !== "agent_prompt_stalled" && error.code !== "timeout")) throw error;
      reason = `未能确认已开工（${error.code}）`;
    }
    writeTaskMeta(project, task, { status: "doing" });
    // 和 handoff 写的一样带时间戳 —— 同一份记录里格式要一致。
    appendRecord(project, task, `- ${stamp(new Date())}  → ${agentName}  (todo → doing)`);

    out.push({ id: task.id, role: task.role, action: "dispatched", workspaceId, branch,
      ...(reason === undefined ? {} : { reason }) });
  }

  refreshSidebar(project, herdr);
  return out;
}

function readIdentity(project: Project): string {
  const path = join(project.herdrDir, "identity.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export interface StoppedAgent {
  role: string;
  agent: string;
  paneId: string;
}

export interface DownResult {
  stopped: StoppedAgent[];
  /** 认出来是我们的人、但拿不到 pane 的。 */
  skipped: string[];
}

/**
 * 哪个角色的 agent 叫这个名字？
 *
 * 常驻角色就是角色名；隔离角色形如 `<role>-<id>`。**只认这两种** ——
 * 认不出来的一律不碰，那多半是用户自己的 agent。
 */
function roleOwning(project: Project, agentName: string): string | null {
  for (const role of project.roles) {
    if (role.name === agentName) return role.name;
    if (role.worktree && agentName.startsWith(`${role.name}-`)) {
      // 后半段得是 4 位任务 id，别把 `dev-something` 误认成我们的
      const suffix = agentName.slice(role.name.length + 1);
      if (/^[0-9]{4}$/.test(suffix)) return role.name;
      // 也认 `<role>-<id>-<slug>` 这种带后缀的写法
      if (/^[0-9]{4}-/.test(suffix)) return role.name;
    }
  }
  return null;
}

/**
 * 关停团队的 agent。
 *
 * **不动 workspace。** 那是用户的项目容器，里面可能有他自己的 tab 和 pane ——
 * 关掉整个 workspace 会连他一起关。这里只关我们认得的那些 agent 的 pane。
 */
export function down(project: Project, herdr: Herdr): DownResult {
  if (!herdr.envOk()) throw new LaunchError("这个命令要在 Herdr 的 pane 里跑（HERDR_ENV=1）。");

  const stopped: StoppedAgent[] = [];
  const skipped: string[] = [];

  for (const agent of herdr.agentList()) {
    const name = agent.name;
    if (name === undefined || name === null) continue;

    const role = roleOwning(project, name);
    if (role === null) continue; // 不是我们的，别碰

    const paneId = agent.pane_id;
    if (paneId === undefined || paneId === null) {
      skipped.push(name);
      continue;
    }

    herdr.paneClose(paneId);
    stopped.push({ role, agent: name, paneId });
  }

  return { stopped, skipped };
}

export { HerdrError };

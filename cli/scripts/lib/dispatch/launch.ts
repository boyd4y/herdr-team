import { taskScoped } from "../tasks/verification.ts";
import { loadProject } from "../team/project.ts";
import { deliveryFor } from "./delivery.ts";
import { enqueueTasks, pumpQueue } from "./queue.ts";
import { ensureConsole, stopConsole, type ConsoleOutcome } from "../runtime/console.ts";
import { withTeamLock } from "../runtime/state.ts";
import { basename, join } from "node:path";
import { HerdrError, type Herdr } from "../runtime/herdr.ts";
import { reportRoleSidebar } from "../ui/sidebar.ts";
import { forgetRoleSession, scopeForTaskSession, rememberRoleSession, savedResumeArgs } from "../runtime/sessions.ts";
import { availableAgentName, bindProjectWorkspace, findRoleAgent, projectAgents, resolveProjectWorkspace, roleAssignment } from "./team-scope.ts";
import { findTask } from "../tasks/cards.ts";
import {
  worktreeBranch,
  type Project,
  type RoleCard,
} from "../shared/types.ts";

export class LaunchError extends Error {}

export interface RoleOutcome {
  role: string;
  /** 常驻角色落在项目 workspace 的 tab；隔离角色不预起，这里为 null。 */
  tab: string | null;
  paneId: string | null;
  action: "started" | "resumed" | "reused" | "deferred" | "failed";
  /** 显示名上报成功了吗。**deferred 的角色是 null** —— 它压根没起，谈不上上报。 */
  reported: boolean | null;
  /** action 是 failed 时，失败原因。 */
  failure?: string;
  sessionWarning?: string;
}

export interface DispatchOutcome {
  id: string;
  role: string;
  action: "dispatched" | "queued" | "uncertain" | "waiting-on-deps" | "no-agent";
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
  console: ConsoleOutcome;
}

/** 项目名 → workspace label。用户可能已经手动为这个项目开过 workspace。 */
export function workspaceLabelFor(project: Project): string {
  return basename(project.root);
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
    if (root === undefined) throw new LaunchError(`No pane in tab "${role.name}"`);
    return { paneId: root.pane_id, tabId: tab.tab_id };
  }

  // 新 tab 不继承 workspace 的 cwd，必须显式给。
  const cwd = role.cwd === undefined ? projectRoot : join(projectRoot, role.cwd);
  const made = herdr.tabCreate(workspaceId, role.name, cwd, role.env ?? {});
  return { paneId: made.paneId, tabId: made.tabId };
}

export function up(project: Project, herdr: Herdr, options: { fresh?: boolean } = {}): UpResult {
  if (!herdr.envOk()) {
    throw new LaunchError(
      "Run this command inside a Herdr pane (HERDR_ENV=1).\n" +
        "Herdr session control requires a managed pane to identify the caller safely.",
    );
  }

  const roles = project.roles;
  if (roles.length === 0) throw new LaunchError("No roles found; run init first");

  const label = workspaceLabelFor(project);
  const existing = resolveProjectWorkspace(project, herdr);

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

  bindProjectWorkspace(project, herdr, workspaceId, true);
  const live = projectAgents(project, herdr);
  const outcomes: RoleOutcome[] = [];
  let residentIndex = 0;

  for (const role of roles) {
    if (role.worktree && role.name !== "lead") {
      // 隔离角色不预起 —— 来活了才在它自己的 worktree 里出现。
      outcomes.push({ role: role.name, tab: null, paneId: null, action: "deferred", reported: null });
      continue;
    }

    const existingAgent = findRoleAgent(project, live, role);
    if (existingAgent && !existingAgent.pane_id) {
      outcomes.push({ role: role.name, tab: null, paneId: null, action: "failed", reported: null,
        failure: "Project agent has no pane ID; refusing to guess a target" });
      continue;
    }
    let paneId: string;
    let tabId: string | null;
    if (existingAgent?.pane_id) {
      paneId = existingAgent.pane_id;
      tabId = existingAgent.tab_id ?? null;
    } else if (residentIndex === 0 && createdRoot !== null) {
      tabId = createdRoot.tabId;
      paneId = createdRoot.paneId;
      herdr.tabRename(tabId, role.name);
    } else {
      const got = residentPane(herdr, workspaceId, role, project.root);
      paneId = got.paneId;
      tabId = got.tabId;
    }
    residentIndex += 1;
    const alreadyLive = existingAgent !== undefined;
    let failure: string | undefined;
    let resumed = false;
    let sessionWarning: string | undefined;
    if (!alreadyLive) {
      try {
        const resume = options.fresh ? undefined : savedResumeArgs(project, role);
        resumed = resume !== undefined;
        herdr.agentStart(availableAgentName(project, herdr, role), role.kind, paneId, [...(resume ?? []), ...(role.args ?? [])]);
      } catch (error) {
        failure = `${resumed ? "Session resume failed (use up --fresh to start a new session): " : ""}${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (failure === undefined) {
      try {
        // Clear only after a fresh process starts successfully; keep running agents intact.
        if (options.fresh && !alreadyLive) forgetRoleSession(project, role);
        const agent = alreadyLive ? existingAgent : herdr.agentList().find((a) => a.pane_id === paneId);
        if (agent) rememberRoleSession(project, role, agent);
      } catch (error) {
        sessionWarning = `Session record was not saved: ${error instanceof Error ? error.message : String(error)}`;
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
      action: failure !== undefined ? "failed" : alreadyLive ? "reused" : resumed ? "resumed" : "started",
      reported,
      ...(failure !== undefined ? { failure } : {}),
      ...(sessionWarning !== undefined ? { sessionWarning } : {}),
    });
  }

  return { workspaceId, workspaceLabel: label, workspaceAction, roles: outcomes, console: ensureConsole(project, herdr, workspaceId) };
}

/** 按 priority 升序、同优先级按 id 升序派活。 */
export function dispatch(project: Project, herdr: Herdr, id?: string): DispatchOutcome[] {
  const selected = id === undefined ? undefined : findTask(project, id);
  if (selected && selected.status !== "todo") throw new LaunchError(`${id} is ${selected.status}; only todo tasks can be dispatched`);
  if (!herdr.envOk()) throw new LaunchError("Run this command inside a Herdr pane (HERDR_ENV=1).");
  const ids = project.tasks.filter((t) => t.status === "todo" && (id === undefined || t.id === id))
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id)).map((t) => t.id);
  enqueueTasks(project, id);
  pumpQueue(project, herdr);
  const fresh = loadProject(project.root);
  return ids.map((taskId) => {
    const task = findTask(fresh, taskId), delivery = deliveryFor(task)!;
    return { id: taskId, role: task.role,
      action: delivery.state === "submitted" || delivery.state === "claimed" ? "dispatched"
        : delivery.state === "uncertain" ? "uncertain"
        : task.dependsOn.some((id) => !fresh.tasks.some((t) => t.id === id && t.status === "done")) ? "waiting-on-deps" : "queued",
      ...(delivery.reason ? { reason: delivery.reason } : {}),
      ...(taskScoped(task, project.roles.find((r) => r.name === task.role)) ? {
        branch: worktreeBranch(task),
        workspaceId: herdr.agentList().find((a) => a.pane_id === delivery.pane_id)?.workspace_id,
      } : {}),
    };
  });
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
 * 关停团队的 agent。
 *
 * **不动 workspace。** 那是用户的项目容器，里面可能有他自己的 tab 和 pane ——
 * 关掉整个 workspace 会连他一起关。这里只关我们认得的那些 agent 的 pane。
 */
export function down(project: Project, herdr: Herdr): DownResult {
  if (!herdr.envOk()) throw new LaunchError("Run this command inside a Herdr pane (HERDR_ENV=1).");

  stopConsole(project);
  return withTeamLock(project, "queue", () => {
  const stopped: StoppedAgent[] = [];
  const skipped: string[] = [];

  for (const agent of projectAgents(project, herdr)) {
    const name = agent.name;
    if (name === undefined || name === null) continue;

    const assignment = roleAssignment(project, agent);
    const role = assignment?.role.name;
    if (role === undefined) continue; // 不是我们的，别碰

    const paneId = agent.pane_id;
    if (paneId === undefined || paneId === null) {
      skipped.push(name);
      continue;
    }

    // Persist before closing: a failed write must leave the recoverable agent alive.
    const scope = assignment!.taskId && agent.agent_session
      ? scopeForTaskSession(project, herdr, assignment!.role, assignment!.taskId) : undefined;
    rememberRoleSession(project, assignment!.role, agent, scope);
    herdr.paneClose(paneId);
    stopped.push({ role, agent: name, paneId });
  }

  return { stopped, skipped };
  });
}

export { HerdrError };

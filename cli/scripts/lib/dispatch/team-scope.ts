import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { findRoot } from "../team/project.ts";
import type { AgentInfo, Herdr } from "../runtime/herdr.ts";
import { isolatedAgentName, type Project, type RoleCard } from "../shared/types.ts";

export class TeamScopeError extends Error {}

/** Human-readable identity stays distinct even when live names need a namespace. */
export function roleAgentLabel(role: string, taskId?: string): string {
  return taskId === undefined ? role : `${role}-${taskId}`;
}

export function projectKey(project: Pick<Project, "root">): string {
  let root = project.root;
  try { root = realpathSync(root); } catch { /* Validation handles absent roots. */ }
  return createHash("sha256").update(root).digest("hex");
}

export function scopedAgentName(project: Project, role: string, taskId?: string): string {
  const roleHash = createHash("sha256").update(role).digest("hex").slice(0, 6);
  return `ht-${projectKey(project).slice(0, 16)}-${roleHash}${taskId === undefined ? "" : `-${taskId}`}`;
}

/** A foreign workspace's label or a globally matching role name is never ownership evidence. */
export function resolveProjectWorkspace(project: Project, herdr: Herdr): string | null {
  const key = projectKey(project);
  const root = realpathSync(project.root);
  const workspaces = herdr.workspaceList();
  const bound = workspaces.filter((w) => w.tokens?.team_project === key && w.tokens?.team_root === "1");
  const matches = bound.length ? bound : workspaces.filter((w) => {
    if (w.tokens?.team_project !== undefined || w.worktree?.is_linked_worktree) return false;
    return herdr.paneList(w.workspace_id).some((pane) => pane.cwd && findRoot(pane.cwd) === root);
  });
  if (matches.length > 1) throw new TeamScopeError(
    `Project ${project.root} matches multiple workspaces (${matches.map((w) => w.workspace_id).join(", ")}); resolve ownership before continuing`,
  );
  return matches[0]?.workspace_id ?? null;
}

export function bindProjectWorkspace(project: Project, herdr: Herdr, workspaceId: string, root: boolean): void {
  const workspace = herdr.workspaceList().find((w) => w.workspace_id === workspaceId);
  const key = projectKey(project);
  if (workspace?.tokens?.team_project !== undefined && workspace.tokens.team_project !== key) {
    throw new TeamScopeError(`${workspaceId} belongs to another project; refusing takeover`);
  }
  herdr.reportWorkspaceMetadata(workspaceId, { team_project: key, team_root: root ? "1" : "0" });
}

/** Reusing/removing an existing checkout requires project evidence, not just its branch. */
export function assertProjectWorkspace(project: Project, herdr: Herdr, workspaceId: string): void {
  const workspace = herdr.workspaceList().find((w) => w.workspace_id === workspaceId);
  const owner = workspace?.tokens?.team_project;
  if (owner === projectKey(project)) return;
  if (owner !== undefined) throw new TeamScopeError(`${workspaceId} belongs to another project; refusing reuse or removal`);
  const root = realpathSync(project.root);
  if (workspace && herdr.paneList(workspaceId).some((pane) => pane.cwd && findRoot(pane.cwd) === root)) return;
  throw new TeamScopeError(`${workspaceId} has no verifiable project ownership; refusing reuse or removal`);
}

/** Agents without reported ownership require cwd evidence; reported agents have a full project key. */
export function projectAgents(project: Project, herdr: Herdr, agents = herdr.agentList()): AgentInfo[] {
  if (!agents.length) return [];
  const key = projectKey(project);
  let root = project.root;
  try { root = realpathSync(root); } catch {}
  const workspaces = herdr.workspaceList();
  let panes: ReturnType<Herdr["paneList"]> | undefined;
  return agents.filter((agent) => {
    const workspace = workspaces.find((w) => w.workspace_id === agent.workspace_id);
    if (workspace?.tokens?.team_project !== undefined && workspace.tokens.team_project !== key) return false;
    if (agent.tokens?.team_project !== undefined) return agent.tokens.team_project === key;
    if (!agent.pane_id) return false;
    panes ??= herdr.paneList();
    const pane = panes.find((p) => p.pane_id === agent.pane_id);
    return pane?.cwd !== undefined && findRoot(pane.cwd) === root;
  });
}

export function roleAssignment(project: Project, agent: AgentInfo): { role: RoleCard; taskId?: string } | null {
  if (agent.tokens?.team_project !== undefined && agent.tokens.team_project !== projectKey(project)) return null;
  const declaredRole = agent.tokens?.team_role;
  // A pane may retain a display label after the process's live name is lost.
  const name = agent.name ?? agent.display_agent;
  const roles = declaredRole === undefined ? project.roles : project.roles.filter((role) => role.name === declaredRole);
  for (const role of roles) {
    const declaredTask = agent.tokens?.team_role === role.name ? agent.tokens.team_task_id : undefined;
    if (declaredTask && /^[0-9]{4}$/.test(declaredTask)) return { role, taskId: declaredTask };
    const taskSuffix = name?.startsWith(`${role.name}-`) ? name.slice(role.name.length + 1)
      : name?.startsWith(`${scopedAgentName(project, role.name)}-`) ? name.slice(scopedAgentName(project, role.name).length + 1) : undefined;
    const inferredTask = taskSuffix && /^([0-9]{4})(?:-|$)/.exec(taskSuffix)?.[1];
    if (inferredTask) return { role, taskId: inferredTask };
    if (!role.worktree || role.name === "lead") {
      if (name === role.name || name === scopedAgentName(project, role.name) ||
        (agent.tokens?.team_role === role.name && !agent.tokens.team_task_id)) return { role };
    } else {
      if (name === role.name) return { role }; // An owned resident can remain after its launch mode changes.
      const prefix = `${role.name}-`;
      const scopedPrefix = `${scopedAgentName(project, role.name)}-`;
      const suffix = name?.startsWith(prefix) ? name.slice(prefix.length)
        : name?.startsWith(scopedPrefix) ? name.slice(scopedPrefix.length) : undefined;
      const taskId = agent.tokens?.team_role === role.name ? agent.tokens.team_task_id : undefined;
      const id = taskId ?? (suffix === undefined ? undefined : /^([0-9]{4})(?:-|$)/.exec(suffix)?.[1]);
      if (id && /^[0-9]{4}$/.test(id)) return { role, taskId: id };
    }
  }
  return null;
}

/** Input must already be project-filtered; observation may show ambiguous matches. */
export function roleAgents(project: Project, agents: AgentInfo[], role: RoleCard, taskId?: string): AgentInfo[] {
  return agents.filter((agent) => {
    const assignment = roleAssignment(project, agent);
    return assignment?.role.name === role.name && assignment.taskId === taskId;
  });
}

/** Mutations require exactly one target and never choose an ambiguous match. */
export function findRoleAgent(project: Project, agents: AgentInfo[], role: RoleCard, taskId?: string): AgentInfo | undefined {
  const matches = roleAgents(project, agents, role, taskId);
  if (matches.length > 1) throw new TeamScopeError(`Role ${role.name}${taskId ? `/${taskId}` : ""} matches multiple project agents; refusing to guess`);
  return matches[0];
}

/** Use available role names and namespace collisions without changing the displayed role. */
export function availableAgentName(project: Project, herdr: Herdr, role: RoleCard, taskId?: string): string {
  const plain = taskId === undefined ? role.name : isolatedAgentName(role.name, taskId);
  const names = new Set(herdr.agentList().map((agent) => agent.name));
  if (plain.length <= 32 && !names.has(plain)) return plain;
  const scoped = scopedAgentName(project, role.name, taskId);
  if (names.has(scoped)) throw new TeamScopeError(`Agent name ${scoped} is already taken; refusing to reuse an unverified agent`);
  return scoped;
}

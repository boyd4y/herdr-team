import { findRoot, loadProject } from "../team/project.ts";
import { findRoleAgent, projectKey, projectAgents, roleAgentLabel, roleAssignment } from "../dispatch/team-scope.ts";
import { badgeTokens, type AgentInfo, type Herdr } from "../runtime/herdr.ts";
import type { Project, RoleCard } from "../shared/types.ts";
import { rememberRoleSession, scopeForTaskSession } from "../runtime/sessions.ts";
import { deliveryFor, waitingDelivery } from "../dispatch/delivery.ts";
import { taskScoped } from "../tasks/verification.ts";

/** Keep display fields separate from the unique name used to address an agent. */
export function reportRoleSidebar(
  project: Project, herdr: Herdr, paneId: string, role: RoleCard, isolatedTaskId?: string,
  agent: AgentInfo | undefined = herdr.agentList().find((agent) => agent.pane_id === paneId),
): void {
  const tasks = project.tasks
    .filter((task) => task.role === role.name && ["doing", "review", "blocked"].includes(task.status))
    .filter((task) => !waitingDelivery(task))
    .filter((task) => {
      if (isolatedTaskId !== undefined) return task.id === isolatedTaskId;
      const deliveredPane = deliveryFor(task)?.pane_id;
      return deliveredPane ? deliveredPane === paneId : !taskScoped(task, role);
    })
    .map((task) => task.id)
    .sort();
  const badge = agent?.tokens?.team_workspace;
  const slot = badge === undefined ? -1 : Array.from({ length: 8 }, (_, slot) => slot)
    .find((slot) => agent?.tokens?.[`team_workspace_c${slot}`] !== undefined) ?? -1;
  const label = roleAgentLabel(role.name, isolatedTaskId);
  const labels = slot < 0 ? {} : badgeTokens(badge!, slot, label);
  delete labels.team_workspace; // The badge registry owns the stable number.
  const tokens = {
    ...labels,
    team_project: projectKey(project),
    team_role: role.name,
    team_session: isolatedTaskId === undefined ? "resident" : "task",
    team_task_id: isolatedTaskId ?? null,
    team_harness: role.kind,
    team_model: role.model ?? "default",
    team_task: tasks.length ? tasks.map((id) => `#${id}`).join(", ") : null,
  };
  if (agent?.display_agent === label && Object.entries(tokens).every(([key, value]) =>
    value === null ? agent.tokens?.[key] === undefined : agent.tokens?.[key] === value)) return;
  herdr.reportMetadata(paneId, "herdr-team", label, tokens);
}

/** Refresh after task changes, including clearing completed or handed-off IDs. */
export function refreshSidebar(project: Project, herdr: Herdr, sessionsOnly = false): { updated: number; failed: number } {
  const result = { updated: 0, failed: 0 };
  if (!herdr.envOk()) return result;
  try {
    const fresh = loadProject(project.root);
    const agents = projectAgents(fresh, herdr);
    for (const agent of agents) {
      if (!agent.pane_id) continue;
      const assignment = roleAssignment(fresh, agent);
      if (!assignment) continue;
      try {
        // Ambiguous role/task identities must not overwrite each other's native session ID.
        findRoleAgent(fresh, agents, assignment.role, assignment.taskId);
        const scope = assignment.taskId && agent.agent_session
          ? scopeForTaskSession(fresh, herdr, assignment.role, assignment.taskId) : undefined;
        if (!assignment.taskId || scope) rememberRoleSession(fresh, assignment.role, agent, scope);
        if (!sessionsOnly) reportRoleSidebar(fresh, herdr, agent.pane_id, assignment.role, assignment.taskId, agent);
        result.updated++;
      } catch { result.failed++; }
    }
  } catch { result.failed++; }
  return result;
}

/** One-shot session refresh for plugin hooks, independent of the caller's cwd. */
export function refreshSessionSidebar(herdr: Herdr, sessionsOnly = false): { updated: number; failed: number } {
  const result = { updated: 0, failed: 0 };
  if (!herdr.envOk()) return result;
  try {
    const roots = new Set<string>();
    for (const pane of herdr.paneList()) {
      if (!pane.cwd) continue;
      const root = findRoot(pane.cwd);
      if (root) roots.add(root);
    }
    for (const root of roots) {
      try {
        const refreshed = refreshSidebar(loadProject(root), herdr, sessionsOnly);
        result.updated += refreshed.updated;
        result.failed += refreshed.failed;
      } catch { result.failed++; }
    }
  } catch { result.failed++; }
  return result;
}

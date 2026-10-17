import { findRoot, loadProject } from "./config.ts";
import { findRoleAgent, projectKey, projectAgents, roleAssignment } from "./team-scope.ts";
import { badgeTokens, type Herdr } from "./herdr.ts";
import type { Project, RoleCard } from "./types.ts";
import { rememberRoleSession } from "./sessions.ts";
import { waitingDelivery } from "./delivery.ts";

/** Keep display fields separate from the unique name used to address an agent. */
export function reportRoleSidebar(
  project: Project, herdr: Herdr, paneId: string, role: RoleCard, isolatedTaskId?: string,
): void {
  const tasks = project.tasks
    .filter((task) => task.role === role.name && ["doing", "review", "blocked"].includes(task.status))
    .filter((task) => !waitingDelivery(task))
    .filter((task) => isolatedTaskId === undefined || task.id === isolatedTaskId)
    .map((task) => task.id)
    .sort();
  const agent = herdr.agentList().find((agent) => agent.pane_id === paneId);
  const badge = agent?.tokens?.team_workspace;
  const slot = badge === undefined ? -1 : Array.from({ length: 8 }, (_, slot) => slot)
    .find((slot) => agent?.tokens?.[`team_workspace_c${slot}`] !== undefined) ?? -1;
  const labels = slot < 0 ? {} : badgeTokens(badge!, slot, role.name);
  delete labels.team_workspace; // The badge registry owns the stable number.
  herdr.reportMetadata(paneId, "herdr-team", role.name, {
    ...labels,
    team_project: projectKey(project),
    team_role: role.name,
    team_task_id: isolatedTaskId ?? null,
    team_harness: role.kind,
    team_model: role.model ?? "default",
    team_task: tasks.length ? tasks.map((id) => `#${id}`).join(", ") : null,
  });
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
        // Ambiguous resident roles must not overwrite each other's native session ID.
        if (!assignment.role.worktree) findRoleAgent(fresh, agents, assignment.role);
        rememberRoleSession(fresh, assignment.role, agent);
        if (!sessionsOnly) reportRoleSidebar(fresh, herdr, agent.pane_id, assignment.role, assignment.taskId);
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

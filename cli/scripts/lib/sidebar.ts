import { findRoot, loadProject } from "./config.ts";
import { projectKey, projectAgents, roleAssignment } from "./team-scope.ts";
import type { Herdr } from "./herdr.ts";
import type { Project, RoleCard } from "./types.ts";

/** Keep display fields separate from the unique name used to address an agent. */
export function reportRoleSidebar(
  project: Project, herdr: Herdr, paneId: string, role: RoleCard, isolatedTaskId?: string,
): void {
  const tasks = project.tasks
    .filter((task) => task.role === role.name && ["doing", "review", "blocked"].includes(task.status))
    .filter((task) => isolatedTaskId === undefined || task.id === isolatedTaskId)
    .map((task) => task.id)
    .sort();
  herdr.reportMetadata(paneId, "herdr-team", role.name, {
    team_project: projectKey(project),
    team_role: role.name,
    team_task_id: isolatedTaskId ?? null,
    team_harness: role.kind,
    team_model: role.model ?? "default",
    team_task: tasks.length ? tasks.map((id) => `#${id}`).join(", ") : null,
  });
}

/** Refresh after task changes, including clearing completed or handed-off IDs. */
export function refreshSidebar(project: Project, herdr: Herdr): { updated: number; failed: number } {
  const result = { updated: 0, failed: 0 };
  if (!herdr.envOk()) return result;
  try {
    const fresh = loadProject(project.root);
    for (const agent of projectAgents(fresh, herdr)) {
      if (!agent.pane_id) continue;
      const assignment = roleAssignment(fresh, agent);
      if (!assignment) continue;
      try {
        reportRoleSidebar(fresh, herdr, agent.pane_id, assignment.role, assignment.taskId);
        result.updated++;
      } catch { result.failed++; }
    }
  } catch { result.failed++; }
  return result;
}

/** One-shot session refresh for plugin hooks, independent of the caller's cwd. */
export function refreshSessionSidebar(herdr: Herdr): { updated: number; failed: number } {
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
        const refreshed = refreshSidebar(loadProject(root), herdr);
        result.updated += refreshed.updated;
        result.failed += refreshed.failed;
      } catch { result.failed++; }
    }
  } catch { result.failed++; }
  return result;
}

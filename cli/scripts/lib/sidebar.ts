import { loadProject } from "./config.ts";
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
    for (const agent of herdr.agentList()) {
      if (!agent.name || !agent.pane_id) continue;
      for (const role of fresh.roles) {
        const taskId = role.worktree && agent.name.startsWith(`${role.name}-`)
          ? /^([0-9]{4})(?:-|$)/.exec(agent.name.slice(role.name.length + 1))?.[1]
          : undefined;
        if (agent.name !== role.name && taskId === undefined) continue;
        try {
          reportRoleSidebar(fresh, herdr, agent.pane_id, role, taskId);
          result.updated++;
        } catch { result.failed++; }
        break;
      }
    }
  } catch { result.failed++; }
  return result;
}

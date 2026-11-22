import { deliveryFor } from "../dispatch/delivery.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import { isTaskInactive, type Project } from "../shared/types.ts";
import { confirmedFeatures, deliveredTask } from "../team/features.ts";
import { loadProject } from "../team/project.ts";
import { logDaemon } from "./daemon-log.ts";
import type { AgentInfo, Herdr } from "./herdr.ts";
import { withTeamLock } from "./state.ts";

/** Return the panes whose later status events should wake the daemon again. */
export function closeDeliveredTuiAgents(project: Project, herdr: Herdr): string[] {
  return withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    const confirmations = confirmedFeatures(fresh);
    if (!confirmations.size) return [];
    const tasks = new Map(fresh.tasks.map(task => [task.id, task]));
    if (tasks.size !== fresh.tasks.length) throw new Error("Ambiguous task IDs");
    const owned = projectKey(fresh);
    const spaces = new Set(herdr.workspaceList().filter(space => space.tokens?.team_project === owned &&
      space.tokens.team_root === "0" && space.worktree?.is_linked_worktree).map(space => space.workspace_id));
    const activePanes = new Set(fresh.tasks.filter(task => !isTaskInactive(task)).map(task => deliveryFor(task)?.pane_id));
    const eligible = (agent: AgentInfo) => {
      const labels = agent.tokens, pane = agent.pane_id;
      if (!pane || !agent.agent || !agent.name || activePanes.has(pane) || !spaces.has(agent.workspace_id ?? "") ||
          labels?.team_project !== owned || labels.team_session !== "task") return;
      const task = tasks.get(labels.team_task_id ?? "");
      if (deliveredTask(task, labels.team_feature, labels.team_iteration, labels.team_delivery, confirmations)) return task;
    };
    const settled = (agent: AgentInfo) => agent.agent_status === "idle" || agent.agent_status === "done";
    const waiting = new Set<string>();
    for (const agent of herdr.agentList()) {
      const task = eligible(agent), pane = agent.pane_id;
      if (!task || !pane) continue;
      if (!settled(agent)) { waiting.add(pane); continue; }
      const context = { project: fresh.root, task: task.id, terminal: pane, role: agent.tokens?.team_role,
        feature: agent.tokens?.team_feature, iteration: agent.tokens?.team_iteration, state: task.status };
      try {
        const current = herdr.agentList().find(entry => entry.pane_id === pane);
        if (!current || eligible(current)?.id !== task.id || current.agent_session?.value !== agent.agent_session?.value ||
            current.name !== agent.name || current.agent !== agent.agent ||
            current.tokens?.team_delivery !== agent.tokens?.team_delivery ||
            current.tokens?.team_feature !== agent.tokens?.team_feature ||
            current.tokens?.team_iteration !== agent.tokens?.team_iteration || herdr.paneIsShell(pane)) continue;
        if (!settled(current)) { waiting.add(pane); continue; }
        herdr.paneClose(pane);
        logDaemon("task.agent_closed", context);
      } catch (error) {
        logDaemon("task.agent_close_failed", { ...context, errorType: error instanceof Error ? error.constructor.name : "Error" });
      }
    }
    return [...waiting];
  });
}

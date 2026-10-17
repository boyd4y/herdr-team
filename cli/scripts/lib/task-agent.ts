import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentInfo, Herdr } from "./herdr.ts";
import { assertProjectWorkspace, availableAgentName, bindProjectWorkspace, findRoleAgent, projectAgents } from "./team-scope.ts";
import { reportRoleSidebar } from "./sidebar.ts";
import { worktreeBranch, type Project, type RoleCard, type TaskCard } from "./types.ts";

/** Only isolated task agents are created here; resident roles are started by up. */
export function taskAgent(project: Project, herdr: Herdr, role: RoleCard, task: TaskCard): AgentInfo | undefined {
  const live = findRoleAgent(project, projectAgents(project, herdr), role, role.worktree ? task.id : undefined);
  if (live || !role.worktree) return live;
  const repoPath = join(project.root, task.repo);
  if (!existsSync(repoPath)) throw new Error(`Repository ${task.repo} does not exist`);
  const branch = worktreeBranch(task);
  const trees = herdr.worktreeList(repoPath).filter((tree) => tree.branch === branch);
  if (trees.length > 1) throw new Error(`Multiple worktrees match ${branch}; ask lead to resolve the ambiguity`);
  const existing = trees[0];
  let workspaceId: string;
  let paneId: string;
  if (existing) {
    if (!existing.open_workspace_id) throw new Error(`Worktree ${branch} exists but its workspace is closed; reopen it before dispatch`);
    workspaceId = existing.open_workspace_id;
    assertProjectWorkspace(project, herdr, workspaceId);
    const pane = herdr.paneList(workspaceId)[0];
    if (!pane) throw new Error(`Workspace for ${branch} has no pane`);
    paneId = pane.pane_id;
  } else {
    ({ workspaceId, paneId } = herdr.worktreeCreate(repoPath, branch, branch));
  }
  bindProjectWorkspace(project, herdr, workspaceId, false);
  herdr.agentStart(availableAgentName(project, herdr, role, task.id), role.kind, paneId, role.args ?? []);
  try { reportRoleSidebar(project, herdr, paneId, role, task.id); } catch { /* Presentation is best effort. */ }
  return findRoleAgent(project, projectAgents(project, herdr), role, task.id);
}

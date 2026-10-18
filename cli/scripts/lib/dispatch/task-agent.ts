import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { acceptanceFor, reviewFor, taskEnvironment, taskScoped, verifyCheckout } from "../tasks/verification.ts";
import type { AgentInfo, Herdr } from "../runtime/herdr.ts";
import { assertProjectWorkspace, availableAgentName, bindProjectWorkspace, findRoleAgent, projectAgents } from "./team-scope.ts";
import { savedResumeArgs, rememberRoleSession } from "../runtime/sessions.ts";
import { reportRoleSidebar } from "../ui/sidebar.ts";
import { worktreeBranch, type Project, type RoleCard, type TaskCard } from "../shared/types.ts";

/** Each new task owns its sessions; resident tabs are for conversation only. */
export function taskAgent(project: Project, herdr: Herdr, role: RoleCard, task: TaskCard): AgentInfo | undefined {
  const repoPath = join(project.root, task.repo);
  const offset = role.cwd === undefined ? "" : relative(repoPath, resolve(project.root, role.cwd));
  if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) throw new Error("Role cwd is outside the task repository");
  const scoped = taskScoped(task, role);
  const review = reviewFor(task), accepted = acceptanceFor(task);
  const testing = review?.reviewer === role.name && (accepted?.role !== role.name || accepted?.commit !== review?.commit);
  const live = findRoleAgent(project, projectAgents(project, herdr), role, scoped ? task.id : undefined);
  if (!scoped) return live;
  const reviewTree = testing ? herdr.worktreeList(join(project.root, task.repo)).filter((t) => t.branch === worktreeBranch(task)) : [];
  if (testing && reviewTree.length !== 1) throw new Error("Review requires the task's existing worktree");
  const expected = testing ? verifyCheckout(reviewTree[0]!.path, review!.commit) : undefined;
  if (live) {
    if (expected) {
      const cwd = live.foreground_cwd ?? live.cwd ?? herdr.paneList().find((p) => p.pane_id === live.pane_id)?.cwd;
      if (cwd !== join(expected, offset)) throw new Error("Reviewer session is outside this task worktree; reconcile it before retrying");
    }
    if (live.agent_session) {
      const trees = herdr.worktreeList(repoPath).filter((tree) => tree.branch === worktreeBranch(task));
      if (trees.length !== 1) throw new Error("Cannot identify this task checkout for session recovery");
      rememberRoleSession(project, role, live, { taskId: task.id, cwd: join(trees[0]!.path, offset) });
    }
    return live;
  }
  if (!existsSync(repoPath)) throw new Error(`Repository ${task.repo} does not exist`);
  const branch = worktreeBranch(task);
  const trees = herdr.worktreeList(repoPath).filter((tree) => tree.branch === branch);
  if (trees.length > 1) throw new Error(`Multiple worktrees match ${branch}; ask lead to resolve the ambiguity`);
  const existing = trees[0];
  let workspaceId: string;
  let paneId: string;
  let checkout: string;
  if (existing) {
    if (!existing.open_workspace_id) throw new Error(`Worktree ${branch} exists but its workspace is closed; reopen it before dispatch`);
    workspaceId = existing.open_workspace_id;
    assertProjectWorkspace(project, herdr, workspaceId);
    checkout = existing.path;
  } else {
    ({ workspaceId } = herdr.worktreeCreate(repoPath, branch, branch));
    const created = herdr.worktreeList(repoPath).filter((tree) => tree.branch === branch);
    if (created.length !== 1) throw new Error("Cannot identify the newly created task worktree; refusing to use the main checkout");
    checkout = created[0]!.path;
  }
  bindProjectWorkspace(project, herdr, workspaceId, false);
  const scope = { taskId: task.id, cwd: join(expected ?? checkout, offset) };
  const resume = savedResumeArgs(project, role, scope);
  const env = { ...role.env, ...taskEnvironment(project, task, role.name) };
  const label = `${role.name}-${task.id}`;
  const tab = herdr.tabList(workspaceId).find((t) => t.label === label);
  if (tab) {
    const panes = herdr.paneList(workspaceId).filter((p) => p.tab_id === tab.tab_id);
    if (panes.length !== 1 || !herdr.paneIsShell(panes[0]!.pane_id)) throw new Error("Task tab is occupied; refusing to replace its process");
    paneId = panes[0]!.pane_id;
  } else {
    paneId = herdr.tabCreate(workspaceId, label, join(expected ?? checkout, offset), env).paneId;
  }
  try {
    herdr.agentStart(availableAgentName(project, herdr, role, task.id), role.kind, paneId, [...(resume ?? []), ...(role.args ?? [])]);
  } catch (error) {
    if (resume) throw new Error(`Task session resume failed; inspect the saved session before retrying: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  try { reportRoleSidebar(project, herdr, paneId, role, task.id); } catch { /* Presentation is best effort. */ }
  const started = findRoleAgent(project, projectAgents(project, herdr), role, task.id);
  if (started) rememberRoleSession(project, role, started, scope);
  return started;
}

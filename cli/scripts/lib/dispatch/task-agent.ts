import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { acceptanceFor, reviewFor, taskEnvironment, taskScoped, verifyCheckout } from "../tasks/verification.ts";
import type { AgentInfo, Herdr } from "../runtime/herdr.ts";
import { assertProjectWorkspace, availableAgentName, bindProjectWorkspace, findRoleAgent, projectAgents } from "./team-scope.ts";
import { savedResumeArgs, rememberRoleSession } from "../runtime/sessions.ts";
import { reportRoleSidebar } from "../ui/sidebar.ts";
import { featureWorkspace, workspaceKey, worktreeBranch, type Project, type RoleCard, type TaskCard } from "../shared/types.ts";
import { dispatchFeature } from "../team/features.ts";
import { runtimePath } from "../runtime/state.ts";
import { outsideRoot } from "../shared/paths.ts";
import { readServiceCatalog, requiredFeatureServices } from "../team/services.ts";
import { WorkspaceProvisionError } from "./delivery.ts";

/** Each new task owns its sessions; resident tabs are for conversation only. */
export function taskAgent(project: Project, herdr: Herdr, role: RoleCard, task: TaskCard): AgentInfo | undefined {
  const repoPath = join(project.root, task.repo);
  const offset = role.cwd === undefined ? "" : relative(repoPath, resolve(project.root, role.cwd));
  if (outsideRoot(offset)) throw new Error("Role cwd is outside the task repository");
  const scoped = taskScoped(task, role);
  const feature = dispatchFeature(project, task, role);
  const shared = featureWorkspace(task);
  const review = reviewFor(task), accepted = acceptanceFor(task);
  const testing = scoped && review?.reviewer === role.name && (accepted?.role !== role.name || accepted?.commit !== review?.commit);
  const live = findRoleAgent(project, projectAgents(project, herdr), role, scoped ? task.id : undefined);
  if (!scoped && (!shared || !live)) return live;
  const reviewTree = testing ? herdr.worktreeList(join(project.root, task.repo)).filter((t) => t.branch === worktreeBranch(task)) : [];
  if (testing && reviewTree.length !== 1) throw new Error("Review requires the task's existing worktree");
  const expected = testing ? verifyCheckout(reviewTree[0]!.path, review!.commit) : undefined;
  if (scoped && live) {
    if (live.tokens?.team_feature !== feature?.feature || live.tokens?.team_iteration !== feature?.iteration) {
      throw new Error("A live task session belongs to a different feature or iteration");
    }
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
  let bootstrapPane: string | undefined;
  if (existing) {
    if (!existing.open_workspace_id) throw new Error(`Worktree ${branch} exists but its workspace is closed; reopen it before dispatch`);
    workspaceId = existing.open_workspace_id;
    assertProjectWorkspace(project, herdr, workspaceId);
    if (shared && herdr.workspaceList().find(space => space.workspace_id === workspaceId)?.tokens?.team_feature_workspace !== workspaceKey(task)) {
      throw new Error(`No feature ownership for ${branch}; keeping the existing checkout`);
    }
    checkout = existing.path;
  } else {
    if (shared) {
      let required;
      try { required = requiredFeatureServices(readServiceCatalog(project.root), shared.feature); }
      catch (error) { throw new WorkspaceProvisionError(error instanceof Error ? error.message : String(error)); }
      if (required.length) throw new WorkspaceProvisionError("Feature service ports require a local Desktop workspace");
    }
    const ownership = shared ? runtimePath(project, `tui/features/${workspaceKey(task)}.json`) : undefined;
    if (ownership && existsSync(ownership)) throw new Error(`Feature ownership for ${branch} exists without its checkout; inspect it before retrying`);
    ({ workspaceId, paneId: bootstrapPane } = herdr.worktreeCreate(repoPath, branch, branch));
    const created = herdr.worktreeList(repoPath).filter((tree) => tree.branch === branch);
    if (created.length !== 1) throw new Error("Cannot identify the newly created task worktree; refusing to use the main checkout");
    checkout = created[0]!.path;
    if (ownership) {
      mkdirSync(dirname(ownership), { recursive: true });
      writeFileSync(ownership, JSON.stringify({ repo: realpathSync(repoPath), checkout: realpathSync(checkout), branch }), { flag: "wx", mode: 0o600 });
    }
  }
  bindProjectWorkspace(project, herdr, workspaceId, false);
  if (shared) herdr.reportWorkspaceMetadata(workspaceId, { team_feature_workspace: workspaceKey(task) });
  if (!scoped) return live;
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
    const name = availableAgentName(project, herdr, role, task.id);
    herdr.agentStart(name, role.kind, paneId, [...(resume ?? []), ...(role.args ?? [])]);
  } catch (error) {
    if (resume) throw new Error(`Task session resume failed; inspect the saved session before retrying: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  try { reportRoleSidebar(project, herdr, paneId, role, task.id); } catch { /* Presentation is best effort. */ }
  if (feature) herdr.reportMetadata(paneId, "herdr-team", label, { team_feature: feature.feature, team_iteration: feature.iteration });
  if (shared && bootstrapPane && bootstrapPane !== paneId && herdr.paneIsShell(bootstrapPane)) herdr.paneClose(bootstrapPane);
  const started = findRoleAgent(project, projectAgents(project, herdr), role, task.id);
  if (started) rememberRoleSession(project, role, started, scope);
  return started;
}

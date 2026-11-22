import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { runtimePath } from "../runtime/state.ts";
import { assertProjectWorkspace } from "./team-scope.ts";
import { join } from "node:path";
import type { Herdr } from "../runtime/herdr.ts";
import { featureWorkspace, isTaskInactive, workspaceKey, worktreeBranch, type Project, type TaskCard } from "../shared/types.ts";
import { confirmedFeatures } from "../team/features.ts";
import { git } from "../tasks/verification.ts";


export type CleanupAction =
  /** 收掉了。 */
  | "removed"
  /** 本来就没有 —— 没建过，或已经收过了。 */
  | "absent"
  /** 任务还没结束。 */
  | "not-terminal"
  /** checkout 还在，但 Herdr 里已经关掉了。 */
  | "closed"
  /** Git 拒绝删 —— 多半有未提交的东西。 */
  | "dirty"
  | "foreign"
  | "retained"
  | "failed";

export interface CleanupResult {
  id: string;
  branch: string;
  action: CleanupAction;
  note: string;
}

/**
 * 按任务分支回收 worktree，不依赖交棒后当前角色的隔离配置。
 *
 * **不 force。** Git 有未提交的东西时会拒绝，这时只报出来让人决定 ——
 * 悄悄丢掉别人没提交的工作是最不该发生的事。
 */
export function releaseTaskResources(project: Project, card: TaskCard): void {
  if (!isTaskInactive(card)) return;
  const path = runtimePath(project, "resources");
  if (!existsSync(path)) return;
  for (const name of readdirSync(path)) {
    if (name.startsWith(`${card.id}-`) && name.endsWith(".json")) unlinkSync(join(path, name));
  }
}

export function cleanupTask(project: Project, herdr: Herdr, card: TaskCard): CleanupResult {
  const branch = worktreeBranch(card);
  const scope = featureWorkspace(card);
  const key = workspaceKey(card);
  const members = scope ? project.tasks.filter(task => workspaceKey(task) === key) : [card];
  const confirmation = scope ? confirmedFeatures(project).get(key) : undefined;
  if (scope && (!confirmation?.commit || members.some(task => !isTaskInactive(task) || task.meta.pending_history || !confirmation.tasks.includes(task.id)))) {
    return { id: card.id, branch, action: "retained", note: "Confirm feature delivery before reclaiming the shared checkout" };
  }

  const repoPath = join(project.root, card.repo);
  let trees;
  try {
    trees = herdr.worktreeList(repoPath);
  } catch (error) {
    return {
      id: card.id,
      branch,
      action: "failed",
      note: `Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const found = trees.find((t) => t.branch === branch);
  const ownership = scope ? runtimePath(project, `tui/features/${key}.json`) : undefined;
  if (found === undefined) {
    for (const member of members) releaseTaskResources(project, member);
    return { id: card.id, branch, action: "absent", note: `No checkout for ${branch} (not created or already removed)` };
  }

  if (found.open_workspace_id === undefined || found.open_workspace_id === null) {
    if (ownership && existsSync(ownership)) {
      try {
        const owner = JSON.parse(readFileSync(ownership, "utf8"));
        if (owner.repo !== realpathSync(repoPath) || owner.checkout !== realpathSync(found.path) || owner.branch !== branch) {
          return { id: card.id, branch, action: "foreign", note: "Feature checkout ownership changed" };
        }
        if (git(found.path, "status", "--porcelain", "--untracked-files=normal", "--ignored=matching")) {
          return { id: card.id, branch, action: "dirty", note: `Checkout has local files at ${found.path}` };
        }
        git(repoPath, "worktree", "remove", found.path);
        for (const member of members) releaseTaskResources(project, member);
        unlinkSync(ownership);
        return { id: card.id, branch, action: "removed", note: `Reclaimed feature checkout ${branch}; branch retained` };
      } catch (error) {
        return { id: card.id, branch, action: "failed", note: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      id: card.id,
      branch,
      action: "closed",
      note: `Checkout ${branch} remains at ${found.path}, but its Herdr workspace is closed; remove it manually with \`git worktree remove\``,
    };
  }

  try { assertProjectWorkspace(project, herdr, found.open_workspace_id); }
  catch (error) {
    return { id: card.id, branch, action: "foreign", note: `Cannot safely remove ${branch}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (scope) {
    const space = herdr.workspaceList().find(item => item.workspace_id === found.open_workspace_id);
    if (space?.tokens?.team_feature_workspace !== key || herdr.paneList(found.open_workspace_id).length) {
      return { id: card.id, branch, action: "retained", note: "Feature workspace has open panes or unresolved ownership" };
    }
    if (git(found.path, "status", "--porcelain", "--untracked-files=normal", "--ignored=matching")) {
      return { id: card.id, branch, action: "dirty", note: `Checkout has local files at ${found.path}` };
    }
  }

  try {
    herdr.worktreeRemove(found.open_workspace_id);
  } catch (error) {
    return {
      id: card.id,
      branch,
      action: "dirty",
      note: `Git refused to remove ${branch} (check for uncommitted changes): ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const member of members) releaseTaskResources(project, member);
  if (ownership && existsSync(ownership)) unlinkSync(ownership);
  return {
    id: card.id,
    branch,
    action: "removed",
    note: `Removed ${branch} checkout and task workspace (branch retained)`,
  };
}

/**
 * 回收一个任务，但**只在它是终态时**。
 * `handoff` 走到终态时调它。
 */
export function cleanupIfDone(project: Project, herdr: Herdr, card: TaskCard): CleanupResult {
  if (!isTaskInactive(card)) {
    return {
      id: card.id,
      branch: worktreeBranch(card),
      action: "not-terminal",
      note: `${card.id} is still ${card.status}; keeping its worktree`,
    };
  }
  return cleanupTask(project, herdr, card);
}

/** 扫一遍所有终态任务，把留下的 worktree 收掉。 */
export function cleanupAll(project: Project, herdr: Herdr): CleanupResult[] {
  return project.tasks.filter((t) => isTaskInactive(t)).map((t) => cleanupTask(project, herdr, t));
}

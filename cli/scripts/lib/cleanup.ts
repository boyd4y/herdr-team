import { assertProjectWorkspace } from "./team-scope.ts";
import { join } from "node:path";
import type { Herdr } from "./herdr.ts";
import { isTerminal, worktreeBranch, type Project, type TaskCard } from "./types.ts";


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
  | "foreign";

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
export function cleanupTask(project: Project, herdr: Herdr, card: TaskCard): CleanupResult {
  const branch = worktreeBranch(card);

  const repoPath = join(project.root, card.repo);
  let trees;
  try {
    trees = herdr.worktreeList(repoPath);
  } catch (error) {
    return {
      id: card.id,
      branch,
      action: "absent",
      note: `查不到 worktree 列表：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const found = trees.find((t) => t.branch === branch);
  if (found === undefined) {
    return { id: card.id, branch, action: "absent", note: `没有 ${branch} 的 checkout（没建过或已收）` };
  }

  if (found.open_workspace_id === undefined || found.open_workspace_id === null) {
    return {
      id: card.id,
      branch,
      action: "closed",
      note: `${branch} 的 checkout 还在 ${found.path}，但 Herdr 里已经关掉了 —— 手动 \`git worktree remove\` 收`,
    };
  }

  try { assertProjectWorkspace(project, herdr, found.open_workspace_id); }
  catch (error) {
    return { id: card.id, branch, action: "foreign", note: `${branch} 不能安全回收：${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    herdr.worktreeRemove(found.open_workspace_id);
  } catch (error) {
    return {
      id: card.id,
      branch,
      action: "dirty",
      note: `Git 拒绝删 ${branch}（多半有未提交的改动）：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    id: card.id,
    branch,
    action: "removed",
    note: `已收掉 ${branch}（分支保留，随时能合）`,
  };
}

/**
 * 回收一个任务，但**只在它是终态时**。
 * `handoff` 走到终态时调它。
 */
export function cleanupIfDone(project: Project, herdr: Herdr, card: TaskCard): CleanupResult {
  if (!isTerminal(card.status)) {
    return {
      id: card.id,
      branch: worktreeBranch(card),
      action: "not-terminal",
      note: `${card.id} 还是 ${card.status}，不动它的 worktree`,
    };
  }
  return cleanupTask(project, herdr, card);
}

/** 扫一遍所有终态任务，把留下的 worktree 收掉。 */
export function cleanupAll(project: Project, herdr: Herdr): CleanupResult[] {
  return project.tasks.filter((t) => isTerminal(t.status)).map((t) => cleanupTask(project, herdr, t));
}

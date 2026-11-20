import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, TaskCard } from "../shared/types.ts";
import { worktreeBranch } from "../shared/types.ts";
import { git, taskRepo } from "../tasks/verification.ts";
import { DesktopError, type DesktopBinding } from "./desktop.ts";
import { runtimePath } from "./state.ts";

export function desktopWorktrees(repo: string): { path: string; branch: string; locked?: true }[] {
  return git(repo, "worktree", "list", "--porcelain", "-z").split("\0\0").filter(Boolean).flatMap(record => {
    const fields = record.split("\0");
    const path = fields.find(field => field.startsWith("worktree "))?.slice(9);
    const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18);
    return path && branch ? [{ path, branch, ...(fields.some(field => field === "locked" || field.startsWith("locked ")) ? { locked: true as const } : {}) }] : [];
  });
}

interface Checkout { root: string; space: string; repo: string; branch: string; path: string }

export function inspectDesktopCheckout(project: Project, binding: DesktopBinding, task: TaskCard) {
  const repo = realpathSync(taskRepo(project, task));
  if (realpathSync(git(repo, "rev-parse", "--show-toplevel")) !== repo) throw new DesktopError("Task repo must name a Git repository root");
  const file = runtimePath(project, `desktop/tasks/${task.id}.json`);
  const branch = worktreeBranch(task);
  const path = runtimePath(project, `desktop/checkouts/${task.id}-${task.slug}`);
  const trees = desktopWorktrees(repo).filter(tree => tree.branch === branch);
  if (trees.length > 1) throw new DesktopError(`Multiple task checkouts for ${branch}; reconcile before retrying`);
  const tree = trees[0], fileStat = lstatSync(file, { throwIfNoEntry: false });
  const pathStat = lstatSync(path, { throwIfNoEntry: false });
  const expected = { root: binding.root, space: binding.space, repo, branch, path } satisfies Checkout;
  if (!fileStat) return { owner: false, pathExists: Boolean(pathStat), file, expected, tree };
  if (!fileStat.isFile()) throw new DesktopError("Task checkout ownership file is not a regular file");
  const record = JSON.parse(readFileSync(file, "utf8")) as Checkout;
  if (!record || !Object.entries(expected).every(([key, value]) => record[key as keyof Checkout] === value) ||
      (tree ? !pathStat?.isDirectory() || realpathSync(tree.path) !== realpathSync(path) : pathStat)) {
    throw new DesktopError("Task checkout ownership changed or creation was interrupted; inspect it before retrying");
  }
  return { owner: true, pathExists: Boolean(pathStat), file, expected, tree };
}

/** Explicit ownership is reserved before Git creates a checkout; a branch name never grants ownership. */
export function checkoutFor(project: Project, binding: DesktopBinding, task: TaskCard, create = true): string {
  const { file, owner, expected, pathExists, tree } = inspectDesktopCheckout(project, binding, task);
  const { path, branch, repo } = expected;
  if (owner) {
    if (!tree) throw new DesktopError("Task checkout ownership changed or creation was interrupted; inspect it before retrying");
    return realpathSync(path);
  }
  if (!create) throw new DesktopError(`No owned Desktop checkout for task ${task.id}; no worktree was created`);
  if (tree || git(repo, "branch", "--list", branch)) throw new DesktopError(`Branch ${branch} already exists without Desktop task ownership; refusing to adopt it`);
  if (pathExists) throw new DesktopError(`Task checkout path already exists: ${path}`);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(file, JSON.stringify(expected), { flag: "wx", mode: 0o600 });
  git(repo, "worktree", "add", "-b", branch, path);
  return realpathSync(path);
}

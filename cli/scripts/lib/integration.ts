import { spawnSync } from "node:child_process";
import { loadProject } from "./config.ts";
import { acceptanceFor, commitId, git, integrationFor, taskRepo } from "./execution.ts";
import { withTeamLock } from "./runtime.ts";
import { commitTaskTransition } from "./queue.ts";
import { findTask, TaskError } from "./task.ts";
import { worktreeBranch, type Project } from "./types.ts";
import { assertPullRequest, prDecisionFor, pullRequestFor, realGitHub, testResultFor, usesPullRequest, type GitHub } from "./pull-request.ts";
import { stepRole } from "./workflow.ts";

export function mergeRows(project: Project) {
  return project.tasks.flatMap((task) => {
    const item = integrationFor(task);
    return item && item.state !== "done" ? [{ id: task.id, ...item }] : [];
  }).sort((a, b) => (a.queued_at ?? "").localeCompare(b.queued_at ?? "") || a.id.localeCompare(b.id));
}

/** Only integration and its optional local migration share this long-lived lock. */
export function mergeTask(project: Project, id?: string, migrate?: string, github: GitHub = realGitHub()): { id: string; commit: string; state: string } {
  return withTeamLock(project, "integration", () => {
    let fresh = loadProject(project.root);
    if (fresh.tasks.some((t) => integrationFor(t)?.state === "running")) {
      throw new TaskError("A previous integration needs reconciliation; inspect it before merge retry");
    }
    const task = id ? findTask(fresh, id) : fresh.tasks.filter((t) => integrationFor(t)?.state === "queued").sort((a, b) => (integrationFor(a)?.queued_at ?? "").localeCompare(integrationFor(b)?.queued_at ?? "") || a.id.localeCompare(b.id))[0];
    if (!task) throw new TaskError("No accepted tasks are queued for merge");
    const item = integrationFor(task), accepted = acceptanceFor(task);
    if (item?.state !== "queued" || !accepted || accepted.commit !== item.commit) throw new TaskError("Task is not queued with an accepted commit");
    const repo = taskRepo(fresh, task);
    const prFlow = usesPullRequest(task), pr = pullRequestFor(task);
    if (prFlow) {
      const tested = testResultFor(task), decision = prDecisionFor(task);
      if (!pr || !tested || tested.role !== stepRole(task, "test") || tested.commit !== item.commit || !decision || decision.state !== "approved" || decision.commit !== item.commit ||
          accepted.role !== stepRole(task, "review") || decision.role !== accepted.role) throw new TaskError("PR merge requires matching test results and PR review approval");
      assertPullRequest(pr, github.get(pr));
    }
    const branch = git(repo, "branch", "--show-current");
    if (prFlow ? branch !== pr!.base : !["main", "master"].includes(branch)) throw new TaskError("Run integration from the PR base branch or main/master checkout");
    if (git(repo, "status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude).herdr")) {
      throw new TaskError("Main checkout has changes outside .herdr; commit or stash them before integrating");
    }
    const transition = (state: "running" | "blocked" | "done", reason?: string) => withTeamLock(project, "queue", () => {
      fresh = loadProject(project.root);
      const current = findTask(fresh, task.id);
      if (integrationFor(current)?.commit !== item.commit) throw new TaskError("Integration changed while running; reconcile it before continuing");
      commitTaskTransition(fresh, current, {
        integration: { ...item, commit: item.commit, state, ...(reason ? { reason } : {}) },
        ...(state === "done" ? { status: "done" } : {}),
      }, `- Integration ${state}: ${item.commit}${reason ? ` (${reason})` : ""}`);
    });
    // Compare the branch tip, not a moving working-tree snapshot or a prose claim.
    if (git(repo, "rev-parse", `refs/heads/${worktreeBranch(task)}`) !== item.commit) {
      transition("blocked", "Branch advanced after acceptance; submit the new commit for review");
      throw new TaskError("Branch advanced after acceptance; a new review is required");
    }
    transition("running");
    try {
      if (prFlow) {
        const merged = github.merge(pr!);
        assertPullRequest(pr!, merged);
        if (merged.state !== "MERGED" || !merged.mergeCommit) throw new TaskError("PR merge is not confirmed by GitHub");
        git(repo, "fetch", "origin", `refs/heads/${pr!.base}:refs/remotes/origin/${pr!.base}`);
        git(repo, "merge-base", "--is-ancestor", merged.mergeCommit, `refs/remotes/origin/${pr!.base}`);
        git(repo, "merge", "--ff-only", `refs/remotes/origin/${pr!.base}`);
      } else git(repo, "merge", "--no-ff", "--no-edit", item.commit);
      if (migrate !== undefined) {
        if (!migrate.trim()) throw new TaskError("Migration command cannot be empty");
        const run = spawnSync(process.env.SHELL || "/bin/sh", ["-c", migrate], {
          cwd: repo, encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
        });
        if (run.error || run.status !== 0) throw new TaskError(`Local migration failed: ${run.error?.message ?? (run.stderr || run.stdout).trim()}`);
      }
      transition("done");
      return { id: task.id, commit: item.commit, state: "done" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      transition("blocked", reason);
      // Leave conflicts/migration effects for inspection. Never abort or rerun blindly.
      throw error;
    }
  });
}

/** Explicit reconciliation only; restarting Console never retries integrations. */
export function retryMerge(project: Project, id: string): void {
  withTeamLock(project, "integration", () => withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root), task = findTask(fresh, id), item = integrationFor(task);
    if (!item || !["blocked", "running"].includes(item.state)) throw new TaskError("Only blocked or interrupted integrations can be retried");
    if (commitId(fresh, task, item.commit) !== acceptanceFor(task)?.commit) throw new TaskError("No matching acceptance");
    commitTaskTransition(fresh, task, { integration: { commit: item.commit, state: "queued", queued_at: new Date().toISOString() } }, "- Integration explicitly requeued after reconciliation");
  }));
}

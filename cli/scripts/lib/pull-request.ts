import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, taskRepo } from "./execution.ts";
import { worktreeBranch, type Project, type TaskCard } from "./types.ts";
import { stepRole, taskWorkflow } from "./workflow.ts";

export interface PullRequest {
  repository: string; number: number; url: string; base: string; head: string; commit: string;
}
export interface PullRequestState extends PullRequest {
  state: "OPEN" | "CLOSED" | "MERGED"; draft: boolean; author: string;
  reviewDecision?: string; mergeCommit?: string;
}
export interface TestResult { commit: string; role: string; summary: string }
export interface PullRequestDecision { commit: string; role: string; state: "approved" | "changes_requested"; mode: "comment" | "review" }

export function usesPullRequest(task: TaskCard): boolean { return taskWorkflow(task)?.delivery === "pull-request"; }
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export function pullRequestFor(task: Pick<TaskCard, "meta">): PullRequest | undefined {
  const value = task.meta.pull_request;
  if (value == null) return;
  const pr = value as PullRequest;
  if (!pr || typeof pr !== "object" || !/^[\w.-]+\/[\w.-]+$/.test(pr.repository) ||
      !Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.url !== "string" ||
      pr.url !== `https://github.com/${pr.repository}/pull/${pr.number}` ||
      typeof pr.base !== "string" || !pr.base || typeof pr.head !== "string" || !pr.head || !SHA.test(pr.commit)) {
    throw new Error("Invalid pull request record");
  }
  return pr;
}
export function testResultFor(task: TaskCard): TestResult | undefined {
  const value = task.meta.test_result;
  if (value == null) return;
  const result = value as TestResult;
  if (!result || !SHA.test(result.commit) || typeof result.role !== "string" || !result.role ||
      typeof result.summary !== "string" || !result.summary.trim()) throw new Error("Invalid test result");
  return result;
}
export function prDecisionFor(task: TaskCard): PullRequestDecision | undefined {
  const value = task.meta.pr_decision;
  if (value == null) return;
  const result = value as PullRequestDecision;
  if (!result || !SHA.test(result.commit) || typeof result.role !== "string" || !result.role || result.role !== stepRole(task, "review") ||
      !["approved", "changes_requested"].includes(result.state) || !["comment", "review"].includes(result.mode)) {
    throw new Error("Invalid PR review decision");
  }
  return result;
}

/** Remote operations are replaceable in offline tests; production always uses gh. */
export interface GitHub {
  repository(cwd: string): { name: string; base: string };
  find(repository: string, head: string): PullRequestState | undefined;
  create(repository: string, head: string, base: string, title: string, body: string): PullRequestState;
  get(pr: PullRequest): PullRequestState;
  push(cwd: string, repository: string, branch: string, commit: string): void;
  decide(pr: PullRequest, decision: "approved" | "changes_requested", body: string, operation: string): "comment" | "review";
  merge(pr: PullRequest): PullRequestState;
}

function gh(args: string[], cwd?: string): string {
  const run = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" } });
  if (run.error || run.status !== 0) throw new Error(`GitHub operation failed: ${run.error?.message ?? (run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
}
function withBody<T>(body: string, action: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "herdr-team-pr-"));
  try { const file = join(dir, "body.md"); writeFileSync(file, body, { mode: 0o600 }); return action(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const FIELDS = "number,url,state,isDraft,baseRefName,headRefName,headRefOid,author,reviewDecision,mergeCommit";
function decode(repository: string, data: any): PullRequestState {
  const pr = { repository, number: data.number, url: data.url, base: data.baseRefName, head: data.headRefName,
    commit: data.headRefOid, state: data.state, draft: data.isDraft, author: data.author?.login,
    reviewDecision: data.reviewDecision, mergeCommit: data.mergeCommit?.oid };
  pullRequestFor({ meta: { pull_request: pr } });
  if (!["OPEN", "CLOSED", "MERGED"].includes(pr.state) || typeof pr.draft !== "boolean" || typeof pr.author !== "string") {
    throw new Error("Invalid GitHub PR response");
  }
  return pr as PullRequestState;
}
export function realGitHub(): GitHub {
  const read = (pr: Pick<PullRequest, "repository" | "number">) => decode(pr.repository,
    JSON.parse(gh(["pr", "view", String(pr.number), "--repo", pr.repository, "--json", FIELDS])));
  return {
    repository(cwd) {
      const data = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], cwd));
      if (typeof data.nameWithOwner !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(data.nameWithOwner) ||
          typeof data.defaultBranchRef?.name !== "string" || !data.defaultBranchRef.name) throw new Error("Cannot identify the GitHub repository and base branch");
      return { name: data.nameWithOwner, base: data.defaultBranchRef.name };
    },
    find(repository, head) {
      const items = JSON.parse(gh(["pr", "list", "--repo", repository, "--head", head, "--state", "all", "--limit", "100", "--json", FIELDS]));
      if (!Array.isArray(items) || items.length > 1) throw new Error("Multiple PRs match the task branch; reconcile them before retrying");
      return items[0] ? decode(repository, items[0]) : undefined;
    },
    create(repository, head, base, title, body) {
      const url = withBody(body, (file) => gh(["pr", "create", "--repo", repository, "--head", head, "--base", base, "--title", title, "--body-file", file]));
      const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
      if (!number) throw new Error("PR creation returned an unexpected URL; inspect GitHub before retrying");
      return read({ repository, number });
    },
    get: read,
    push(cwd, repository, branch, commit) {
      const origin = git(cwd, "remote", "get-url", "origin");
      const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)\/?$/.exec(origin);
      if (!match || match[1]!.replace(/\.git$/, "") !== repository) throw new Error("Git origin does not match the GitHub PR repository");
      git(cwd, "push", "origin", `${commit}:refs/heads/${branch}`);
    },
    decide(pr, decision, body, operation) {
      const state = read(pr); assertPullRequest(pr, state, true);
      const login = gh(["api", "user", "--jq", ".login"]);
      const mode = login.toLowerCase() === state.author.toLowerCase() ? "comment" : "review";
      const event = decision === "approved" ? "APPROVE" : "REQUEST_CHANGES";
      const marker = `<!-- herdr-team-pr:${operation}:${pr.commit}:${decision} -->`;
      const endpoint = mode === "comment" ? `repos/${pr.repository}/issues/${pr.number}/comments` : `repos/${pr.repository}/pulls/${pr.number}/reviews`;
      const pages = JSON.parse(gh(["api", endpoint, "--paginate", "--slurp"]));
      if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Invalid GitHub review history");
      if (!pages.flat().some((item: any) => item.user?.login?.toLowerCase() === login.toLowerCase() && item.body?.includes(marker) &&
        (mode === "comment" || item.commit_id === pr.commit && item.state === (decision === "approved" ? "APPROVED" : "CHANGES_REQUESTED")))) {
        const text = `Herdr Team review: ${decision}\n\nCommit: ${pr.commit}\n\n${body}\n\n${mode === "comment" ? "This is a Team decision recorded as a comment because the authenticated account authored the PR; it is not an independent GitHub approval.\n\n" : ""}${marker}`;
        withBody(text, (file) => gh(["api", endpoint, "--method", "POST", "-F", `body=@${file}`,
          ...(mode === "review" ? ["-f", `event=${event}`, "-f", `commit_id=${pr.commit}`] : [])]));
      }
      // A concurrent push invalidates the decision, even if its comment was already sent.
      assertPullRequest(pr, read(pr), true);
      return mode;
    },
    merge(pr) {
      let current = read(pr); assertPullRequest(pr, current);
      if (current.state !== "MERGED") {
        if (current.state !== "OPEN" || current.draft || current.reviewDecision === "CHANGES_REQUESTED") throw new Error("PR is closed, draft, or has outstanding requested changes");
        const result = JSON.parse(gh(["api", `repos/${pr.repository}/pulls/${pr.number}/merge`, "--method", "PUT",
          "-f", `sha=${pr.commit}`, "-f", "merge_method=merge"]));
        if (result.merged !== true) throw new Error("GitHub did not confirm PR merge; inspect its checks before retrying");
        current = read(pr); assertPullRequest(pr, current);
      }
      if (current.state !== "MERGED" || !current.mergeCommit) throw new Error("GitHub has not merged this PR; reconcile checks or its merge queue before retrying");
      return current;
    },
  };
}
export function assertPullRequest(expected: PullRequest, current: PullRequestState, open = false): void {
  if (current.repository !== expected.repository || current.number !== expected.number || current.url !== expected.url ||
      current.base !== expected.base || current.head !== expected.head || current.commit !== expected.commit) {
    throw new Error("PR identity or head changed; retest and review the new commit");
  }
  if (open && (current.state !== "OPEN" || current.draft)) throw new Error("PR must be open and ready for review");
}

export function publishTestedPullRequest(project: Project, task: TaskCard, commit: string, summary: string, github: GitHub): PullRequest {
  const repo = taskRepo(project, task), branch = worktreeBranch(task);
  const target = github.repository(repo), previous = pullRequestFor(task);
  if (previous && (previous.repository !== target.name || previous.base !== target.base || previous.head !== branch)) throw new Error("Task PR target changed; reconcile it before publishing");
  if (git(repo, "rev-parse", `refs/heads/${branch}`) !== commit) throw new Error("Task branch advanced after testing; retest its current commit");
  const existing = previous ? github.get(previous) : github.find(target.name, branch);
  if (existing && (existing.state !== "OPEN" || existing.draft || existing.head !== branch || existing.base !== target.base)) throw new Error("Existing task PR is closed, merged, draft, or targets another branch; reconcile it before retrying");
  github.push(repo, target.name, branch, commit);
  const body = `Task #${task.id}: ${task.title}\n\nTested commit: ${commit}\n\nTest results\n\n${summary}\n\n<!-- herdr-team-task:${task.id} -->`;
  const remote = existing ? github.get(existing) : github.create(target.name, branch, target.base, task.title, body);
  const record: PullRequest = { repository: target.name, number: remote.number, url: remote.url, base: target.base, head: branch, commit };
  assertPullRequest(record, remote, true);
  return record;
}

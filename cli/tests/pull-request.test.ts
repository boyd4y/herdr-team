import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { loadProject } from "../scripts/lib/team/project.ts";
import { acceptanceFor, git, integrationFor } from "../scripts/lib/tasks/verification.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { dispatch } from "../scripts/lib/dispatch/launch.ts";
import { mergeTask } from "../scripts/lib/integration/merge.ts";
import { createTask, writeTaskMeta } from "../scripts/lib/tasks/cards.ts";
import { runtimePath } from "../scripts/lib/runtime/state.ts";
import { prDecisionFor, pullRequestFor, testResultFor, type GitHub, type PullRequestState } from "../scripts/lib/integration/pull-request.ts";
import { worktreeBranch } from "../scripts/lib/shared/types.ts";
import { claimCurrent, fakeHerdr, makeProject, roleMeta, writeRole } from "./helpers.ts";

function setup() {
  const p = makeProject(), root = p.root;
  for (const role of ["builder", "qa", "auditor", "lead"]) writeRole(root, role, roleMeta());
  git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".herdr/\n"); writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", "."); git(root, "commit", "-m", "base");
  const remote = join(root, "..", "remote.git");
  git(root, "init", "--bare", remote); git(root, "remote", "add", "origin", remote); git(root, "push", "origin", "main");
  const h = fakeHerdr(), originalCreate = h.worktreeCreate, originalList = h.worktreeList;
  const paths = new Map<string, string>();
  h.worktreeCreate = (repo, branch, label) => {
    const created = originalCreate(repo, branch, label), path = join(root, "..", label.replaceAll("/", "-"));
    git(repo, "worktree", "add", "-b", branch, path, "main"); paths.set(branch, path);
    h.state.panes.find((pane) => pane.pane_id === created.paneId)!.cwd = path;
    return created;
  };
  h.worktreeList = (repo) => originalList(repo).map((tree) => ({ ...tree, path: paths.get(tree.branch)! }));
  const load = () => loadProject(root), task = () => load().tasks[0]!;
  const events: string[] = [];
  let remotePR: PullRequestState | undefined, created = 0;
  const get = () => {
    if (!remotePR) throw new Error("PR missing");
    return { ...remotePR, commit: git(root, "ls-remote", "origin", `refs/heads/${remotePR.head}`).split(/\s/)[0]! };
  };
  const github: GitHub & { push(cwd: string, repository: string, branch: string, sha: string): void; create(repository: string, head: string, base: string, title: string, body: string): PullRequestState } = {
    repository: () => ({ name: "owner/project", base: "main" }),
    get,
    push(cwd, repository, branch, sha) { expect(repository).toBe("owner/project"); events.push(`push:${sha}`); git(cwd, "push", "origin", `${sha}:refs/heads/${branch}`); },
    create(repository, head, base) {
      created++; events.push("create");
      remotePR = { repository, number: 1, url: "https://github.com/owner/project/pull/1", head, base,
        commit: git(root, "ls-remote", "origin", `refs/heads/${head}`).split(/\s/)[0]!, state: "OPEN", draft: false, author: "owner" };
      return get();
    },
    decide(pr, decision) { expect(get().commit).toBe(pr.commit); events.push(decision); return "comment"; },
    merge(pr) {
      expect(get().commit).toBe(pr.commit); events.push("merge");
      git(root, "push", "origin", `${pr.commit}:refs/heads/main`);
      remotePR = { ...get(), state: "MERGED", mergeCommit: pr.commit };
      return get();
    },
  };
  createTask(load(), { title: "Implement change", role: "builder", handoff: ["qa", "auditor"], priority: "P2", body: "Acceptance criteria" });
  const commit = () => {
    const tree = paths.get(worktreeBranch(task()))!;
    writeFileSync(join(tree, "file.txt"), `${Math.random()}\n`); git(tree, "add", "."); git(tree, "commit", "-m", "Implement change");
    return git(tree, "rev-parse", "HEAD");
  };
  const submit = () => {
    dispatch(load(), h, task().id); const delivery = claimCurrent(root), sha = commit();
    handoff(load(), h, task().id, new Date(), { delivery, commit: sha, summary: "Ready for tests", github });
    return { sha, delivery: claimCurrent(root) };
  };
  const pass = () => {
    const submitted = submit();
    handoff(load(), h, task().id, new Date(), { delivery: submitted.delivery, accept: submitted.sha, summary: "Tests passed", github });
    return { ...submitted, delivery: claimCurrent(root) };
  };
  return { ...p, h, github, load, task, submit, pass, commit, paths, events, created: () => created };
}
test("new tasks attach an explicit PR, record approval, and merge only on request", () => {
  const f = setup();
  try {
    const { sha, delivery } = f.submit();
    expect(f.task().meta.workflow).toBeUndefined();
    expect(f.events).toEqual([]);
    const head = worktreeBranch(f.task());
    f.github.push(f.root, "owner/project", head, sha);
    const pr = f.github.create("owner/project", head, "main", "Change", "Tests passed");
    handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, pr: pr.url, summary: "Targeted tests passed", github: f.github });
    expect(f.events).toEqual([`push:${sha}`, "create"]);
    expect(testResultFor(f.task())).toMatchObject({ commit: sha, role: "qa" });
    expect(f.task().role).toBe("auditor");
    expect(() => mergeTask(f.load(), "0001", undefined, f.github)).toThrow(/not queued/);
    const approved = handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), accept: sha, summary: "Approved", github: f.github });
    expect(approved.queueState).toBe("merge-queued");
    expect(f.events).toEqual([`push:${sha}`, "create", "approved"]);
    expect(f.task().status).toBe("review");
    expect(mergeTask(f.load(), "0001", undefined, f.github).state).toBe("done");
    expect(f.events.at(-1)).toBe("merge");
  } finally { f.cleanup(); }
});

test("an explicit chain repeats all completed validation owners after rejection without a workflow", () => {
  const f = setup();
  try {
    const first = f.pass();
    expect(f.events).toEqual([]);
    expect(f.task().meta.review).toMatchObject({ reviewer: "auditor", reviewers: ["qa", "auditor"] });
    handoff(f.load(), f.h, "0001", new Date(), { delivery: first.delivery, reject: true, summary: "Fix edge case", github: f.github });
    expect(f.task().role).toBe("builder"); expect(f.task().handoff).toEqual(["qa", "auditor"]);
    const sha = f.commit();
    handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), commit: sha, summary: "Fixed", github: f.github });
    handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), accept: sha, summary: "Retested", github: f.github });
    handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), accept: sha, summary: "Reviewed", github: f.github });
    expect(acceptanceFor(f.task())).toEqual({ commit: sha, role: "auditor" });
    expect(integrationFor(f.task())?.commit).toBe(sha); expect(f.events).toEqual([]);
  } finally { f.cleanup(); }
});

test("attaching an unrelated, draft or changed PR leaves the claimed delivery unchanged", () => {
  const f = setup();
  try {
    const { sha, delivery } = f.submit(), head = worktreeBranch(f.task());
    f.github.push(f.root, "owner/project", head, sha);
    const pr = f.github.create("owner/project", head, "main", "Change", "Test results");
    const before = JSON.stringify(f.task().meta);
    for (const url of ["not-a-url", "https://github.com/other/project/pull/1"]) {
      expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, pr: url, summary: "Tested", github: f.github })).toThrow();
      expect(JSON.stringify(f.task().meta)).toBe(before);
    }
    for (const patch of [{ draft: true }, { head: "other" }, { base: "other" }, { commit: "a".repeat(40) }]) {
      const github = { ...f.github, get: () => ({ ...pr, ...patch }) };
      expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, pr: pr.url, summary: "Tested", github })).toThrow();
      expect(JSON.stringify(f.task().meta)).toBe(before);
    }
    expect(f.events).toEqual([`push:${sha}`, "create"]);
  } finally { f.cleanup(); }
});

test("new PR rejection repeats validation, retains the PR, and never reuses an old approval", () => {
  const f = setup();
  try {
    const first = f.submit(), head = worktreeBranch(f.task());
    f.github.push(f.root, "owner/project", head, first.sha);
    const pr = f.github.create("owner/project", head, "main", "Change", "Initial validation");
    handoff(f.load(), f.h, "0001", new Date(), { delivery: first.delivery, accept: first.sha, pr: pr.url, summary: "Tested", github: f.github });
    handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), reject: true, summary: "Fix edge case", github: f.github });
    expect(f.task().handoff).toEqual(["qa", "auditor"]);
    expect(testResultFor(f.task())).toBeUndefined(); expect(acceptanceFor(f.task())).toBeUndefined();
    const sha = f.commit();
    handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), commit: sha, summary: "Fixed", github: f.github });
    const delivery = claimCurrent(f.root);
    expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Retested", github: f.github })).toThrow(/--pr/);
    f.github.push(f.root, "owner/project", head, sha);
    handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, pr: pr.url, summary: "Retested", github: f.github });
    const reviewDelivery = claimCurrent(f.root);
    handoff(f.load(), f.h, "0001", new Date(), { delivery: reviewDelivery, accept: sha, summary: "Approved fix", github: f.github });
    const duplicate = handoff(f.load(), f.h, "0001", new Date(), { delivery: reviewDelivery, accept: sha, summary: "Duplicate", github: f.github });
    expect(duplicate.duplicate).toBe(true);
    expect(f.created()).toBe(1); expect(f.events).not.toContain("merge");
    expect(f.events.filter((event) => event === "approved")).toHaveLength(1);
    expect(prDecisionFor(f.task())).toMatchObject({ commit: sha, state: "approved" });
    const advanced = f.commit(); f.github.push(f.root, "owner/project", head, advanced);
    expect(() => mergeTask(f.load(), "0001", undefined, f.github)).toThrow(/changed|advanced/);
    expect(f.events).not.toContain("merge");
  } finally { f.cleanup(); }
});

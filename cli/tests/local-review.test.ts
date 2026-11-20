import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { acceptanceFor, git, integrationFor, reviewFor } from "../scripts/lib/tasks/verification.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { mergeTask } from "../scripts/lib/integration/merge.ts";
import { dispatch } from "../scripts/lib/dispatch/launch.ts";
import { testResultFor } from "../scripts/lib/integration/pull-request.ts";
import { createTask, writeTaskMeta } from "../scripts/lib/tasks/cards.ts";
import { taskAgent } from "../scripts/lib/dispatch/task-agent.ts";
import { claimCurrent, fakeHerdr, makeProject, roleMeta, writeRole } from "./helpers.ts";

function setup() {
  const p = makeProject(), root = p.root;
  for (const role of ["builder", "qa", "auditor"]) writeRole(root, role, roleMeta());
  git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".herdr/\n"); writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", "."); git(root, "commit", "-m", "base");
  const h = fakeHerdr(), create = h.worktreeCreate, list = h.worktreeList;
  const tree = join(root, "..", "task-checkout");
  h.worktreeCreate = (repo, branch, label) => {
    const created = create(repo, branch, label);
    git(repo, "worktree", "add", "-b", branch, tree, "main");
    h.state.panes.find((pane) => pane.pane_id === created.paneId)!.cwd = tree;
    return created;
  };
  h.worktreeList = (repo) => list(repo).map((entry) => ({ ...entry, path: tree }));
  const load = () => loadProject(root), task = () => load().tasks[0]!;
  createTask(load(), { title: "Local reviewed change", role: "builder", handoff: ["qa", "auditor"], priority: "P2", body: "Acceptance criteria" });
  let version = 0;
  const commit = () => {
    writeFileSync(join(tree, "file.txt"), `version ${++version}\n`); git(tree, "add", "."); git(tree, "commit", "-m", `Version ${version}`);
    return git(tree, "rev-parse", "HEAD");
  };
  const submit = () => {
    dispatch(load(), h, "0001"); const delivery = claimCurrent(root), sha = commit();
    handoff(load(), h, "0001", new Date(), { delivery, commit: sha, summary: "Ready for testing" });
    return { sha, delivery: claimCurrent(root) };
  };
  const pass = () => {
    const submitted = submit();
    handoff(load(), h, "0001", new Date(), { delivery: submitted.delivery, accept: submitted.sha, summary: "Tests passed" });
    return { ...submitted, delivery: claimCurrent(root) };
  };
  return { ...p, h, tree, load, task, submit, pass, commit };
}
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup(); try { run(f); } finally { f.cleanup(); }
}

test("local test approval assigns the same commit to review without granting merge permission", () => fixture((f) => {
  const { sha, delivery } = f.pass();
  expect(f.task().role).toBe("auditor");
  expect(reviewFor(f.task())).toMatchObject({ commit: sha, developer: "builder", reviewer: "auditor" });
  expect(testResultFor(f.task())).toMatchObject({ commit: sha, role: "qa", summary: "Tests passed" });
  expect(acceptanceFor(f.task())).toBeUndefined(); expect(integrationFor(f.task())).toBeUndefined();
  expect(() => mergeTask(f.load(), "0001")).toThrow(/not queued/);
  expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, summary: "Skip approval" })).toThrow(/--accept/);
  const result = handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Independently reviewed" });
  expect(result.queueState).toBe("merge-queued");
  expect(acceptanceFor(f.task())).toEqual({ commit: sha, role: "auditor" });
  expect(mergeTask(f.load(), "0001").state).toBe("done");
  expect(f.h.calls.filter((call) => call.startsWith("worktree create"))).toHaveLength(1);
}));

test("local review rejection returns to development and repeats test and review on the new SHA", () => fixture((f) => {
  const first = f.pass();
  handoff(f.load(), f.h, "0001", new Date(), { delivery: first.delivery, reject: true, summary: "Fix boundary case" });
  expect(f.task().role).toBe("builder"); expect(f.task().handoff).toEqual(["qa", "auditor"]);
  expect(acceptanceFor(f.task())).toBeUndefined(); expect(testResultFor(f.task())).toBeUndefined();
  const delivery = claimCurrent(f.root), sha = f.commit(); expect(sha).not.toBe(first.sha);
  handoff(f.load(), f.h, "0001", new Date(), { delivery, commit: sha, summary: "Fixed" });
  handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), accept: sha, summary: "Retested" });
  const reviewDelivery = claimCurrent(f.root);
  expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery: reviewDelivery, accept: first.sha, summary: "Stale approval" })).toThrow(/exact commit/);
  handoff(f.load(), f.h, "0001", new Date(), { delivery: reviewDelivery, accept: sha, summary: "Reviewed fix" });
  expect(integrationFor(f.task())).toMatchObject({ commit: sha, state: "queued" });
}));

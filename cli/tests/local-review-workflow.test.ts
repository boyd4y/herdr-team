import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { acceptanceFor, assignedReviewFor, git, integrationFor, reviewFor } from "../scripts/lib/execution.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { mergeTask } from "../scripts/lib/integration.ts";
import { dispatch } from "../scripts/lib/launch.ts";
import { testResultFor } from "../scripts/lib/pull-request.ts";
import { createTask, writeTaskMeta } from "../scripts/lib/task.ts";
import { taskAgent } from "../scripts/lib/task-agent.ts";
import { parseWorkflow } from "../scripts/lib/legacy-workflow.ts";
import { claimCurrent, fakeHerdr, makeProject, roleMeta, writeRole } from "./helpers.ts";

function setup() {
  const p = makeProject(), root = p.root;
  const workflow = parseWorkflow({ name: "local-review", delivery: "local", merge: "manual",
    steps: [{ kind: "develop", role: "builder" }, { kind: "test", role: "qa" }, { kind: "review", role: "auditor" }] });
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
  writeTaskMeta(load(), task(), { workflow });
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
  const legacy = () => {
    const passed = pass();
    writeTaskMeta(load(), task(), { review: { commit: passed.sha, developer: "builder", reviewer: "qa" },
      acceptance: { commit: passed.sha, role: "qa" }, test_result: null });
    return passed;
  };
  return { ...p, h, tree, load, task, submit, pass, legacy, commit };
}
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup(); try { run(f); } finally { f.cleanup(); }
}

test("local test approval assigns the same commit to review without granting merge permission", () => fixture((f) => {
  const { sha, delivery } = f.pass();
  expect(f.task().role).toBe("auditor");
  expect(reviewFor(f.task())).toEqual({ commit: sha, developer: "builder", reviewer: "auditor" });
  expect(testResultFor(f.task())).toMatchObject({ commit: sha, role: "qa", summary: "Tests passed" });
  expect(acceptanceFor(f.task())).toBeUndefined(); expect(integrationFor(f.task())).toBeUndefined();
  expect(() => mergeTask(f.load(), "0001")).toThrow(/not queued/);
  expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, summary: "Skip approval" })).toThrow(/--accept/);
  const result = handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Independently reviewed" });
  expect(result.queueState).toBe("merge-queued"); expect(result.automaticMerge).toBeUndefined();
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

test("already-issued local review deliveries recover the prior stage record without changing the delivery ID", () => fixture((f) => {
  const { sha, delivery } = f.legacy();
  handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Recovered independent review" });
  expect(reviewFor(f.task())).toEqual({ commit: sha, developer: "builder", reviewer: "auditor" });
  expect(acceptanceFor(f.task())).toEqual({ commit: sha, role: "auditor" });
  expect(integrationFor(f.task())).toMatchObject({ commit: sha, state: "queued" });
  expect(handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha }).duplicate).toBe(true);
}));

test("legacy test approval cannot bypass the pending independent local review", () => fixture((f) => {
  const { delivery } = f.legacy(), before = JSON.stringify(f.task().meta);
  expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, summary: "No new approval" })).toThrow(/--accept/);
  expect(JSON.stringify(f.task().meta)).toBe(before); expect(integrationFor(f.task())).toBeUndefined();
}));

test("legacy local review can reject and must repeat testing", () => fixture((f) => {
  const { delivery } = f.legacy();
  handoff(f.load(), f.h, "0001", new Date(), { delivery, reject: true, summary: "Needs a fix" });
  expect(f.task().role).toBe("builder"); expect(f.task().handoff).toEqual(["qa", "auditor"]);
}));

test("a queued local merge cannot use a test approval in place of its final review", () => fixture((f) => {
  const { sha } = f.legacy(), base = git(f.root, "rev-parse", "HEAD");
  writeTaskMeta(f.load(), f.task(), { delivery: null, integration: { commit: sha, state: "queued" } });
  expect(() => mergeTask(f.load(), "0001")).toThrow(/final.*review/);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(base);
}));

test("recovering a legacy local review still verifies the clean checkout and session location", () => fixture((f) => {
  const { sha, delivery } = f.legacy();
  writeFileSync(join(f.tree, "file.txt"), "uncommitted change\n");
  expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Approve" })).toThrow(/checkout changed/);
  expect(integrationFor(f.task())).toBeUndefined();
  git(f.tree, "restore", "file.txt");
  const reviewer = f.load().roles.find((role) => role.name === "auditor")!;
  const agent = f.h.state.agents.find((entry) => entry.name === "auditor-0001")!;
  f.h.state.panes.find((pane) => pane.pane_id === agent.pane_id)!.cwd = f.root;
  expect(() => taskAgent(f.load(), f.h, reviewer, f.task())).toThrow(/outside this task worktree/);
  f.h.state.panes.find((pane) => pane.pane_id === agent.pane_id)!.cwd = f.tree;
  expect(taskAgent(f.load(), f.h, reviewer, f.task())).toBe(agent);
}));

test("legacy recovery follows the saved task workflow even after project defaults change", () => fixture((f) => {
  const { sha, delivery } = f.legacy();
  writeFileSync(join(f.root, ".herdr/workflow.md"), "Use builder alone for future tasks.\n");
  expect(assignedReviewFor(f.task())?.reviewer).toBe("auditor");
  handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Reviewed task snapshot" });
  expect(integrationFor(f.task())?.state).toBe("queued");
}));

for (const mismatch of ["missing approval", "different commit", "different approver", "different delivery role", "different chain", "no snapshot", "PR workflow"] as const) {
  test(`legacy recovery does not guess review ownership with ${mismatch}`, () => fixture((f) => {
    const { sha, delivery } = f.legacy(), meta = f.task().meta;
    switch (mismatch) {
      case "missing approval": writeTaskMeta(f.load(), f.task(), { acceptance: null }); break;
      case "different commit": writeTaskMeta(f.load(), f.task(), { acceptance: { commit: "f".repeat(40), role: "qa" } }); break;
      case "different approver": writeTaskMeta(f.load(), f.task(), { acceptance: { commit: sha, role: "builder" } }); break;
      case "different delivery role": writeTaskMeta(f.load(), f.task(), { delivery: { ...meta.delivery as object, role: "qa" } }); break;
      case "different chain": writeTaskMeta(f.load(), f.task(), { handoff: ["qa"] }); break;
      case "no snapshot": writeTaskMeta(f.load(), f.task(), { workflow: null }); break;
      case "PR workflow": writeTaskMeta(f.load(), f.task(), { workflow: { ...meta.workflow as object, delivery: "pull-request" } }); break;
    }
    const before = JSON.stringify(f.task().meta);
    expect(assignedReviewFor(f.task())?.reviewer).toBe("qa");
    expect(() => handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Invalid approval" })).toThrow(/reviewer|assignment/);
    expect(JSON.stringify(f.task().meta)).toBe(before);
  }));
}

test("a local work step between test and review retains evidence and assigns review on handoff", () => fixture((f) => {
  writeRole(f.root, "docs", roleMeta());
  const workflow = parseWorkflow({ name: "documented-review", delivery: "local", merge: "manual", steps: [
    { kind: "develop", role: "builder" }, { kind: "test", role: "qa" }, { kind: "work", role: "docs" }, { kind: "review", role: "auditor" },
  ] });
  writeTaskMeta(f.load(), f.task(), { workflow, handoff: ["qa", "docs", "auditor"] });
  const { sha, delivery } = f.submit();
  handoff(f.load(), f.h, "0001", new Date(), { delivery, accept: sha, summary: "Tests passed" });
  expect(f.task().role).toBe("docs");
  handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), summary: "Documentation checked" });
  expect(f.task().role).toBe("auditor"); expect(acceptanceFor(f.task())).toBeUndefined();
  expect(reviewFor(f.task())?.reviewer).toBe("auditor"); expect(testResultFor(f.task())?.commit).toBe(sha);
  handoff(f.load(), f.h, "0001", new Date(), { delivery: claimCurrent(f.root), accept: sha, summary: "Reviewed all evidence" });
  expect(integrationFor(f.task())?.state).toBe("queued");
}));

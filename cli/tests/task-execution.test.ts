import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { acceptanceFor, git, integrationFor, taskEnvironment } from "../scripts/lib/execution.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { mergeRows, mergeTask, retryMerge } from "../scripts/lib/integration.ts";
import { dispatch } from "../scripts/lib/launch.ts";
import { pumpQueue } from "../scripts/lib/queue.ts";
import { runtimePath } from "../scripts/lib/runtime.ts";
import { createTask, writeTaskMeta } from "../scripts/lib/task.ts";
import { worktreeBranch } from "../scripts/lib/types.ts";
import { claimCurrent, fakeHerdr, makeProject, roleMeta, taskMeta, writeRole, writeTask } from "./helpers.ts";

function setup() {
  const project = makeProject();
  const root = project.root;
  for (const name of ["dev", "test", "docs", "lead"]) writeRole(root, name, roleMeta()); // All resident metadata, yet task sessions are independent.
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".herdr/\n");
  writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", "."); git(root, "commit", "-m", "base");
  const herdr = fakeHerdr();
  const paths = new Map<string, string>();
  const originalCreate = herdr.worktreeCreate, originalList = herdr.worktreeList;
  herdr.worktreeCreate = (repo, branch, label) => {
    const result = originalCreate(repo, branch, label);
    const path = join(root, "..", `tree-${branch.replaceAll("/", "-")}`);
    git(repo, "worktree", "add", "-b", branch, path, "main");
    paths.set(branch, path);
    herdr.state.panes.find((p) => p.pane_id === result.paneId)!.cwd = path;
    return result;
  };
  herdr.worktreeList = (repo) => originalList(repo).map((t) => ({ ...t, path: paths.get(t.branch)! }));
  const load = () => loadProject(root);
  const task = (id = "0001") => load().tasks.find((t) => t.id === id)!;
  const add = (title: string, handoff = ["test"]) => createTask(load(), { title, role: "dev", handoff, body: "Acceptance criteria", priority: "P2" });
  const commit = (id = "0001") => {
    const path = paths.get(worktreeBranch(task(id)))!;
    writeFileSync(join(path, `${id}.txt`), `${Date.now()}\n`);
    git(path, "add", "."); git(path, "commit", "-m", `Implement ${id}`);
    return git(path, "rev-parse", "HEAD");
  };
  const submit = (id = "0001") => {
    dispatch(load(), herdr, id); const delivery = claimCurrent(root, id), sha = commit(id);
    handoff(load(), herdr, id, new Date(), { delivery, commit: sha, summary: `Review ${sha}` });
    return { sha, delivery: claimCurrent(root, id) };
  };
  return { root, load, task, add, herdr, paths, commit, submit,
    cleanup() { rmSync(runtimePath(load(), "reviews"), { recursive: true, force: true }); project.cleanup(); } };
}
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup(); try { run(f); } finally { f.cleanup(); }
}

test("new task execution ignores resident role slots and busy conversations", () => fixture((f) => {
  f.add("First"); f.add("Second");
  f.herdr.live("dev", "conversation"); f.herdr.state.agents[0]!.agent_status = "working";
  dispatch(f.load(), f.herdr); claimCurrent(f.root);
  const first = f.herdr.state.agents.find((a) => a.name === "dev-0001")!;
  first.agent_status = "working";
  pumpQueue(f.load(), f.herdr);
  expect(f.task().meta.execution).toBe("task");
  expect(f.task("0002").meta.delivery).toMatchObject({ state: "submitted" });
  expect(f.herdr.state.agents.some((a) => a.name === "dev-0002")).toBe(true);
  expect(f.herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(2);
  expect(f.herdr.calls.some((c) => c.startsWith("agent prompt conversation"))).toBe(false);
}));

test("two independent test sessions run concurrently; advancing an accepted branch requires new review", () => fixture((f) => {
  f.add("First"); f.add("Second");
  const a = f.submit();
  const tester = f.herdr.state.agents.find((agent) => agent.name === "test-0001")!;
  tester.agent_status = "working";
  const b = f.submit("0002");
  expect(f.herdr.state.agents.some((agent) => agent.name === "test-0002")).toBe(true);
  const checkout = f.herdr.paneList().find((p) => p.pane_id === tester.pane_id)!.cwd!;
  expect(git(checkout, "rev-parse", "HEAD")).toBe(a.sha);
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery: a.delivery, accept: a.sha, summary: `Passed ${a.sha}` });
  expect(acceptanceFor(f.task())?.commit).toBe(a.sha);
  expect(integrationFor(f.task())?.state).toBe("queued");
  expect(f.commit()).not.toBe(a.sha);
  expect(() => mergeTask(f.load(), "0001")).toThrow(/advanced/);
  expect(integrationFor(f.task())?.state).toBe("blocked");
  // A blocked task cannot occupy another task's tester or integration slot.
  handoff(f.load(), f.herdr, "0002", new Date(), { delivery: b.delivery, accept: b.sha, summary: `Passed ${b.sha}` });
  expect(mergeTask(f.load()).id).toBe("0002");
  expect(f.task("0002").status).toBe("done");
  expect(f.task().status).toBe("review");
}));

test("reviewer rejects directly to original dev and reuses the task worktree for the new commit", () => fixture((f) => {
  f.add("Fix validation"); const first = f.submit();
  expect(() => handoff(f.load(), f.herdr, "0001", new Date(), { delivery: first.delivery })).toThrow(/--accept/);
  expect(() => handoff(f.load(), f.herdr, "0001", new Date(), { delivery: first.delivery, accept: "0000000", summary: "bad" })).toThrow();
  const rejected = handoff(f.load(), f.herdr, "0001", new Date(), { delivery: first.delivery, reject: true, summary: "Repro: validation fails" });
  expect(rejected.to).toBe("dev"); expect(f.task().handoff).toEqual(["test"]);
  expect(f.task().meta.acceptance).toBeNull();
  const devDelivery = claimCurrent(f.root), sha = f.commit();
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery: devDelivery, commit: sha, summary: "Fixed validation" });
  const testing = claimCurrent(f.root);
  const agent = f.herdr.state.agents.find((a) => a.name === "test-0001")!;
  const cwd = f.herdr.paneList().find((p) => p.pane_id === agent.pane_id)!.cwd!;
  expect(git(cwd, "rev-parse", "HEAD")).toBe(sha);
  const result = handoff(f.load(), f.herdr, "0001", new Date(), { delivery: testing, accept: sha, summary: `Passed ${sha}` });
  expect(result.queueState).toBe("merge-queued");
  expect(handoff(f.load(), f.herdr, "0001", new Date(), { delivery: testing, accept: sha }).duplicate).toBe(true);
  expect(mergeRows(f.load())).toHaveLength(1);
  expect(f.herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(1);
}));

test("task test resources are distinct, stable and injected into task tabs", () => fixture((f) => {
  f.add("First"); f.add("Second");
  const a = taskEnvironment(f.load(), f.task(), "test"), b = taskEnvironment(f.load(), f.task("0002"), "test");
  expect(a).toEqual(taskEnvironment(f.load(), f.task(), "test"));
  for (const name of ["HERDR_TEAM_TEST_DATABASE", "HERDR_TEAM_REDIS_PREFIX", "PORT"]) expect(a[name]).not.toBe(b[name]);
  dispatch(f.load(), f.herdr, "0001");
  const tab = f.herdr.calls.find((c) => c.startsWith("tab create dev-0001"))!;
  expect(tab).toContain('"HERDR_TEAM_TASK_ID":"0001"');
  expect(tab).toContain('"HERDR_TEAM_REDIS_PREFIX":');
}));

test("cancelled prerequisites do not satisfy real dependencies, independent tasks continue", () => fixture((f) => {
  f.add("Needs interface"); f.add("Cancelled provider"); f.add("Independent");
  writeTaskMeta(f.load(), f.task(), { depends_on: ["0002"] });
  writeTaskMeta(f.load(), f.task("0002"), { status: "cancelled" });
  dispatch(f.load(), f.herdr);
  expect(f.task().meta.delivery).toMatchObject({ state: "queued", reason: "Waiting for 0002" });
  expect(f.task("0003").meta.delivery).toMatchObject({ state: "submitted" });
}));

test("acceptance cannot silently include modified tracked verification files", () => fixture((f) => {
  f.add("First"); const { sha, delivery } = f.submit();
  writeFileSync(join(f.paths.get(worktreeBranch(f.task()))!, "file.txt"), "changed by reviewer\n");
  expect(() => handoff(f.load(), f.herdr, "0001", new Date(), { delivery, accept: sha, summary: "Passed" })).toThrow(/changed/);
  expect(acceptanceFor(f.task())).toBeUndefined();
}));

test("migration failure stays blocked, never repeats on a queue tick, and does not block another merge", () => fixture((f) => {
  f.add("First"); f.add("Second");
  for (const id of ["0001", "0002"]) {
    const { sha, delivery } = f.submit(id);
    handoff(f.load(), f.herdr, id, new Date(), { delivery, accept: sha, summary: `Passed ${sha}` });
  }
  expect(() => mergeTask(f.load(), "0001", "exit 7")).toThrow(/migration failed/);
  expect(f.task().status).toBe("review");
  expect(integrationFor(f.task())?.state).toBe("blocked");
  pumpQueue(f.load(), f.herdr);
  expect(integrationFor(f.task())?.state).toBe("blocked");
  expect(mergeTask(f.load()).id).toBe("0002");
  retryMerge(f.load(), "0001");
  expect(mergeTask(f.load(), "0001").state).toBe("done");
}));

test("interrupted integration requires explicit reconciliation and acceptance", () => fixture((f) => {
  f.add("First"); const { sha, delivery } = f.submit();
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery, accept: sha, summary: "Passed" });
  writeTaskMeta(f.load(), f.task(), { integration: { commit: sha, state: "running" } });
  expect(() => mergeTask(f.load())).toThrow(/reconciliation/);
  retryMerge(f.load(), "0001");
  expect(mergeTask(f.load()).state).toBe("done");
}));

test("real concurrent integration processes serialize merge plus local migration", async () => {
  const f = setup();
  try {
    f.add("First"); f.add("Second");
    for (const id of ["0001", "0002"]) {
      const { sha, delivery } = f.submit(id);
      handoff(f.load(), f.herdr, id, new Date(), { delivery, accept: sha, summary: "Passed" });
    }
    const log = join(f.root, "..", "integration-events.log"), worker = join(f.root, "..", "integration-worker.ts");
    writeFileSync(worker, `import { loadProject } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/config.ts"))};
import { mergeTask } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/integration.ts"))};
const command = ${JSON.stringify(process.execPath)} + ' -e ' + JSON.stringify('const fs=require("node:fs");fs.appendFileSync(' + JSON.stringify(process.argv[4]) + ', "start '+process.argv[3]+'\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);fs.appendFileSync(' + JSON.stringify(process.argv[4]) + ', "end '+process.argv[3]+'\\n");');
mergeTask(loadProject(process.argv[2]), process.argv[3], command);`);
    const workers = ["0001", "0002"].map((id) => Bun.spawn([process.execPath, worker, f.root, id, log], { stdout: "pipe", stderr: "pipe" }));
    for (const p of workers) {
      const error = await new Response(p.stderr).text();
      expect(error).toBe(""); expect(await p.exited).toBe(0);
    }
    const events = readFileSync(log, "utf8").trim().split("\n");
    expect(events).toHaveLength(4);
    expect(events[0]!.replace("start", "end")).toBe(events[1]);
    expect(events[2]!.replace("start", "end")).toBe(events[3]);
    expect(f.load().tasks.every((t) => t.status === "done")).toBe(true);
  } finally { f.cleanup(); }
});

test("default dev/test reuse exactly one task checkout and reject any version drift", () => fixture((f) => {
  f.add("Shared checkout");
  dispatch(f.load(), f.herdr, "0001");
  const devDelivery = claimCurrent(f.root), sha = f.commit();
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery: devDelivery, commit: sha, summary: "Ready" });
  const tester = f.herdr.state.agents.find((a) => a.name === "test-0001")!;
  const source = f.paths.get(worktreeBranch(f.task()))!;
  expect(f.herdr.paneList().find((p) => p.pane_id === tester.pane_id)!.cwd).toBe(source);
  expect(existsSync(runtimePath(f.load(), "reviews"))).toBe(false);
  const delivery = claimCurrent(f.root);
  writeFileSync(join(source, "file.txt"), "uncommitted dev change\n");
  expect(() => handoff(f.load(), f.herdr, "0001", new Date(), { delivery, accept: sha, summary: "Passed" })).toThrow(/changed/);
  git(source, "restore", "file.txt");
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery, accept: sha, summary: `Passed ${sha}` });
  expect(mergeTask(f.load(), "0001").state).toBe("done");
  expect(f.herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(1);
}));

test("legacy unsent cards migrate to task sessions without changing already-issued deliveries", () => fixture((f) => {
  writeTask(f.root, "0001-a", taskMeta());
  writeTask(f.root, "0002-b", taskMeta());
  dispatch(f.load(), f.herdr);
  const original = JSON.stringify(f.task().meta.delivery);
  claimCurrent(f.root);
  pumpQueue(f.load(), f.herdr);
  expect(f.task("0002").meta.execution).toBe("task");
  expect(f.task("0002").meta.delivery).toMatchObject({ state: "submitted" });
  expect(JSON.parse(original).pane_id).toBe((f.task().meta.delivery as any).pane_id);
}));

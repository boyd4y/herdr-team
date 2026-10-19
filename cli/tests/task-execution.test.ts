import { taskAgent } from "../scripts/lib/dispatch/task-agent.ts";
import { refreshSidebar } from "../scripts/lib/ui/sidebar.ts";
import { rememberRoleSession, roleSessionPath, savedResumeArgs, scopeForTaskSession } from "../scripts/lib/runtime/sessions.ts";
import { down, up } from "../scripts/lib/dispatch/launch.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { acceptanceFor, git, integrationFor, taskEnvironment } from "../scripts/lib/tasks/verification.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { mergeRows, mergeTask, retryMerge } from "../scripts/lib/integration/merge.ts";
import { dispatch } from "../scripts/lib/dispatch/launch.ts";
import { pumpQueue } from "../scripts/lib/dispatch/queue.ts";
import { runtimePath } from "../scripts/lib/runtime/state.ts";
import { roleStatusesFrom } from "../scripts/lib/ui/status.ts";
import { createTask, writeTaskMeta } from "../scripts/lib/tasks/cards.ts";
import { worktreeBranch } from "../scripts/lib/shared/types.ts";
import { persistedCodexSession, claimCurrent, fakeHerdr, makeProject, roleMeta, taskMeta, writeRole, writeTask } from "./helpers.ts";

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

test("lead always starts one resident session and queues its tasks without creating task agents", () => fixture((f) => {
  writeRole(f.root, "lead", roleMeta({ worktree: true }));
  const started = up(f.load(), f.herdr);
  expect(started.roles.find((role) => role.role === "lead")!.action).toBe("started");
  up(f.load(), f.herdr);
  expect(f.herdr.state.agents.filter((agent) => agent.name === "lead")).toHaveLength(1);
  expect(roleStatusesFrom(f.load(), f.herdr.state.agents).find((role) => role.role === "lead")).toMatchObject({ agent: "lead", worktree: false });
  writeTask(f.root, "0001-a", taskMeta({ role: "lead", execution: "task" }));
  writeTask(f.root, "0002-b", taskMeta({ role: "lead", execution: "task" }));
  const prompts: string[] = [], prompt = f.herdr.agentPrompt;
  f.herdr.agentPrompt = (target, text) => { prompts.push(text); prompt(target, text); };
  dispatch(f.load(), f.herdr);
  const first = claimCurrent(f.root);
  expect(prompts[0]).toContain("single resident lead session");
  const lead = f.herdr.state.agents.find((agent) => agent.name === "lead")!;
  lead.agent_session = persistedCodexSession("lead-native");
  refreshSidebar(f.load(), f.herdr);
  const role = f.load().roles.find((role) => role.name === "lead")!;
  expect(savedResumeArgs(f.load(), role)).toEqual(["resume", "lead-native"]);
  expect(lead.tokens).toMatchObject({ team_session: "resident", team_task: "#0001" });
  expect(pumpQueue(f.load(), f.herdr)).toMatchObject([{ id: "0002", state: "queued", reason: "Session is processing #0001" }]);
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery: first, summary: "Planning complete" });
  pumpQueue(f.load(), f.herdr);
  expect(f.task("0002").meta.delivery).toMatchObject({ state: "submitted", pane_id: lead.pane_id });
  expect(f.herdr.state.agents.some((agent) => agent.name?.startsWith("lead-"))).toBe(false);
  expect(f.herdr.calls.some((call) => call.startsWith("worktree create"))).toBe(false);
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
    writeFileSync(worker, `import { loadProject } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/team/project.ts"))};
import { mergeTask } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/integration/merge.ts"))};
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

// Recovery uses native reports backed by persisted harness messages.
test("task native IDs are saved independently by task and role, then Codex resumes exactly its own ID", () => fixture((f) => {
  writeRole(f.root, "dev", roleMeta({ worktree: true, args: ["-m", "gpt-6.1-sol"] }));
  f.add("First"); f.add("Second");
  dispatch(f.load(), f.herdr); claimCurrent(f.root);
  pumpQueue(f.load(), f.herdr);
  const first = f.herdr.state.agents.find((a) => a.name === "dev-0001")!;
  const second = f.herdr.state.agents.find((a) => a.name === "dev-0002")!;
  first.agent_session = persistedCodexSession("first-native-session");
  second.agent_session = persistedCodexSession("second-native-session");
  expect(refreshSidebar(f.load(), f.herdr, true)).toEqual({ updated: 2, failed: 0 });
  const role = f.load().roles.find((r) => r.name === "dev")!;
  const a = scopeForTaskSession(f.load(), f.herdr, role, "0001"), b = scopeForTaskSession(f.load(), f.herdr, role, "0002");
  expect(savedResumeArgs(f.load(), role, a)).toEqual(["resume", "first-native-session"]);
  expect(savedResumeArgs(f.load(), role, b)).toEqual(["resume", "second-native-session"]);
  expect(savedResumeArgs(f.load(), role)).toBeUndefined();
  f.herdr.paneClose(first.pane_id!);
  f.herdr.calls.length = 0;
  taskAgent(f.load(), f.herdr, role, f.task());
  expect(f.herdr.calls.find((c) => c.startsWith("agent start dev-0001"))).toContain('args=["resume","first-native-session","-m","gpt-6.1-sol"]');
  expect(f.herdr.calls.some((c) => c.startsWith("worktree create"))).toBe(false);
  expect(f.herdr.calls.some((c) => c.startsWith("agent prompt"))).toBe(false);
}));

test("task dev and test save different native sessions in the same worktree; down persists before closing", () => fixture((f) => {
  f.add("First"); const { delivery } = f.submit();
  const dev = f.herdr.state.agents.find((a) => a.name === "dev-0001")!;
  const tester = f.herdr.state.agents.find((a) => a.name === "test-0001")!;
  dev.agent_session = persistedCodexSession("dev-native");
  tester.agent_session = persistedCodexSession("test-native");
  const p = f.load(), devRole = p.roles.find((r) => r.name === "dev")!, testRole = p.roles.find((r) => r.name === "test")!;
  const devScope = scopeForTaskSession(p, f.herdr, devRole, "0001"), testScope = scopeForTaskSession(p, f.herdr, testRole, "0001");
  expect(devScope.cwd).toBe(testScope.cwd);
  down(p, f.herdr);
  expect(savedResumeArgs(p, devRole, devScope)).toEqual(["resume", "dev-native"]);
  expect(savedResumeArgs(p, testRole, testScope)).toEqual(["resume", "test-native"]);
  // Reading/saving session identity cannot advance the delivery or handoff chain.
  expect(f.task().meta.delivery).toMatchObject({ id: delivery, state: "claimed" });
}));

test("task late reports preserve existing IDs when absent and reject wrong checkout or duplicate task identities", () => fixture((f) => {
  f.add("First"); dispatch(f.load(), f.herdr);
  const agent = f.herdr.state.agents.find((a) => a.name === "dev-0001")!;
  const role = f.load().roles.find((r) => r.name === "dev")!;
  const scope = scopeForTaskSession(f.load(), f.herdr, role, "0001");
  expect(savedResumeArgs(f.load(), role, scope)).toBeUndefined();
  agent.agent_session = persistedCodexSession("correct-id");
  refreshSidebar(f.load(), f.herdr, true);
  agent.agent_session = undefined;
  refreshSidebar(f.load(), f.herdr, true);
  expect(savedResumeArgs(f.load(), role, scope)).toEqual(["resume", "correct-id"]);
  rememberRoleSession(f.load(), role, { ...agent, cwd: f.root,
    agent_session: persistedCodexSession("wrong-cwd") }, scope);
  expect(savedResumeArgs(f.load(), role, scope)).toEqual(["resume", "correct-id"]);
  expect(savedResumeArgs(f.load(), { ...role, kind: "grok" }, scope)).toBeUndefined();
  expect(savedResumeArgs(f.load(), role, { ...scope, cwd: f.root })).toBeUndefined();
  f.herdr.state.agents.push({ ...agent, name: "duplicate", pane_id: "duplicate-pane" });
  expect(refreshSidebar(f.load(), f.herdr, true).failed).toBe(2);
  expect(savedResumeArgs(f.load(), role, scope)).toEqual(["resume", "correct-id"]);
}));

test("failed task resume never falls back to a fresh session and keeps the original saved ID", () => fixture((f) => {
  f.add("First"); dispatch(f.load(), f.herdr);
  const agent = f.herdr.state.agents.find((a) => a.name === "dev-0001")!;
  const role = f.load().roles.find((r) => r.name === "dev")!;
  const scope = scopeForTaskSession(f.load(), f.herdr, role, "0001");
  rememberRoleSession(f.load(), role, { ...agent,
    agent_session: persistedCodexSession("resume-me") }, scope);
  f.herdr.paneClose(agent.pane_id!);
  let attempts = 0;
  f.herdr.agentStart = () => { attempts++; throw new Error("session unavailable"); };
  expect(() => taskAgent(f.load(), f.herdr, role, f.task())).toThrow(/Task session resume failed/);
  expect(attempts).toBe(1);
  expect(savedResumeArgs(f.load(), role, scope)).toEqual(["resume", "resume-me"]);
}));

test("task records do not leak to other tasks or projects and malformed records stop restart", () => fixture((f) => {
  f.add("First"); f.add("Second"); dispatch(f.load(), f.herdr); pumpQueue(f.load(), f.herdr);
  const role = f.load().roles.find((r) => r.name === "dev")!;
  const a = scopeForTaskSession(f.load(), f.herdr, role, "0001"), b = scopeForTaskSession(f.load(), f.herdr, role, "0002");
  rememberRoleSession(f.load(), role, {
    agent_session: persistedCodexSession("only-first") }, a);
  expect(savedResumeArgs(f.load(), role, b)).toBeUndefined();
  const other = makeProject();
  try { expect(savedResumeArgs(loadProject(other.root), role, a)).toBeUndefined(); } finally { other.cleanup(); }
  const first = f.herdr.state.agents.find((a) => a.name === "dev-0001")!;
  f.herdr.paneClose(first.pane_id!);
  writeFileSync(roleSessionPath(f.load(), role, a), "{bad");
  f.herdr.calls.length = 0;
  expect(() => taskAgent(f.load(), f.herdr, role, f.task())).toThrow(/session record/);
  expect(f.herdr.calls.some((c) => c.startsWith("agent start"))).toBe(false);
}));

import { test } from "node:test";
import assert from "node:assert/strict";
import { boardColumns, consoleBinding, flowNodes, groupTasks, iterationOptions, listFilters, listTasks,
  requirementsForIteration, roleRows, sameTeam, scopedTerminals, sortTasks, taskAssignee, taskDocument, taskReviewPhase, tasksForIteration, tasksWithIterations, teamSpace, waitingOn } from "../mods/team-console/model.js";

test("task assignee uses native agent and launch model only for the recorded live delivery", () => {
  const binding = { root: "/repo", space: "main", machine: null };
  const role = { name: "dev", kind: "codex", model: "configured-model" };
  const configured = { name: "Codex", icon: "icons/codex.svg", agent: true, tint: true };
  const programs = new Map([["codex", configured]]);
  const real = { name: "Live Codex", key: "codex", icon: "icons/codex.png", agent: true, tint: false };
  const terminal = { address: "t1", state: "live", pid: 31, program: real, argv: ["codex", "-m", "launch-model", "prompt"],
    labels: { "team.project": "/repo", "team.owner_space": "main", "herdr.space": "worktree", "team.runtime": "desktop",
      "team.role": "dev", "team.task": "0002", "team.delivery": "second" } };
  const task = { id: "0002", status: "doing", role: "dev", meta: { delivery: { id: "second", role: "dev", state: "claimed",
    runtime: "desktop", space: "main", terminal: "t1", process_id: 31 } } };
  const view = terminals => taskAssignee(task, roleRows([role], scopedTerminals(terminals, binding)), programs);
  assert.deepEqual(view([terminal]), { name: "dev", program: real, model: "launch-model", live: true, modelSource: "launch" });
  for (const wrong of [
    { ...terminal, address: "t2" },
    { ...terminal, address: "remote/t1" },
    { ...terminal, pid: 71 },
    { ...terminal, state: "finished" },
    { ...terminal, program: { name: "Shell", agent: false } },
    ...Object.entries({ "team.project": "/elsewhere", "team.owner_space": "other", "team.runtime": "tui", "team.role": "test",
      "team.task": "0001", "team.delivery": "first" }).map(([key, value]) => ({ ...terminal, labels: { ...terminal.labels, [key]: value } })),
  ]) {
    assert.deepEqual(view([wrong]), { name: "dev", program: configured, model: "configured-model", live: false, modelSource: "role" });
  }
});

test("history uses the configured agent and only displays a named model when known", () => {
  const program = { name: "Claude Code", icon: "icons/claude.svg", agent: true, tint: true };
  const catalog = new Map([["claude", program]]);
  const roles = [{ name: "review", kind: "claude", model: "default", instances: [] }];
  const task = { id: "0002", status: "done", role: "review", meta: { completed_deliveries: ["first"] } };
  assert.deepEqual(taskAssignee(task, roles, catalog), { name: "review", program, live: false, model: null, modelSource: null });
  assert.equal(taskAssignee(task, [{ ...roles[0], args: ["--model=claude-sonnet-4-6"] }], catalog).model, "claude-sonnet-4-6");
  assert.equal(taskAssignee({ ...task, status: "todo", meta: {} }, roles, catalog).program, null);
  assert.equal(taskAssignee({ ...task, meta: { ...task.meta, delivery: { id: "queued", state: "queued", role: "review" } } }, roles, catalog).program, null);
});

test("review cards distinguish code review from integration while staying in the Review column", () => {
  const tasks = [undefined, "queued", "running", "blocked"].map((state, idx) => ({
    id: String(idx), status: "review", meta: { integration: { state } },
  }));
  assert.deepEqual(tasks.map(taskReviewPhase), ["Awaiting review", "Awaiting merge", "Merging", "Merge blocked"]);
  assert.equal(taskReviewPhase({ status: "done", meta: { integration: { state: "done" } } }), null);
  assert.equal(boardColumns(tasks).find(column => column.status === "review").tasks.length, tasks.length);
});

test("the requirements filter offers only versions and keeps unscheduled cards under All", () => {
  const cards = [
    { id: "R0001", iteration: "v0.10", type: "requirement" },
    { id: "R0002", iteration: "", type: "defect" },
    { id: "R0003", iteration: "v0.2", type: "requirement" },
    { id: "R0004", iteration: "v0.2", type: "defect" },
    { id: "R0005", iteration: "requirement", type: "requirement" },
    { id: "R0006", iteration: "Backlog", type: "defect" },
  ];
  assert.deepEqual(iterationOptions(cards), ["v0.2", "v0.10"]);
  assert.deepEqual(requirementsForIteration(cards, "v0.2"), [cards[2], cards[3]]);
  assert.deepEqual(requirementsForIteration(cards, "v0.2", "defect"), [cards[3]]);
  assert.deepEqual(requirementsForIteration(cards, null, "defect"), [cards[1], cards[3], cards[5]]);
  assert.deepEqual(requirementsForIteration(cards, null), cards);
});

test("both task views use the shared iteration and retain task-only versions", () => {
  const issues = [{ id: "R0001", iteration: "v1.2" }];
  const tasks = tasksWithIterations([
    { id: "0001", status: "todo", meta: { requirement: "R0001" } },
    { id: "0002", status: "doing", meta: { requirement: "R0001", iteration: "v1.1" } },
    { id: "0003", status: "done", iteration: "v1.3" },
    { id: "0004", status: "todo" },
  ], issues);
  assert.deepEqual(iterationOptions([...tasks, ...issues]), ["v1.1", "v1.2", "v1.3"]);
  assert.deepEqual(tasksForIteration(tasks, null), tasks);
  assert.deepEqual(listTasks(tasksForIteration(tasks, "v1.2")).map(task => task.id), ["0001"]);
  assert.deepEqual(boardColumns(tasksForIteration(tasks, "v1.1")).flatMap(column => column.tasks).map(task => task.id), ["0002"]);
});

test("task detail separates description and recorded history and hides internal operation markers", () => {
  assert.deepEqual(taskDocument("需求说明\r\n\r\n## History\r\n- 用户记录\r\n<!-- team-operation:submit-1 -->\r\n## Delivery\r\n已提交"), {
    description: "需求说明", history: "- 用户记录\r\n## Delivery\r\n已提交",
  });
  assert.deepEqual(taskDocument("## 流转记录\n- 完成"), { description: "", history: "- 完成" });
  assert.deepEqual(taskDocument("Only the assignment."), { description: "Only the assignment.", history: "" });
});

test("space lookup never selects a project by a stale folder, cwd or display name", () => {
  const space = { id: "actual-id", name: "ccremote", folder: "/old/test", machine: null, active: true };
  const target = teamSpace([space], []);
  assert.equal(target.localId, "actual-id");
  assert.equal(consoleBinding(null, space), null);
  assert.deepEqual(consoleBinding({ root: "/real/project", space: "actual-id", machine: null }, space),
    { root: "/real/project", space: "actual-id", machine: null });
  assert.throws(() => consoleBinding({ root: "/old/test", space: "other-id", machine: null }, space));
  const renamed = { ...space, name: "other", folder: "/other/path" };
  assert.equal(teamSpace([renamed], []).key, target.key);
  const terminal = { address: "t1", state: "live", labels: { "team.owner_space": "actual-id", "team.project": "/real/project" } };
  assert.notEqual(teamSpace([space], [terminal]).key, target.key);
  assert.equal(teamSpace([space], [{ ...terminal, address: "remote/t1" }]).key, target.key);
  const remote = { ...space, id: "box/actual-id", machine: "box" };
  assert.deepEqual(consoleBinding({ root: "/remote/project", space: "actual-id", machine: null }, remote),
    { root: "/remote/project", space: "box/actual-id", machine: "box" });
});

test("tasks show newest first without rewriting the input", () => {
  const tasks = [{ id: "0039" }, { id: "0080" }, { id: "0042" }];
  assert.deepEqual(sortTasks(tasks).map(task => task.id), ["0080", "0042", "0039"]);
  assert.equal(tasks[0].id, "0039");
});

test("task spaces resolve only through explicit CLI parent mappings and retain one team scope", () => {
  const parent = consoleBinding({ root: "/repo", space: "main", machine: null }, { id: "main", machine: null });
  const child = consoleBinding({ root: "/repo", space: "main", view_space: "task-space", task: "0002", checkout: "/checkouts/0002", machine: null }, { id: "task-space", machine: null });
  assert.deepEqual(child, parent);
  assert.equal(sameTeam(parent, child), true);
  assert.equal(sameTeam(parent, { ...child, root: "/other" }), false);
  assert.equal(sameTeam(parent, { ...child, machine: "remote" }), false);
  assert.equal(sameTeam(parent, null), false);
  assert.throws(() => consoleBinding({ root: "/repo", space: "main", machine: null }, { id: "task-space", machine: null }));
  assert.throws(() => consoleBinding({ root: "/repo", space: "main", view_space: "task-space", task: "0002", machine: null }, { id: "task-space", machine: null }));
  assert.throws(() => consoleBinding({ root: "/repo", space: "main", view_space: "wrong", task: "0002", checkout: "/checkouts/0002", machine: null }, { id: "task-space", machine: null }));
  const space = { id: "task-space", active: true, machine: null };
  const terminal = { address: "t1", state: "live", labels: { "team.project": "/repo", "team.owner_space": "main", "herdr.space": "task-space" } };
  assert.notEqual(teamSpace([space], []).key, teamSpace([space], [terminal]).key);
  assert.deepEqual(scopedTerminals([terminal], child), [terminal]);
});

test("same root on another space or machine is not this team instance", () => {
  const terminal = { address: "t1", state: "live", labels: { "team.project": "/repo", "herdr.space": "s1", "team.role": "dev" } };
  const terminals = [terminal,
    { ...terminal, address: "t2", labels: { ...terminal.labels, "herdr.space": "s2" } },
    { ...terminal, address: "box/t1" },
    { ...terminal, address: "t3", labels: { ...terminal.labels, "team.project": "/other" } },
    { ...terminal, address: "t4", state: "finished" },
  ];
  assert.deepEqual(scopedTerminals(terminals, { root: "/repo", space: "s1" }), [terminal]);
  assert.deepEqual(scopedTerminals(terminals, { root: "/repo", space: "box/s1", machine: "box" }).map(terminal => terminal.address), ["box/t1"]);
  assert.deepEqual(scopedTerminals(terminals, { root: "/repo" }), []);
  const taskSpace = { ...terminal, address: "t5", labels: { ...terminal.labels, "herdr.space": "task-space", "team.owner_space": "s1" } };
  assert.deepEqual(scopedTerminals([taskSpace], { root: "/repo", space: "s1" }), [taskSpace]);
  assert.deepEqual(scopedTerminals([taskSpace], { root: "/repo", space: "s2" }), []);
});

test("missing program reports stay unknown, including live shell recovery", () => {
  const roles = [{ name: "dev", kind: "codex", model: "default" }];
  const terminals = [{ address: "t1", status: null, labels: { "team.role": "dev" } }];
  assert.equal(roleRows(roles, terminals)[0].status, "unknown");
  assert.equal(flowNodes({ role: "dev", status: "doing", handoff: [] }, roleRows(roles, terminals))[0].status, "assigned");
});

test("parallel instances remain distinct; an agent done report cannot complete the task", () => {
  const roles = roleRows([{ name: "dev", kind: "codex", preset: "dev" }], [
    { address: "t1", status: "done", labels: { "team.role": "dev", "team.task": "0041" } },
    { address: "t2", status: "blocked", labels: { "team.role": "dev", "team.task": "0042" } },
  ]);
  assert.equal(roles[0].instances.length, 2);
  assert.equal(roles[0].harness, "codex");
  const task = { role: "dev", status: "doing", handoff: ["test"] };
  flowNodes(task, roles);
  assert.equal(task.status, "doing");
  assert.deepEqual(task.handoff, ["test"]);
});

test("the path follows the task's assignees rather than a predefined workflow", () => {
  const flow = flowNodes({ role: "doc", status: "todo", handoff: ["owner"] }, []);
  assert.deepEqual(flow.map(node => node.name), ["doc", "owner"]);
  assert.deepEqual(flow.map(node => node.status), ["ready", "next"]);
});

test("a role's other task cannot supply the selected task's execution status", () => {
  const roles = roleRows([{ name: "dev", kind: "codex" }], [
    { address: "t1", status: "blocked", labels: { "team.role": "dev", "team.task": "0041" } },
    { address: "t2", status: "done", labels: { "team.role": "dev", "team.task": "0042" } },
  ]);
  assert.equal(flowNodes({ id: "0042", role: "dev", status: "doing" }, roles)[0].status, "awaiting handoff");
  assert.equal(flowNodes({ id: "0043", role: "dev", status: "doing" }, roles)[0].status, "assigned");
});

test("list sections and dependencies follow task records", () => {
  const tasks = [
    { id: "3", status: "todo", role: "test", handoff: [], dependsOn: ["2", "9"] },
    { id: "2", status: "doing", role: "dev", handoff: ["test", "doc"] },
    { id: "1", status: "done", role: "doc", handoff: [] },
    { id: "4", status: "doing", role: "owner", handoff: [] },
  ];
  const groups = groupTasks(tasks);
  assert.deepEqual([groups.active, groups.todo, groups.done].map(list => list.map(task => task.id)), [["4", "2"], ["3"], ["1"]]);
  assert.deepEqual(waitingOn(tasks[0], tasks), ["2", "9"]);
});

test("board keeps fixed status columns including empty and completed columns", () => {
  assert.deepEqual(boardColumns([]).map(column => [column.status, column.tasks]), [
    ["todo", []], ["doing", []], ["review", []], ["blocked", []], ["done", []],
  ]);
});

test("board places each task once by recorded status, retaining owner and handoff", () => {
  const tasks = [
    { id: "2", status: "doing", role: "dev", handoff: ["test", "lead"] },
    { id: "10", status: "doing", role: "other", handoff: ["dev"] },
    ...["todo", "review", "blocked", "done", "cancelled", "future"].map((status, i) => ({ id: String(i + 11), status, role: "lead" })),
  ];
  const before = structuredClone(tasks);
  const columns = boardColumns(tasks);
  assert.deepEqual(columns.map(column => column.status), ["todo", "doing", "review", "blocked", "done", "cancelled", "future"]);
  assert.deepEqual(columns[1].tasks.map(task => [task.id, task.role]), [["10", "other"], ["2", "dev"]]);
  assert.equal(columns.flatMap(column => column.tasks).length, tasks.length);
  assert.equal(new Set(columns.flatMap(column => column.tasks.map(task => task.id))).size, tasks.length);
  for (const column of columns) assert.ok(column.tasks.every(task => task.status === column.status));
  assert.deepEqual(tasks, before);
});

test("sidebar prioritizes attention and hides finished tasks only in Open", () => {
  const tasks = [
    { id: "1", status: "blocked", role: "dev" },
    { id: "9", status: "blocked", role: "lead" },
    { id: "3", status: "review" },
    { id: "4", status: "doing" },
    { id: "10", status: "todo" },
    { id: "11", status: "done" },
    { id: "12", status: "cancelled" },
    { id: "13", status: "future" },
  ];
  const before = structuredClone(tasks);
  assert.deepEqual(listTasks(tasks).map(task => task.id), ["13", "12", "11", "10", "9", "4", "3", "1"]);
  assert.deepEqual(listTasks(tasks, "open").map(task => task.id), ["9", "1", "3", "4", "10", "13"]);
  const filters = listFilters(tasks);
  assert.deepEqual(filters.map(filter => [filter.status, filter.count]), [
    ["all", 8], ["open", 6], ["blocked", 2], ["review", 1], ["doing", 1], ["todo", 1], ["future", 1], ["done", 1], ["cancelled", 1],
  ]);
  for (const filter of filters) assert.equal(listTasks(tasks, filter.status).length, filter.count);
  assert.deepEqual(listTasks(tasks, "done").map(task => task.id), ["11"]);
  assert.deepEqual(listTasks(tasks, "cancelled").map(task => task.id), ["12"]);
  assert.deepEqual(tasks, before);
});

test("empty sidebar filters stay available with zero counts", () => {
  assert.deepEqual(listFilters([]).map(filter => filter.status), ["all", "open", "blocked", "review", "doing", "todo", "done"]);
  assert.ok(listFilters([]).every(filter => filter.count === 0));
  assert.deepEqual(listTasks([], "review"), []);
});

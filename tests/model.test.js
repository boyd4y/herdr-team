import { test } from "node:test";
import assert from "node:assert/strict";
import { flowNodes, roleRows, scopedTerminals, sortTasks } from "../mods/team-console/model.js";

test("tasks show newest first without rewriting the input", () => {
  const tasks = [{ id: "0039" }, { id: "0080" }, { id: "0042" }];
  assert.deepEqual(sortTasks(tasks).map(task => task.id), ["0080", "0042", "0039"]);
  assert.equal(tasks[0].id, "0039");
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

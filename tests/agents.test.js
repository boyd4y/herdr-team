import { test } from "node:test";
import assert from "node:assert/strict";
import { agentGroup, agentTeam, groupAgents, roleDescription } from "../mods/team-agents/model.js";

test("agent ownership uses terminal labels and actual space IDs, including machines", () => {
  const agent = { address: "t1", space: "s1", space_name: "same name" };
  const terminal = { address: "t1", state: "live", labels: { "herdr.space": "s1", "team.project": "/project", "team.owner_space": "owner", "team.role": "lead", "team.session": "resident" } };
  assert.equal(agentTeam(agent, terminal).role, "lead");
  assert.equal(agentTeam(agent, terminal).owner, "owner");
  assert.equal(agentTeam({ ...agent, space: "s2" }, terminal), null);
  assert.equal(agentTeam(agent, { ...terminal, address: "t2" }), null);
  assert.equal(agentTeam(agent, { ...terminal, state: "finished" }), null);
  const renamed = { ...agent, space_name: "different name" };
  assert.deepEqual(agentTeam(renamed, terminal), agentTeam(agent, terminal));
  const remote = agentTeam({ ...agent, address: "box/t1", space: "box/s1" }, { ...terminal, address: "box/t1" });
  assert.equal(remote.machine, "box");
  assert.notEqual(remote.key, agentTeam(agent, terminal).key);
  assert.equal(agentTeam({ ...agent, address: "box/t1" }, { ...terminal, address: "box/t1" }), null);
});

test("role descriptions prefer user metadata and skip startup boilerplate without inventing duties", () => {
  assert.equal(roleDescription({ meta: { description: "检查实现与验收证据" }, body: "Other prose" }), "检查实现与验收证据");
  assert.equal(roleDescription({ body: "Read the skill. Read TEAM.md. You are the lead. Own requirements and final acceptance. Wait for tasks." }), "Own requirements and final acceptance.");
  assert.equal(roleDescription({ body: "# 开发职责\n1. 完成实现、自测并交付。" }), "完成实现、自测并交付。");
  assert.equal(roleDescription({ body: "" }), "");
  assert.equal(roleDescription(null), "");
});

test("verified parent grouping merges interleaved task agents without changing their navigation targets", () => {
  const lead = { address: "t1", space: "main", space_name: "Project", pane: "p1" };
  const dev = { address: "t2", space: "task", space_name: "0002-feature", pane: "p2" };
  const other = { address: "t3", space: "other", space_name: "Project", pane: "p3" };
  const terminal = (agent, role) => ({ address: agent.address, state: "live", labels: { "herdr.space": agent.space, "team.project": "/repo", "team.owner_space": "main", "team.role": role } });
  const terminals = [terminal(lead, "lead"), terminal(dev, "developer")];
  const team = agentTeam(dev, terminals[1]);
  const teams = new Map([[team.key, { ...team, verified: true }]]);
  const spaces = [{ id: "main", machine: null, name: "Project" }, { id: "task", machine: null, name: "0002-feature" }];
  const input = [lead, other, dev], before = structuredClone(input);
  const groups = groupAgents(input, terminals, spaces, teams);
  assert.deepEqual(groups.map(group => [group.id, group.members.map(agent => agent.address)]), [["sp-main", ["t1", "t2"]], ["sp-other", ["t3"]]]);
  assert.equal(agentGroup(dev, terminals[1], spaces, teams).space, "main");
  assert.equal(groups[0].members[1].pane, "p2");
  assert.equal(groups[0].members[1].space, "task");
  assert.deepEqual(input, before);
  assert.equal(agentGroup(dev, terminals[1], [{ ...spaces[0], name: "Renamed" }], teams).label, "Renamed");
  for (const states of [new Map(), new Map([[team.key, { ...team, verified: false }]]), new Map([[team.key, { ...team, root: "/other", verified: true }]])]) {
    assert.equal(agentGroup(dev, terminals[1], spaces, states).id, "sp-task");
  }
  assert.equal(agentGroup(dev, terminals[1], [], teams).id, "sp-task");
  const remote = { ...dev, address: "box/t2", space: "box/task" };
  assert.equal(agentGroup(remote, { ...terminals[1], address: "box/t2" }, spaces, teams).id, "sp-box/task");
});

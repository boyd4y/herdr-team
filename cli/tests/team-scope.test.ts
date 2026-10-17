import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { up, dispatch, down } from "../scripts/lib/launch.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { buildReport } from "../scripts/lib/status.ts";
import { refreshSidebar } from "../scripts/lib/sidebar.ts";
import { cleanupTask } from "../scripts/lib/cleanup.ts";
import { worktreeBranch } from "../scripts/lib/types.ts";
import { projectAgents, projectKey, resolveProjectWorkspace, TeamScopeError } from "../scripts/lib/team-scope.ts";
import { claimCurrent, fakeHerdr, makeProject, roleMeta, taskMeta, writeRole, writeTask } from "./helpers.ts";

function fixture(run: (a: ReturnType<typeof loadProject>, b: ReturnType<typeof loadProject>, herdr: ReturnType<typeof fakeHerdr>) => void) {
  const a = makeProject("same-name"), b = makeProject("same-name");
  try {
    for (const root of [a.root, b.root]) {
      writeRole(root, "dev", roleMeta({ model: "sol" }));
      writeRole(root, "docs", roleMeta({ kind: "claude" }));
      writeTask(root, "0001-a", taskMeta({ handoff: ["docs"] }));
    }
    const herdr = fakeHerdr({
      workspaces: ["a", "b"].map((id) => ({ workspace_id: id, label: "same-name", pane_count: 2, tab_count: 2 })),
      tabs: ["a", "b"].flatMap((id) => ["dev", "docs"].map((name) => ({ workspace_id: id, tab_id: `${id}:t-${name}`, label: name, pane_count: 1 }))),
      panes: [["a", a.root], ["b", b.root]].flatMap(([id, cwd]) => ["dev", "docs"].map((name) => ({ workspace_id: id!, tab_id: `${id}:t-${name}`, pane_id: `${id}:p-${name}`, cwd }))),
    });
    run(loadProject(a.root), loadProject(b.root), herdr);
  } finally { a.cleanup(); b.cleanup(); }
}

describe("两个项目同名角色、同号任务的隔离", () => {
  test("up 用目录证据区分同名 workspace；全局角色名占用时使用内部命名空间", () => fixture((a, b, herdr) => {
    herdr.state.agents = ["dev", "docs"].map((name) => ({ name, pane_id: `b:p-${name}`, workspace_id: "b", tokens: { team_project: projectKey(b) } }));
    const foreign = structuredClone(herdr.state.agents);
    const result = up(a, herdr);
    expect(result.workspaceId).toBe("a");
    expect(result.roles.every((role) => role.action === "started")).toBe(true);
    const own = projectAgents(a, herdr);
    expect(own).toHaveLength(2);
    expect(own.every((agent) => agent.name?.startsWith("ht-") && agent.name.length <= 32)).toBe(true);
    expect(own.map((agent) => agent.display_agent).sort()).toEqual(["dev", "docs"]);
    expect(herdr.state.agents.filter((agent) => agent.workspace_id === "b")).toEqual(foreign);
    expect(herdr.calls.some((call) => call.startsWith("agent prompt"))).toBe(false);
    const calls = herdr.calls.length;
    herdr.state.workspaces[0]!.label = "renamed";
    expect(up(a, herdr).roles.every((role) => role.action === "reused")).toBe(true);
    expect(herdr.calls.slice(calls).some((call) => call.startsWith("agent start") || call.startsWith("agent prompt"))).toBe(false);
  }));

  test("dispatch / handoff 仅发送到本项目 pane，同号任务不改另一个项目", () => fixture((a, b, herdr) => {
    herdr.state.agents = ["dev", "docs"].map((name) => ({ name, pane_id: `b:p-${name}`, workspace_id: "b", tokens: { team_project: projectKey(b) } }));
    up(a, herdr);
    const foreignTask = readFileSync(join(b.herdrDir, "tasks/0001-a/.task.yaml"), "utf8");
    herdr.calls.length = 0;
    expect(dispatch(a, herdr, "0001")[0]!.action).toBe("dispatched");
    expect(handoff(loadProject(a.root), herdr, "0001", new Date(), { summary: "项目 A 的交付记录。", delivery: claimCurrent(a.root) }).prompted).toBe(true);
    const prompts = herdr.calls.filter((call) => call.startsWith("agent prompt"));
    expect(prompts.map((call) => call.split(" ")[2])).toEqual(["a:p-dev", "a:p-docs"]);
    expect(readFileSync(join(b.herdrDir, "tasks/0001-a/.task.yaml"), "utf8")).toBe(foreignTask);
    expect(loadProject(a.root).tasks[0]!.role).toBe("docs");
    expect(loadProject(a.root).tasks[0]!.body).toContain("项目 A 的交付记录。");
  }));

  test("只存在另一个项目的同名 agent 时，dispatch 不派出、handoff 不误投", () => fixture((a, b, herdr) => {
    herdr.state.agents = ["dev", "docs"].map((name) => ({ name, pane_id: `b:p-${name}`, workspace_id: "b", tokens: { team_project: projectKey(b) } }));
    expect(dispatch(a, herdr, "0001")[0]!.action).toBe("queued");
    expect(loadProject(a.root).tasks[0]!.status).toBe("todo");
    expect(() => handoff(loadProject(a.root), herdr, "0001")).toThrow(/Claim/);
    expect(herdr.calls.some((call) => call.startsWith("agent prompt"))).toBe(false);
    expect(buildReport(loadProject(a.root), herdr, false).roles.every((role) => role.herdrStatus === "absent")).toBe(true);
  }));

  test("sidebar 和 down 不更新、不关停另一个项目的同名角色", () => fixture((a, b, herdr) => {
    herdr.state.agents = [
      { name: "dev", pane_id: "a:p-dev", workspace_id: "a", tokens: { team_project: projectKey(a) } },
      { name: "docs", pane_id: "b:p-docs", workspace_id: "b", tokens: { team_project: projectKey(b) } },
    ];
    const foreign = structuredClone(herdr.state.agents[1]);
    refreshSidebar(a, herdr);
    expect(herdr.state.agents[1]).toEqual(foreign);
    expect(down(a, herdr).stopped.map((agent) => agent.paneId)).toEqual(["a:p-dev"]);
    expect(herdr.state.agents).toEqual([foreign]);
  }));

  test("旧版无项目 token 的 agent 只能通过实际 cwd 收编，名称不足以证明归属", () => fixture((a, _b, herdr) => {
    herdr.state.agents = [
      { name: "dev", pane_id: "a:p-dev", workspace_id: "a" },
      { name: "docs", pane_id: "b:p-docs", workspace_id: "b" },
      { name: "lead", pane_id: "unknown" },
    ];
    expect(projectAgents(a, herdr).map((agent) => agent.name)).toEqual(["dev"]);
  }));

  test("归属有歧义时明确拒绝，不随意选择同目录 workspace", () => fixture((a, _b, herdr) => {
    herdr.state.panes.filter((pane) => pane.workspace_id === "b").forEach((pane) => pane.cwd = a.root);
    expect(() => resolveProjectWorkspace(a, herdr)).toThrow(TeamScopeError);
    expect(herdr.calls).toEqual([]);
  }));
});

test("两个项目的隔离任务 0001 各起自己的 worktree agent", () => fixture((a, b, herdr) => {
  writeRole(a.root, "dev", roleMeta({ worktree: true }));
  writeRole(b.root, "dev", roleMeta({ worktree: true }));
  expect(dispatch(loadProject(a.root), herdr, "0001")[0]!.action).toBe("dispatched");
  expect(dispatch(loadProject(b.root), herdr, "0001")[0]!.action).toBe("dispatched");
  const ownA = projectAgents(a, herdr), ownB = projectAgents(b, herdr);
  expect(ownA).toHaveLength(1);
  expect(ownB).toHaveLength(1);
  expect(ownA[0]!.name).not.toBe(ownB[0]!.name);
  expect(ownA[0]!.pane_id).not.toBe(ownB[0]!.pane_id);
  expect(ownA[0]!.tokens?.team_task_id).toBe("0001");
  expect(ownB[0]!.tokens?.team_task_id).toBe("0001");
}));

test("handoff retains a queued delivery when the target is ambiguous", () => fixture((a, _b, herdr) => {
  herdr.state.agents = ["one", "two"].map((name) => ({ name, pane_id: `a:p-${name}`, workspace_id: "a",
    tokens: { team_project: projectKey(a), team_role: "docs" } }));
  const file = join(a.herdrDir, "tasks/0001-a/.task.yaml");
  const before = readFileSync(file, "utf8");
  expect(handoff(a, herdr, "0001")).toMatchObject({ prompted: false, queueState: "queued" });
  expect(readFileSync(file, "utf8")).not.toBe(before);
  expect(herdr.calls.some((call) => call.startsWith("agent prompt"))).toBe(false);
}));

test.each([false, true])("同分支的外项目 worktree 不能复用或回收（有归属标记=%s）", (tagged) => fixture((a, b, herdr) => {
  writeRole(a.root, "dev", roleMeta({ worktree: true }));
  const project = loadProject(a.root);
  const made = herdr.worktreeCreate(b.root, worktreeBranch(project.tasks[0]!), "foreign");
  if (tagged) herdr.reportWorkspaceMetadata(made.workspaceId, { team_project: projectKey(b), team_root: "0" });
  // Simulate a checkout surfaced by a shared repository; branch equality is insufficient.
  const trees = herdr.worktreeList(b.root);
  herdr.worktreeList = () => trees;
  herdr.calls.length = 0;
  expect(dispatch(project, herdr, "0001")[0]!.action).toBe("queued");
  expect(loadProject(a.root).tasks[0]!.status).toBe("todo");
  expect(cleanupTask(project, herdr, { ...project.tasks[0]!, status: "done" }).action).toBe("foreign");
  expect(herdr.calls.some((call) => /^(agent (start|prompt)|worktree remove)/.test(call))).toBe(false);
}));

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { dispatch, up } from "../scripts/lib/dispatch/launch.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { refreshSessionSidebar, refreshSidebar } from "../scripts/lib/ui/sidebar.ts";
import { syncWorkspaceBadges } from "../scripts/lib/ui/workspace-badges.ts";
import { claimCurrent, fakeHerdr, makeProject, roleMeta, runningWorkspace, taskMeta, twoResidentRoles, writeRole, writeTask } from "./helpers.ts";

describe("agent sidebar 的两行信息", () => {
  test("角色与 harness 独立，模型不再拼进角色名，无任务时清空旧 ID", () => {
    const { root, cleanup } = makeProject();
    try {
      twoResidentRoles(root);
      const herdr = runningWorkspace();
      herdr.state.agents[0]!.tokens = { team_task: "#9999" };
      up(loadProject(root), herdr);
      expect(herdr.state.agents[0]).toMatchObject({ name: "dev", display_agent: "dev",
        tokens: { team_harness: "codex", team_model: "sol-6.1", team_session: "resident" } });
      expect(herdr.state.agents[0]!.tokens).not.toHaveProperty("team_task");
    } finally { cleanup(); }
  });

  test("派活、交棒、完成同步任务 ID，包括从旧负责人清除", () => {
    const { root, cleanup } = makeProject();
    try {
      twoResidentRoles(root);
      writeTask(root, "0001-a", taskMeta({ handoff: ["docs"] }));
      const herdr = runningWorkspace();
      dispatch(loadProject(root), herdr, "0001");
      const dev = herdr.state.agents.find((agent) => agent.name === "dev-0001")!;
      expect(dev.tokens?.team_task).toBe("#0001");
      expect(herdr.state.agents.slice(0, 2).every((agent) => !agent.tokens?.team_task)).toBe(true);
      handoff(loadProject(root), herdr, "0001", new Date(), { delivery: claimCurrent(root) });
      expect(dev.tokens?.team_task).toBeUndefined();
      expect(herdr.state.agents.find((agent) => agent.name === "docs-0001")!.tokens?.team_task).toBe("#0001");
      handoff(loadProject(root), herdr, "0001", new Date(), { delivery: claimCurrent(root) });
      expect(herdr.state.agents.every((agent) => agent.tokens?.team_task === undefined)).toBe(true);
    } finally { cleanup(); }
  });

  test("隔离角色各自显示自己的任务，内部 agent 名保持唯一", () => {
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "dev", roleMeta({ worktree: true, model: "sol-6.1" }));
      writeTask(root, "0001-a", taskMeta());
      writeTask(root, "0002-b", taskMeta());
      const herdr = fakeHerdr();
      dispatch(loadProject(root), herdr);
      expect(herdr.state.agents).toHaveLength(1);
      expect(loadProject(root).tasks[1]!.meta.delivery).toMatchObject({ state: "queued" });
      expect(herdr.state.agents.map((agent) => [agent.name, agent.display_agent, agent.tokens])).toMatchObject([
        ["dev-0001", "dev-0001", { team_harness: "codex", team_model: "sol-6.1", team_task: "#0001", team_session: "task" }],
      ]);
    } finally { cleanup(); }
  });

  test("resident and task labels stay distinct across badge refreshes and completed tasks", () => {
    const { root, cleanup } = makeProject();
    try {
      twoResidentRoles(root);
      writeTask(root, "0001-a", taskMeta({ execution: "task" }));
      const herdr = runningWorkspace();
      dispatch(loadProject(root), herdr, "0001");
      const resident = herdr.state.agents.find((agent) => agent.name === "dev")!;
      const task = herdr.state.agents.find((agent) => agent.name === "dev-0001")!;
      const file = join(root, "badges.json");
      syncWorkspaceBadges(herdr, file);
      refreshSidebar(loadProject(root), herdr);
      syncWorkspaceBadges(herdr, file);
      expect(resident).toMatchObject({ display_agent: "dev", tokens: { team_session: "resident" } });
      expect(resident.tokens).not.toHaveProperty("team_task");
      expect(task).toMatchObject({ display_agent: "dev-0001", tokens: { team_session: "task", team_task_id: "0001", team_task: "#0001" } });
      const label = Object.entries(task.tokens!).find(([key]) => /^team_workspace_c[0-7]$/.test(key))?.[1];
      expect(label).toMatch(/ dev-0001$/);
      writeTask(root, "0001-a", taskMeta({ execution: "task", status: "done" }));
      refreshSidebar(loadProject(root), herdr);
      syncWorkspaceBadges(herdr, file);
      expect(task.display_agent).toBe("dev-0001");
      expect(task.tokens).not.toHaveProperty("team_task");
    } finally { cleanup(); }
  });

  test("复用 agent 刷新模型与多个任务，省略模型时显示 default", () => {
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "dev", roleMeta());
      writeTask(root, "0002-b", taskMeta({ status: "blocked" }));
      writeTask(root, "0001-a", taskMeta({ status: "doing" }));
      writeTask(root, "0003-c", taskMeta({ status: "done" }));
      const herdr = runningWorkspace();
      herdr.live("outsider", "w1:p3");
      refreshSidebar(loadProject(root), herdr);
      expect(herdr.state.agents[0]!.tokens).toMatchObject({ team_harness: "codex", team_model: "default", team_task: "#0001, #0002" });
      expect(herdr.state.agents.find((agent) => agent.name === "outsider")!.tokens?.team_harness).toBeUndefined();
      const reports = herdr.calls.filter(call => call.startsWith("report-metadata")).length;
      let reads = 0;
      const agentList = herdr.agentList;
      herdr.agentList = () => { reads++; return agentList(); };
      refreshSidebar(loadProject(root), herdr);
      expect(reads).toBe(1);
      expect(herdr.calls.filter(call => call.startsWith("report-metadata"))).toHaveLength(reports);
      writeRole(root, "dev", roleMeta({ model: "new-model" }));
      refreshSidebar(loadProject(root), herdr);
      expect(herdr.state.agents[0]!.tokens?.team_model).toBe("new-model");
      expect(herdr.calls.filter(call => call.startsWith("report-metadata"))).toHaveLength(reports + 1);
    } finally { cleanup(); }
  });
});

describe("plugin 自动刷新旧 agent", () => {
  test("跨项目补齐 arch 的 codex/model；无 live name 时用原显示角色，但不覆盖显式其他名称", () => {
    const a = makeProject("same"), b = makeProject("same");
    try {
      writeRole(a.root, "arch", roleMeta({ model: "sol-6.1" }));
      writeRole(b.root, "arch", roleMeta({ kind: "claude", model: "other-model" }));
      const herdr = fakeHerdr({
        workspaces: ["a", "b"].map((id) => ({ workspace_id: id, label: "same", pane_count: 1, tab_count: 1 })),
        panes: [["a", a.root], ["b", b.root]].map(([id, cwd]) => ({ workspace_id: id!, tab_id: `${id}:t1`, pane_id: `${id}:p1`, cwd })),
        agents: [
          { display_agent: "arch", agent: "codex", workspace_id: "a", pane_id: "a:p1" },
          { display_agent: "arch", agent: "claude", workspace_id: "b", pane_id: "b:p1" },
          { name: "outsider", display_agent: "arch", agent: "codex", workspace_id: "a", pane_id: "a:p2" },
        ],
      });
      expect(refreshSessionSidebar(herdr)).toEqual({ updated: 2, failed: 0 });
      expect(herdr.state.agents[0]!.tokens).toMatchObject({ team_harness: "codex", team_model: "sol-6.1" });
      expect(herdr.state.agents[1]!.tokens).toMatchObject({ team_harness: "claude", team_model: "other-model" });
      expect(herdr.state.agents[2]!.tokens).toBeUndefined();
      expect(herdr.calls.some((call) => call.startsWith("agent start") || call.startsWith("agent prompt"))).toBe(false);
    } finally { a.cleanup(); b.cleanup(); }
  });

  test("非团队目录、缺失 cwd 或不在 Herdr 中不猜归属", () => {
    const herdr = fakeHerdr({
      panes: [{ workspace_id: "a", tab_id: "a:t1", pane_id: "a:p1", cwd: "/nonexistent/herdr-team-sidebar-test" }],
      agents: [{ name: "arch", agent: "codex", pane_id: "a:p1", workspace_id: "a" }],
    });
    expect(refreshSessionSidebar(herdr)).toEqual({ updated: 0, failed: 0 });
    expect(herdr.calls).toEqual([]);
    herdr.paneList = () => { throw new Error("must not query outside Herdr"); };
    herdr.state.envOk = false;
    expect(refreshSessionSidebar(herdr)).toEqual({ updated: 0, failed: 0 });
  });
});

import { describe, expect, test } from "bun:test";
import { loadProject } from "../scripts/lib/config.ts";
import { dispatch, up } from "../scripts/lib/launch.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { refreshSidebar } from "../scripts/lib/sidebar.ts";
import { fakeHerdr, makeProject, roleMeta, runningWorkspace, taskMeta, twoResidentRoles, writeRole, writeTask } from "./helpers.ts";

describe("agent sidebar 的两行信息", () => {
  test("角色与 harness 独立，模型不再拼进角色名，无任务时清空旧 ID", () => {
    const { root, cleanup } = makeProject();
    try {
      twoResidentRoles(root);
      const herdr = runningWorkspace();
      herdr.state.agents[0]!.tokens = { team_task: "#9999" };
      up(loadProject(root), herdr);
      expect(herdr.state.agents[0]).toMatchObject({ name: "dev", display_agent: "dev",
        tokens: { team_harness: "codex", team_model: "sol-6.1" } });
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
      expect(herdr.state.agents[0]!.tokens?.team_task).toBe("#0001");
      expect(herdr.state.agents[1]!.tokens?.team_task).toBeUndefined();
      handoff(loadProject(root), herdr, "0001");
      expect(herdr.state.agents[0]!.tokens?.team_task).toBeUndefined();
      expect(herdr.state.agents[1]!.tokens?.team_task).toBe("#0001");
      handoff(loadProject(root), herdr, "0001");
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
      expect(herdr.state.agents.map((agent) => [agent.name, agent.display_agent, agent.tokens])).toMatchObject([
        ["dev-0001", "dev", { team_harness: "codex", team_model: "sol-6.1", team_task: "#0001" }],
        ["dev-0002", "dev", { team_harness: "codex", team_model: "sol-6.1", team_task: "#0002" }],
      ]);
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
      writeRole(root, "dev", roleMeta({ model: "new-model" }));
      refreshSidebar(loadProject(root), herdr);
      expect(herdr.state.agents[0]!.tokens?.team_model).toBe("new-model");
    } finally { cleanup(); }
  });
});

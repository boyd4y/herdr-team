import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { HerdrError, realHerdr } from "../scripts/lib/herdr.ts";
import { dispatch, up } from "../scripts/lib/launch.ts";
import { buildReport } from "../scripts/lib/status.ts";
import { buildModel, formatStatusLine, frameText, renderFrame } from "../scripts/lib/watch.ts";
import { fakeHerdr, makeProject, taskMeta, twoResidentRoles, twoRoles, writeTask } from "./helpers.ts";

const WATCH_STATE = {
  showAll: false, query: "", searching: false, selectedId: null, selectedIndex: 0, detailScroll: 0, loadError: null,
};
const ACTIVITY_FLAGS = ["--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"];

for (const isolated of [false, true]) {
  describe(`dispatch 启动确认（${isolated ? "隔离" : "常驻"}角色）`, () => {
    function fixture() {
      const project = makeProject();
      (isolated ? twoRoles : twoResidentRoles)(project.root);
      writeTask(project.root, "0001-a", taskMeta());
      const herdr = fakeHerdr();
      if (!isolated) herdr.live("dev");
      const load = () => loadProject(project.root);
      const body = () => readFileSync(join(project.root, ".herdr/tasks/0001-a/task.md"), "utf8");
      const model = () => buildModel(load(), herdr, WATCH_STATE, "", 0);
      return { ...project, herdr, load, body, model };
    }

    test.each(["working", "blocked"])("确认 %s 前不写 doing；之后真正空闲仍报没交棒", (activity) => {
      const f = fixture();
      try {
        const originalBody = f.body();
        const calls: string[][] = [];
        // 经过真实参数适配器，在 Herdr 等待输入生效时读取磁盘上的卡，
        // 不依赖调用方内存里的旧 TaskCard，也不需要真实 agent 或计时等待。
        f.herdr.agentPrompt = realHerdr((args) => {
          calls.push(args);
          expect(args[2]).toBe(f.herdr.state.agents.find((agent) => agent.name === (isolated ? "dev-0001" : "dev"))?.pane_id);
          expect(args.slice(4)).toEqual(ACTIVITY_FLAGS);
          expect(f.herdr.state.agents[0]?.agent_status).toBe("idle");
          expect(f.load().tasks[0]?.status).toBe("todo");
          expect(f.body()).toBe(originalBody);
          expect(buildReport(f.load(), f.herdr, false).inconsistencies).toEqual([]);
          expect(frameText(renderFrame(f.model(), { width: 100, height: 40, color: false })))
            .not.toContain("maybe-finished");
          expect(formatStatusLine(f.model())).not.toContain("blocked");
          f.herdr.state.agents[0]!.agent_status = activity;
          return { code: 0, stdout: "", stderr: "" };
        }).agentPrompt;

        expect(dispatch(f.load(), f.herdr)[0]?.action).toBe("dispatched");
        expect(calls).toHaveLength(1);
        expect(f.load().tasks[0]?.status).toBe("doing");
        expect(f.body()).toContain("(todo → doing)");
        expect(f.model().inconsistencies.map((i) => i.kind)).toEqual(activity === "blocked" ? ["blocked"] : []);

        for (const status of ["idle", "done"]) {
          f.herdr.state.agents[0]!.agent_status = status;
          expect(buildReport(f.load(), f.herdr, false).inconsistencies)
            .toMatchObject([{ id: "0001", kind: "maybe-finished" }]);
          expect(frameText(renderFrame(f.model(), { width: 100, height: 40, color: false })))
            .toContain("maybe-finished");
          expect(formatStatusLine(f.model())).toBe("team: 1 doing · 1 blocked");
        }
      } finally {
        f.cleanup();
      }
    });

    test.each(["agent_prompt_stalled", "timeout"])("%s 仍派出，只提示未确认；没开工仍报 maybe-finished", (code) => {
      const f = fixture();
      try {
        let prompts = 0;
        f.herdr.agentPrompt = realHerdr(() => {
          prompts += 1;
          expect(f.load().tasks[0]?.status).toBe("todo");
          return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
        }).agentPrompt;
        expect(dispatch(f.load(), f.herdr)).toMatchObject([{
          id: "0001", action: "dispatched", reason: `未能确认已开工（${code}）`,
        }]);
        expect(prompts).toBe(1);
        expect(f.load().tasks[0]?.status).toBe("doing");
        expect(f.body().match(/\(todo → doing\)/g)).toHaveLength(1);
        expect(buildReport(f.load(), f.herdr, false).inconsistencies)
          .toMatchObject([{ id: "0001", kind: "maybe-finished" }]);
        expect(frameText(renderFrame(f.model(), { width: 100, height: 40, color: false })))
          .toContain("maybe-finished");
        // 慢启动最终进入 working 后，原有的安全网自然消除提示。
        f.herdr.state.agents[0]!.agent_status = "working";
        expect(f.model().inconsistencies).toEqual([]);
      } finally {
        f.cleanup();
      }
    });

    test.each(["agent_blocked", "agent_not_found", "pane_not_found", "unknown_error"])("%s 保留 todo 和原记录，不报派出成功", (code) => {
      const f = fixture();
      try {
        const originalBody = f.body();
        f.herdr.agentPrompt = realHerdr(() => ({
          code: 1, stdout: "", stderr: JSON.stringify({ error: { code, message: "timeout agent_prompt_stalled" } }),
        })).agentPrompt;
        expect(() => dispatch(f.load(), f.herdr)).toThrow(HerdrError);
        expect(f.load().tasks[0]?.status).toBe("todo");
        expect(f.body()).toBe(originalBody);
        expect(f.model().inconsistencies).toEqual([]);
      } finally {
        f.cleanup();
      }
    });
  });
}

test("up 和 handoff 仍只提交输入，不添加活动等待", () => {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    const herdr = fakeHerdr();
    const calls: string[][] = [];
    herdr.agentPrompt = realHerdr((args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }).agentPrompt;
    up(loadProject(root), herdr);
    writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] }));
    expect(handoff(loadProject(root), herdr, "0001").prompted).toBe(true);
    expect(loadProject(root).tasks[0]?.status).toBe("review");
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(0, 3)).toEqual(["agent", "prompt", herdr.state.agents.find((agent) => agent.name === "docs")?.pane_id]);
      expect(args).toHaveLength(4);
    }
  } finally {
    cleanup();
  }
});

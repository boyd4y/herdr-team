import { describe, expect, test } from "bun:test";
import { loadProject } from "../scripts/lib/team/project.ts";
import { dispatch, down, up } from "../scripts/lib/dispatch/launch.ts";
import { buildReport } from "../scripts/lib/ui/status.ts";
import { type Project } from "../scripts/lib/shared/types.ts";
import { fakeHerdr, makeProject, runningWorkspace, taskMeta, twoRoles, writeTask } from "./helpers.ts";

/** 项目里 dev 是隔离角色（worktree: true），docs 常驻。 */
function withProject(build: (root: string) => void, run: (p: Project) => void): void {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    build(root);
    run(loadProject(root));
  } finally {
    cleanup();
  }
}

describe("up —— 隔离角色不预起", () => {
  test("常驻角色起 tab，隔离角色 deferred", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      const result = up(p, herdr);

      const dev = result.roles.find((r) => r.role === "dev");
      const docs = result.roles.find((r) => r.role === "docs");
      expect(dev?.action).toBe("deferred");
      expect(dev?.paneId).toBeNull();
      expect(docs?.action).toBe("started");

      expect(herdr.calls.some((c) => c.startsWith("agent start dev"))).toBe(false);
      expect(herdr.calls.some((c) => c.startsWith("agent start docs"))).toBe(true);
      expect(herdr.calls.some((c) => c.startsWith("worktree create"))).toBe(false);
    });
  });
});

describe("派活 —— 隔离角色按任务开 worktree", () => {
  const oneTask = (root: string) => writeTask(root, "0001-fix-login", taskMeta({ title: "修登录" }));

  test("up 有 todo 卡也不派活、不起 worktree、不改卡", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      const result = up(p, herdr);
      expect(result).not.toHaveProperty("dispatched");
      expect(herdr.calls.some((c) => c.startsWith("worktree create"))).toBe(false);
      expect(herdr.calls.some((c) => c.startsWith("agent prompt dev-"))).toBe(false);
      expect(loadProject(p.root).tasks[0]?.status).toBe("todo");
    });
  });

  test("agent 启动失败后 dispatch 复用原 worktree，重试成功", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      const start = herdr.agentStart;
      herdr.agentStart = () => { throw new Error("agent_pane_busy"); };
      expect(dispatch(p, herdr)[0]?.reason).toContain("agent_pane_busy");
      expect(loadProject(p.root).tasks[0]?.status).toBe("todo");
      herdr.agentStart = start;
      expect(dispatch(loadProject(p.root), herdr)[0]?.action).toBe("dispatched");
      expect(herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(1);
      expect(loadProject(p.root).tasks[0]?.status).toBe("doing");
    });
  });

  test("已有 checkout 但 workspace 已关闭时说明原因，不重复创建", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      const made = herdr.worktreeCreate(p.root, "feat/0001-fix-login", "feat/0001-fix-login");
      herdr.state.workspaces = [];
      const result = dispatch(p, herdr);
      expect(result[0]?.reason).toContain("workspace is closed");
      expect(herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(1);
      expect(herdr.calls).not.toContain(`worktree remove ${made.workspaceId}`);
      expect(loadProject(p.root).tasks[0]?.status).toBe("todo");
    });
  });

  test("repo 不存在就不派，并说明原因", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ repo: "not-here" })),
      (p) => {
        const out = dispatch(p, fakeHerdr());
        expect(out[0]?.action).toBe("queued");
        expect(out[0]?.reason).toContain("not-here");
      },
    );
  });
});

describe("down —— 只关停 agent，不动 workspace", () => {
  test("关掉我们认得的 agent", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace(); // 里面跑着 dev 和 docs
      const result = down(p, herdr);
      expect(result.stopped.map((s) => s.agent).sort()).toEqual(["dev", "docs"]);
      expect(herdr.calls).toContain("pane close w1:p1");
      expect(herdr.calls).toContain("pane close w1:p2");
    });
  });

  test("**workspace 绝对不动** —— 那是用户的项目容器", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      down(p, herdr);
      expect(herdr.calls.some((c) => c.startsWith("workspace close"))).toBe(false);
    });
  });

  test("用户自己的 agent 不碰", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      herdr.live("my-own-thing", "w1:p9");
      const result = down(p, herdr);
      expect(result.stopped.some((s) => s.agent === "my-own-thing")).toBe(false);
      expect(herdr.calls).not.toContain("pane close w1:p9");
    });
  });

  test("隔离角色的 <role>-<id> 认得出", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      herdr.live("dev-0001", "w1:p7");
      const result = down(p, herdr);
      expect(result.stopped.some((s) => s.agent === "dev-0001")).toBe(true);
    });
  });

  test("`dev-whatever` 不是任务 id —— 不认（别误伤）", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      herdr.live("dev-whatever", "w1:p8");
      const result = down(p, herdr);
      expect(result.stopped.some((s) => s.agent === "dev-whatever")).toBe(false);
      expect(herdr.calls).not.toContain("pane close w1:p8");
    });
  });

  test("没有 agent 在跑就是空结果，不是错误", () => {
    withProject(() => {}, (p) => {
      const result = down(p, fakeHerdr());
      expect(result.stopped).toEqual([]);
    });
  });

  test("不在 Herdr 里就拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() => down(p, fakeHerdr({ envOk: false }))).toThrow(/HERDR_ENV/);
    });
  });
});

describe("status 认识隔离角色", () => {
  test("隔离角色标 per-task，不报『缺 agent』", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing" })),
      (p) => {
        const report = buildReport(p, fakeHerdr(), false);
        const dev = report.roles.find((r) => r.role === "dev");
        expect(dev?.worktree).toBe(true);
        expect(dev?.herdrStatus).toBe("per-task");
      },
    );
  });

  test("doing 但 worktree agent 不在 —— 仍然报", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing" })),
      (p) => {
        const report = buildReport(p, fakeHerdr(), false);
        expect(report.inconsistencies.some((i) => i.kind === "agent-missing")).toBe(true);
        expect(report.inconsistencies.find((i) => i.kind === "agent-missing")?.message).toContain("dev-0001");
      },
    );
  });
});

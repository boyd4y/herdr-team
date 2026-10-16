import { describe, expect, test } from "bun:test";
import { loadProject } from "../scripts/lib/config.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { agentNameFor, dispatch, down, up } from "../scripts/lib/launch.ts";
import { buildReport } from "../scripts/lib/status.ts";
import { worktreeBranch, type Project } from "../scripts/lib/types.ts";
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

describe("worktreeBranch", () => {
  test("分支名一眼看出是哪个 feature", () => {
    withProject(
      (root) => writeTask(root, "0001-fix-login", taskMeta()),
      (p) => expect(worktreeBranch(p.tasks[0]!)).toBe("feat/0001-fix-login"),
    );
  });
});

describe("agentNameFor", () => {
  test("隔离角色带任务 id —— 同一角色能同时在多个任务上", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta()),
      (p) => expect(agentNameFor(p, p.tasks[0]!)).toBe("dev-0001"),
    );
  });

  test("常驻角色就是角色名", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs" })),
      (p) => expect(agentNameFor(p, p.tasks[0]!)).toBe("docs"),
    );
  });
});

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
      expect(result[0]?.reason).toContain("workspace 已关闭");
      expect(herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(1);
      expect(herdr.calls).not.toContain(`worktree remove ${made.workspaceId}`);
      expect(loadProject(p.root).tasks[0]?.status).toBe("todo");
    });
  });

  test("开 worktree，分支名是 feat/<id>-<slug>", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      const out = dispatch(p, herdr);
      const created = herdr.calls.find((c) => c.startsWith("worktree create"));
      expect(created).toContain("branch=feat/0001-fix-login");
      expect(out[0]?.branch).toBe("feat/0001-fix-login");
    });
  });

  test("workspace 的 label 用分支名（feature 名）", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      dispatch(p, herdr);
      const created = herdr.calls.find((c) => c.startsWith("worktree create"));
      expect(created).toContain("label=feat/0001-fix-login");
    });
  });

  test("agent 名是 <role>-<id>", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      dispatch(p, herdr);
      expect(herdr.calls.some((c) => c.startsWith("agent start dev-0001"))).toBe(true);
      expect(herdr.calls.some((c) => c.startsWith("agent prompt dev-0001"))).toBe(true);
    });
  });

  test("隔离 agent 只报名字，不带模型（省空间）", () => {
    withProject(oneTask, (p) => {
      const herdr = fakeHerdr();
      dispatch(p, herdr);
      expect(herdr.calls.some((c) => c.startsWith("report-metadata") && c.endsWith(" dev-0001"))).toBe(true);
    });
  });

  test("两个任务各开一个 worktree，互不打架", () => {
    withProject(
      (root) => {
        writeTask(root, "0001-a", taskMeta({ title: "甲" }));
        writeTask(root, "0002-b", taskMeta({ title: "乙" }));
      },
      (p) => {
        const herdr = fakeHerdr();
        dispatch(p, herdr);
        expect(herdr.calls.filter((c) => c.startsWith("worktree create"))).toHaveLength(2);
        expect(herdr.calls.some((c) => c.startsWith("agent start dev-0001"))).toBe(true);
        expect(herdr.calls.some((c) => c.startsWith("agent start dev-0002"))).toBe(true);
      },
    );
  });

  test("worktree 建好后卡变 doing，流转记录写的是 agent 名", () => {
    withProject(oneTask, (p) => {
      dispatch(p, fakeHerdr());
      const after = loadProject(p.root).tasks[0];
      expect(after?.status).toBe("doing");
      const body = require("node:fs").readFileSync(`${p.herdrDir}/tasks/0001-fix-login/task.md`, "utf8") as string;
      expect(body).toContain("dev-0001");
    });
  });

  test("常驻角色不开 worktree，仍用 tab agent", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs" })),
      (p) => {
        const herdr = fakeHerdr();
        herdr.live("docs");
        dispatch(p, herdr);
        expect(herdr.calls.some((c) => c.startsWith("worktree create"))).toBe(false);
        expect(herdr.calls.some((c) => c.startsWith("agent prompt docs"))).toBe(true);
      },
    );
  });

  test("repo 不存在就不派，并说明原因", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ repo: "not-here" })),
      (p) => {
        const out = dispatch(p, fakeHerdr());
        expect(out[0]?.action).toBe("no-agent");
        expect(out[0]?.reason).toContain("not-here");
      },
    );
  });
});

describe("handoff 到隔离角色", () => {
  test("目标是 <role>-<id>，不是角色名", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing", role: "docs", handoff: ["dev"] })),
      (p) => {
        const herdr = fakeHerdr();
        herdr.live("docs");
        herdr.live("dev-0001", "w9:p1");
        const result = handoff(p, herdr, "0001");

        expect(result.to).toBe("dev");
        expect(herdr.calls.some((c) => c.startsWith("agent prompt dev-0001"))).toBe(true);
      },
    );
  });

  test("隔离 agent 不在时，请 lead 把 review 卡重排为 todo 再 dispatch", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing", role: "docs", handoff: ["dev"] })),
      (p) => {
        const herdr = fakeHerdr();
        herdr.live("docs");
        const result = handoff(p, herdr, "0001");

        expect(result.prompted).toBe(false);
        expect(result.note).toContain("feat/0001-a");
        expect(result.note).toContain("请 lead");
        expect(result.note).toContain("edit 0001 --status todo --force");
        expect(result.note).toContain("dispatch 0001");
        expect(result.status).toBe("review");
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

describe("up —— deferred 的 reported 是 null，不是 false", () => {
  test("隔离角色没起，就不该被报成上报失败", () => {
    withProject(() => {}, (p) => {
      const deferred = up(p, fakeHerdr()).roles.find((r) => r.action === "deferred");
      expect(deferred?.role).toBe("dev");
      expect(deferred?.reported).toBeNull();
    });
  });
});

import { describe, expect, test } from "bun:test";
import { loadProject } from "../scripts/lib/config.ts";
import { dispatch, up } from "../scripts/lib/launch.ts";
import { buildReport } from "../scripts/lib/status.ts";
import { type Project } from "../scripts/lib/types.ts";
import { fakeHerdr, makeProject, runningWorkspace, taskMeta, twoResidentRoles, writeTask } from "./helpers.ts";

function withProject(build: (root: string) => void, run: (p: Project) => void): void {
  const { root, cleanup } = makeProject(); // 目录名 myproj → workspace label
  try {
    twoResidentRoles(root);
    build(root);
    run(loadProject(root));
  } finally {
    cleanup();
  }
}

describe("up —— 幂等：先找后建", () => {
  test("没有同名 workspace 时新建", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      const result = up(p, herdr);
      expect(result.workspaceAction).toBe("created");
      expect(herdr.calls.some((c) => c.startsWith("workspace create myproj"))).toBe(true);
    });
  });

  test("已有同名 workspace 时复用，**不新建**", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      const result = up(p, herdr);
      expect(result.workspaceAction).toBe("reused");
      expect(result.workspaceId).toBe("w1");
      expect(herdr.calls.some((c) => c.startsWith("workspace create"))).toBe(false);
    });
  });

  test("已有同名 tab 时复用它，不新建", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      up(p, herdr);
      expect(herdr.calls.some((c) => c.startsWith("tab create") && !c.startsWith("tab create Team Console"))).toBe(false);
    });
  });

  test("已在跑的 agent 不重启，但**仍然重新上报 metadata**", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      up(p, herdr);
      expect(herdr.calls.some((c) => c.startsWith("agent start"))).toBe(false);
      // 名字或 model 改过时，不重报就永远不生效
      expect(herdr.calls).toContain("report-metadata w1:p1 dev");
      expect(herdr.calls).toContain("report-metadata w1:p2 docs");
    });
  });

  test("角色的 env 被交给 tab create", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      up(p, herdr);
      const created = herdr.calls.find((c) => c.startsWith("tab create docs"));
      expect(created).toContain('"ANTHROPIC_MODEL":"deepseek-flash"');
    });
  });

  test("agent 的 args 透传", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      up(p, herdr);
      const started = herdr.calls.find((c) => c.startsWith("agent start dev"));
      expect(started).toContain('["-m","gpt-6.1-sol"]');
    });
  });

  test("不在 Herdr 的 pane 里就拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() => up(p, fakeHerdr({ envOk: false }))).toThrow(/HERDR_ENV/);
    });
  });

  test("没有角色时拒绝", () => {
    const { root, cleanup } = makeProject();
    try {
      expect(() => up(loadProject(root), fakeHerdr())).toThrow(/No roles/);
    } finally {
      cleanup();
    }
  });
});

describe("派活", () => {
  const withTasks = withProject;

  test("dispatch 不在 Herdr pane 里拒绝", () => {
    withTasks(() => {}, (p) => {
      expect(() => dispatch(p, fakeHerdr({ envOk: false }))).toThrow(/HERDR_ENV/);
    });
  });
});

describe("status", () => {
  const withTasks = withProject;

  test("doing 但 agent 空闲 —— 报不一致", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing" })),
      (p) => {
        const herdr = runningWorkspace();
        expect(buildReport(p, herdr, false).inconsistencies.some((i) => i.kind === "maybe-finished")).toBe(true);
      },
    );
  });

  test("doing 但 agent blocked —— 报需要你", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing" })),
      (p) => {
        const herdr = runningWorkspace();
        herdr.state.agents[0]!.agent_status = "blocked";
        expect(buildReport(p, herdr, false).inconsistencies.some((i) => i.kind === "blocked")).toBe(true);
      },
    );
  });

  test("doing 但没有 agent —— 报掉了", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing" })),
      (p) => {
        expect(buildReport(p, fakeHerdr(), false).inconsistencies.some((i) => i.kind === "agent-missing")).toBe(true);
      },
    );
  });
});

describe("up —— 一个角色起不来不该把整轮带崩", () => {
  test("agent start 失败时记下来，其余角色照常起", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      const real = herdr.agentStart.bind(herdr);
      herdr.agentStart = (name, kind, pane, args) => {
        if (name === "docs") throw new Error("agent target pane is not an available shell");
        real(name, kind, pane, args);
      };

      const result = up(p, herdr); // 不该抛

      const failedRole = result.roles.find((r) => r.role === "docs");
      expect(failedRole?.action).toBe("failed");
      expect(failedRole?.failure).toContain("available shell");
      expect(failedRole?.reported).toBeNull();
      // 其他角色照样起来了
      expect(result.roles.some((r) => r.role === "dev" && r.action === "started")).toBe(true);
    });
  });

});

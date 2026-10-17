import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadProject } from "../scripts/lib/config.ts";
import { dispatch, LaunchError, up, workspaceLabelFor } from "../scripts/lib/launch.ts";
import { buildReport } from "../scripts/lib/status.ts";
import { TASK_BODY, type Project } from "../scripts/lib/types.ts";
import { fakeHerdr, makeProject, runningWorkspace, taskMeta, twoResidentRoles, twoRoles, writeTask } from "./helpers.ts";

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

describe("workspaceLabelFor", () => {
  test("取项目根目录名", () => {
    withProject(() => {}, (p) => expect(workspaceLabelFor(p)).toBe("myproj"));
  });
});

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

  test("同一项目目录的多个 workspace 无法确定归属时拒绝，不猜", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr({
        workspaces: [
          { workspace_id: "w1", label: "myproj", pane_count: 1, tab_count: 1 },
          { workspace_id: "w2", label: "myproj", pane_count: 1, tab_count: 1 },
        ],
        panes: [
          { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: p.root },
          { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", cwd: p.root },
        ],
      });
      expect(() => up(p, herdr)).toThrow(/resolve ownership/);
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

  test("第一个角色用 workspace 自带的 root tab（改名复用）", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      const result = up(p, herdr);
      expect(result.roles[0]?.paneId.endsWith(":p1")).toBe(true);
      expect(herdr.calls.some((c) => c.startsWith("tab rename") && c.endsWith("dev"))).toBe(true);
      expect(herdr.calls.filter((c) => c.startsWith("tab create"))).toHaveLength(2);
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

  test("指定 id 只派该卡，保留依赖检查", () => {
    withTasks(
      (root) => {
        writeTask(root, "0001-a", taskMeta());
        writeTask(root, "0002-b", taskMeta({ depends_on: ["0001"] }));
      },
      (p) => {
        const herdr = runningWorkspace();
        expect(dispatch(p, herdr, "0002")[0]?.action).toBe("waiting-on-deps");
        expect(dispatch(p, herdr, "0001").map((d) => d.id)).toEqual(["0001"]);
        expect(loadProject(p.root).tasks.find((t) => t.id === "0002")?.status).toBe("todo");
      },
    );
  });

  test.each(["doing", "review", "done", "cancelled"])("指定非 todo 卡（%s）报错", (status) => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta({ status })),
      (p) => {
        const herdr = runningWorkspace();
        expect(() => dispatch(p, herdr, "0001")).toThrow(new RegExp(`${status}.*todo`));
        expect(herdr.calls).toEqual([]);
      },
    );
  });

  test("未知 id 报错，且不派其他卡", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta()),
      (p) => {
        const herdr = runningWorkspace();
        expect(() => dispatch(p, herdr, "9999")).toThrow(/9999/);
        expect(herdr.calls).toEqual([]);
        expect(loadProject(p.root).tasks[0]?.status).toBe("todo");
      },
    );
  });

  test("dispatch 不在 Herdr pane 里拒绝", () => {
    withTasks(() => {}, (p) => {
      expect(() => dispatch(p, fakeHerdr({ envOk: false }))).toThrow(/HERDR_ENV/);
    });
  });

  test("按 priority 升序派", () => {
    withTasks(
      (root) => {
        writeTask(root, "0001-a", taskMeta());
        writeTask(root, "0002-b", taskMeta({ priority: "P0" }));
      },
      (p) => {
        const herdr = runningWorkspace();
        expect(dispatch(p, herdr).map((d) => d.id)).toEqual(["0002", "0001"]);
      },
    );
  });

  test("depends_on 未满足就等", () => {
    withTasks(
      (root) => {
        writeTask(root, "0001-a", taskMeta());
        writeTask(root, "0002-b", taskMeta({ depends_on: ["0001"] }));
      },
      (p) => {
        const out = dispatch(p, runningWorkspace());
        expect(out.find((d) => d.id === "0002")?.action).toBe("waiting-on-deps");
      },
    );
  });

  test("依赖已终态就算满足", () => {
    withTasks(
      (root) => {
        writeTask(root, "0001-a", taskMeta({ status: "done" }));
        writeTask(root, "0002-b", taskMeta({ depends_on: ["0001"] }));
      },
      (p) => {
        const out = dispatch(p, runningWorkspace());
        expect(out.find((d) => d.id === "0002")?.action).toBe("dispatched");
      },
    );
  });

  test("角色没有存活 agent 就不派", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta()),
      (p) => {
        expect(dispatch(p, fakeHerdr())[0]?.action).toBe("queued");
      },
    );
  });

  test("派出去后变 doing 并追加流转记录", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta()),
      (p) => {
        dispatch(p, runningWorkspace());
        const after = loadProject(p.root).tasks[0];
        expect(after?.status).toBe("doing");
        const body = readFileSync(
          `${p.herdrDir}/tasks/0001-a/${TASK_BODY}`,
          "utf8",
        ) as string;
        expect(body).toContain("(todo → doing)");
      },
    );
  });

  test("派活说明含卡片目录和交棒要求", () => {
    withTasks(
      (root) => writeTask(root, "0001-a", taskMeta()),
      (p) => {
        const herdr = runningWorkspace();
        dispatch(p, herdr);
        expect(herdr.calls.some((c) => c.startsWith(`agent prompt ${herdr.state.agents.find((agent) => agent.name === "dev")?.pane_id}`))).toBe(true);
      },
    );
  });
});

describe("status", () => {
  const withTasks = withProject;
  const done = taskMeta({ status: "done" });

  test("默认隐藏终态", () => {
    withTasks(
      (root) => {
        writeTask(root, "0001-a", taskMeta());
        writeTask(root, "0002-b", done);
      },
      (p) => expect(buildReport(p, runningWorkspace(), false).tasks.map((t) => t.id)).toEqual(["0001"]),
    );
  });

  test("--all 显示全部", () => {
    withTasks(
      (root) => {
        writeTask(root, "0001-a", taskMeta());
        writeTask(root, "0002-b", done);
      },
      (p) => expect(buildReport(p, runningWorkspace(), true).tasks).toHaveLength(2),
    );
  });

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

describe("up 只启动，不发送消息", () => {
  test("新起的常驻 agent 不收到身份说明，侧栏信息仍更新", () => {
    withProject(() => {}, (p) => {
      const herdr = fakeHerdr();
      const result = up(p, herdr);
      expect(result.roles.every((role) => role.action === "started" && role.reported)).toBe(true);
      expect(herdr.calls.some((c) => c.startsWith("agent prompt"))).toBe(false);
    });
  });

  test("已经在跑的 agent **不重发** —— 会打断它手头的事", () => {
    withProject(() => {}, (p) => {
      const herdr = runningWorkspace();
      up(p, herdr);
      expect(herdr.calls.some((c) => c.startsWith("agent prompt"))).toBe(false);
    });
  });
});

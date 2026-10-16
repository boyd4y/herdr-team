import { describe, expect, test } from "bun:test";
import { cleanupAll, cleanupIfDone, cleanupTask } from "../scripts/lib/cleanup.ts";
import { loadProject } from "../scripts/lib/config.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { dispatch } from "../scripts/lib/launch.ts";
import { worktreeBranch, type Project } from "../scripts/lib/types.ts";
import { fakeHerdr, makeProject, taskMeta, twoRoles, writeTask } from "./helpers.ts";

function withProject(build: (root: string) => void, run: (p: Project) => void): void {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root); // dev 隔离，docs 常驻
    build(root);
    run(loadProject(root));
  } finally {
    cleanup();
  }
}

/** 派活 → 真的建出 worktree 的现场。 */
function dispatched(root: string, statusAfter = "todo"): void {
  writeTask(root, "0001-fix-login", taskMeta({ status: statusAfter, title: "修登录" }));
}

function withWorktree(build: (root: string) => void, run: (p: Project, h: ReturnType<typeof fakeHerdr>) => void): void {
  withProject(build, (p) => {
    const herdr = fakeHerdr();
    dispatch(p, herdr); // 建出 worktree
    run(loadProject(p.root), herdr);
  });
}

describe("cleanupTask", () => {
  test("终态任务收掉 worktree，分支保留", () => {
    withWorktree(dispatched, (p, herdr) => {
      const card = { ...p.tasks[0]!, status: "done" };
      const result = cleanupTask(p, herdr, card);

      expect(result.action).toBe("removed");
      expect(result.branch).toBe("feat/0001-fix-login");
      expect(herdr.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
      // 分支不在 handoff 的职责里 —— Herdr 的 worktree remove 本来就不删分支
      expect(herdr.calls.some((c) => c.includes("force"))).toBe(false);
    });
  });

  test("没建过 worktree 就什么都不做", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "done" })),
      (p) => {
        const result = cleanupTask(p, fakeHerdr(), p.tasks[0]!);
        expect(result.action).toBe("absent");
      },
    );
  });

  test.each(["docs", "retired"])("当前角色 %s 不决定 worktree 是否存在", (role) => {
    withWorktree(dispatched, (p, herdr) => {
      const card = { ...p.tasks[0]!, role, status: "done" };
      const result = cleanupTask(p, herdr, card);

      expect(result.action).toBe("removed");
      expect(herdr.branches.size).toBe(0);
      expect(herdr.calls.some((c) => c.includes("force"))).toBe(false);
    });
  });

  test("常驻角色没有对应分支时报 absent，其他 worktree 不动", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs", status: "done" })),
      (p) => {
        const herdr = fakeHerdr();
        const made = herdr.worktreeCreate(p.root, "feat/0002-other", "other");
        const result = cleanupTask(p, herdr, p.tasks[0]!);
        expect(result.action).toBe("absent");
        expect(herdr.branches.get(made.workspaceId)).toBe("feat/0002-other");
        expect(herdr.calls.some((c) => c.startsWith("worktree remove"))).toBe(false);
      },
    );
  });

  test("Git 拒绝时不 force，只报出来", () => {
    withWorktree(dispatched, (p, herdr) => {
      herdr.state.removeFails = true;
      const result = cleanupTask(p, herdr, { ...p.tasks[0]!, status: "done" });

      expect(result.action).toBe("dirty");
      expect(result.note).toContain("未提交");
      // 关键：**没有** force 删掉别人没提交的工作
      expect(herdr.calls.some((c) => c.includes("force"))).toBe(false);
    });
  });

  test("checkout 还在但 Herdr 里已关闭 —— 报出来让人手动收", () => {
    withWorktree(dispatched, (p, herdr) => {
      // 把 workspace 关掉，但 checkout 仍在
      const wsId = [...herdr.branches.entries()][0]?.[0];
      herdr.state.workspaces = herdr.state.workspaces.filter((w) => w.workspace_id !== wsId);

      const result = cleanupTask(p, herdr, { ...p.tasks[0]!, status: "done" });
      expect(result.action).toBe("closed");
      expect(result.note).toContain("git worktree remove");
    });
  });
});

describe("cleanupIfDone", () => {
  test("不是终态就不动", () => {
    withWorktree(dispatched, (p, herdr) => {
      const result = cleanupIfDone(p, herdr, p.tasks[0]!); // doing
      expect(result.action).toBe("not-terminal");
      expect(herdr.calls.some((c) => c.startsWith("worktree remove"))).toBe(false);
    });
  });

  test("终态才收", () => {
    withWorktree(dispatched, (p, herdr) => {
      expect(cleanupIfDone(p, herdr, { ...p.tasks[0]!, status: "done" }).action).toBe("removed");
    });
  });
});

describe("handoff 到终态时顺带回收", () => {
  test("隔离角色交给常驻角色，最后一次 handoff 才回收原 worktree", () => {
    withWorktree(
      (root) => writeTask(root, "0001-a", taskMeta({ handoff: ["docs"] })),
      (p, herdr) => {
        herdr.live("docs");
        const branch = worktreeBranch(p.tasks[0]!);
        expect([...herdr.branches.values()]).toContain(branch);

        const first = handoff(p, herdr, "0001");
        expect(first.status).toBe("review");
        expect(loadProject(p.root).tasks[0]?.role).toBe("docs");
        expect([...herdr.branches.values()]).toContain(branch);

        const last = handoff(loadProject(p.root), herdr, "0001");
        expect(last.status).toBe("done");
        expect(last.cleanup?.action).toBe("removed");
        expect(herdr.branches.size).toBe(0);
      },
    );
  });

  test("队列空 → done → 收 worktree", () => {
    withWorktree(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "review", role: "dev", handoff: [] })),
      (p, herdr) => {
        // 先手工造一个 worktree（review 状态时 worktree 应该还在）
        const branch = worktreeBranch(p.tasks[0]!);
        const made = herdr.worktreeCreate(p.root, branch, "x");

        const result = handoff(loadProject(p.root), herdr, "0001");
        expect(result.status).toBe("done");
        expect(result.cleanup?.action).toBe("removed");
        expect(herdr.calls.some((c) => c === `worktree remove ${made.workspaceId}`)).toBe(true);
      },
    );
  });

  test("中间交棒**不**回收 —— 活还没干完", () => {
    withWorktree(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing", role: "dev", handoff: ["docs"] })),
      (p, herdr) => {
        const made = herdr.worktreeCreate(p.root, worktreeBranch(p.tasks[0]!), "x");
        herdr.live("docs");
        const result = handoff(loadProject(p.root), herdr, "0001");

        expect(result.status).toBe("review");
        expect(result.cleanup).toBeUndefined();
        expect(herdr.calls.some((c) => c === `worktree remove ${made.workspaceId}`)).toBe(false);
      },
    );
  });

  test("回收失败时说得清楚，不静默吞掉", () => {
    withWorktree(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "review", role: "dev", handoff: [] })),
      (p, herdr) => {
        herdr.worktreeCreate(p.root, worktreeBranch(p.tasks[0]!), "x");
        herdr.state.removeFails = true;
        const result = handoff(loadProject(p.root), herdr, "0001");

        expect(result.status).toBe("done"); // 任务照样结束
        expect(result.cleanup?.action).toBe("dirty");
        expect(result.note).toContain("未提交");
      },
    );
  });

  test("常驻角色走到终态不报回收问题", () => {
    withWorktree(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "review", role: "docs", handoff: [] })),
      (p, herdr) => {
        herdr.live("docs");
        const result = handoff(loadProject(p.root), herdr, "0001");
        expect(result.cleanup?.action).toBe("absent");
        expect(result.note).not.toContain("⚠");
      },
    );
  });
});

describe("cleanupAll", () => {
  test("终态卡已交给常驻角色仍能回收，重复清理报 absent", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs", status: "done" })),
      (p) => {
        const herdr = fakeHerdr();
        const made = herdr.worktreeCreate(p.root, worktreeBranch(p.tasks[0]!), "task");

        expect(cleanupAll(p, herdr)[0]?.action).toBe("removed");
        expect(herdr.calls).toContain(`worktree remove ${made.workspaceId}`);
        expect(herdr.branches.size).toBe(0);
        expect(cleanupAll(p, herdr)[0]?.action).toBe("absent");
        expect(herdr.calls.filter((c) => c.startsWith("worktree remove"))).toHaveLength(1);
      },
    );
  });

  test("只扫终态任务", () => {
    withWorktree(
      (root) => {
        writeTask(root, "0001-a", taskMeta({ status: "done" }));
        writeTask(root, "0002-b", taskMeta({ status: "doing" }));
      },
      (p, herdr) => {
        const results = cleanupAll(p, herdr);
        expect(results).toHaveLength(1);
        expect(results[0]?.id).toBe("0001");
      },
    );
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { TASK_BODY, type Project } from "../scripts/lib/types.ts";
import { claimCurrent, fakeHerdr, makeProject, taskMeta, twoRoles, writeTask } from "./helpers.ts";

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

function bodyOf(p: Project, dir: string): string {
  return readFileSync(join(p.herdrDir, dir, TASK_BODY), "utf8");
}

describe("handoff —— 队列非空：交给下一个角色", () => {
  test("role 前进，status 变 review，下游收到 prompt", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] })), (p) => {
      const herdr = fakeHerdr();
      herdr.live("dev");
      herdr.live("docs");
      const prompts: string[] = [];
      const send = herdr.agentPrompt;
      herdr.agentPrompt = (target, text, options) => { prompts.push(text); send(target, text, options); };

      const result = handoff(p, herdr, "0001", new Date(2026, 9, 15, 1, 10));

      expect(result.from).toBe("dev");
      expect(result.to).toBe("docs");
      expect(result.status).toBe("review");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("我是谁");
      expect(prompts[0]).toContain("你是文档");
      expect(prompts[0]).toContain(join(p.herdrDir, "tasks/0001-a"));
      expect(herdr.calls.some((c) => c.startsWith(`agent prompt ${herdr.state.agents.find((agent) => agent.name === "docs-0001")?.pane_id}`))).toBe(true);
    });
  });

  test("回归：交给最后一个角色后**不能**直接标 done", () => {
    // 这是当初写反的算法 —— 队列空被当成"完成"，于是 docs 拿到一个已经 done 的任务。
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] })), (p) => {
      const herdr = fakeHerdr();
      herdr.live("docs");
      handoff(p, herdr, "0001");

      const after = loadProject(p.root).tasks[0];
      expect(after?.status).toBe("review");
      expect(after?.role).toBe("docs");
      expect(after?.handoff).toEqual([]);
    });
  });

  test("三段队列一次只前进一格", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs", "dev"] })),
      (p) => {
        handoff(p, fakeHerdr(), "0001");
        const after = loadProject(p.root).tasks[0];
        expect(after?.role).toBe("docs");
        expect(after?.handoff).toEqual(["dev"]);
      },
    );
  });

  test("下游没有存活 agent 时创建任务会话并交付", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] })), (p) => {
      const herdr = fakeHerdr(); // docs 不在
      const result = handoff(p, herdr, "0001");

      expect(herdr.calls.some((c) => c.startsWith("agent prompt"))).toBe(true);
      expect(result.prompted).toBe(true);
      expect(result.to).toBe("docs");
      expect(herdr.state.agents.some((agent) => agent.name === "docs-0001")).toBe(true);
      // 任务记录的是"该谁做"，不是"agent 在不在"
      expect(loadProject(p.root).tasks[0]?.role).toBe("docs");
    });
  });
});

describe("handoff —— 队列为空：收尾", () => {
  test("标 done，不 prompt 任何人", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "review", role: "docs", handoff: [] })), (p) => {
      const herdr = fakeHerdr();
      herdr.live("docs");
      const result = handoff(p, herdr, "0001");

      expect(result.status).toBe("done");
      expect(result.to).toBeNull();
      expect(herdr.calls.some((c) => c.startsWith("agent prompt"))).toBe(false);
      expect(loadProject(p.root).tasks[0]?.status).toBe("done");
    });
  });
});

describe("handoff —— 守卫", () => {
  test("终态拒绝", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "done" })), (p) => {
      expect(() => handoff(p, fakeHerdr(), "0001")).toThrow(/terminal/);
    });
  });

  test("cancelled 也拒绝", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "cancelled" })), (p) => {
      expect(() => handoff(p, fakeHerdr(), "0001")).toThrow(/terminal/);
    });
  });

  test("找不到的 id 报错", () => {
    withProject(() => {}, (p) => {
      expect(() => handoff(p, fakeHerdr(), "0099")).toThrow(/not found/);
    });
  });
});

describe("流转记录 —— 只追加，不重写散文", () => {
  test("追加一行，保留已有的", () => {
    withProject(
      (root) =>
        writeTask(
          root,
          "0001-a",
          taskMeta({ status: "doing", handoff: ["docs"] }),
          "任务描述",
        ),
      (p) => {
        handoff(p, fakeHerdr(), "0001", new Date(2026, 9, 15, 2, 5));
        const text = bodyOf(p, "tasks/0001-a");
        expect(text).toContain("## 流转记录");
        expect(text).toContain("- 2026-10-15 02:05  → docs  (doing → review)");
        // 描述没被动过
        expect(text).toContain("任务描述");
      },
    );
  });

  test("已有历史记录时接在后面，不覆盖", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] })), (p) => {
      // 先手工塞一条历史
      const herdr = fakeHerdr();
      herdr.live("docs");
      const first = handoff(p, herdr, "0001", new Date(2026, 9, 15, 1, 0));
      expect(first.status).toBe("review");

      // 再推进一次（队列已空）→ 收尾
      const reloaded = loadProject(p.root);
      handoff(reloaded, herdr, "0001", new Date(2026, 9, 15, 2, 0), { delivery: claimCurrent(p.root) });

      const text = bodyOf(p, "tasks/0001-a");
      expect(text).toContain("(doing → review)");
      expect(text).toContain("(review → done)");
    });
  });
});

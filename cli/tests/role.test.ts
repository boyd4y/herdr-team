import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { addRole, removeRole, RoleError, tasksUsingRole } from "../scripts/lib/role.ts";
import { ROLE_BODY, ROLE_META, type Project } from "../scripts/lib/types.ts";
import { validateProject } from "../scripts/lib/validate.ts";
import { makeProject, taskMeta, twoRoles, writeTask } from "./helpers.ts";

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

describe("addRole —— 运行期加角色", () => {
  test("元数据和正文都写出来", () => {
    withProject(() => {}, (p) => {
      const result = addRole(p, {
        name: "reviewer",
        kind: "codex",
        model: "luna",
        args: ["--no-daemon", "-m", "gpt-6-luna"],
        body: "你负责审查。",
      });
      expect(result.action).toBe("added");

      const dir = join(p.herdrDir, "roles/reviewer");
      expect(readFileSync(join(dir, ROLE_META), "utf8")).toContain("model: luna");
      expect(readFileSync(join(dir, ROLE_BODY), "utf8")).toContain("你负责审查");
    });
  });

  test("加完立刻通过校验 —— up 读的就是它", () => {
    withProject(() => {}, (p) => {
      addRole(p, { name: "reviewer", kind: "codex" });
      expect(validateProject(loadProject(p.root))).toEqual([]);
    });
  });

  test("worktree 标记能加上", () => {
    withProject(() => {}, (p) => {
      addRole(p, { name: "builder", kind: "codex", worktree: true });
      expect(loadProject(p.root).roles.find((r) => r.name === "builder")?.worktree).toBe(true);
    });
  });

  test("env 写成嵌套映射", () => {
    withProject(() => {}, (p) => {
      addRole(p, { name: "writer", kind: "claude", env: { ANTHROPIC_MODEL: "deepseek-flash" } });
      expect(loadProject(p.root).roles.find((r) => r.name === "writer")?.env).toEqual({
        ANTHROPIC_MODEL: "deepseek-flash",
      });
    });
  });

  test("已经存在就拒绝，别默默覆盖", () => {
    withProject(() => {}, (p) => {
      expect(() => addRole(p, { name: "dev", kind: "claude" })).toThrow(RoleError);
    });
  });

  test("--force 改元数据，但**不动手写的正文**", () => {
    withProject(() => {}, (p) => {
      const before = readFileSync(join(p.herdrDir, "roles/dev", ROLE_BODY), "utf8");
      addRole(p, { name: "dev", kind: "claude", force: true });
      expect(loadProject(p.root).roles.find((r) => r.name === "dev")?.kind).toBe("claude");
      expect(readFileSync(join(p.herdrDir, "roles/dev", ROLE_BODY), "utf8")).toBe(before);
    });
  });

  test("--force --body 只改职责，省略 kind 和启动配置则全部保留", () => {
    withProject(() => {}, (p) => {
      for (const name of ["dev", "docs"]) {
        const metaPath = join(p.herdrDir, "roles", name, ROLE_META);
        const before = readFileSync(metaPath, "utf8");
        addRole(p, { name, body: "新职责。\n\n完成后运行 `herdr-team handoff <id>`。", force: true });
        expect(readFileSync(metaPath, "utf8")).toBe(before);
        expect(readFileSync(join(p.herdrDir, "roles", name, ROLE_BODY), "utf8"))
          .toBe("新职责。\n\n完成后运行 `herdr-team handoff <id>`。\n");
      }
      expect(validateProject(loadProject(p.root))).toEqual([]);
    });
  });

  test("--force 不给正文就逐字保留，只更新显式元数据", () => {
    withProject(() => {}, (p) => {
      const before = p.roles.find((r) => r.name === "dev")!;
      addRole(p, { name: "dev", model: "new-display", force: true });
      const after = loadProject(p.root).roles.find((r) => r.name === "dev")!;
      expect(after.meta).toEqual({ ...before.meta, model: "new-display" });
      expect(after.body).toBe(before.body);
    });
  });

  test("新角色即使有 --force 也必须给 kind，失败不落盘", () => {
    withProject(() => {}, (p) => {
      for (const force of [false, true]) {
        expect(() => addRole(p, { name: "new-role", body: "职责", force })).toThrow(/--kind is required for new roles/);
        expect(existsSync(join(p.herdrDir, "roles/new-role"))).toBe(false);
      }
    });
  });

  test("非法名字拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() => addRole(p, { name: "Bad_Name", kind: "codex" })).toThrow(/must match/);
    });
  });

  test("非法 kind 拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() => addRole(p, { name: "x", kind: "nope" })).toThrow(/[Uu]nsupported/);
    });
  });
});

describe("tasksUsingRole —— 谁还在用", () => {
  test("算 role 和 handoff，且**只算没结束的**", () => {
    withProject(
      (root) => {
        writeTask(root, "0001-a", taskMeta({ role: "docs", status: "doing" }));
        writeTask(root, "0002-b", taskMeta({ role: "dev", handoff: ["docs"] }));
        writeTask(root, "0003-c", taskMeta({ role: "docs", status: "done" }));
      },
      (p) => {
        expect(tasksUsingRole(p, "docs").sort()).toEqual(["0001", "0002"]);
      },
    );
  });

  test("终态任务里的引用是历史，不算数", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs", status: "done" })),
      (p) => expect(tasksUsingRole(p, "docs")).toEqual([]),
    );
  });
});

describe("removeRole", () => {
  test("没人在用就删掉", () => {
    withProject(() => {}, (p) => {
      expect(removeRole(p, "docs").name).toBe("docs");
      expect(existsSync(join(p.herdrDir, "roles/docs"))).toBe(false);
      expect(loadProject(p.root).roles.map((r) => r.name)).toEqual(["dev"]);
    });
  });

  test("还有没结束的任务用它就拒绝，并列出 id", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs", status: "doing" })),
      (p) => {
        expect(() => removeRole(p, "docs")).toThrow(/0001/);
        // 拒绝了就不能删掉
        expect(existsSync(join(p.herdrDir, "roles/docs"))).toBe(true);
      },
    );
  });

  test("--force 能强删", () => {
    withProject(
      (root) => writeTask(root, "0001-a", taskMeta({ role: "docs", status: "doing" })),
      (p) => {
        expect(() => removeRole(p, "docs", true)).not.toThrow();
        expect(existsSync(join(p.herdrDir, "roles/docs"))).toBe(false);
      },
    );
  });

  test("删不存在的角色报错并列出已有的", () => {
    withProject(() => {}, (p) => {
      expect(() => removeRole(p, "ghost")).toThrow(/dev, docs/);
    });
  });

  test("删完剩下的仍然通过校验", () => {
    withProject(() => {}, (p) => {
      removeRole(p, "docs");
      expect(validateProject(loadProject(p.root))).toEqual([]);
    });
  });
});

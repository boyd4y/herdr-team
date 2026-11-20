import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { addRole, removeRole, RoleError, tasksUsingRole } from "../scripts/lib/team/roles.ts";
import { ROLE_BODY, ROLE_META, type Project } from "../scripts/lib/shared/types.ts";
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
});

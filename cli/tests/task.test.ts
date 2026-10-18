import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import {
  createTask,
  deriveSlug,
  editTask,
  nextId,
  TaskError,
} from "../scripts/lib/tasks/cards.ts";
import { TASK_BODY, TASK_META, type Project } from "../scripts/lib/shared/types.ts";
import { emitYaml, parseYaml, scalar } from "../scripts/lib/shared/yaml.ts";
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

describe("nextId", () => {

  test("取现存最大值 + 1", () => {
    withProject((root) => writeTask(root, "0003-a", taskMeta()), (p) => expect(nextId(p)).toBe("0004"));
  });

  test("把 .retired-ids 也算进去 —— 删过的号不复用", () => {
    withProject(
      (root) => {
        writeTask(root, "0002-a", taskMeta());
        require("node:fs").writeFileSync(join(root, ".herdr", ".retired-ids"), "0007\n0009\n");
      },
      (p) => expect(nextId(p)).toBe("0010"),
    );
  });

  test("用尽时报错", () => {
    withProject((root) => writeTask(root, "9999-a", taskMeta()), (p) => {
      expect(() => nextId(p)).toThrow(TaskError);
    });
  });
});

describe("deriveSlug", () => {
  test("英文标题折成 kebab-case", () => {
    expect(deriveSlug("Fix Login Timeout")).toBe("fix-login-timeout");
  });

  test("标点和多余空格被折叠", () => {
    expect(deriveSlug("Fix  the /login -- timeout!")).toBe("fix-the-login-timeout");
  });

  test("中文标题返回 null —— 那需要人来译", () => {
    expect(deriveSlug("修复登录超时")).toBeNull();
  });

  test("超长时断在词边界", () => {
    const slug = deriveSlug("alpha bravo charlie delta echo foxtrot golf hotel india juliet");
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(40);
    expect(slug!.endsWith("-")).toBe(false);
  });
});

describe("createTask —— 写出的东西", () => {
  test("建目录，元数据与正文分开", () => {
    withProject(() => {}, (p) => {
      const created = createTask(p, {
        title: "Fix login timeout",
        role: "dev",
        handoff: ["docs"],
        priority: "P1",
        body: "把超时改成 60s。",
      });

      expect(created.dir).toBe("tasks/0001-fix-login-timeout");
      expect(existsSync(join(created.path, TASK_META))).toBe(true);
      expect(existsSync(join(created.path, TASK_BODY))).toBe(true);

      const meta = readFileSync(join(created.path, TASK_META), "utf8");
      expect(meta).toContain("title: Fix login timeout");
      expect(meta).toContain("priority: P1");
      expect(meta).toContain("status: todo");
      expect(meta).toContain("role: dev");
      expect(meta).toContain("handoff: [docs]");
      // id 不在元数据里 —— 身份来自目录名，不重复存
      expect(meta).not.toContain("id:");

      expect(readFileSync(join(created.path, TASK_BODY), "utf8")).toContain("把超时改成 60s。");
    });
  });

  test("role 解析不到就拒绝，并列出可用角色", () => {
    withProject(() => {}, (p) => {
      expect(() =>
        createTask(p, { title: "X", role: "ghost", handoff: [], priority: "P2", body: "" }),
      ).toThrow(/Available: dev, docs/);
    });
  });

  test("handoff 解析不到就拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() =>
        createTask(p, { title: "X", role: "dev", handoff: ["nobody"], priority: "P2", body: "" }),
      ).toThrow(TaskError);
    });
  });

  test("中文标题没给 slug 就拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() =>
        createTask(p, { title: "修复登录", role: "dev", handoff: [], priority: "P2", body: "" }),
      ).toThrow(/--slug/);
    });
  });

  test("给了 slug 就能建", () => {
    withProject(() => {}, (p) => {
      const created = createTask(p, {
        title: "修复登录",
        role: "dev",
        handoff: [],
        priority: "P2",
        body: "",
        slug: "fix-login",
      });
      expect(created.dir).toBe("tasks/0001-fix-login");
    });
  });

  test("非法 priority 被拒绝", () => {
    withProject(() => {}, (p) => {
      expect(() =>
        createTask(p, { title: "X", role: "dev", handoff: [], priority: "P9", body: "" }),
      ).toThrow(TaskError);
    });
  });
});

describe("editTask", () => {

  test("已派出不给 --force 就拒绝", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "doing" })), (p) => {
      expect(() => editTask(p, "0001", { priority: "P0" }, false)).toThrow(/--force/);
    });
  });

  test("终态不许改", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "done" })), (p) => {
      expect(() => editTask(p, "0001", { title: "x" }, true)).toThrow(/terminal/);
    });
  });

  test("找不到的 id 报错并列出已知", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta()), (p) => {
      expect(() => editTask(p, "0099", {}, false)).toThrow(/0001/);
    });
  });

  test("不给 --body 时正文保持原样（不重写）", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta(), "原始描述"), (p) => {
      const before = readFileSync(join(p.herdrDir, "tasks/0001-a", TASK_BODY), "utf8");
      editTask(p, "0001", { role: "docs" }, false);
      const after = readFileSync(join(p.herdrDir, "tasks/0001-a", TASK_BODY), "utf8");
      expect(after).toBe(before);
    });
  });
});

describe("YAML 输出器", () => {
  test("数字开头的值加引号", () => {
    expect(scalar("0001")).toBe('"0001"');
  });

  test("YAML 关键字加引号", () => {
    expect(scalar("true")).toBe('"true"');
    expect(scalar("no")).toBe('"no"');
    expect(scalar("y")).toBe('"y"');
  });

  test("含冒号的值加引号", () => {
    expect(scalar("a: b")).toBe('"a: b"');
  });

  test("空数组和列表", () => {
    expect(emitYaml({ handoff: [], depends_on: [] })).toBe("handoff: []\ndepends_on: []\n");
    expect(emitYaml({ handoff: ["docs"] })).toBe("handoff: [docs]\n");
  });

  test("嵌套映射写成块", () => {
    expect(emitYaml({ env: { ANTHROPIC_MODEL: "ds-flash" } })).toBe("env:\n  ANTHROPIC_MODEL: ds-flash\n");
  });

  test("能被解析回来", () => {
    const data = { title: "一个任务", handoff: ["docs"], args: ["-m", "gpt-6.1-sol"] };
    expect(parseYaml(emitYaml(data, ["title", "handoff", "args"]))).toEqual(data);
  });
});

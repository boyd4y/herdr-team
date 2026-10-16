import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import type { Problem } from "../scripts/lib/types.ts";
import { validateProject } from "../scripts/lib/validate.ts";
import { makeProject, roleMeta, taskMeta, twoRoles, writeRaw, writeRole, writeTask } from "./helpers.ts";

/** 建一个项目 → 跑校验 → 收掉目录。 */
function check(build: (root: string) => void): Problem[] {
  const { root, cleanup } = makeProject();
  try {
    build(root);
    return validateProject(loadProject(root));
  } finally {
    cleanup();
  }
}

function rules(problems: Problem[]): string[] {
  return problems.map((p) => p.rule).sort();
}

function withTwoRoles(build: (root: string) => void): Problem[] {
  return check((root) => {
    twoRoles(root);
    build(root);
  });
}

describe("合法项目", () => {
  test("全通过", () => {
    expect(
      withTwoRoles((root) => writeTask(root, "0001-some-task", taskMeta())),
    ).toEqual([]);
  });

  test("没有角色和任务也合法", () => {
    expect(check(() => {})).toEqual([]);
  });
});

describe("规则 9 —— identity.md", () => {
  test("缺失即报错", () => {
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "dev", roleMeta());
      rmSync(join(root, ".herdr", "identity.md"));
      expect(rules(validateProject(loadProject(root)))).toEqual(["9"]);
    } finally {
      cleanup();
    }
  });
});

describe("规则 3 —— 角色目录名", () => {
  test("不合命名规则", () => {
    const problems = check((root) => writeRole(root, "Bad_Name", roleMeta()));
    expect(rules(problems)).toEqual(["3"]);
  });

  test("大写开头不合规", () => {
    expect(rules(check((root) => writeRole(root, "Dev", roleMeta())))).toEqual(["3"]);
  });

  test("缺 .role.yaml", () => {
    const problems = check((root) => {
      mkdirSync(`${root}/.herdr/roles/dev`, { recursive: true });
    });
    expect(rules(problems)).toEqual(["3"]);
  });
});

describe("规则 2 —— 枚举", () => {
  test("kind 非法", () => {
    expect(rules(check((root) => writeRole(root, "dev", roleMeta({ kind: "nope" }))))).toEqual(["2"]);
  });

  test("缺 kind", () => {
    expect(rules(check((root) => writeRole(root, "dev", {})))).toEqual(["1"]);
  });

  test("priority / status 非法", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", taskMeta({ priority: "P9", status: "nope" })),
    );
    expect(rules(problems)).toEqual(["2", "2"]);
  });
});

describe("规则 8 —— cwd 逃逸", () => {
  test("拒绝 .. 逃逸", () => {
    expect(rules(check((root) => writeRole(root, "dev", roleMeta({ cwd: "../../outside" }))))).toContain("8");
  });

  test("拒绝绝对路径", () => {
    expect(rules(check((root) => writeRole(root, "dev", roleMeta({ cwd: "/etc" }))))).toContain("8");
  });

  test("接受相对子目录", () => {
    expect(check((root) => writeRole(root, "dev", roleMeta({ cwd: "packages/api" })))).toEqual([]);
  });
});

describe("规则 4 / 4b —— 任务目录名", () => {
  test("目录名不是 <4位id>-<slug>", () => {
    expect(rules(withTwoRoles((root) => writeTask(root, "no-id-here", taskMeta())))).toEqual(["4b"]);
  });

  test("slug 含大写", () => {
    expect(rules(withTwoRoles((root) => writeTask(root, "0001-Nope_Slug", taskMeta())))).toEqual(["4b"]);
  });

  test("id 重复", () => {
    const problems = withTwoRoles((root) => {
      writeTask(root, "0001-a", taskMeta());
      writeTask(root, "0001-b", taskMeta());
    });
    expect(rules(problems)).toEqual(["4"]);
  });

  test("缺 .task.yaml", () => {
    const problems = withTwoRoles((root) => {
      mkdirSync(`${root}/.herdr/tasks/0001-a`, { recursive: true });
    });
    expect(rules(problems)).toEqual(["4"]);
  });
});

describe("规则 1 —— 必填与类型", () => {
  test("缺 title", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", { priority: "P2", status: "todo", role: "dev" }),
    );
    expect(rules(problems)).toContain("1");
  });

  test("title 是数字（类型不对）", () => {
    const problems = withTwoRoles((root) =>
      writeRaw(root, "tasks/0001-a/.task.yaml", "title: 123\npriority: P2\nstatus: todo\nrole: dev\n"),
    );
    expect(rules(problems)).toContain("1");
  });

  test("title 超长", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", taskMeta({ title: "x".repeat(81) })),
    );
    expect(rules(problems)).toContain("1");
  });

  test("args 不是列表", () => {
    const problems = check((root) => writeRole(root, "dev", { kind: "codex", args: "-m" }));
    expect(rules(problems)).toContain("1");
  });

  test("env 不是映射", () => {
    const problems = check((root) => writeRole(root, "dev", { kind: "codex", env: ["A=B"] }));
    expect(rules(problems)).toContain("1");
  });
});

describe("规则 5 —— 引用完整性", () => {
  test("role 解析不到", () => {
    expect(rules(withTwoRoles((root) => writeTask(root, "0001-a", taskMeta({ role: "ghost" }))))).toEqual(["5"]);
  });

  test("handoff 解析不到", () => {
    expect(
      rules(withTwoRoles((root) => writeTask(root, "0001-a", taskMeta({ handoff: ["nobody"] })))),
    ).toEqual(["5"]);
  });

  test("能解析到就通过", () => {
    expect(withTwoRoles((root) => writeTask(root, "0001-a", taskMeta({ handoff: ["docs"] })))).toEqual([]);
  });

  test("终态任务的 role 解析不到**不报** —— 那是历史，角色后来改名/删了不该弄坏记录", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", taskMeta({ status: "done", role: "ghost" })),
    );
    expect(problems).toEqual([]);
  });

  test("cancelled 同理", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", taskMeta({ status: "cancelled", role: "ghost" })),
    );
    expect(problems).toEqual([]);
  });

  test("但没结束的任务引用不到角色**要报**", () => {
    expect(
      rules(withTwoRoles((root) => writeTask(root, "0001-a", taskMeta({ status: "doing", role: "ghost" })))),
    ).toEqual(["5"]);
  });
});

describe("规则 6 / 7 —— depends_on", () => {
  test("引用不存在的任务", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", taskMeta({ depends_on: ["0099"] })),
    );
    expect(rules(problems)).toEqual(["6"]);
  });

  test("自环", () => {
    const problems = withTwoRoles((root) =>
      writeTask(root, "0001-a", taskMeta({ depends_on: ["0001"] })),
    );
    expect(rules(problems)).toEqual(["7"]);
  });

  test("两节点互指成环", () => {
    const problems = withTwoRoles((root) => {
      writeTask(root, "0001-a", taskMeta({ depends_on: ["0002"] }));
      writeTask(root, "0002-b", taskMeta({ depends_on: ["0001"] }));
    });
    expect(rules(problems)).toEqual(["7", "7"]);
  });

  test("合法的链不算环", () => {
    const problems = withTwoRoles((root) => {
      writeTask(root, "0001-a", taskMeta());
      writeTask(root, "0002-b", taskMeta({ depends_on: ["0001"] }));
    });
    expect(problems).toEqual([]);
  });
});

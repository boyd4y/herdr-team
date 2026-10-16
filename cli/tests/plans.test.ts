import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { init } from "../scripts/lib/init.ts";
import { describePlan, isPlanName, PLAN_NAMES, planRoles } from "../scripts/lib/plans.ts";
import { validateProject } from "../scripts/lib/validate.ts";
import { makeBareProject } from "./helpers.ts";

describe("方案名", () => {
  test("只有三个", () => {
    expect([...PLAN_NAMES]).toEqual(["cheap", "balanced", "strong"]);
  });

  test("认识 / 不认识", () => {
    expect(isPlanName("balanced")).toBe(true);
    expect(isPlanName("expensive")).toBe(false);
  });
});

describe("planRoles", () => {
  test("每个方案都给出完整的启动参数", () => {
    for (const plan of PLAN_NAMES) {
      for (const spec of planRoles(plan)) {
        expect(spec.kind).not.toBe("");
        // 要么有 args，要么有 env —— 否则这个 agent 不知道跑什么模型
        expect(spec.args !== undefined || spec.env !== undefined).toBe(true);
      }
    }
  });

  test("只有写代码的角色隔离", () => {
    for (const plan of PLAN_NAMES) {
      const isolated = planRoles(plan).filter((s) => s.worktree === true).map((s) => s.name);
      expect(isolated).toEqual(["dev"]);
    }
  });

  test("省钱方案里没有 sol —— 只有写代码才配最强模型", () => {
    const models = planRoles("cheap").map((s) => s.model);
    expect(models).not.toContain("sol-6.1");
  });

  test("均衡方案把 sol 只给 developer", () => {
    const withSol = planRoles("balanced").filter((s) => s.model === "sol-6.1").map((s) => s.name);
    expect(withSol).toEqual(["dev"]);
  });

  test("全强方案到处是 sol", () => {
    const withSol = planRoles("strong").filter((s) => s.model === "sol-6.1").map((s) => s.name);
    expect(withSol).toEqual(["lead", "dev", "test"]);
  });

  test("模型短名和启动参数对得上（sol 是 codex，ds-flash 是 claude）", () => {
    const balanced = planRoles("balanced");
    const dev = balanced.find((s) => s.name === "dev");
    const test_ = balanced.find((s) => s.name === "test");
    expect(dev?.kind).toBe("codex");
    expect(dev?.args).toEqual(["--no-daemon", "-m", "gpt-6.1-sol"]);
    expect(test_?.kind).toBe("claude");
    expect(test_?.env).toEqual({ ANTHROPIC_MODEL: "deepseek-flash" });
  });

  test("每个方案都有调度员，而且不隔离", () => {
    for (const plan of PLAN_NAMES) {
      const dispatcher = planRoles(plan).find((s) => s.name === "lead");
      expect(dispatcher).toBeDefined();
      expect(dispatcher?.worktree).toBeUndefined();
    }
  });

  test("改返回的数组不会污染下一次调用", () => {
    const first = planRoles("balanced");
    first[0]!.name = "tampered";
    expect(planRoles("balanced")[0]?.name).toBe("lead");
  });
});

describe("describePlan", () => {
  test("回显时标出谁隔离", () => {
    expect(describePlan("balanced")).toContain("dev=sol-6.1(隔离)");
    expect(describePlan("balanced")).toContain("lead=ds-flash");
  });
});

describe("init --plan 的产物", () => {
  test("三个方案的职责表与内置 skill 一致，并保留非 lead 的边界", () => {
    const presets = readFileSync(join(import.meta.dir, "../../skill/references/role-presets.md"), "utf8");
    for (const plan of PLAN_NAMES) {
      const { root, cleanup } = makeBareProject();
      try {
        init(loadProject(root), planRoles(plan));
        expect(validateProject(loadProject(root))).toEqual([]);
        for (const role of loadProject(root).roles) {
          const section = presets.split(`### \`${role.name}\``)[1]!.split("\n### ")[0]!
            .split("```markdown\n")[1]!.split("\n```")[0]!;
          const table = section.split("\n").filter((line) => line.startsWith("|")).join("\n");
          expect(table).not.toBe("");
          expect(role.body).toContain(table);
          expect(role.body).toContain("herdr-team handoff <id>");
          if (role.name !== "lead") {
            expect(role.body).toContain("你只能跑 `handoff <id>` 和只读查询");
            expect(role.body).toContain("不建分支、不合并、不删分支、不碰 main");
          }
          if (role.name === "test") expect(role.body).toContain("由 `dev` 修改、`test` 验证");
        }
      } finally { cleanup(); }
    }
  });

  test("写完直接通过校验", () => {
    const { root, cleanup } = makeBareProject();
    try {
      init(loadProject(root), planRoles("balanced"));
      expect(validateProject(loadProject(root))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("四个角色都在，developer 是隔离的", () => {
    const { root, cleanup } = makeBareProject();
    try {
      init(loadProject(root), planRoles("balanced"));
      const roles = loadProject(root).roles;
      expect(roles.map((r) => r.name).sort()).toEqual(["dev", "lead", "search", "test"]);
      expect(roles.find((r) => r.name === "dev")?.worktree).toBe(true);
      expect(roles.find((r) => r.name === "lead")?.worktree).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("每个角色都写了 prompt.md，不是空的", () => {
    const { root, cleanup } = makeBareProject();
    try {
      init(loadProject(root), planRoles("balanced"));
      for (const role of loadProject(root).roles) {
        expect(role.body.trim().length).toBeGreaterThan(0);
      }
    } finally {
      cleanup();
    }
  });

  test("角色的正文里都写了怎么交棒", () => {
    const { root, cleanup } = makeBareProject();
    try {
      init(loadProject(root), planRoles("balanced"));
      for (const role of loadProject(root).roles) {
        expect(role.body).toContain("herdr-team handoff <id>");
      }
    } finally {
      cleanup();
    }
  });
});

describe("各家的启动参数都带上了各自的坑位开关", () => {
  test("grok 带 --trust（否则启动时弹信任提示卡住 agent）", () => {
    for (const plan of PLAN_NAMES) {
      const grok = planRoles(plan).find((s) => s.kind === "grok");
      expect(grok?.args).toContain("--trust");
    }
  });

  test("codex 带 --no-daemon（否则被共享 daemon 的 feature 冲突卡住）", () => {
    for (const plan of PLAN_NAMES) {
      for (const spec of planRoles(plan).filter((s) => s.kind === "codex")) {
        expect(spec.args).toContain("--no-daemon");
      }
    }
  });
});

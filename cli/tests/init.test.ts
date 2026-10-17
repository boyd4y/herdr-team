import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { init, InitError, parseRoleSpecs } from "../scripts/lib/init.ts";
import { ROLE_BODY, ROLE_META } from "../scripts/lib/types.ts";
import { validateProject } from "../scripts/lib/validate.ts";
import { makeBareProject } from "./helpers.ts";

/** 一个只有 .herdr/identity.md 的空项目。 */
function bareProject(): { root: string; cleanup: () => void } {
  return makeBareProject();
}

describe("parseRoleSpecs", () => {
  test("接受裸数组", () => {
    const specs = parseRoleSpecs('[{"name":"dev","kind":"codex"}]');
    expect(specs[0]?.name).toBe("dev");
  });

  test("接受 {roles: [...]}", () => {
    expect(parseRoleSpecs('{"roles":[{"name":"dev","kind":"codex"}]}')).toHaveLength(1);
  });

  test("非法 JSON 报错", () => {
    expect(() => parseRoleSpecs("不是 JSON")).toThrow(InitError);
  });

  test("非法角色名报错", () => {
    expect(() => parseRoleSpecs('[{"name":"Bad_Name","kind":"codex"}]')).toThrow(/must match/);
  });

  test("非法 kind 报错", () => {
    expect(() => parseRoleSpecs('[{"name":"dev","kind":"nope"}]')).toThrow(/[Uu]nsupported/);
  });

  test("缺 name 报错", () => {
    expect(() => parseRoleSpecs('[{"kind":"codex"}]')).toThrow(/missing string field name/);
  });

  test("args 不是数组报错", () => {
    expect(() => parseRoleSpecs('[{"name":"dev","kind":"codex","args":"-m"}]')).toThrow(/args must be an array of strings/);
  });
});

describe("init —— 骨架", () => {
  test("建 identity.md 和两个 .gitkeep", () => {
    const { root, cleanup } = bareProject();
    try {
      const result = init(loadProject(root), []);
      expect(result.created).toContain("identity.md");
      expect(result.created).toContain("roles/.gitkeep");
      expect(result.created).toContain("tasks/.gitkeep");
    } finally {
      cleanup();
    }
  });

  test("identity.md 只有骨架，不编内容", () => {
    const { root, cleanup } = bareProject();
    try {
      init(loadProject(root), []);
      const text = readFileSync(join(root, ".herdr/identity.md"), "utf8");
      expect(text).toContain("# Identity");
      expect(text).toContain("## Code conventions");
      expect(text).toContain("## Preferences");
    } finally {
      cleanup();
    }
  });
});

describe("init —— 不覆盖已有内容", () => {
  test("已有 identity.md 就跳过", () => {
    const { root, cleanup } = bareProject();
    try {
      writeFileSync(join(root, ".herdr/identity.md"), "# 我的身份\n\n很长的一段说明。\n");
      const result = init(loadProject(root), []);
      expect(result.skipped).toContain("identity.md");
      expect(readFileSync(join(root, ".herdr/identity.md"), "utf8")).toContain("很长的一段说明");
    } finally {
      cleanup();
    }
  });

  test("已有角色就跳过，不冲掉手写正文", () => {
    const { root, cleanup } = bareProject();
    try {
      const dir = join(root, ".herdr/roles/dev");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ROLE_META), "kind: codex\n");
      writeFileSync(join(dir, ROLE_BODY), "手写的角色设定。\n");

      const result = init(loadProject(root), [{ name: "dev", kind: "claude" }]);
      expect(result.skipped).toContain("roles/dev");
      expect(result.roleMetadataWritten).toEqual([]);
      expect(result.roleBodiesWritten).toEqual([]);
      expect(result.roleBodiesPreserved).toEqual([]);
      expect(readFileSync(join(dir, ROLE_BODY), "utf8")).toContain("手写的角色设定");
      expect(readFileSync(join(dir, ROLE_META), "utf8")).toContain("kind: codex");
    } finally {
      cleanup();
    }
  });

  test("--force 才覆盖元数据", () => {
    const { root, cleanup } = bareProject();
    try {
      const dir = join(root, ".herdr/roles/dev");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ROLE_META), "kind: codex\n");
      writeFileSync(join(dir, ROLE_BODY), "手写的角色设定。\n");

      const result = init(loadProject(root), [{ name: "dev", kind: "claude", body: "新的职责，不应覆盖。" }], true);
      expect(readFileSync(join(dir, ROLE_META), "utf8")).toContain("kind: claude");
      // 正文不受 --force 影响
      expect(readFileSync(join(dir, ROLE_BODY), "utf8")).toBe("手写的角色设定。\n");
      expect(result.roleMetadataWritten).toEqual(["roles/dev/.role.yaml"]);
      expect(result.roleBodiesWritten).toEqual([]);
      expect(result.roleBodiesPreserved).toEqual(["roles/dev/prompt.md"]);
      expect(result.skipped).toContain("roles/dev/prompt.md");
    } finally {
      cleanup();
    }
  });
});

describe("init —— 写出的角色", () => {
  test("元数据与正文分开，能被读回", () => {
    const { root, cleanup } = bareProject();
    try {
      const result = init(loadProject(root), [
        { name: "dev", kind: "codex", model: "sol-6.1", args: ["-m", "gpt-6.1-sol"], body: "你是开发者。" },
      ]);
      const reloaded = loadProject(root);
      expect(reloaded.roles).toHaveLength(1);
      expect(reloaded.roles[0]?.name).toBe("dev");
      expect(reloaded.roles[0]?.kind).toBe("codex");
      expect(reloaded.roles[0]?.model).toBe("sol-6.1");
      expect(reloaded.roles[0]?.args).toEqual(["-m", "gpt-6.1-sol"]);
      expect(reloaded.roles[0]?.body).toContain("你是开发者");
      expect(result.roleMetadataWritten).toEqual(["roles/dev/.role.yaml"]);
      expect(result.roleBodiesWritten).toEqual(["roles/dev/prompt.md"]);
      expect(result.roleBodiesPreserved).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("元数据里不含 name —— 身份来自目录名", () => {
    const { root, cleanup } = bareProject();
    try {
      init(loadProject(root), [{ name: "dev", kind: "codex" }]);
      const text = readFileSync(join(root, ".herdr/roles/dev", ROLE_META), "utf8");
      expect(text).not.toContain("name:");
      expect(text).toContain("kind: codex");
    } finally {
      cleanup();
    }
  });

  test("env 写成嵌套映射", () => {
    const { root, cleanup } = bareProject();
    try {
      init(loadProject(root), [{ name: "docs", kind: "claude", env: { ANTHROPIC_MODEL: "deepseek-flash" } }]);
      const text = readFileSync(join(root, ".herdr/roles/docs", ROLE_META), "utf8");
      expect(text).toContain("env:\n  ANTHROPIC_MODEL: deepseek-flash");
      expect(loadProject(root).roles[0]?.env).toEqual({ ANTHROPIC_MODEL: "deepseek-flash" });
    } finally {
      cleanup();
    }
  });

  test("没给 body 时补一句默认的交棒说明", () => {
    const { root, cleanup } = bareProject();
    try {
      init(loadProject(root), [{ name: "dev", kind: "codex" }]);
      expect(readFileSync(join(root, ".herdr/roles/dev", ROLE_BODY), "utf8")).toContain("herdr-team handoff <id>");
    } finally {
      cleanup();
    }
  });

  test("init 完直接通过校验", () => {
    const { root, cleanup } = bareProject();
    try {
      init(loadProject(root), [
        { name: "dev", kind: "codex" },
        { name: "docs", kind: "claude" },
      ]);
      expect(validateProject(loadProject(root))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("角色名就是目录名", () => {
    const { root, cleanup } = bareProject();
    try {
      init(loadProject(root), [{ name: "developer-alt", kind: "kimi" }]);
      expect(existsSync(join(root, ".herdr/roles/developer-alt", ROLE_META))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

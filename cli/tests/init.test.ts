import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { init, InitError, parseRoleSpecs } from "../scripts/lib/team/init.ts";
import { ROLE_BODY, ROLE_META } from "../scripts/lib/shared/types.ts";
import { validateProject } from "../scripts/lib/team/validate.ts";
import { makeBareProject } from "./helpers.ts";
import { git } from "../scripts/lib/tasks/verification.ts";
import { createTask } from "../scripts/lib/tasks/cards.ts";

/** 一个只有 .herdr/identity.md 的空项目。 */
function bareProject(): { root: string; cleanup: () => void } {
  return makeBareProject();
}

describe("parseRoleSpecs", () => {

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

test("team configuration survives a Git clone while local tasks and runtime records stay behind", () => {
  const { root, cleanup } = bareProject();
  try {
    init(loadProject(root), [{ name: "dev", kind: "codex", body: "Build the assigned change." }]);
    writeFileSync(join(root, ".herdr/workflow.md"), "Develop, then validate. Lead merges accepted work.\n");
    createTask(loadProject(root), { title: "Local task", role: "dev", handoff: [], priority: "P2", body: "Local execution record" });
    for (const dir of ["reports", "projects", "worktrees"]) {
      mkdirSync(join(root, ".herdr", dir), { recursive: true });
      writeFileSync(join(root, ".herdr", dir, "local.txt"), "machine-specific data");
    }
    writeFileSync(join(root, ".herdr/.retired-ids"), "0000\n");
    git(root, "init", "-b", "main");
    git(root, "add", ".herdr");
    expect(git(root, "ls-files", ".herdr").split("\n")).toEqual([
      ".herdr/.gitignore", ".herdr/identity.md", ".herdr/models.json", ".herdr/roles/.gitkeep", ".herdr/roles/dev/.role.yaml", ".herdr/roles/dev/prompt.md", ".herdr/workflow.md",
    ]);
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Share team configuration");
    const clone = join(root, "..", "other-machine");
    git(root, "clone", "--no-hardlinks", root, clone);
    const shared = loadProject(clone);
    expect(shared.roles.map((role) => [role.name, role.kind, role.body])).toEqual(loadProject(root).roles.map((role) => [role.name, role.kind, role.body]));
    expect(readFileSync(join(clone, ".herdr/workflow.md"), "utf8")).toBe(readFileSync(join(root, ".herdr/workflow.md"), "utf8"));
    expect(readFileSync(join(clone, ".herdr/models.json"), "utf8")).toBe(readFileSync(join(root, ".herdr/models.json"), "utf8"));
    expect(shared.hasIdentity).toBe(true);
    expect(shared.tasks).toEqual([]);
    expect(shared.retiredIds).toEqual([]);
    expect(existsSync(join(root, ".herdr/tasks/0001-local-task/task.md"))).toBe(true);
  } finally { cleanup(); }
});

describe("init —— 不覆盖已有内容", () => {
  test("preserves custom ignore rules even with force and never edits the root ignore file", () => {
    const { root, cleanup } = bareProject();
    try {
      writeFileSync(join(root, ".gitignore"), "*.local\n");
      writeFileSync(join(root, ".herdr/.gitignore"), "/private-notes/\n");
      const result = init(loadProject(root), [], true);
      expect(result.skipped).toContain(".gitignore");
      expect(readFileSync(join(root, ".herdr/.gitignore"), "utf8")).toBe("/private-notes/\n");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("*.local\n");
    } finally { cleanup(); }
  });
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
});

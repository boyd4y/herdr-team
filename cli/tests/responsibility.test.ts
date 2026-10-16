import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { makeProject, twoRoles } from "./helpers.ts";

// Run documented commands against this checkout, offline and only in a disposable project.
function withCLI(run: (cli: (...args: string[]) => { code: number; stdout: string; stderr: string }, root: string) => void): void {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(join(import.meta.dir, "../scripts/cli.ts"), join(bin, "herdr-team"));
    const cli = (...args: string[]) => {
      const proc = Bun.spawnSync([join(bin, "herdr-team"), ...args], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    run(cli, root);
  } finally {
    cleanup();
  }
}

describe("CLI responsibility updates", () => {
  test("documented --body command replaces the prompt without changing any startup configuration", () => {
    withCLI((cli, root) => {
      const body = "你负责实现功能和同步接口文档，自测后提交；编排与分支管理交给 lead。完成后运行 herdr-team handoff <id> 交棒，不要自己改任务卡。";
      const metaPath = join(root, ".herdr/roles/dev/.role.yaml");
      const before = readFileSync(metaPath, "utf8");
      const result = cli("role", "add", "dev", "--force", "--body", body);
      expect(result.code).toBe(0);
      expect(readFileSync(join(root, ".herdr/roles/dev/prompt.md"), "utf8")).toBe(`${body}\n`);
      expect(readFileSync(metaPath, "utf8")).toBe(before);
    });
  });

  test("--body-file works; omitted body preserves exact prose and unspecified metadata", () => {
    withCLI((cli, root) => {
      const body = "负责独立验证。\n\n完成后运行 herdr-team handoff <id>。\n";
      writeFileSync(join(root, "responsibility.md"), body);
      const before = loadProject(root).roles.find((r) => r.name === "docs")!;
      expect(cli("role", "add", "docs", "--force", "--body-file", "responsibility.md").code).toBe(0);
      const updated = loadProject(root).roles.find((r) => r.name === "docs")!;
      expect(updated.body).toBe(body);
      expect(updated.meta).toEqual(before.meta);
      expect(cli("role", "add", "docs", "--force", "--model", "display-only").code).toBe(0);
      const preserved = loadProject(root).roles.find((r) => r.name === "docs")!;
      expect(preserved.body).toBe(body);
      expect(preserved.meta).toEqual({ ...before.meta, model: "display-only" });
    });
  });

  test("existing roles still require --force, new roles still require --kind, and conflicting body inputs fail without writes", () => {
    withCLI((cli, root) => {
      const before = loadProject(root).roles;
      const refused = cli("role", "add", "dev", "--body", "new");
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("--force --body");
      expect(cli("role", "add", "new-role", "--force", "--body", "new").code).toBe(2);
      writeFileSync(join(root, "responsibility.md"), "new");
      expect(cli("role", "add", "dev", "--force", "--body", "new", "--body-file", "responsibility.md").code).toBe(2);
      expect(loadProject(root).roles).toEqual(before);
      expect(cli("role", "add", "new-role", "--kind", "codex", "--body", "new").code).toBe(0);
      expect(loadProject(root).roles.find((r) => r.name === "new-role")?.body).toBe("new\n");
    });
  });

  test("init --roles-file --force reports preserved prose separately in JSON and human output", () => {
    withCLI((cli, root) => {
      const before = readFileSync(join(root, ".herdr/roles/dev/prompt.md"), "utf8");
      writeFileSync(join(root, "roles.json"), JSON.stringify([{ name: "dev", kind: "claude", body: "新职责" }]));
      // Without --force both metadata and prose remain untouched.
      expect(cli("init", "--roles-file", "roles.json").code).toBe(0);
      expect(loadProject(root).roles.find((r) => r.name === "dev")?.kind).toBe("codex");
      const result = cli("init", "--roles-file", "roles.json", "--force", "--json");
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).not.toHaveProperty("rolesWritten");
      expect(report.roleMetadataWritten).toEqual(["roles/dev/.role.yaml"]);
      expect(report.roleBodiesWritten).toEqual([]);
      expect(report.roleBodiesPreserved).toEqual(["roles/dev/prompt.md"]);
      expect(report.skipped).toContain("roles/dev/prompt.md");
      const human = cli("init", "--roles-file", "roles.json", "--force");
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("角色元数据已写入: roles/dev/.role.yaml");
      expect(human.stdout).toContain("角色正文已保留（未覆盖）: roles/dev/prompt.md");
      expect(human.stdout).not.toContain("角色正文已写入");
      expect(loadProject(root).roles.find((r) => r.name === "dev")?.kind).toBe("claude");
      expect(readFileSync(join(root, ".herdr/roles/dev/prompt.md"), "utf8")).toBe(before);
    });
  });
});

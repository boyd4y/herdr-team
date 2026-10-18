import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRoot, loadProject } from "../scripts/lib/team/project.ts";

/** macOS 上 /var 和 /private/var 是同一个地方 —— 比较前先归一化。 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

/** 一个真 git 仓库 + 一个从它切出来的 linked worktree，两边都带 .herdr/。 */
function withWorktree(run: (main: string, wt: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "herdr-team-root-"));
  const main = join(base, "main");
  const wt = join(base, "wt");
  try {
    mkdirSync(join(main, ".herdr", "tasks", "0001-old"), { recursive: true });
    writeFileSync(join(main, ".herdr", "identity.md"), "# 我是谁\n");
    writeFileSync(join(main, ".herdr", "tasks", "0001-old", ".task.yaml"), "title: old\n");
    git(main, "init", "-q");
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "t");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    git(main, "worktree", "add", "-q", "-b", "feat/x", wt);
    run(main, wt);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe("findRoot —— worktree 里回落到主检出", () => {
  test("主检出里照常找到自己", () => {
    withWorktree((main) => expect(findRoot(main)).toBe(canonical(main)));
  });

  test("**worktree 里找到的是主检出，不是自己**", () => {
    withWorktree((main, wt) => {
      // 先确认 worktree 里确实有一份 .herdr/ 的副本（否则这个测试就是空的）
      expect(canonical(findRoot(wt) as string)).not.toBe(canonical(wt));
      expect(findRoot(wt)).toBe(canonical(main));
    });
  });

  test("worktree 向上没有 .herdr/ 时仍找到主检出", () => {
    withWorktree((main, wt) => {
      // wt 与 main 是临时目录下的兄弟目录，主检出的 .herdr/ 不在 wt 的祖先链上。
      rmSync(join(wt, ".herdr"), { recursive: true });
      const nested = join(wt, "sub", "dir");
      mkdirSync(nested, { recursive: true });
      expect(findRoot(wt)).toBe(canonical(main));
      expect(findRoot(nested)).toBe(canonical(main));

      rmSync(join(main, ".herdr"), { recursive: true });
      mkdirSync(join(main, ".herdr", "worktrees"), { recursive: true });
      expect(findRoot(nested)).toBeNull();
    });
  });

  test("回落之后读到的才是**活的**卡片", () => {
    withWorktree((main, wt) => {
      // 主检出上新加一张卡 —— worktree 里没有（它停在切出来的那一刻）
      mkdirSync(join(main, ".herdr", "tasks", "0002-new"), { recursive: true });
      writeFileSync(join(main, ".herdr", "tasks", "0002-new", ".task.yaml"), "title: new\n");

      const fromWorktree = loadProject(findRoot(wt) as string);
      expect(fromWorktree.tasks.map((t) => t.id).sort()).toEqual(["0001", "0002"]);
    });
  });
});

describe("findRoot —— 不在 git 里", () => {
  test("普通目录照常向上找", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-team-nogit-"));
    try {
      const proj = join(base, "p", "sub");
      mkdirSync(join(base, "p", ".herdr"), { recursive: true });
      writeFileSync(join(base, "p", ".herdr", "identity.md"), "# 我是谁\n");
      mkdirSync(proj, { recursive: true });
      expect(findRoot(proj)).toBe(canonical(join(base, "p")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("哪里都没有就返回 null", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-team-none-"));
    try {
      expect(findRoot(base)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/** 模拟任意位置的 Herdr 数据目录，不依赖真实 HOME 或已安装的 Herdr。 */
function withHerdrData(run: (base: string, project: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "herdr-team-data-"));
  const project = join(base, "workspace", "project");
  try {
    mkdirSync(join(base, ".herdr", "projects"), { recursive: true });
    mkdirSync(join(base, ".herdr", "worktrees"), { recursive: true });
    mkdirSync(project, { recursive: true });
    run(base, project);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function cli(cwd: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("findRoot —— 区分 Herdr 数据目录和团队项目", () => {
  test("只有 projects/、worktrees/ 的 .herdr 不算项目", () => {
    withHerdrData((base, project) => {
      expect(findRoot(base)).toBeNull();
      expect(findRoot(project)).toBeNull();
      mkdirSync(join(project, ".herdr"));
      expect(findRoot(project)).toBeNull();
    });
  });

  for (const marker of ["identity.md", "models.json", "roles", "tasks"]) {
    test(`只有 ${marker} 的半成品仍可从子目录找到`, () => {
      withHerdrData((_base, project) => {
        const herdr = join(project, ".herdr");
        mkdirSync(herdr);
        if (marker.endsWith(".md") || marker.endsWith(".json")) writeFileSync(join(herdr, marker), marker.endsWith(".json") ? "{}" : "# Identity\n");
        else mkdirSync(join(herdr, marker));
        const nested = join(project, "src", "nested");
        mkdirSync(nested, { recursive: true });
        expect(findRoot(project)).toBe(canonical(project));
        expect(findRoot(nested)).toBe(canonical(project));
      });
    });
  }

  test("无团队配置时 CLI 报找不到项目，而非 identity.md 缺失", () => {
    withHerdrData((_base, project) => {
      const result = cli(project, "validate");
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("No team project found in this directory or its parents; use --root");
      expect(result.stderr.toString()).not.toContain("identity.md is missing");
    });
  });

  test("无团队配置时 watch --line 静默退出", () => {
    withHerdrData((_base, project) => {
      const result = cli(project, "console", "--line");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe("");
    });
  });

  test("init 在当前目录建配置，不写入祖先的数据目录", () => {
    withHerdrData((base, project) => {
      const result = cli(project, "init");
      expect(result.exitCode).toBe(0);
      for (const marker of ["identity.md", "roles", "tasks"]) {
        expect(existsSync(join(project, ".herdr", marker))).toBe(true);
        expect(existsSync(join(base, ".herdr", marker))).toBe(false);
      }
      expect(findRoot(project)).toBe(canonical(project));
    });
  });
});

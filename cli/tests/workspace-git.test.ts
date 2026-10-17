import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFileCount, readChangedFileCount, syncWorkspaceGit } from "../scripts/lib/workspace-git.ts";
import { realHerdr } from "../scripts/lib/herdr.ts";
import { fakeHerdr } from "./helpers.ts";

describe("侧栏未提交文件数", () => {
  test("NUL 记录按文件计数，重命名只计一次，路径支持空格和换行", () => {
    expect(changedFileCount("")).toBe(0);
    expect(changedFileCount("MM both\0R  new\0old\0?? new\nfile\0 D deleted\0!! ignored\0")).toBe(4);
  });

  test("实际 Git 仓库：暂存与未暂存去重、重命名、未跟踪目录逐文件计数、忽略文件不计", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-team-git-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    try {
      git("init", "-q");
      writeFileSync(join(cwd, "both"), "initial\n");
      writeFileSync(join(cwd, "old"), "rename\n");
      writeFileSync(join(cwd, ".gitignore"), "ignored\n");
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
      expect(readChangedFileCount(cwd)).toBe(0);
      writeFileSync(join(cwd, "both"), "staged\n");
      git("add", "both");
      writeFileSync(join(cwd, "both"), "staged and unstaged\n");
      renameSync(join(cwd, "old"), join(cwd, "new name"));
      git("add", "old", "new name");
      mkdirSync(join(cwd, "new-dir"));
      writeFileSync(join(cwd, "new-dir", "one\nfile"), "new");
      writeFileSync(join(cwd, "new-dir", "two"), "new");
      writeFileSync(join(cwd, "ignored"), "ignore");
      expect(readChangedFileCount(cwd)).toBe(4);
      expect(readChangedFileCount(join(cwd, "new-dir"))).toBe(4);
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "changes");
      expect(readChangedFileCount(cwd)).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("不是 Git 仓库时不伪报零", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-team-nongit-"));
    try { expect(readChangedFileCount(cwd)).toBeUndefined(); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("普通 workspace 及不同 worktree 各计各的，同 checkout 只读一次且不重复上报", () => {
    const h = fakeHerdr({
      workspaces: [
        { workspace_id: "w1", label: "a", pane_count: 1, tab_count: 1 },
        { workspace_id: "w2", label: "b", pane_count: 1, tab_count: 1 },
        { workspace_id: "w3", label: "child", pane_count: 1, tab_count: 1,
          worktree: { repo_key: "/repo/.git", checkout_path: "/worktree", is_linked_worktree: true } },
      ],
      panes: ["w1", "w2", "w3"].map((id) => ({ workspace_id: id, tab_id: `${id}:t1`, pane_id: `${id}:p1`, cwd: "/repo" })),
    });
    const reads: string[] = [];
    const read = (cwd: string) => { reads.push(cwd); return cwd === "/repo" ? 3 : 0; };
    expect(syncWorkspaceGit(h, read)).toEqual({ updated: 3, failed: 0 });
    expect(reads).toEqual(["/repo", "/worktree"]);
    expect(h.state.workspaces.map((w) => w.tokens?.team_git_files)).toEqual(["📄3", "📄3", "📄0"]);
    expect(syncWorkspaceGit(h, read).updated).toBe(0);
    expect(h.calls).toHaveLength(3);
    expect(syncWorkspaceGit(h, () => undefined).updated).toBe(3);
    expect(h.state.workspaces.every((w) => w.tokens?.team_git_files === undefined)).toBe(true);
  });

  test("无法上报时计失败；外部不控制 Herdr", () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "a", pane_count: 1, tab_count: 1 }],
      panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" }] });
    h.reportWorkspaceMetadata = () => { throw new Error("unavailable"); };
    expect(syncWorkspaceGit(h, () => 3)).toEqual({ updated: 0, failed: 1 });
    h.state.envOk = false;
    expect(syncWorkspaceGit(h, () => { throw new Error("must not read"); })).toEqual({ updated: 0, failed: 0 });
  });

  test("Git 字段有独立 metadata source，可清除过期值", () => {
    const calls: string[][] = [];
    const h = realHerdr((args) => { calls.push(args); return { code: 0, stdout: "{}", stderr: "" }; });
    h.reportWorkspaceMetadata("w1", { team_git_files: null }, "herdr-team-git");
    expect(calls[0]).toEqual(["workspace", "report-metadata", "w1", "--source", "herdr-team-git", "--clear-token", "team_git_files"]);
  });
});

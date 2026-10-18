import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkspaceGit, readWorkspaceGit, syncWorkspaceGit } from "../scripts/lib/workspace-git.ts";
import { realHerdr } from "../scripts/lib/herdr.ts";
import { fakeHerdr } from "./helpers.ts";

describe("侧栏未提交文件数", () => {
  test("NUL 记录按文件计数，重命名只计一次，路径支持空格和换行", () => {
    expect(parseWorkspaceGit("# branch.head main\0")).toEqual({ branch: "main", files: 0 });
    expect(parseWorkspaceGit("# branch.head 开发\0# branch.ab +2 -3\0" +
      "1 MM N... 100644 100644 100644 abc abc both\0" +
      "2 R. N... 100644 100644 100644 abc abc R100 new\0old\0" +
      "? new\nfile\0u UU N... 100644 100644 100644 100644 a b c conflict\0! ignored\0"))
      .toEqual({ branch: "开发", files: 4, ahead: 2, behind: 3 });
    expect(parseWorkspaceGit("# branch.head (detached)\0")).toEqual({ files: 0 });
    expect(() => parseWorkspaceGit("# branch.ab invalid\0")).toThrow("Invalid git ahead/behind record");
    expect(() => parseWorkspaceGit("invalid\0")).toThrow("Invalid git status record");
    expect(() => parseWorkspaceGit("2 rename without source\0")).toThrow("Missing git rename source");
  });

  test("实际 Git 仓库：暂存与未暂存去重、重命名、未跟踪目录逐文件计数、忽略文件不计", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-team-git-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8",
        env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: join(cwd, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    try {
      git("init", "-q", "-b", "main");
      expect(readWorkspaceGit(cwd)).toEqual({ files: 0, branch: "main" });
      writeFileSync(join(cwd, "both"), "initial\n");
      writeFileSync(join(cwd, "old"), "rename\n");
      writeFileSync(join(cwd, ".gitignore"), "ignored\n");
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
      expect(readWorkspaceGit(cwd)).toEqual({ files: 0, branch: "main" });
      writeFileSync(join(cwd, "both"), "staged\n");
      git("add", "both");
      writeFileSync(join(cwd, "both"), "staged and unstaged\n");
      renameSync(join(cwd, "old"), join(cwd, "new name"));
      git("add", "old", "new name");
      mkdirSync(join(cwd, "new-dir"));
      writeFileSync(join(cwd, "new-dir", "one\nfile"), "new");
      writeFileSync(join(cwd, "new-dir", "two"), "new");
      writeFileSync(join(cwd, "ignored"), "ignore");
      expect(readWorkspaceGit(cwd)).toEqual({ files: 4, branch: "main" });
      expect(readWorkspaceGit(join(cwd, "new-dir"))).toEqual({ files: 4, branch: "main" });
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "changes");
      expect(readWorkspaceGit(cwd)).toEqual({ files: 0, branch: "main" });
      git("checkout", "--detach", "-q");
      expect(readWorkspaceGit(cwd)).toEqual({ files: 0 });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("不是 Git 仓库时不伪报零", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-team-nongit-"));
    try { expect(readWorkspaceGit(cwd)).toBeUndefined(); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("local tracking refs report aligned, ahead, behind and diverged branches without fetching", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-team-upstream-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        encoding: "utf8", env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: join(cwd, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git("init", "-q", "-b", "main");
      git("commit", "--allow-empty", "-qm", "initial");
      const initial = git("rev-parse", "HEAD");
      // An unreachable remote proves status needs only the local tracking ref.
      git("remote", "add", "origin", join(cwd, "must-not-fetch"));
      git("update-ref", "refs/remotes/origin/main", initial);
      git("branch", "--set-upstream-to=origin/main", "main");
      git("config", "status.aheadBehind", "false");
      expect(readWorkspaceGit(cwd)).toEqual({ branch: "main", files: 0, ahead: 0, behind: 0 });
      git("commit", "--allow-empty", "-qm", "local");
      const local = git("rev-parse", "HEAD");
      expect(readWorkspaceGit(cwd)).toEqual({ branch: "main", files: 0, ahead: 1, behind: 0 });
      git("checkout", "-qb", "remote-change", initial);
      git("commit", "--allow-empty", "-qm", "remote");
      git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
      git("checkout", "-q", "main");
      expect(readWorkspaceGit(cwd)).toEqual({ branch: "main", files: 0, ahead: 1, behind: 1 });
      git("update-ref", "refs/remotes/origin/main", local);
      git("reset", "--hard", "-q", initial);
      expect(readWorkspaceGit(cwd)).toEqual({ branch: "main", files: 0, ahead: 0, behind: 1 });
      git("update-ref", "-d", "refs/remotes/origin/main");
      expect(readWorkspaceGit(cwd)).toEqual({ branch: "main", files: 0 });
      git("config", "--unset", "branch.main.remote");
      git("config", "--unset", "branch.main.merge");
      expect(readWorkspaceGit(cwd)).toEqual({ branch: "main", files: 0 });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("ordinary and primary workspaces read once per checkout; linked worktrees have no Git row", () => {
    const h = fakeHerdr({
      workspaces: [
        { workspace_id: "w1", label: "a", pane_count: 1, tab_count: 1 },
        { workspace_id: "w2", label: "b", pane_count: 1, tab_count: 1 },
        { workspace_id: "w3", label: "child", pane_count: 1, tab_count: 1,
          worktree: { repo_key: "/repo/.git", checkout_path: "/worktree", is_linked_worktree: true },
          tokens: { team_git_files: "📄5", team_git_summary: "old · 📄5 ↑3" } },
        { workspace_id: "w4", label: "primary", pane_count: 0, tab_count: 1,
          worktree: { repo_key: "/other/.git", checkout_path: "/other", is_linked_worktree: false } },
      ],
      panes: ["w1", "w2", "w3"].map((id) => ({ workspace_id: id, tab_id: `${id}:t1`, pane_id: `${id}:p1`, cwd: "/repo" })),
    });
    const reads: string[] = [];
    const read = (cwd: string) => { reads.push(cwd); return { branch: "main", files: cwd === "/repo" ? 3 : 0, ahead: 2, behind: 1 }; };
    expect(syncWorkspaceGit(h, read)).toEqual({ updated: 4, failed: 0 });
    expect(reads).toEqual(["/repo", "/other"]);
    expect(h.state.workspaces.map((w) => w.tokens?.team_git_summary)).toEqual(["main · 📄3 ↑2 ↓1", "main · 📄3 ↑2 ↓1", undefined, "main · 📄0 ↑2 ↓1"]);
    expect(h.state.workspaces.every((w) => w.tokens?.team_git_files === undefined)).toBe(true);
    expect(syncWorkspaceGit(h, read).updated).toBe(0);
    expect(h.calls).toHaveLength(4);
    expect(syncWorkspaceGit(h, () => undefined).updated).toBe(3);
    expect(h.state.workspaces.every((w) => w.tokens?.team_git_summary === undefined)).toBe(true);
    expect(syncWorkspaceGit(h, () => undefined)).toEqual({ updated: 0, failed: 0 });
  });

  test.each([
    { branch: "a".repeat(74), files: 0, ahead: 0, behind: 0, suffix: " · 📄0", shortened: false },
    { branch: "a".repeat(75), files: 0, ahead: 0, behind: 0, suffix: " · 📄0", shortened: false },
    { branch: "a".repeat(76), files: 0, ahead: 0, behind: 0, suffix: " · 📄0", shortened: true },
    { branch: "a".repeat(77), files: 0, ahead: 0, behind: 0, suffix: " · 📄0", shortened: true },
    { branch: "feature/" + "a".repeat(80), files: 12345, ahead: 123, behind: 4567, suffix: " · 📄12345 ↑123 ↓4567", shortened: true },
    { branch: "开发/" + "🚀".repeat(72), files: 0, ahead: 0, behind: 0, suffix: " · 📄0", shortened: false },
    { branch: "开发/" + "🚀".repeat(73), files: 12, ahead: 34, behind: 56, suffix: " · 📄12 ↑34 ↓56", shortened: true },
  ])("long branch summaries preserve statistics and converge under Herdr's 80-character limit: %j", (snapshot) => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "unchanged label", pane_count: 1, tab_count: 1,
      tokens: { team_git_summary: Array.from(snapshot.branch + snapshot.suffix).slice(0, 80).join("") } }],
      panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" }] });
    const report = h.reportWorkspaceMetadata;
    h.reportWorkspaceMetadata = (id, tokens, source) => report(id, Object.fromEntries(Object.entries(tokens)
      .map(([key, value]) => [key, value === null ? null : Array.from(value).slice(0, 80).join("")])), source);

    expect(syncWorkspaceGit(h, () => snapshot)).toEqual({ updated: snapshot.shortened ? 1 : 0, failed: 0 });
    const summary = h.state.workspaces[0]!.tokens!.team_git_summary!;
    expect(Array.from(summary).length).toBeLessThanOrEqual(80);
    expect(summary.endsWith(snapshot.suffix)).toBe(true);
    expect(summary.includes("…")).toBe(snapshot.shortened);
    if (!snapshot.shortened) expect(summary).toBe(snapshot.branch + snapshot.suffix);
    else expect(summary).toContain("…" + snapshot.suffix);
    // The retained branch prefix must contain complete Unicode code points.
    expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(syncWorkspaceGit(h, () => snapshot)).toEqual({ updated: 0, failed: 0 });
    expect(syncWorkspaceGit(h, () => snapshot)).toEqual({ updated: 0, failed: 0 });
    expect(h.state.workspaces[0]!.label).toBe("unchanged label");
  });

  test("classification changes and unavailable Git clear stale summaries and legacy counts", () => {
    const h = fakeHerdr({
      workspaces: [{ workspace_id: "w1", label: "开发 checkout", pane_count: 1, tab_count: 1,
        worktree: { repo_key: "/repo/.git", checkout_path: "/checkout", is_linked_worktree: true },
        tokens: { team_git_files: "📄4", team_git_summary: "old · 📄9 ↑3", user_token: "keep" } }],
    });
    const workspace = h.state.workspaces[0]!;
    const noRead = () => { throw new Error("must not read linked worktree Git"); };
    expect(syncWorkspaceGit(h, noRead)).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ user_token: "keep" });
    expect(syncWorkspaceGit(h, noRead)).toEqual({ updated: 0, failed: 0 });

    workspace.worktree!.is_linked_worktree = false;
    expect(syncWorkspaceGit(h, () => ({ files: 4, branch: "main", ahead: 2, behind: 0 }))).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ team_git_summary: "main · 📄4 ↑2", user_token: "keep" });
    workspace.worktree!.is_linked_worktree = true;
    expect(syncWorkspaceGit(h, noRead)).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ user_token: "keep" });

    // Missing worktree metadata falls back to the pane cwd and the normal row.
    delete workspace.worktree;
    h.state.panes.push({ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" });
    expect(syncWorkspaceGit(h, () => ({ files: 2, branch: "other", ahead: 0, behind: 3 }))).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ team_git_summary: "other · 📄2 ↓3", user_token: "keep" });
    expect(syncWorkspaceGit(h, () => undefined)).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ user_token: "keep" });
    expect(syncWorkspaceGit(h, () => ({ files: 0, branch: "main", ahead: 0, behind: 0 }))).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ team_git_summary: "main · 📄0", user_token: "keep" });
    expect(syncWorkspaceGit(h, () => { throw new Error("invalid Git output"); })).toEqual({ updated: 1, failed: 1 });
    expect(workspace.tokens).toEqual({ user_token: "keep" });
    expect(syncWorkspaceGit(h, () => ({ files: 0 }))).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ team_git_summary: "📄0", user_token: "keep" });
    h.state.panes = [];
    expect(syncWorkspaceGit(h, () => { throw new Error("must not read without a cwd"); })).toEqual({ updated: 1, failed: 0 });
    expect(workspace.tokens).toEqual({ user_token: "keep" });
    expect(workspace.label).toBe("开发 checkout");
  });

  test("无法上报时计失败；外部不控制 Herdr", () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "a", pane_count: 1, tab_count: 1 }],
      panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" }] });
    h.reportWorkspaceMetadata = () => { throw new Error("unavailable"); };
    expect(syncWorkspaceGit(h, () => ({ files: 3 }))).toEqual({ updated: 0, failed: 1 });
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

test("offline Herdr adapter migrates root statistics and clears nested/standalone worktree statistics", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-team-git-cli-"));
  try {
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    const home = join(dir, "home");
    const config = join(dir, "config.toml");
    for (const cwd of [repo, home]) mkdirSync(cwd);
    writeFileSync(config, "# user configuration\n");
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(dir, "config"),
      XDG_STATE_HOME: join(dir, "state"), HERDR_CONFIG_PATH: config, HERDR_ENV: "1",
      HERDR_PLUGIN_STATE_DIR: join(dir, "plugin-state"), HERDR_SOCKET_PATH: join(dir, "offline.sock"),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { env, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git("init", "-q", "-b", "main");
    git("commit", "--allow-empty", "-qm", "initial");
    git("worktree", "add", "--quiet", "--detach", linked);
    writeFileSync(join(repo, "new file"), "untracked");
    writeFileSync(join(linked, "linked change"), "hidden");
    const workspace = (id: string, cwd: string, isLinked: boolean) => ({ workspace_id: id, label: `名字 ${id}`, pane_count: 1, tab_count: 1,
      worktree: { repo_key: join(repo, ".git"), checkout_path: cwd, is_linked_worktree: isLinked },
      tokens: { team_git_files: "📄9", team_git_summary: "stale · 📄9 ↑9 ↓9", user_token: "keep" } });
    const stateFile = join(dir, "herdr.json");
    const log = join(dir, "calls.jsonl");
    writeFileSync(stateFile, JSON.stringify({
      workspaces: [workspace("w1", repo, false), workspace("w2", linked, true), workspace("w3", linked, true),
        { workspace_id: "w4", label: "ordinary", pane_count: 1, tab_count: 1, tokens: { team_git_files: "📄7", team_git_summary: "stale" } }],
      panes: [{ workspace_id: "w4", tab_id: "w4:t1", pane_id: "w4:p1", cwd: home }],
    }));
    const executable = join(dir, "fake-herdr");
    writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GIT_TEST_STATE, 'utf8'));
fs.appendFileSync(process.env.GIT_TEST_LOG, JSON.stringify(args) + '\\n');
let result = {};
if (args.join(' ') === 'workspace list') result = {workspaces: state.workspaces};
else if (args.join(' ') === 'pane list') result = {panes: state.panes};
else if (args[0] === 'workspace' && args[1] === 'report-metadata' && args[3] === '--source' && args[4] === 'herdr-team-git') {
  const target = state.workspaces.find(w => w.workspace_id === args[2]);
  for (let i = 5; i < args.length; i++) {
    if (args[i] === '--clear-token') delete target.tokens[args[++i]];
    else if (args[i] === '--token') { const [key, ...value] = args[++i].split('='); target.tokens[key] = Array.from(value.join('=').trim()).filter(ch => !/[\\x00-\\x1f\\x7f-\\x9f]/.test(ch)).slice(0, 80).join('').trim(); }
    else throw new Error('Unexpected metadata option');
  }
  fs.writeFileSync(process.env.GIT_TEST_STATE, JSON.stringify(state));
} else throw new Error('Unexpected Herdr call: ' + args.join(' '));
process.stdout.write(JSON.stringify({result}));
`);
    chmodSync(executable, 0o755);
    const run = () => {
      const result = Bun.spawnSync([process.execPath, "--eval", `import { realHerdr } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/herdr.ts"))}; import { syncWorkspaceGit } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/workspace-git.ts"))}; console.log(JSON.stringify(syncWorkspaceGit(realHerdr())));`], {
        cwd: home, env: { ...env, HERDR_BIN_PATH: executable, GIT_TEST_STATE: stateFile, GIT_TEST_LOG: log }, stdout: "pipe", stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
    expect(run()).toEqual({ updated: 4, failed: 0 });
    expect(state().workspaces.map((w: {tokens: Record<string, string>}) => w.tokens.team_git_summary)).toEqual(["main · 📄1", undefined, undefined, undefined]);
    expect(state().workspaces[1]).toMatchObject({ label: "名字 w2", tokens: { user_token: "keep" } });
    expect(state().workspaces.every((w: {tokens: Record<string, string>}) => w.tokens.team_git_files === undefined)).toBe(true);
    expect(run()).toEqual({ updated: 0, failed: 0 });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[1] === "report-metadata")).toHaveLength(4);
    git("branch", "-m", "feature/" + "a".repeat(80));
    expect(run()).toEqual({ updated: 1, failed: 0 });
    const longSummary = state().workspaces[0].tokens.team_git_summary;
    expect(Array.from(longSummary).length).toBe(80);
    expect(longSummary.endsWith("… · 📄1")).toBe(true);
    expect(run()).toEqual({ updated: 0, failed: 0 });
    writeFileSync(join(repo, "another file"), "changed count");
    expect(run()).toEqual({ updated: 1, failed: 0 });
    expect(state().workspaces[0].tokens.team_git_summary.endsWith("… · 📄2")).toBe(true);
    expect(run()).toEqual({ updated: 0, failed: 0 });
    expect(state().workspaces[0].label).toBe("名字 w1");
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    expect(run()).toEqual({ updated: 1, failed: 0 });
    expect(state().workspaces[0].tokens).not.toHaveProperty("team_git_summary");
    expect(readFileSync(config, "utf8")).toBe("# user configuration\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { badgeLabel, badgeStatePath, syncWorkspaceBadges } from "../scripts/lib/workspace-badges.ts";
import { fakeHerdr, makeProject } from "./helpers.ts";
import type { WorkspaceInfo } from "../scripts/lib/herdr.ts";

const workspace = (id: string, label = id): WorkspaceInfo => ({ workspace_id: id, label, pane_count: 1, tab_count: 1 });

describe("稳定的 workspace 归属编号", () => {
  test("workspace 和所有 agent 共用编号，包括非团队 agent", () => {
    const { root, cleanup } = makeProject();
    try {
      const herdr = fakeHerdr({ workspaces: [workspace("w1"), workspace("w2")], agents: [
        { name: "arch", pane_id: "w1:p1", workspace_id: "w1" },
        { pane_id: "w1:p2", workspace_id: "w1" },
        { name: "dev", pane_id: "w2:p1", workspace_id: "w2" },
      ] });
      expect(syncWorkspaceBadges(herdr, join(root, "badges.json"))).toEqual({ updated: 5, failed: 0 });
      expect(herdr.state.workspaces.map((w) => w.tokens?.team_workspace)).toEqual(["①", "②"]);
      expect(herdr.state.agents.map((a) => a.tokens?.team_workspace)).toEqual(["①", "①", "②"]);
      const calls = herdr.calls.length;
      expect(syncWorkspaceBadges(herdr, join(root, "badges.json")).updated).toBe(0);
      expect(herdr.calls.length).toBe(calls);
    } finally { cleanup(); }
  });

  test("排序、重命名、重启恢复都不重编号；新建继续递增，不回收旧号", () => {
    const { root, cleanup } = makeProject();
    try {
      const file = join(root, "badges.json");
      syncWorkspaceBadges(fakeHerdr({ workspaces: [workspace("w1"), workspace("w2")] }), file);
      const restored = fakeHerdr({ workspaces: [workspace("w2", "renamed"), workspace("w1")] });
      syncWorkspaceBadges(restored, file);
      expect(restored.state.workspaces.map((w) => w.tokens?.team_workspace)).toEqual(["②", "①"]);
      restored.state.workspaces = [workspace("w2"), workspace("w3")];
      syncWorkspaceBadges(restored, file);
      expect(restored.state.workspaces.map((w) => w.tokens?.team_workspace)).toEqual(["②", "③"]);
    } finally { cleanup(); }
  });

  test("子 worktree 沿用主 workspace 编号，不论列表先后；父目录后来加入分组也不变", () => {
    const { root, cleanup } = makeProject();
    try {
      const file = join(root, "badges.json");
      syncWorkspaceBadges(fakeHerdr({ workspaces: [workspace("w1"), workspace("w2")] }), file);
      const parent = { ...workspace("w2"), worktree: { repo_key: "/repo/.git", is_linked_worktree: false } };
      const child = { ...workspace("w3"), worktree: { repo_key: "/repo/.git", is_linked_worktree: true } };
      const herdr = fakeHerdr({ workspaces: [child, parent], agents: [{ pane_id: "w3:p1", workspace_id: "w3" }] });
      syncWorkspaceBadges(herdr, file);
      expect(herdr.state.workspaces.map((w) => w.tokens?.team_workspace)).toEqual(["②", "②"]);
      expect(herdr.state.agents[0]!.tokens?.team_workspace).toBe("②");
    } finally { cleanup(); }
  });

  test("agent 移动 workspace 后更新归属，并保留模型等其他 metadata", () => {
    const { root, cleanup } = makeProject();
    try {
      const herdr = fakeHerdr({ workspaces: [workspace("w1"), workspace("w2")], agents: [
        { pane_id: "w1:p1", workspace_id: "w1", tokens: { team_model: "sol" } },
      ] });
      const file = join(root, "badges.json");
      syncWorkspaceBadges(herdr, file);
      herdr.state.agents[0]!.workspace_id = "w2";
      syncWorkspaceBadges(herdr, file);
      expect(herdr.state.agents[0]!.tokens).toEqual({ team_model: "sol", team_workspace: "②" });
    } finally { cleanup(); }
  });

  test("上报失败重试不换号；损坏的记录拒绝覆盖并释放锁", () => {
    const { root, cleanup } = makeProject();
    try {
      const file = join(root, "badges.json");
      const herdr = fakeHerdr({ workspaces: [workspace("w1")] });
      herdr.reportBadge = () => { throw new Error("API unavailable"); };
      expect(syncWorkspaceBadges(herdr, file)).toEqual({ updated: 0, failed: 1 });
      const retry = fakeHerdr({ workspaces: [workspace("w1")] });
      syncWorkspaceBadges(retry, file);
      expect(retry.state.workspaces[0]!.tokens?.team_workspace).toBe("①");
      writeFileSync(file, '{"next":1,"assignments":{"workspace:w1":2}}');
      expect(() => syncWorkspaceBadges(retry, file)).toThrow("Invalid workspace badge registry");
      expect(readFileSync(file, "utf8")).toContain('"next":1');
      expect(existsSync(`${file}.lock`)).toBe(false);
    } finally { cleanup(); }
  });

  test("不同会话分开存储；编号超过圈号范围仍可表示", () => {
    expect(badgeStatePath({ HERDR_PLUGIN_STATE_DIR: "/state", HERDR_SOCKET_PATH: "/a.sock" })).not.toBe(
      badgeStatePath({ HERDR_PLUGIN_STATE_DIR: "/state", HERDR_SOCKET_PATH: "/b.sock" }));
    expect([1, 20, 21, 35, 36, 50, 51].map(badgeLabel)).toEqual(["①", "⑳", "㉑", "㉟", "㊱", "㊿", "[51]"]);
  });
});

test("真实 CLI 可从非项目目录同步编号，并使用插件注入的 HERDR_BIN_PATH", async () => {
  const { root, cleanup } = makeProject();
  try {
    const { chmodSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const state = join(root, "fake-herdr.json");
    writeFileSync(state, JSON.stringify({ workspaces: [workspace("w1"), workspace("w2")], agents: [
      { pane_id: "w1:p1", workspace_id: "w1" }, { pane_id: "w2:p1", workspace_id: "w2" },
    ] }));
    const executable = join(root, "fake-herdr");
    writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.BADGE_TEST_STATE, 'utf8'));
const args = process.argv.slice(2);
let result = {};
if(args[1] === 'list') result = args[0] === 'workspace' ? {workspaces:state.workspaces} : {agents:state.agents};
else if(args[1] === 'report-metadata') {
 const target = args[0] === 'workspace' ? state.workspaces.find(w=>w.workspace_id===args[2]) : state.agents.find(a=>a.pane_id===args[2]);
 const token = args[args.indexOf('--token')+1];
 const index = token.indexOf('=');
 target.tokens = {...target.tokens, [token.slice(0,index)]:token.slice(index+1)};
} else throw new Error('Unexpected call');
fs.writeFileSync(process.env.BADGE_TEST_STATE, JSON.stringify(state));
process.stdout.write(JSON.stringify({result}));
`);
    chmodSync(executable, 0o755);
    const run = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "sidebar", "--badges-only", "--json"], {
      cwd: dirname(root), env: { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: executable,
        HERDR_PLUGIN_STATE_DIR: join(root, "plugin-state"), BADGE_TEST_STATE: state }, stdout: "pipe", stderr: "pipe",
    });
    const first = run();
    expect(first.stderr.toString()).toBe("");
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toEqual({ updated: 4, failed: 0 });
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString())).toEqual({ updated: 0, failed: 0 });
    expect(JSON.parse(readFileSync(state, "utf8")).agents.map((agent: {tokens: Record<string,string>}) => agent.tokens.team_workspace)).toEqual(["①", "②"]);
  } finally { cleanup(); }
});

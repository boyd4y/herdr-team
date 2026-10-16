import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { makeProject, twoRoles, writeTask, taskMeta } from "./helpers.ts";

// Exercise the real CLI and realHerdr adapter, with an offline Herdr executable.
// Every mutation is confined to a throwaway project, never the user's team.
function withCLI(run: (cli: (...args: string[]) => { code: number; stdout: string; stderr: string }, root: string, calls: () => string[][]) => void, promptError = "", logos = "off"): void {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    writeTask(root, "0001-a", taskMeta());
    writeTask(root, "0002-b", taskMeta({ priority: "P0" }));
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(join(import.meta.dir, "../scripts/cli.ts"), join(bin, "herdr-team"));
    const stateFile = join(root, "herdr-state.json");
    writeFileSync(stateFile, JSON.stringify({ calls: [], agents: [], trees: [] }));
    const executable = join(bin, "herdr");
    writeFileSync(executable, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.HERDR_TEST_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const [command, sub] = args;
let result = {};
if (command === "workspace" && sub === "list") {
  result = { workspaces: [{ workspace_id: "w1", label: "myproj" }] };
} else if (command === "tab" && sub === "list") {
  result = { tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "docs" }] };
} else if (command === "pane" && sub === "list") {
  result = { panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" }] };
} else if (command === "agent" && sub === "list") {
  result = { agents: state.agents };
} else if (command === "worktree" && sub === "list") {
  result = { worktrees: state.trees };
} else if (command === "worktree" && sub === "create") {
  const branch = args[args.indexOf("--branch") + 1];
  const id = "w" + (state.trees.length + 2);
  state.trees.push({ branch, path: "/unused/" + branch, open_workspace_id: id });
  result = { workspace: { workspace_id: id }, tab: { tab_id: id + ":t1" }, root_pane: { pane_id: id + ":p1" } };
} else if (command === "agent" && sub === "start") {
  state.agents.push({ name: args[2], pane_id: args[args.indexOf("--pane") + 1] });
} else if (!((command === "agent" && sub === "prompt") || (command === "pane" && sub === "report-metadata"))) {
  throw new Error("Unexpected Herdr call: " + args.join(" "));
}
writeFileSync(path, JSON.stringify(state));
if (command === "agent" && sub === "prompt" && args.includes("--wait") && process.env.HERDR_TEST_PROMPT_ERROR) {
  process.stderr.write(JSON.stringify({ error: { code: process.env.HERDR_TEST_PROMPT_ERROR } }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ result }));
`);
    chmodSync(executable, 0o755);
    const cli = (...args: string[]) => {
      const proc = Bun.spawnSync([join(bin, "herdr-team"), ...args], {
        cwd: root,
        env: { ...process.env, HERDR_ENV: "1", HERDR_TEAM_LOGOS: logos, HERDR_TEST_STATE: stateFile,
          HERDR_TEST_PROMPT_ERROR: promptError, PATH: `${bin}${delimiter}${process.env.PATH}` },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    run(cli, root, () => JSON.parse(readFileSync(stateFile, "utf8")).calls);
  } finally {
    cleanup();
  }
}

describe("CLI up / dispatch", () => {
  test.each(["off", "font"])("旧环境变量 HERDR_TEAM_LOGOS=%s 不再让 up / dispatch 上报图标", (mode) => {
    withCLI((cli, _, calls) => {
      expect(cli("up").code).toBe(0);
      expect(cli("dispatch", "0001").code).toBe(0);
      const tokens = calls().filter((args) => args.some((arg) => arg.startsWith("harness_logo=")));
      expect(tokens).toEqual([]);
    }, "", mode);
  });

  for (const code of ["agent_prompt_stalled", "timeout"]) {
    test.each([false, true])(`dispatch ${code} 成功并在输出中注明未确认（json=%s）`, (json) => {
      withCLI((cli, root, calls) => {
        const result = cli("dispatch", "0001", ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject([{
            id: "0001", action: "dispatched", reason: `未能确认已开工（${code}）`,
          }]);
        } else {
          expect(result.stdout).toContain(`0001  dev  dispatched  (未能确认已开工（${code}）)`);
        }
        expect(loadProject(root).tasks.map((t) => t.status)).toEqual(["doing", "todo"]);
        expect(calls().filter((c) => c[0] === "agent" && c[1] === "prompt")).toHaveLength(1);
      }, code);
    });
  }

  test.each(["agent_blocked", "agent_not_found"])("dispatch %s 仍报错并保留 todo", (code) => {
    withCLI((cli, root) => {
      const result = cli("dispatch", "0001");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(code);
      expect(result.stdout).toBe("");
      expect(loadProject(root).tasks.map((t) => t.status)).toEqual(["todo", "todo"]);
      expect(readFileSync(join(root, ".herdr/tasks/0001-a/task.md"), "utf8")).not.toContain("(todo → doing)");
    }, code);
  });

  test("up 只起常驻角色，dispatch 派全部，按 priority 排序", () => {
    withCLI((cli, root, calls) => {
      const onboard = cli("up", "--json");
      expect(onboard.code).toBe(0);
      expect(JSON.parse(onboard.stdout)).not.toHaveProperty("dispatched");
      expect(loadProject(root).tasks.map((t) => t.status)).toEqual(["todo", "todo"]);
      expect(calls().some((c) => c[0] === "worktree")).toBe(false);
      expect(calls().filter((c) => c[0] === "agent" && c[1] === "start").map((c) => c[2])).toEqual(["docs"]);
      const assigned = cli("dispatch", "--json");
      expect(assigned.code).toBe(0);
      expect(JSON.parse(assigned.stdout).map((d: { id: string; action: string }) => [d.id, d.action])).toEqual([
        ["0002", "dispatched"], ["0001", "dispatched"],
      ]);
      expect(loadProject(root).tasks.map((t) => t.status)).toEqual(["doing", "doing"]);
    });
  });

  test("dispatch <id> 只派一张，并输出人类可读结果", () => {
    withCLI((cli, root, calls) => {
      const result = cli("dispatch", "0001");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("0001  dev  dispatched");
      expect(result.stdout).not.toContain("0002");
      expect(loadProject(root).tasks.map((t) => t.status)).toEqual(["doing", "todo"]);
      expect(calls().filter((c) => c[0] === "worktree" && c[1] === "create")).toHaveLength(1);
    });
  });

  test("未知 id / 非 todo / 多个 id 报错，且不派其他卡", () => {
    withCLI((cli, root, calls) => {
      const unknown = cli("dispatch", "9999");
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("找不到任务 9999");
      writeTask(root, "0001-a", taskMeta({ status: "done" }));
      const finished = cli("dispatch", "0001");
      expect(finished.code).toBe(2);
      expect(finished.stderr).toContain("done，只能派 todo");
      expect(cli("dispatch", "0001", "0002").code).toBe(2);
      expect(calls()).toEqual([]);
      expect(loadProject(root).tasks[1]?.status).toBe("todo");
    });
  });

  test("交给尚未启动的隔离角色时，提示的 edit + dispatch 路径可执行", () => {
    withCLI((cli, root) => {
      writeTask(root, "0001-a", taskMeta({ role: "docs", status: "doing", handoff: ["dev"] }));
      const handed = cli("handoff", "0001", "--json");
      expect(handed.code).toBe(0);
      expect(JSON.parse(handed.stdout).status).toBe("review");
      expect(JSON.parse(handed.stdout).note).toContain("edit 0001 --status todo --force");
      expect(cli("edit", "0001", "--status", "todo", "--force").code).toBe(0);
      expect(cli("dispatch", "0001").code).toBe(0);
      expect(loadProject(root).tasks[0]?.status).toBe("doing");
      expect(loadProject(root).tasks[1]?.status).toBe("todo");
    });
  });
});

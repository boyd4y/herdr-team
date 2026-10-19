import { describe, expect, test } from "bun:test";
import { HerdrError, realHerdr, type SpawnFn } from "../scripts/lib/runtime/herdr.ts";

/** 记录参数、返回预设 JSON 的假 spawn。 */
function recordingSpawn(stdout: string, code = 0): { fn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: SpawnFn = (args) => {
    calls.push(args);
    return { code, stdout: code === 0 ? stdout : "", stderr: code === 0 ? "" : stdout };
  };
  return { fn, calls };
}

const WRAP = (result: object) => JSON.stringify({ result });

describe("herdr 客户端 —— 参数拼装", () => {
  test("native plugin panes use explicit workspace/cwd/focus and validate returned scope", () => {
    const { fn, calls } = recordingSpawn(WRAP({ plugin_pane: { pane: { pane_id: "w1:p3", tab_id: "w1:t3", workspace_id: "w1" } } }));
    expect(realHerdr(fn).pluginPaneOpen("w1", "/tmp/a project", false)).toEqual({ paneId: "w1:p3", tabId: "w1:t3" });
    expect(calls[0]).toContain("--no-focus");
    expect(calls[0]).toContain("/tmp/a project");
    expect(() => realHerdr(fn).pluginPaneOpen("another", "/tmp", true)).toThrow(/mismatched/);
  });
  test("tab create 把 env 展开成 --env K=V", () => {
    const { fn, calls } = recordingSpawn(WRAP({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }));
    realHerdr(fn).tabCreate("w1", "docs", "/tmp/p", { ANTHROPIC_MODEL: "sonnet" });

    expect(calls[0]).toEqual([
      "tab", "create",
      "--workspace", "w1",
      "--label", "docs",
      "--cwd", "/tmp/p",
      "--no-focus",
      "--env", "ANTHROPIC_MODEL=sonnet",
    ]);
  });

  test("workspace create 同样带 env", () => {
    const { fn, calls } = recordingSpawn(
      WRAP({ workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
    );
    realHerdr(fn).workspaceCreate("myproj", "/tmp/p", { FOO: "bar" });

    expect(calls[0]).toEqual([
      "workspace", "create",
      "--label", "myproj",
      "--cwd", "/tmp/p",
      "--no-focus",
      "--env", "FOO=bar",
    ]);
  });

  test("没有 env 时不加 --env", () => {
    const { fn, calls } = recordingSpawn(WRAP({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }));
    realHerdr(fn).tabCreate("w1", "docs", "/tmp/p", {});
    expect(calls[0]).not.toContain("--env");
  });

  test("agent start 的额外参数走 --", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).agentStart("dev", "codex", "w1:p1", ["-m", "gpt-6.1-sol"]);

    expect(calls[0]).toEqual([
      "agent", "start", "dev", "--kind", "codex", "--pane", "w1:p1", "--", "-m", "gpt-6.1-sol",
    ]);
  });

  test("agent start 没有额外参数时不加 --", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).agentStart("dev", "codex", "w1:p1", []);
    expect(calls[0]).not.toContain("--");
  });

  test("report-metadata 带 display-agent 和 clear-state-labels", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).reportMetadata("w1:p1", "herdr-team", "dev (sol-6.1)");

    expect(calls[0]).toEqual([
      "pane", "report-metadata", "w1:p1",
      "--source", "herdr-team",
      "--display-agent", "dev (sol-6.1)",
      "--clear-state-labels",
    ]);
  });

  test("sidebar 字段分别上报，空任务用 clear-token 清除", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).reportMetadata("w1:p1", "herdr-team", "dev", {
      team_harness: "codex", team_model: "sol-6.1", team_task: null,
    });
    expect(calls[0]).toEqual([
      "pane", "report-metadata", "w1:p1", "--source", "herdr-team",
      "--display-agent", "dev", "--clear-state-labels",
      "--token", "team_harness=codex", "--token", "team_model=sol-6.1",
      "--clear-token", "team_task",
    ]);
  });

  test("workspace close 用 workspace_id", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).workspaceClose("w1");
    expect(calls[0]).toEqual(["workspace", "close", "w1"]);
  });

  test("项目归属标记写到明确 workspace，保留其他 metadata", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).reportWorkspaceMetadata("w2", { team_project: "project-key", team_root: "1" });
    expect(calls[0]).toEqual([
      "workspace", "report-metadata", "w2", "--source", "herdr-team",
      "--token", "team_project=project-key", "--token", "team_root=1",
    ]);
  });
});

describe("herdr 客户端 —— 解析与报错", () => {
  test.each(["stdout", "stderr"])("从 %s 的 JSON 错误提取错误码", (stream) => {
    const client = realHerdr(() => ({
      code: 1, stdout: "", stderr: "",
      [stream]: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "no activity" } }),
    }));
    try {
      client.agentPrompt("dev", "a task", { waitForActivity: true });
      throw new Error("expected HerdrError");
    } catch (error) {
      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBe("agent_prompt_stalled");
    }
  });

  test.each(["timeout", "agent_prompt_stalled", '{"error":{"code":123}}', "null"])("不从非结构化错误或 prompt 猜错误码：%s", (stderr) => {
    const client = realHerdr(() => ({ code: 1, stdout: "", stderr }));
    try {
      client.agentPrompt("dev", '{"error":{"code":"timeout"}} agent_prompt_stalled', { waitForActivity: true });
      throw new Error("expected HerdrError");
    } catch (error) {
      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBeUndefined();
    }
  });

  test("解析 workspace list", () => {
    const { fn } = recordingSpawn(
      WRAP({ workspaces: [{ workspace_id: "w1", label: "p", pane_count: 1, tab_count: 1 }] }),
    );
    expect(realHerdr(fn).workspaceList()).toHaveLength(1);
  });

  test("退出码非 0 时报错，带上 stderr", () => {
    const { fn } = recordingSpawn('{"error":{"message":"boom"}}', 1);
    expect(() => realHerdr(fn).workspaceList()).toThrow(HerdrError);
    expect(() => realHerdr(fn).workspaceList()).toThrow(/boom/);
  });

  test("输出不是 JSON 时报错", () => {
    const { fn } = recordingSpawn("这不是 JSON");
    expect(() => realHerdr(fn).workspaceList()).toThrow(/不是 JSON/);
  });

  test("缺 result 字段时报错", () => {
    const { fn } = recordingSpawn('{"result":{}}');
    expect(() => realHerdr(fn).workspaceList()).toThrow(/missing result/);
  });

  test("workspace create 返回值不全时报错", () => {
    const { fn } = recordingSpawn(WRAP({ workspace: { workspace_id: "w1" } }));
    expect(() => realHerdr(fn).workspaceCreate("p", "/tmp", {})).toThrow(/returned incomplete/);
  });

  test("herdr 本体不存在时报错", () => {
    const fn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    expect(() => realHerdr(fn).workspaceList()).toThrow(/PATH/);
  });
});

test("Console shell checks use process-info --pane and reject foreground children", () => {
  const calls: string[][] = [];
  let info: Record<string, unknown> = { shell_pid: 12, foreground_process_group_id: 12, foreground_processes: [{ pid: 12 }] };
  const h = realHerdr((args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ result: { process_info: info } }), stderr: "" }; });
  expect(h.paneIsShell("w1:p1")).toBe(true);
  expect(calls[0]).toEqual(["pane", "process-info", "--pane", "w1:p1"]);
  info = { ...info, foreground_process_group_id: 99, foreground_processes: [{ pid: 99 }] };
  expect(h.paneIsShell("w1:p1")).toBe(false);
  info = {};
  expect(h.paneIsShell("w1:p1")).toBe(false);
});

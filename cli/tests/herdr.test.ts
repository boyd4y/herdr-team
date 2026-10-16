import { describe, expect, test } from "bun:test";
import { HerdrError, realHerdr, type SpawnFn } from "../scripts/lib/herdr.ts";

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
  test("tab create 把 env 展开成 --env K=V", () => {
    const { fn, calls } = recordingSpawn(WRAP({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }));
    realHerdr(fn).tabCreate("w1", "docs", "/tmp/p", { ANTHROPIC_MODEL: "deepseek-flash" });

    expect(calls[0]).toEqual([
      "tab", "create",
      "--workspace", "w1",
      "--label", "docs",
      "--cwd", "/tmp/p",
      "--no-focus",
      "--env", "ANTHROPIC_MODEL=deepseek-flash",
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

  test("图标 token 用独立 metadata source 和 24 小时 TTL，不修改显示名或状态标签", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).reportTokens("w1:p1", "herdr-team-logo", { harness_logo: "\ue1a1" }, 86_400_000);
    expect(calls).toEqual([[
      "pane", "report-metadata", "w1:p1", "--source", "herdr-team-logo",
      "--ttl-ms", "86400000", "--token", "harness_logo=\ue1a1",
    ]]);
  });

  test("workspace close 用 workspace_id", () => {
    const { fn, calls } = recordingSpawn(WRAP({}));
    realHerdr(fn).workspaceClose("w1");
    expect(calls[0]).toEqual(["workspace", "close", "w1"]);
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
    expect(() => realHerdr(fn).workspaceList()).toThrow(/没有 result/);
  });

  test("workspace create 返回值不全时报错", () => {
    const { fn } = recordingSpawn(WRAP({ workspace: { workspace_id: "w1" } }));
    expect(() => realHerdr(fn).workspaceCreate("p", "/tmp", {})).toThrow(/没返回完整/);
  });

  test("herdr 本体不存在时报错", () => {
    const fn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    expect(() => realHerdr(fn).workspaceList()).toThrow(/PATH/);
  });
});

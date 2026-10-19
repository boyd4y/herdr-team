import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import type { AgentSessionInfo } from "../scripts/lib/runtime/herdr.ts";
import { down, up } from "../scripts/lib/dispatch/launch.ts";
import { refreshSessionSidebar } from "../scripts/lib/ui/sidebar.ts";
import { rememberRoleSession, resumeArgs, roleSessionPath, savedResumeArgs } from "../scripts/lib/runtime/sessions.ts";
import { fakeHerdr, makeProject, persistedCodexSession, runningWorkspace, twoResidentRoles } from "./helpers.ts";

const session = (agent = "codex", value = "session-123"): AgentSessionInfo => ({
  source: `herdr:${agent}`, agent, kind: "id", value,
});

function fixture(run: (project: ReturnType<typeof loadProject>, herdr: ReturnType<typeof runningWorkspace>) => void) {
  const { root, cleanup } = makeProject();
  try { twoResidentRoles(root); persistedCodexSession(); run(loadProject(root), runningWorkspace()); }
  finally { cleanup(); }
}

describe("up 的原生会话恢复", () => {
  test("关停前保存 ID；重建 Herdr 后按项目和角色恢复并保留模型参数", () => {
    fixture((p, h) => {
      const transcripts = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "saved-project");
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(transcripts, "claude-456.jsonl"), '{"type":"user","message":{"content":"Hello"}}\n');
      h.state.agents[0]!.agent_session = session();
      h.state.agents[1]!.agent_session = session("claude", "claude-456");
      down(p, h);
      const file = roleSessionPath(p, p.roles[0]!);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8")).session.value).toBe("session-123");
      const restarted = fakeHerdr();
      const result = up(p, restarted);
      expect(result.roles.map((r) => r.action)).toEqual(["resumed", "resumed"]);
      expect(restarted.calls.find((c) => c.startsWith("agent start dev")))
        .toContain('args=["resume","session-123","-m","gpt-6.1-sol"]');
      expect(restarted.calls.find((c) => c.startsWith("agent start docs")))
        .toContain('args=["--resume","claude-456"]');
      expect(restarted.calls.some((c) => c.startsWith("agent prompt"))).toBe(false);
    });
  });

  test("Claude IDs are saved only after real messages, and a blank session cannot replace a confirmed one", () => {
    fixture((p, h) => {
      const role = p.roles.find(role => role.kind === "claude")!;
      const agent = h.state.agents.find(agent => agent.name === role.name)!;
      agent.agent_session = session("claude", "confirmed-after-message");
      refreshSessionSidebar(h, true);
      expect(existsSync(roleSessionPath(p, role))).toBe(false);
      const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "message-confirmation");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "confirmed-after-message.jsonl");
      writeFileSync(file, '{"type":"file-history-snapshot","snapshot":{}}\n');
      refreshSessionSidebar(h, true);
      expect(existsSync(roleSessionPath(p, role))).toBe(false);
      writeFileSync(file, '{"type":"user","message":{"content":"Hello"}}\n');
      refreshSessionSidebar(h, true);
      expect(JSON.parse(readFileSync(roleSessionPath(p, role), "utf8")).confirmed).toBe(true);
      expect(savedResumeArgs(p, role)).toEqual(["--resume", "confirmed-after-message"]);
      const before = readFileSync(roleSessionPath(p, role), "utf8");
      agent.agent_session = session("claude", "another-blank-session");
      refreshSessionSidebar(h, true);
      expect(readFileSync(roleSessionPath(p, role), "utf8")).toBe(before);
    });
  });

  test("Claude confirmation respects its config profile and confirms old IDs only when messages exist", () => {
    fixture((p) => {
      const role = { ...p.roles.find(role => role.kind === "claude")!, env: { CLAUDE_CONFIG_DIR: join(p.root, "claude-profile") } };
      const agent = { agent_session: session("claude", "profile-session") };
      const other = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "other-profile");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "profile-session.jsonl"), '{"type":"user","message":{"content":"Hello"}}\n');
      expect(rememberRoleSession(p, role, agent)).toBe(false);
      const dir = join(role.env.CLAUDE_CONFIG_DIR, "projects", "profile-project");
      mkdirSync(dir, { recursive: true });
      const transcript = join(dir, "profile-session.jsonl");
      writeFileSync(transcript, "");
      expect(rememberRoleSession(p, role, agent)).toBe(false);
      writeFileSync(transcript, '{"type":"user","message":{"content":"Hello"}}\n');
      expect(rememberRoleSession(p, role, agent)).toBe(true);
      const old = JSON.parse(readFileSync(roleSessionPath(p, role), "utf8"));
      delete old.confirmed;
      writeFileSync(roleSessionPath(p, role), JSON.stringify(old));
      expect(savedResumeArgs(p, role)).toEqual(["--resume", "profile-session"]);
      expect(JSON.parse(readFileSync(roleSessionPath(p, role), "utf8")).confirmed).toBe(true);
      writeFileSync(roleSessionPath(p, role), JSON.stringify({ ...old, session: session("claude", "old-blank-id") }));
      expect(savedResumeArgs(p, role)).toBeUndefined();
      expect(savedResumeArgs(p, { ...role, args: ["--resume", "explicit-id"] })).toBeUndefined();
    });
  });

  test("Codex startup IDs need persisted messages in the selected profile; confirmed IDs avoid rereads", () => {
    fixture((p) => {
      const role = { ...p.roles[0]!, env: { CODEX_HOME: join(p.root, "codex-profile") } };
      const agent = { agent_session: session("codex", "codex-confirmation") };
      persistedCodexSession("codex-confirmation"); // A different profile must not confirm it.
      expect(rememberRoleSession(p, role, agent)).toBe(false);
      const dir = join(role.env.CODEX_HOME, "sessions", "2026", "10", "19");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "rollout-2026-10-19T10-00-00-codex-confirmation.jsonl");
      writeFileSync(file, '{"type":"session_meta","payload":{"id":"codex-confirmation"}}\n{"type":');
      expect(rememberRoleSession(p, role, agent)).toBe(false);
      writeFileSync(file, '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}\n{"type":');
      expect(rememberRoleSession(p, role, agent)).toBe(true);
      const record = readFileSync(roleSessionPath(p, role), "utf8");
      writeFileSync(file, "");
      expect(rememberRoleSession(p, role, agent)).toBe(true);
      expect(savedResumeArgs(p, role)).toEqual(["resume", "codex-confirmation"]);
      expect(rememberRoleSession(p, role, { agent_session: session("codex", "blank-replacement") })).toBe(false);
      expect(readFileSync(roleSessionPath(p, role), "utf8")).toBe(record);
      const old = JSON.parse(record);
      delete old.confirmed;
      writeFileSync(roleSessionPath(p, role), JSON.stringify(old));
      expect(savedResumeArgs(p, role)).toBeUndefined();
      writeFileSync(file, '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}\n');
      expect(savedResumeArgs(p, role)).toEqual(["resume", "codex-confirmation"]);
      expect(JSON.parse(readFileSync(roleSessionPath(p, role), "utf8")).confirmed).toBe(true);
    });
  });

  test.each(["grok", "kimi"])("%s keeps native session semantics without a message gate", (kind) => {
    fixture((p) => {
      const role = { ...p.roles[0]!, kind };
      expect(rememberRoleSession(p, role, { agent_session: session(kind, "native-id") })).toBe(true);
      expect(savedResumeArgs(p, role)).toEqual([kind === "grok" ? "--resume" : "--session", "native-id"]);
    });
  });

  test("有消息的原生 ID 可保存，运行中复用更新 ID，不发送输入", () => {
    fixture((p) => {
      const h = fakeHerdr();
      const start = h.agentStart;
      h.agentStart = (...args) => {
        start(...args);
        if (args[0] === "dev") h.state.agents.at(-1)!.agent_session = session();
      };
      up(p, h);
      expect(savedResumeArgs(p, p.roles[0]!)).toEqual(["resume", "session-123"]);
      h.state.agents[0]!.agent_session = persistedCodexSession("new-session");
      h.calls.length = 0;
      expect(up(p, h).roles[0]!.action).toBe("reused");
      expect(savedResumeArgs(p, p.roles[0]!)).toEqual(["resume", "new-session"]);
      expect(h.calls.some((c) => c.startsWith("agent start") || c.startsWith("agent prompt"))).toBe(false);
    });
  });

  test("状态事件仅保存会话，不回写 metadata；迟到的报告可被记录", () => {
    fixture((p, h) => {
      refreshSessionSidebar(h, true);
      expect(savedResumeArgs(p, p.roles[0]!)).toBeUndefined();
      h.state.agents[0]!.agent_session = session();
      expect(refreshSessionSidebar(h, true)).toEqual({ updated: 2, failed: 0 });
      expect(savedResumeArgs(p, p.roles[0]!)).toEqual(["resume", "session-123"]);
      expect(h.calls).toEqual([]);
    });
  });

  test("--fresh 在启动成功后清旧记录，失败保留；运行中的 agent 始终复用", () => {
    fixture((p, h) => {
      h.state.agents[0]!.agent_session = session();
      up(p, h);
      expect(up(p, h, { fresh: true }).roles[0]!.action).toBe("reused");
      const failed = fakeHerdr();
      failed.agentStart = () => { throw new Error("shell busy"); };
      up(p, failed, { fresh: true });
      expect(savedResumeArgs(p, p.roles[0]!)).toEqual(["resume", "session-123"]);
      const fresh = fakeHerdr();
      expect(up(p, fresh, { fresh: true }).roles[0]!.action).toBe("started");
      expect(fresh.calls.find((c) => c.startsWith("agent start dev"))).toContain('args=["-m","gpt-6.1-sol"]');
      expect(existsSync(roleSessionPath(p, p.roles[0]!))).toBe(false);
    });
  });

  test("恢复失败不重试新会话，其他角色照常启动", () => {
    fixture((p, h) => {
      h.state.agents[0]!.agent_session = session();
      up(p, h);
      const restart = fakeHerdr();
      const start = restart.agentStart;
      let attempts = 0;
      restart.agentStart = (...args) => {
        if (args[0] === "dev") { attempts++; throw new Error("session not found"); }
        start(...args);
      };
      const result = up(p, restart);
      expect(attempts).toBe(1);
      expect(result.roles[0]).toMatchObject({ action: "failed", failure: expect.stringContaining("up --fresh") });
      expect(result.roles[1]!.action).toBe("started");
      expect(savedResumeArgs(p, p.roles[0]!)).toBeDefined();
    });
  });

  test("不同项目、kind、cwd、隔离任务不混用；显式 resume 参数优先", () => {
    fixture((p) => {
      const role = p.roles[0]!;
      rememberRoleSession(p, role, { agent_session: session() });
      const other = makeProject();
      try {
        twoResidentRoles(other.root);
        expect(savedResumeArgs(loadProject(other.root), role)).toBeUndefined();
      } finally { other.cleanup(); }
      expect(savedResumeArgs(p, { ...role, kind: "claude" })).toBeUndefined();
      expect(savedResumeArgs(p, { ...role, cwd: "subdir" })).toBeUndefined();
      rememberRoleSession(p, { ...role, cwd: "subdir" }, { cwd: p.root, agent_session: session("codex", "wrong-cwd") });
      expect(savedResumeArgs(p, role)).toEqual(["resume", "session-123"]);
      expect(savedResumeArgs(p, { ...role, worktree: true })).toBeUndefined();
      expect(savedResumeArgs(p, { ...role, args: ["resume", "explicit-id"] })).toBeUndefined();
      expect(savedResumeArgs(p, { ...role, args: ["-c", "model_reasoning_effort=high"] })).toBeDefined();
    });
  });

  test("外项目 agent 不写记录，无 session 报告时保留已有记录", () => {
    fixture((p, h) => {
      const role = p.roles[0]!;
      h.state.agents[0]!.agent_session = session();
      h.state.agents[0]!.tokens!.team_project = "foreign-project";
      refreshSessionSidebar(h, true);
      expect(existsSync(roleSessionPath(p, role))).toBe(false);
      rememberRoleSession(p, role, { agent_session: session() });
      rememberRoleSession(p, role, {});
      expect(savedResumeArgs(p, role)).toBeDefined();
    });
  });

  test("一个常驻角色对应多个 agent 时不猜 session ID", () => {
    fixture((p, h) => {
      h.state.agents[0]!.agent_session = session();
      h.live("dev", "w1:p3");
      expect(refreshSessionSidebar(h, true).failed).toBe(2);
      expect(existsSync(roleSessionPath(p, p.roles[0]!))).toBe(false);
    });
  });

  test("坏记录明确报错；--fresh 可以重建", () => {
    fixture((p) => {
      const role = p.roles[0]!;
      rememberRoleSession(p, role, { agent_session: session() });
      writeFileSync(roleSessionPath(p, role), "{broken");
      expect(up(p, fakeHerdr()).roles[0]).toMatchObject({ action: "failed", failure: expect.stringContaining("session record") });
      expect(up(p, fakeHerdr(), { fresh: true }).roles[0]!.action).toBe("started");
    });
  });

  test("关停前记录写入失败则保留 agent", () => {
    fixture((p, h) => {
      h.state.agents[0]!.agent_session = session();
      mkdirSync(roleSessionPath(p, p.roles[0]!), { recursive: true });
      expect(() => down(p, h)).toThrow();
      expect(h.calls.some((c) => c.startsWith("pane close"))).toBe(false);
    });
  });
});

describe("原生恢复参数", () => {
  test.each([
    ["grok", ["--resume", "id"]], ["claude", ["--resume", "id"]],
    ["codex", ["resume", "id"]], ["copilot", ["--resume=id"]],
    ["pi", ["--session", "id"]], ["omp", ["--resume=id"]],
  ] as const)("%s", (kind, args) => expect(resumeArgs(kind, session(kind, "id"))).toEqual(args));

  test("Pi 路径会话可恢复，不执行自定义 source 或不支持的类型", () => {
    expect(resumeArgs("pi", { ...session("pi", "/tmp/session.jsonl"), kind: "path" }))
      .toEqual(["--session", "/tmp/session.jsonl"]);
    expect(resumeArgs("codex", { ...session(), source: "custom:codex" })).toBeUndefined();
    expect(resumeArgs("gemini", session("gemini"))).toBeUndefined();
    expect(resumeArgs("codex", session("codex", "--last"))).toBeUndefined();
    expect(resumeArgs("codex", session("codex", "id\ncommand"))).toBeUndefined();
  });
});

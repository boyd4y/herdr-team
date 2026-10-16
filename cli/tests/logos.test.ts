import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadProject } from "../scripts/lib/config.ts";
import { dispatch, up } from "../scripts/lib/launch.ts";
import { reportHarnessLogo } from "../scripts/lib/logos.ts";
import { fakeHerdr, makeProject, roleMeta, runningWorkspace, taskMeta, twoResidentRoles, writeRole, writeTask } from "./helpers.ts";

describe("harness_logo —— 显式启用的厂商图标", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env["HERDR_TEAM_LOGOS"];
    process.env["HERDR_TEAM_LOGOS"] = "font";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env["HERDR_TEAM_LOGOS"];
    else process.env["HERDR_TEAM_LOGOS"] = previous;
  });

  test("码点与社区字体逐个对应", () => {
    const kinds = [
      "claude", "codex", "opencode", "omp", "cline", "mastracode", "kimi", "kilo", "maki",
      "pi", "hermes", "cursor", "copilot", "deepseek", "gemini", "gpt", "qwen", "grok",
      "agy", "kiro", "amp", "devin", "qodercli", "glm", "kimchi", "muse", "crush",
    ];
    const herdr = fakeHerdr();
    const reports: unknown[][] = [];
    herdr.reportTokens = (...args) => { reports.push(args); };
    kinds.forEach((kind, index) => reportHarnessLogo(herdr, `w1:p${index + 1}`, kind));
    expect(reports).toEqual(kinds.map((_, index) => [
      `w1:p${index + 1}`, "herdr-team-logo",
      { harness_logo: String.fromCodePoint(0xe1a0 + index) }, 86_400_000,
    ]));
  });

  test.each(["droid", "letta", "unknown", "toString", "__proto__"])("无字形的 kind %s 不上报", (kind) => {
    const herdr = fakeHerdr();
    reportHarnessLogo(herdr, "w1:p1", kind);
    expect(herdr.calls).toEqual([]);
  });

  test.each([undefined, "off", "auto", "text", "", "FONT"])("开关 %s 在两条启动路径都不写 token", (mode) => {
    if (mode === undefined) delete process.env["HERDR_TEAM_LOGOS"];
    else process.env["HERDR_TEAM_LOGOS"] = mode;
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "docs", roleMeta({ kind: "claude" }));
      writeRole(root, "dev", roleMeta({ worktree: true }));
      writeTask(root, "0001-a", taskMeta());
      const project = loadProject(root);
      const herdr = fakeHerdr();
      up(project, herdr);
      dispatch(project, herdr);
      expect(herdr.state.agents).toHaveLength(2);
      expect(herdr.calls.filter((c) => c.startsWith("report-tokens"))).toEqual([]);
      expect(herdr.state.agents.every((a) => a.tokens === undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("up 每个常驻 pane 按 kind 上报，复用时也刷新", () => {
    const { root, cleanup } = makeProject();
    try {
      twoResidentRoles(root);
      const project = loadProject(root);
      for (const herdr of [fakeHerdr(), runningWorkspace()]) {
        const result = up(project, herdr);
        expect(herdr.calls.filter((c) => c.startsWith("report-tokens"))).toHaveLength(2);
        for (const [role, glyph] of [["dev", "\ue1a1"], ["docs", "\ue1a0"]]) {
          const pane = result.roles.find((r) => r.role === role)?.paneId;
          expect(herdr.state.agents.find((a) => a.pane_id === pane)?.tokens).toEqual({ harness_logo: glyph });
        }
      }
    } finally {
      cleanup();
    }
  });

  test.each(["codex", "claude", "kimi", "grok", "droid"])("dispatch 每个隔离 pane 使用 %s 对应字形或留空", (kind) => {
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "dev", roleMeta({ kind, worktree: true }));
      writeTask(root, "0001-a", taskMeta());
      writeTask(root, "0002-b", taskMeta());
      const herdr = fakeHerdr();
      expect(dispatch(loadProject(root), herdr).map((o) => o.action)).toEqual(["dispatched", "dispatched"]);
      const glyph = new Map([
        ["codex", "\ue1a1"], ["claude", "\ue1a0"], ["kimi", "\ue1a6"], ["grok", "\ue1b1"],
      ]).get(kind);
      expect(herdr.state.agents).toHaveLength(2);
      for (const agent of herdr.state.agents) {
        expect(agent.tokens).toEqual(glyph === undefined ? undefined : { harness_logo: glyph });
      }
      expect(herdr.calls.filter((c) => c.startsWith("report-tokens"))).toHaveLength(glyph === undefined ? 0 : 2);
    } finally {
      cleanup();
    }
  });

  test.each([false, true])("图标上报失败不阻断启动或派活（isolated=%s）", (isolated) => {
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "dev", roleMeta({ worktree: isolated }));
      writeTask(root, "0001-a", taskMeta());
      const project = loadProject(root);
      const herdr = fakeHerdr();
      herdr.reportTokens = () => { throw new Error("unsupported metadata"); };
      if (!isolated) {
        expect(up(project, herdr).roles[0]?.action).toBe("started");
        expect(herdr.state.agents[0]?.display_agent).toBe("dev");
      }
      expect(dispatch(project, herdr)[0]?.action).toBe("dispatched");
      expect(loadProject(root).tasks[0]?.status).toBe("doing");
      expect(herdr.state.agents[0]?.display_agent).toBe(isolated ? "dev-0001" : "dev");
    } finally {
      cleanup();
    }
  });

  test("启动失败的 pane 不写图标", () => {
    const { root, cleanup } = makeProject();
    try {
      writeRole(root, "docs", roleMeta({ kind: "claude" }));
      writeRole(root, "dev", roleMeta({ worktree: true }));
      writeTask(root, "0001-a", taskMeta());
      const project = loadProject(root);
      const herdr = fakeHerdr();
      herdr.agentStart = () => { throw new Error("busy"); };
      expect(up(project, herdr).roles.find((r) => r.role === "docs")?.action).toBe("failed");
      expect(dispatch(project, herdr)[0]?.action).toBe("no-agent");
      expect(herdr.calls.filter((c) => c.startsWith("report-tokens"))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentPresets, resolveAgentPreset } from "../scripts/lib/team/agents.ts";
import { init } from "../scripts/lib/team/init.ts";
import { addRole } from "../scripts/lib/team/roles.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { validateProject } from "../scripts/lib/team/validate.ts";
import { up } from "../scripts/lib/dispatch/launch.ts";
import { taskAgent } from "../scripts/lib/dispatch/task-agent.ts";
import { createTask } from "../scripts/lib/tasks/cards.ts";
import { fakeHerdr, makeProject, writeRole } from "./helpers.ts";

test("agents list reads project presets without local task state and preserves structured JSON", () => {
  const f = makeProject();
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "agents", ...args], {
      cwd: join(f.root, "src"), stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  try {
    rmSync(join(f.root, ".herdr"), { recursive: true });
    mkdirSync(join(f.root, "src"));
    const file = join(f.root, "agents.json");
    const config = { model: "project-model", reasoning_effort: "high", daemon: false };
    const original = JSON.stringify({ codex: { z: {}, dev: config }, acpc: { remote: { alias: "cc-remote" } } });
    writeFileSync(file, original);
    const result = cli("list", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      { kind: "acpc", preset: "remote", config: { alias: "cc-remote" } },
      { kind: "codex", preset: "dev", config }, { kind: "codex", preset: "z", config: {} },
    ]);
    const filtered = cli("list", "--kind", "codex", "--root", f.root, "--json");
    expect(filtered.code).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual(JSON.parse(result.stdout).filter((row: { kind: string }) => row.kind === "codex"));
    expect(cli("list", "--kind", "acpc").stdout).toContain("cc-remote");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(existsSync(join(f.root, ".herdr"))).toBe(false);
    expect(cli("list", "--kind", "missing").code).toBe(2);
    expect(cli("list", "--knd", "codex").code).toBe(2);
    expect(cli("unknown").code).toBe(2);
    writeFileSync(file, "{}");
    expect(JSON.parse(cli("list", "--json").stdout)).toEqual([]);
    writeFileSync(file, "{broken");
    expect(cli("list", "--json").stdout).toBe("");
    expect(cli("list", "--json").code).toBe(2);
    rmSync(file);
    expect(cli("list", "--root", f.root).code).toBe(2);
  } finally { f.cleanup(); }
});

test("structured presets expand native harness options and leave default models alone", () => {
  const f = makeProject();
  try {
    writeFileSync(join(f.root, "agents.json"), JSON.stringify({
      codex: { dev: { model: "project-model", reasoning_effort: "high", daemon: false, sandbox: "workspace-write", approval_policy: "on-request", env: { TEAM_OPTION: "value" } }, default: {} },
      claude: { review: { model: "sonnet", reasoning_effort: "high", permission_mode: "plan" } },
      acpc: { remote: { alias: "cc-remote" } },
      qodercli: { default: { model: "default" } },
    }));
    const presets = readAgentPresets(f.root);
    expect(resolveAgentPreset(presets, "codex", "dev")).toEqual({
      model: "project-model", env: { TEAM_OPTION: "value" },
      args: ["-m", "project-model", "--no-daemon", "-c", 'model_reasoning_effort="high"', "--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    });
    expect(resolveAgentPreset(presets, "codex", "default").args).toEqual([]);
    expect(resolveAgentPreset(presets, "claude", "review").args).toEqual(["--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]);
    expect(resolveAgentPreset(presets, "acpc", "remote").args).toEqual(["--agent", "cc-remote"]);
    expect(resolveAgentPreset(presets, "qodercli", "default").args).toEqual([]);
  } finally { f.cleanup(); }
});

test("invalid presets fail explicitly without falling back to the seed", () => {
  const f = makeProject();
  try {
    const file = join(f.root, "agents.json");
    for (const value of [[], { codex: { dev: { daemon: "false" } } }, { codex: { dev: { args: ["-m", "x"] } } },
      { claude: { dev: { alias: "wrong-harness" } } }, { acpc: { remote: { model: "unsupported-override" } } },
      { codex: { dev: { env: { OPTION: 42 } } } }]) {
      writeFileSync(file, JSON.stringify(value));
      expect(() => readAgentPresets(f.root)).toThrow(/Invalid agent presets/);
    }
    writeFileSync(file, JSON.stringify({ codex: { default: {} } }));
    expect(() => resolveAgentPreset(readAgentPresets(f.root), "codex", "missing")).toThrow(/Unknown agent preset/);
    writeRole(f.root, "dev", { kind: "codex", preset: "missing" });
    expect(validateProject(loadProject(f.root)).some(p => p.message.includes("Unknown agent preset"))).toBe(true);
    rmSync(file);
    expect(validateProject(loadProject(f.root)).some(p => p.message.includes("requires a valid root agents.json"))).toBe(true);
  } finally { f.cleanup(); }
});

test("role preset selection replaces explicit settings and preserves custom prompts and task records", () => {
  const f = makeProject();
  try {
    init(loadProject(f.root), []);
    writeRole(f.root, "dev", { kind: "codex", model: "old", args: ["-m", "old"], env: { OLD: "value" } }, "Custom responsibilities");
    const task = createTask(loadProject(f.root), { title: "Keep history", role: "dev", handoff: [], priority: "P2", body: "Keep this task" });
    const taskFile = join(f.root, ".herdr", task.dir, ".task.yaml");
    const before = readFileSync(taskFile, "utf8");
    addRole(loadProject(f.root), { name: "dev", preset: "dev", force: true });
    const project = loadProject(f.root), role = project.roles[0]!;
    expect(role.preset).toBe("dev");
    expect(role.meta.model).toBeUndefined();
    expect(role.meta.args).toBeUndefined();
    expect(role.meta.env).toBeUndefined();
    expect(role.body).toBe("Custom responsibilities\n");
    expect(readFileSync(taskFile, "utf8")).toBe(before);
    expect(() => addRole(project, { name: "dev", model: "conflict", force: true })).toThrow(/cannot also define/);
    expect(() => addRole(project, { name: "bad", kind: "codex", preset: "missing" })).toThrow(/Unknown agent preset/);
    expect(existsSync(join(f.root, ".herdr/roles/bad"))).toBe(false);
    addRole(project, { name: "dev", preset: "", model: "explicit", args: ["-m", "explicit"], force: true });
    expect(loadProject(f.root).roles[0]!.preset).toBeUndefined();
  } finally { f.cleanup(); }
});

test("resident and task launches share project presets; edits affect subsequent starts", () => {
  const f = makeProject();
  try {
    init(loadProject(f.root), [{ name: "dev", kind: "codex", preset: "dev" }]);
    const project = loadProject(f.root), resident = fakeHerdr();
    up(project, resident);
    const first = resident.calls.find(call => call.startsWith("agent start dev"))!;
    expect(first).toContain('model_reasoning_effort=\\"high\\"');
    const file = join(f.root, "agents.json"), presets = JSON.parse(readFileSync(file, "utf8"));
    presets.codex.dev.model = "updated-model";
    writeFileSync(file, JSON.stringify(presets));
    const fresh = loadProject(f.root);
    createTask(fresh, { title: "Preset launch", role: "dev", handoff: [], priority: "P2", body: "Run the assigned task" });
    const task = fakeHerdr(), assigned = loadProject(f.root);
    taskAgent(assigned, task, assigned.roles[0]!, assigned.tasks[0]!);
    const second = task.calls.find(call => call.startsWith("agent start"))!;
    expect(second).toContain("updated-model");
    expect(second).toContain('model_reasoning_effort=\\"high\\"');
    expect(resident.calls.filter(call => call.startsWith("agent start"))).toHaveLength(1);
  } finally { f.cleanup(); }
});

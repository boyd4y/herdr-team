import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { runAgentPreset } from "../scripts/lib/runtime/agent-test.ts";

function probeFixture(root: string) {
  const bin = join(root, "bin"), log = join(root, "calls.jsonl");
  mkdirSync(bin);
  const source = `#!${process.execPath}
import {appendFileSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
const args = process.argv.slice(2), mode = process.env.TEST_MODE;
appendFileSync(process.env.TEST_LOG, JSON.stringify({args,cwd:process.cwd(),mode})+"\\n");
if(mode === "auth") { console.error("Authentication failed"); process.exit(3); }
if(mode === "hang") {
 spawn(process.execPath,["-e",'setTimeout(()=>require("fs").writeFileSync(process.env.TEST_ORPHAN,"orphan"),2000)'],{stdio:"inherit"});
 setInterval(()=>{},1000);
} else if(mode !== "interactive") {
 const output = args.indexOf("--output-last-message");
 const reply = mode === "malformed" ? "HERDR_TEAM_OK" : "HERDR_TEAM_OK model: " + (mode === "unknown" ? "unknown" : "fixture-model");
 if(output >= 0 && mode !== "banner") writeFileSync(args[output+1],reply);
 console.log(reply);
}


`;
  for (const name of ["codex", "claude", "grok", "kimi", "qoder"]) {
    const file = join(bin, name); writeFileSync(file, source); chmodSync(file, 0o755);
  }
  const env = { PATH: bin, TEST_LOG: log, TEST_ORPHAN: join(root, "orphan.txt") };
  return { log, env, run: (...args: string[]) => Bun.spawnSync([
    process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "agents", ...args, "--root", root,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" }) };
}

test("local CLI checks respect preset environments, deduplicate probes and keep credentials private", () => {
  const f = makeProject();
  try {
    const fixture = probeFixture(f.root);
    const script = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args=process.argv.slice(2), mode=process.env.TEST_MODE;
appendFileSync(process.env.TEST_LOG,JSON.stringify(args)+"\\n");
if(args[0]==="--version") console.log("fake-cli 1.2.3-beta.1");
else if(args[0]==="login") {
 console.error(mode==="out" ? "Not logged in" : "Logged in using API key: SECRET_TEST_CREDENTIAL");
 process.exit(mode==="out" ? 1 : 0);
} else if(args[0]==="auth" || args[0]==="status") console.log(mode==="broken" ? "SECRET_TEST_CREDENTIAL" : JSON.stringify({loggedIn:mode!=="out",logged_in:mode!=="out",apiKey:"SECRET_TEST_CREDENTIAL"}));
else process.exit(9);
`;
    for (const name of ["codex", "claude", "grok", "qodercli"]) {
      writeFileSync(join(f.root, "bin", name), script); chmodSync(join(f.root, "bin", name), 0o755);
    }
    rmSync(join(f.root, "bin/qoder"));
    const config = (mode: string) => ({ env: { ...fixture.env, TEST_MODE: mode } });
    const original = JSON.stringify({
      codex: { a: config("in"), b: { ...config("in"), model: "different-model" }, c: config("out"), missing: { env: { PATH: join(f.root, "missing") } } },
      claude: { in: config("in"), out: config("out"), broken: config("broken") },
      grok: { default: config("in") }, qoder: { default: config("in") },
    });
    writeFileSync(join(f.root, "agents.json"), original);
    expect(fixture.run("list", "--json").exitCode).toBe(0);
    expect(existsSync(fixture.log)).toBe(false);
    const output = fixture.run("check", "--json");
    expect(output.exitCode).toBe(1);
    expect(output.stderr.toString()).toBe("");
    expect(output.stdout.toString()).not.toContain("SECRET_TEST_CREDENTIAL");
    const rows = JSON.parse(output.stdout.toString());
    const row = (kind: string, preset: string) => rows.find((r: { kind: string; preset: string }) => r.kind === kind && r.preset === preset);
    expect(row("codex", "a").auth).toBe("logged-in");
    expect(row("codex", "b").version).toBe("1.2.3-beta.1");
    expect(row("codex", "c").auth).toBe("not-logged-in");
    expect(row("codex", "missing").installed).toBe(false);
    expect(row("claude", "in").auth).toBe("logged-in");
    expect(row("claude", "out").auth).toBe("not-logged-in");
    expect(row("claude", "broken").auth).toBe("unknown");
    expect(row("claude", "broken").issues.length).toBeGreaterThan(0);
    expect(row("grok", "default").auth).toBe("unknown");
    expect(row("qoder", "default").executable).toBe(join(f.root, "bin/qodercli"));
    expect(row("qoder", "default").auth).toBe("logged-in");
    expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toHaveLength(13);
    expect(fixture.run("check", "--kind", "grok", "--json").exitCode).toBe(0);
    expect(fixture.run("check", "codex/a", "--json").exitCode).toBe(0);
    expect(fixture.run("check", "codex/a", "--kind", "codex").exitCode).toBe(2);
    expect(fixture.run("check", "--all").exitCode).toBe(2);
    expect(readFileSync(join(f.root, "agents.json"), "utf8")).toBe(original);
    expect(existsSync(join(f.root, ".herdr/tasks"))).toBe(false);
  } finally { f.cleanup(); }
});

test("local CLI check timeouts remain unknown and do not prevent checking other presets", () => {
  const f = makeProject();
  try {
    const fixture = probeFixture(f.root);
    writeFileSync(join(f.root, "agents.json"), JSON.stringify({ grok: {
      hang: { env: { ...fixture.env, TEST_MODE: "hang" } }, missing: { env: { PATH: join(f.root, "missing") } },
    } }));
    const output = fixture.run("check", "--timeout-ms", "200", "--json");
    expect(output.exitCode).toBe(1);
    const rows = JSON.parse(output.stdout.toString());
    expect(rows[0].installed).toBe(true);
    expect(rows[0].auth).toBe("unknown");
    expect(rows[0].issues[0]).toContain("timed out");
    expect(rows[1].installed).toBe(false);
    expect(rows[1].issues[0]).toContain("Executable not found");
  } finally { f.cleanup(); }
});

test("batch response tests isolate checkouts, report failures, kill timed-out helpers and continue", async () => {
  const f = makeProject();
  try {
    const fixture = probeFixture(f.root), file = join(f.root, "agents.json");
    const config = (mode: string) => ({ model: "project-model", daemon: false, approval_policy: "on-request", env: { ...fixture.env, TEST_MODE: mode } });
    const original = JSON.stringify({ codex: { "a-pass": config("pass"), "b-auth": config("auth"), "c-banner": config("banner"), "d-timeout": config("hang"), "e-malformed": config("malformed"), "f-unknown": config("unknown"), "z-pass": config("pass") }, amp: { default: {} } });
    writeFileSync(file, original);
    const result = fixture.run("test", "--all", "--timeout-ms", "1000", "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    const rows = JSON.parse(result.stdout.toString());
    expect(rows.map((row: { status: string }) => row.status)).toEqual(["skipped", "passed", "failed", "failed", "failed", "failed", "passed", "passed"]);
    expect(rows[1].model).toBe("project-model");
    expect(rows[1].reportedModel).toBe("fixture-model");
    expect(rows[1].detail).toContain("Self-reported model: fixture-model");
    expect(rows.find((row: { preset: string }) => row.preset === "e-malformed").detail).toContain("Unexpected response");
    expect(rows.find((row: { preset: string }) => row.preset === "f-unknown").reportedModel).toBe("unknown");
    expect(rows.find((row: { preset: string }) => row.preset === "b-auth").detail).toContain("Authentication failed");
    expect(rows.find((row: { preset: string }) => row.preset === "d-timeout").detail).toContain("Timed out");
    const calls = readFileSync(fixture.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toHaveLength(7);
    expect(calls[0].args).toContain('approval_policy="on-request"');
    expect(calls[0].args).toContain("project-model");
    expect(calls[0].args[0]).toBe("--no-daemon");
    expect(calls.every(call => !call.cwd.startsWith(realpathSync(f.root)) && !existsSync(call.cwd))).toBe(true);
    await Bun.sleep(1200);
    expect(existsSync(fixture.env.TEST_ORPHAN)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(existsSync(join(f.root, ".herdr/tasks"))).toBe(false);
  } finally { f.cleanup(); }
}, 10000);

test("single and filtered probes use native response modes; run inherits the preset without team state", async () => {
  const f = makeProject();
  try {
    const fixture = probeFixture(f.root);
    writeFileSync(join(f.root, "agents.json"), JSON.stringify(Object.fromEntries(["claude", "grok", "kimi", "qoder"].map(kind => [kind, { custom: { env: fixture.env } }]))));
    const one = fixture.run("test", "kimi/custom", "--json");
    expect(one.exitCode).toBe(0);
    expect(JSON.parse(one.stdout.toString()).map((row: { kind: string }) => row.kind)).toEqual(["kimi"]);
    const all = fixture.run("test", "--all", "--json");
    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout.toString()).every((row: { status: string }) => row.status === "passed")).toBe(true);
    const filtered = fixture.run("test", "--all", "--kind", "claude", "--json");
    expect(JSON.parse(filtered.stdout.toString()).map((row: { kind: string }) => row.kind)).toEqual(["claude"]);
    expect(fixture.run("test").exitCode).toBe(2);
    expect(fixture.run("test", "kimi/custom", "--all").exitCode).toBe(2);
    expect(fixture.run("test", "kimi/custom", "--timeout-ms", "0").exitCode).toBe(2);
    expect(fixture.run("run", "kimi/custom").exitCode).toBe(2); // Inherited CLI pipes are not a TTY.
    const before = process.listenerCount("SIGINT");
    const exit = await runAgentPreset(f.root, { kind: "qoder", preset: "custom", config: { model: "project-model", env: { ...fixture.env, TEST_MODE: "interactive" } } });
    expect(exit).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
    const call = JSON.parse(readFileSync(fixture.log, "utf8").trim().split("\n").at(-1)!);
    expect(call.args).toEqual(["--model", "project-model"]);
    expect(call.cwd).toBe(realpathSync(f.root));
  } finally { f.cleanup(); }
});

test("cancelling response tests stops the current process and leaves remaining presets unstarted", async () => {
  const f = makeProject();
  try {
    const fixture = probeFixture(f.root);
    writeFileSync(join(f.root, "agents.json"), JSON.stringify({ codex: {
      first: { env: { ...fixture.env, TEST_MODE: "hang" } }, second: { env: fixture.env },
    } }));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "agents", "test", "--all", "--json", "--root", f.root], { stdout: "pipe", stderr: "pipe" });
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(fixture.log) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(fixture.log)).toBe(true);
      child.kill("SIGINT");
      expect(await child.exited).toBe(130);
      const results = JSON.parse(await new Response(child.stdout).text());
      expect(results.map((row: { status: string }) => row.status)).toEqual(["failed", "skipped"]);
      expect(results[0].detail).toBe("Cancelled");
      expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally { child.kill("SIGKILL"); await child.exited; }
  } finally { f.cleanup(); }
});

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
    const original = JSON.stringify({ codex: { z: {}, dev: config }, acp: { remote: { command: "cc-remote", args: ["--host", "ssh-alias"] } } });
    writeFileSync(file, original);
    const result = cli("list", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      { kind: "acp", preset: "remote", config: { command: "cc-remote", args: ["--host", "ssh-alias"] } },
      { kind: "codex", preset: "dev", config }, { kind: "codex", preset: "z", config: {} },
    ]);
    const filtered = cli("list", "--kind", "codex", "--root", f.root, "--json");
    expect(filtered.code).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual(JSON.parse(result.stdout).filter((row: { kind: string }) => row.kind === "codex"));
    expect(cli("list", "--kind", "acp").stdout).toContain("cc-remote");
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
      qoder: { default: { model: "default" } },
    }));
    const presets = readAgentPresets(f.root);
    expect(resolveAgentPreset(presets, "codex", "dev")).toEqual({
      model: "project-model", env: { TEAM_OPTION: "value" },
      args: ["-m", "project-model", "--no-daemon", "-c", 'model_reasoning_effort="high"', "--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    });
    expect(resolveAgentPreset(presets, "codex", "default").args).toEqual([]);
    expect(resolveAgentPreset(presets, "claude", "review").args).toEqual(["--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]);
    expect(resolveAgentPreset(presets, "qoder", "default").args).toEqual([]);
  } finally { f.cleanup(); }
});

test("Qoder has one public name while old project presets and role inputs remain usable", () => {
  const f = makeProject();
  try {
    const file = join(f.root, "agents.json");
    const original = JSON.stringify({ qodercli: { custom: { model: "project-model" } } });
    writeFileSync(file, original);
    const presets = readAgentPresets(f.root);
    expect(Object.keys(presets)).toEqual(["qoder"]);
    expect(resolveAgentPreset(presets, "qodercli", "custom").args).toEqual(["--model", "project-model"]);
    writeRole(f.root, "old-role", { kind: "qodercli", preset: "custom" });
    addRole(loadProject(f.root), { name: "new-role", kind: "qoder", preset: "custom" });
    expect(loadProject(f.root).roles.map(role => role.kind)).toEqual(["qoder", "qoder"]);
    expect(validateProject(loadProject(f.root))).toEqual([]);
    const query = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "agents", "list", "--kind", "qodercli", "--root", f.root, "--json"]);
    expect(query.exitCode).toBe(0);
    expect(JSON.parse(query.stdout.toString())[0].kind).toBe("qoder");
    expect(readFileSync(file, "utf8")).toBe(original);
    writeFileSync(file, JSON.stringify({ qodercli: { default: {} }, qoder: { default: { model: "different" } } }));
    expect(() => readAgentPresets(f.root)).toThrow(/Both qoder and qodercli define/);
  } finally { f.cleanup(); }
});

test("invalid presets fail explicitly without falling back to the seed", () => {
  const f = makeProject();
  try {
    const file = join(f.root, "agents.json");
    for (const value of [[], { codex: { dev: { daemon: "false" } } }, { codex: { dev: { args: ["-m", "x"] } } },
      { claude: { dev: { alias: "wrong-harness" } } }, { acpc: { remote: {} } },
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

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoDelay, demoSettings } from "../scripts/lib/demo/config.ts";
import { demoContent } from "../scripts/lib/demo/content.ts";
import { showcaseLanes } from "../scripts/lib/demo/release.ts";
import { smokeSource } from "../scripts/lib/demo/scenario.ts";
import { checkArtifact } from "../scripts/lib/demo/shared.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-demo-test-"));
  mkdirSync(join(root, ".herdr"));
  const save = (record: unknown) => writeFileSync(join(root, ".herdr/demo.json"), JSON.stringify(record));
  return { root, save, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("local demo controls are opt-in, validated and overridden by environment", () => {
  const f = fixture();
  try {
    expect(demoSettings(f.root, {})).toEqual({ enabled: false, speed: 1, concurrency: 3, paused: false });
    f.save({ enabled: true, speed: 0.5, concurrency: 2, paused: true });
    expect(demoSettings(f.root, { HERDR_TEAM_DEMO: "0", HERDR_TEAM_DEMO_SPEED: "4" })).toEqual({ enabled: false, speed: 4, concurrency: 2, paused: true });
    for (const value of [{ speed: 0 }, { speed: "" }, { concurrency: 1.5 }, { paused: "maybe" }, null]) {
      f.save(value);
      expect(() => demoSettings(f.root, {})).toThrow();
    }
  } finally { f.clean(); }
});

test("a waiting demo responds to pause and live speed changes", async () => {
  const f = fixture();
  try {
    f.save({ paused: true });
    let finished = false;
    const wait = demoDelay(f.root, 1000).then(() => { finished = true; });
    await Bun.sleep(300);
    expect(finished).toBe(false);
    f.save({ paused: false, speed: 100 });
    await wait;
    expect(finished).toBe(true);
  } finally { f.clean(); }
});

test("all showcase cards have context and executable acceptance that catches rework", () => {
  const f = fixture();
  mkdirSync(join(f.root, "demo"));
  try {
    for (const [index, lane] of showcaseLanes.entries()) {
      const content = demoContent(lane, "v1.2.0");
      expect(content.body).toContain("## Acceptance criteria");
      expect(content.body).toContain("Demo fixture:");
      expect(content.acceptance).toContain("Examples:");
      const task = { id: String(index), ordinal: index, artifact: `demo/${lane.slug}.ts`, scenario: content.scenario };
      const run = { root: f.root, fast: true, tasks: [task] };
      writeFileSync(join(f.root, task.artifact), smokeSource(content.scenario, false));
      expect(checkArtifact(run, task, f.root)).toBe(false);
      writeFileSync(join(f.root, task.artifact), smokeSource(content.scenario, true));
      expect(checkArtifact(run, task, f.root)).toBe(true);
    }
  } finally { f.clean(); }
});

test.each(["env", "file"])("ordinary init accepts hidden %s configuration without changing presentation help", mode => {
  const f = fixture();
  try {
    const env = { ...process.env, HERDR_TEAM_DEMO: mode === "env" ? "1" : "0", HERDR_TEAM_HOME: join(f.root, "service"), HERDR_PLUGIN_STATE_DIR: join(f.root, "plugin"), HERDR_ENV: "0" };
    delete (env as NodeJS.ProcessEnv).HC_TERMINAL_ID;
    if (mode === "env") rmSync(join(f.root, ".herdr"), { recursive: true });
    if (mode === "file") { delete (env as NodeJS.ProcessEnv).HERDR_TEAM_DEMO; f.save({ enabled: true, speed: 0.5 }); }
    const cli = join(import.meta.dir, "../scripts/cli.ts");
    const call = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { cwd: f.root, env });
    const init = call("init", "--json");
    expect(init.stderr.toString()).toBe("");
    expect(init.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(f.root, ".herdr/demo.json"), "utf8"));
    expect(config.kind).toBe("herdr-team-demo");
    expect(config.speed).toBe(mode === "file" ? 0.5 : 1);
    expect(call("up", "--help").stdout.toString()).not.toContain("--demo");
    const up = call("up", "--json");
    expect(up.exitCode).not.toBe(0);
    expect(up.stderr.toString()).toContain("Herdr terminal");
  } finally { f.clean(); }
});

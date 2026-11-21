import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { smokeChecks, smokeFixtures, type SmokeScenario } from "./scenario.ts";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

export interface MockTask {
  id: string;
  artifact: string;
  ordinal: number;
  rejectOnce?: boolean;
  scenario?: SmokeScenario;
  scope?: string;
}

export interface MockRun {
  root: string;
  fast: boolean;
  tasks: MockTask[];
  scenario?: SmokeScenario;
}

export function handoffGate(area: string, delivery: string): string {
  return join(area, `handoff-${delivery}.ready`);
}

export function demoPath(prefix?: string): string {
  return [...new Set([prefix, dirname(process.execPath), join(homedir(), ".local/bin"), process.env.PATH]
    .filter(Boolean))].join(delimiter);
}

export function command(args: string[], cwd: string, allowFailure = false) {
  const output = Bun.spawnSync(args, { cwd, env: { ...process.env, PATH: demoPath() }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const stdout = output.stdout.toString().trim(), stderr = output.stderr.toString().trim();
  if (output.exitCode !== 0 && !allowFailure) {
    throw new Error(`${args[0]}: ${stderr || stdout || `exited with status ${output.exitCode}`}`);
  }
  return { stdout, stderr, code: output.exitCode };
}

export function teamCommand(root: string, args: string[], allowFailure = false) {
  return command([process.execPath, cli, ...args, "--root", root, "--json"], root, allowFailure);
}

export function team<T>(root: string, ...args: string[]): T {
  return JSON.parse(teamCommand(root, args).stdout) as T;
}

export function checkArtifact(run: MockRun, task: MockTask, cwd: string): boolean {
  const scenario = task.scenario ?? run.scenario;
  if (scenario) {
    const fixture = smokeFixtures[scenario.fixture];
    const check = `
      import assert from "node:assert/strict";
      const evaluate = (await import(process.argv[1]))[${JSON.stringify(fixture.name)}];
      for (const { args, expected } of ${JSON.stringify(smokeChecks(scenario))}) {
        assert.deepEqual(evaluate(...args), expected);
      }
    `;
    return command([process.execPath, "-e", check, pathToFileURL(join(cwd, task.artifact)).href], cwd, true).code === 0;
  }
  const raw = readFileSync(join(cwd, task.artifact), "utf8");
  const expected = `export const result = { lane: ${task.ordinal}, accepted: true } as const;`;
  return raw.split("\n").includes(expected) && raw.includes(`// ${task.artifact}\n`) && Boolean(run.tasks.find(item => item.id === task.id));
}

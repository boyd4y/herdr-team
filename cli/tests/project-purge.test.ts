import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import { newDelivery } from "../scripts/lib/dispatch/delivery.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { writeTaskMeta } from "../scripts/lib/tasks/cards.ts";

function fixture(action: (base: string, run: (...args: string[]) => ReturnType<typeof Bun.spawnSync>, call: (...args: string[]) => any) => void) {
  const base = mkdtempSync(join(tmpdir(), "herdr-purge-test-"));
  const env = { ...process.env, HERDR_TEAM_HOME: join(base, "service"), HERDR_PLUGIN_STATE_DIR: join(base, "plugin"), HERDR_ENV: "0" };
  delete (env as NodeJS.ProcessEnv).HC_TERMINAL_ID;
  const cli = join(import.meta.dir, "../scripts/cli.ts");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args, "--json"], { cwd: base, env });
  const call = (...args: string[]) => {
    const result = run(...args);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  try {
    call("team", "init", "--roles", '[{"name":"dev","kind":"codex"}]');
    action(base, run, call);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test("project purge previews and clears only selected workflow records, retaining task IDs and registration", () => fixture((base, run, call) => {
  const project = call("project", "create", "--name", "purge-test");
  const { id } = call("task", "create", "Example task", "--role", "dev");
  call("issue", "create", "Example issue", "--iteration", "v1.1");
  call("iteration", "archive", "v1.1");
  const herdr = join(base, ".herdr");
  writeFileSync(join(herdr, "feature-deliveries.json"), JSON.stringify([{ feature: "example", iteration: "v1.1", tasks: [id], confirmed_at: new Date().toISOString() }]));
  writeFileSync(join(herdr, "demo.json"), JSON.stringify({ kind: "herdr-team-demo" }));
  mkdirSync(join(herdr, "demo"));
  writeFileSync(join(herdr, "demo", "result.json"), "{}\n");
  writeFileSync(join(herdr, "tasks", "unrelated.txt"), "keep\n");
  writeFileSync(join(herdr, "issues", "unrelated.txt"), "keep\n");
  expect(run("project", "purge").exitCode).toBe(2);
  const preview = call("project", "purge", "--all", "--dry-run", "--project", project.id);
  expect(preview).toMatchObject({ dryRun: true, tasks: 1, issues: 1, iterations: 1, featureDeliveries: 1, blockers: [] });
  expect(call("task", "list", "--all")).toHaveLength(1);
  const removed = call("project", "purge", "--all", "--project", project.id);
  expect(removed).toMatchObject({ dryRun: false, tasks: 1, issues: 1, iterations: 1, featureDeliveries: 1, blockers: [] });
  expect(call("task", "list", "--all")).toEqual([]);
  expect(call("issue", "list")).toEqual([]);
  expect(call("iteration", "list", "--all")).toEqual([]);
  expect(call("project", "show").aliases).toEqual(["purge-test"]);
  expect(readFileSync(join(herdr, "tasks", "unrelated.txt"), "utf8")).toBe("keep\n");
  expect(readFileSync(join(herdr, "issues", "unrelated.txt"), "utf8")).toBe("keep\n");
  expect(existsSync(join(herdr, "demo", "result.json"))).toBe(false);
  expect(existsSync(join(herdr, "demo.json"))).toBe(true);
  expect(existsSync(join(base, "TEAM.md"))).toBe(true);
  expect(call("project", "purge", "--all")).toMatchObject({ tasks: 0, issues: 0 });
  expect(call("task", "create", "Example task", "--role", "dev").id).toBe("0002");
}));

test("project purge fails safely while delivery or a Git worktree remains", () => fixture((base, run, call) => {
  call("task", "create", "Example task", "--role", "dev");
  const root = call("project", "show").root;
  const key = projectKey({ root });
  const teams = join(base, "service", "teams");
  mkdirSync(teams, { recursive: true });
  const registration = join(teams, `${key}.json`);
  const team = { root, kind: "desktop", endpoint: "test-core", space: "test-space", env: {}, enabled: true };
  writeFileSync(registration, JSON.stringify(team));
  expect(call("project", "purge", "--all", "--dry-run").blockers[0]).toContain("Automatic delivery is enabled");
  expect(run("project", "purge", "--all").exitCode).toBe(2);
  expect(run("project", "purge", "--all", "--force").exitCode).toBe(2);
  expect(call("task", "list", "--all")).toHaveLength(1);
  writeFileSync(registration, JSON.stringify({ ...team, enabled: false }));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", base, ...args]);
    expect(result.stderr.toString()).not.toContain("fatal:");
    expect(result.exitCode).toBe(0);
  };
  git("init", "-q");
  git("-c", "user.name=Herdr Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  const checkout = join(base, "checkout");
  git("worktree", "add", "-q", "-b", "feat/0001-example-task", checkout);
  expect(call("project", "purge", "--all", "--dry-run").blockers[0]).toContain("Task checkout remains");
  expect(run("project", "purge", "--all").exitCode).toBe(2);
  expect(run("project", "purge", "--all", "--force").exitCode).toBe(2);
  expect(existsSync(checkout)).toBe(true);
  expect(call("task", "list", "--all")).toHaveLength(1);
  git("worktree", "remove", checkout);
  const project = loadProject(root);
  const task = project.tasks[0]!;
  writeTaskMeta(project, task, { status: "doing", delivery: { ...newDelivery(task.role, "dispatch"), state: "claimed" } });
  expect(call("project", "purge", "--all", "--dry-run").blockers[0]).toContain("unfinished delivery");
  expect(run("project", "purge", "--all").exitCode).toBe(2);
  expect(call("project", "purge", "--all", "--force", "--dry-run")).toMatchObject({ tasks: 1, blockers: [] });
  expect(call("task", "list", "--all")).toHaveLength(1);
  expect(call("project", "purge", "--all", "--force").tasks).toBe(1);
  git("show-ref", "--verify", "refs/heads/feat/0001-example-task");
}), 15_000);

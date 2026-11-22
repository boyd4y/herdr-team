import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bare command groups show help without changing project state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-cli-help-"));
  const home = join(cwd, "state");
  try {
    for (const command of ["project", "team", "task", "issue", "iteration", "feature", "role", "agents", "inbox", "space", "daemon",
      "agentmail", "init", "validate", "up", "status", "add", "edit", "tasks", "backlog", "dispatch", "claim", "handoff", "merge", "clean"]) {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), command], { cwd, env: { ...process.env, HERDR_TEAM_HOME: home } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`Usage: herdr-team ${command}`);
      expect(result.stderr.toString()).toBe("");
    }
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(cwd, ".herdr"))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("bare down resolves the project just like team down", () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-cli-down-"));
  const env = { ...process.env, HERDR_TEAM_HOME: join(cwd, ".state") };
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args], { cwd, env });
  try {
    const canonical = run("team", "down");
    expect(canonical.exitCode).not.toBe(0);
    const alias = run("down");
    expect(alias.exitCode).toBe(canonical.exitCode);
    expect(alias.stderr.toString().split("\n")[0]).toBe(canonical.stderr.toString().split("\n")[0]);
    expect(alias.stdout.toString()).toBe("");
    expect(run("down", "--help").stdout.toString()).toContain("Usage: herdr-team down");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("JSON output is complete when the pipe reader pauses", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-cli-json-"));
  const env = { ...process.env, HERDR_TEAM_HOME: join(cwd, ".state") };
  const cli = join(import.meta.dir, "../scripts/cli.ts");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { cwd, env });
  try {
    expect(run("team", "init", "--roles", '[{"name":"dev","kind":"codex"}]').exitCode).toBe(0);
    const body = "Keep every line.\n".repeat(60_000);
    const file = join(cwd, "body.md");
    writeFileSync(file, body);
    expect(run("task", "create", "Large task body", "--role", "dev", "--body-file", file).exitCode).toBe(0);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "task", "show", "0001", "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let error = "";
      child.stdout.on("data", chunk => {
        chunks.push(chunk);
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 10);
      });
      child.stderr.on("data", chunk => { error += chunk; });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) resolve(Buffer.concat(chunks).toString());
        else reject(new Error(error || `CLI exited with code ${code}`));
      });
    });
    expect(JSON.parse(output).body).toBe(body);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("project and task use the same CRUD verbs and preserve their records on delete", () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-cli-crud-"));
  const env = { ...process.env, HERDR_TEAM_HOME: join(cwd, ".state"), HERDR_ENV: "0" };
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args, "--json"], { cwd, env });
  const call = (...args: string[]) => {
    const result = run(...args);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  try {
    call("team", "init", "--roles", '[{"name":"dev","kind":"codex"}]');
    call("project", "create", "--name", "example-project");
    call("project", "update", "--name", "renamed-project");
    expect(call("project", "show").aliases).toEqual(["renamed-project"]);
    expect(call("project", "list")).toHaveLength(1);
    const { id } = call("task", "create", "Example task", "--role", "dev");
    call("task", "update", id, "--title", "Updated task");
    expect(call("task", "show", id).title).toBe("Updated task");
    expect(call("task", "list")).toHaveLength(1);
    const invalid = run("task", "list", id);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr.toString()).toContain("herdr-team task show ID");
    expect(call("task", "archive", id)).toMatchObject({ status: "todo", meta: { disposition: "archived" } });
    expect(call("task", "list", "--status", "todo", "--disposition", "archived")).toHaveLength(1);
    expect(call("task", "list", "--status", "todo")).toEqual([]);
    expect(call("task", "list", "--status", "archived")).toHaveLength(1);
    expect(run("task", "dispatch", id).stderr.toString()).toContain(`Restore task ${id} before dispatching it`);
    expect(call("task", "delete", id)).toMatchObject({ status: "todo", meta: { disposition: "deleted" } });
    expect(call("task", "delete", id)).toMatchObject({ status: "todo", meta: { disposition: "deleted" } });
    expect(call("task", "list")).toEqual([]);
    expect(call("task", "list", "--disposition", "deleted")).toHaveLength(1);
    expect(call("task", "restore", id).status).toBe("todo");
    call("task", "update", id, "--status", "doing");
    expect(run("task", "archive", id).exitCode).toBe(2);
    expect(call("task", "archive", id, "--force")).toMatchObject({ status: "doing", meta: { disposition: "archived" } });
    expect(call("task", "list", "--status", "doing", "--disposition", "archived")).toHaveLength(1);
    expect(call("task", "restore", id).status).toBe("todo");
    expect(run("task", "update", id, "--status", "cancelled").exitCode).toBe(2);
    const dependent = call("task", "create", "Dependent", "--role", "dev", "--depends-on", id);
    expect(run("task", "archive", id).stderr.toString()).toContain(`#${dependent.id}`);
    call("task", "update", id, "--status", "done");
    const archived = call("task", "archive", id);
    expect(archived.status).toBe("done");
    expect(archived.meta.disposition).toBe("archived");
    expect(call("task", "list", "--status", "done", "--disposition", "archived")).toMatchObject([{ id, status: "done" }]);
    expect(call("task", "delete", id).meta.disposition).toBe("deleted");
    const restored = call("task", "restore", id);
    expect(restored.status).toBe("done");
    expect(restored.meta.disposition).toBeUndefined();
    call("project", "delete");
    expect(call("project", "list")).toEqual([]);
    expect(call("project", "show").aliases).toEqual([]);
    expect(call("project", "show").registered).toBe(false);
    expect(call("task", "show", id).title).toBe("Updated task");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

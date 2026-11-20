import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProject, taskMeta, twoRoles, writeTask } from "./helpers.ts";

test("requirements and defects share an optional iteration; old and independent tasks stay usable", () => {
  const fixture = makeProject();
  try {
    const { root } = fixture;
    twoRoles(root);
    writeTask(root, "0001-old", taskMeta({ title: "完成旧任务", status: "done" }));
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args, "--json"], {
      cwd: root, env: { ...process.env, HERDR_ENV: "0" },
    });
    const json = (...args: string[]) => {
      const result = run(...args);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return JSON.parse(result.stdout.toString());
    };
    expect(json("backlog", "list")).toEqual([]);
    expect(json("backlog", "add", "导出 CSV", "--acceptance", "CSV 内容与列表一致")).toMatchObject({ id: "R0001", type: "requirement" });
    expect(json("backlog", "add", "空结果时报错", "--type", "defect")).toMatchObject({ id: "R0002", type: "defect" });
    for (const invalid of ["backlog", "requirement", "defect"]) {
      expect(run("backlog", "add", "Invalid version", "--iteration", invalid).exitCode).toBe(2);
      expect(run("backlog", "edit", "R0001", "--iteration", invalid).exitCode).toBe(2);
    }
    expect(run("backlog", "edit", "R0001", "R9999", "--iteration", "v0.2").exitCode).toBe(2);
    expect(json("backlog", "list", "--iteration", "v0.2")).toEqual([]);
    json("backlog", "edit", "R0001", "R0002", "--iteration", "v0.2");
    expect(json("backlog", "list", "--iteration", "v0.2")).toHaveLength(2);
    expect(json("backlog", "list", "--type", "defect")).toMatchObject([{ id: "R0002", iteration: "v0.2" }]);
    json("backlog", "edit", "R0002", "--iteration", "");
    expect(json("backlog", "list", "--iteration", "")).toMatchObject([{ id: "R0002" }]);
    expect(json("backlog", "list")[0]).not.toHaveProperty("acceptance");

    const oldTask = json("tasks", "0001");
    const oldBody = readFileSync(join(root, ".herdr/tasks/0001-old/task.md"), "utf8");
    json("backlog", "link", "R0001", "0001");
    expect(json("tasks", "0001")).toEqual({ ...oldTask, iteration: "v0.2", meta: { ...oldTask.meta, requirement: "R0001" } });
    expect(readFileSync(join(root, ".herdr/tasks/0001-old/task.md"), "utf8")).toBe(oldBody);
    expect(json("backlog", "show", "R0001")).toMatchObject({
      status: "ready", progress: { done: 1, total: 1 }, acceptance: "CSV 内容与列表一致",
    });
    expect(run("backlog", "link", "R0002", "0001").exitCode).toBe(2);

    const standalone = json("add", "Independent task", "--role", "dev");
    expect(json("tasks", standalone.id).meta).not.toHaveProperty("requirement");
    expect(json("tasks", standalone.id)).toMatchObject({ status: "todo" });
    const linked = json("add", "Implement CSV export", "--role", "dev", "--requirement", "R0001");
    expect(json("tasks", linked.id).meta).toMatchObject({ requirement: "R0001", status: "todo" });
    expect(json("tasks", linked.id).meta).not.toHaveProperty("iteration");
    expect(json("iteration", "list")).toEqual([{ version: "v0.2", state: "active" }]);
    expect(run("iteration", "archive", "v1.0").exitCode).toBe(2);
    expect(json("iteration", "archive", "v0.2")).toEqual({ version: "v0.2", state: "archived" });
    expect(json("iteration", "list")).toEqual([]);
    expect(json("backlog", "list")).toMatchObject([{ id: "R0002" }]);
    expect(json("backlog", "list", "--iteration", "v0.2")).toEqual([]);
    expect(json("tasks", "--all")).toMatchObject([{ id: standalone.id }]);
    expect(json("tasks", linked.id)).toMatchObject({ id: linked.id, status: "todo" });
    expect(json("iteration", "delete", "v0.2")).toEqual({ version: "v0.2", state: "deleted" });
    expect(json("iteration", "list", "--all")).toEqual([{ version: "v0.2", state: "deleted" }]);
    expect(json("tasks", "--all")).toMatchObject([{ id: standalone.id }]);
    expect(json("backlog", "show", "R0001")).toMatchObject({ iteration: "v0.2", progress: { done: 1, total: 2 } });
    expect(json("iteration", "restore", "v0.2")).toEqual({ version: "v0.2", state: "active" });
    expect(json("backlog", "list", "--iteration", "v0.2")).toMatchObject([{ id: "R0001", iteration: "v0.2" }]);
    expect(json("tasks", "--all")).toHaveLength(3);
    expect(run("backlog", "accept", "R0001").exitCode).toBe(2);
    json("backlog", "unlink", "R0001", linked.id);
    json("backlog", "accept", "R0001");
    expect(json("backlog", "show", "R0001")).toMatchObject({ status: "accepted", progress: { done: 1, total: 1 } });
    expect(run("add", "Cannot link new work after acceptance", "--role", "dev", "--requirement", "R0001").exitCode).toBe(2);
    expect(json("tasks", "--all")).toHaveLength(3);
    expect(run("dispatch", "--all").exitCode).toBe(2);

    const path = join(root, ".herdr/requirements.json");
    const cards = JSON.parse(readFileSync(path, "utf8"));
    cards[1].iteration = "Requirement";
    writeFileSync(path, JSON.stringify(cards));
    expect(json("iteration", "list")).toEqual([{ version: "v0.2", state: "active" }]);
    expect(json("backlog", "list", "--iteration", "")).toMatchObject([{ id: "R0002", status: "backlog", iteration: "" }]);
    json("backlog", "edit", "R0002", "--priority", "P1");
    expect(JSON.parse(readFileSync(path, "utf8"))[1].iteration).toBe("Requirement");
  } finally { fixture.cleanup(); }
});

test("task iterations can override an issue and be archived independently", () => {
  const fixture = makeProject();
  try {
    twoRoles(fixture.root);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args, "--json"], {
      cwd: fixture.root, env: { ...process.env, HERDR_ENV: "0" },
    });
    const json = (...args: string[]) => {
      const result = run(...args);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return JSON.parse(result.stdout.toString());
    };
    const issue = json("backlog", "add", "Issue", "--iteration", "v1.2");
    const inherited = json("add", "Inherit iteration", "--role", "dev", "--requirement", issue.id);
    const override = json("add", "Earlier preparation", "--role", "dev", "--requirement", issue.id, "--iteration", "v1.1");
    const independent = json("add", "Independent task", "--role", "dev", "--iteration", "v1.3");
    expect(run("add", "Invalid version", "--role", "dev", "--iteration", "Backlog").exitCode).toBe(2);
    expect(json("tasks", "--iteration", "v1.1")).toMatchObject([{ id: override.id, iteration: "v1.1" }]);
    expect(json("tasks", "--iteration", "v1.2")).toMatchObject([{ id: inherited.id, iteration: "v1.2" }]);
    expect(json("iteration", "list").map((row: { version: string }) => row.version)).toEqual(["v1.1", "v1.2", "v1.3"]);

    json("iteration", "archive", "v1.2");
    expect(json("tasks", "--all")).toMatchObject([{ id: override.id }, { id: independent.id }]);
    expect(json("backlog", "list")).toEqual([]);
    json("iteration", "delete", "v1.3");
    expect(json("tasks", "--all")).toMatchObject([{ id: override.id }]);
    json("iteration", "restore", "v1.2");
    json("backlog", "edit", issue.id, "--iteration", "v1.4");
    expect(json("tasks", inherited.id).iteration).toBe("v1.4");
    expect(json("tasks", override.id).iteration).toBe("v1.1");
    json("edit", override.id, "--iteration", "");
    expect(json("tasks", override.id)).toMatchObject({ iteration: "v1.4", status: "todo" });
    expect(json("tasks", override.id).meta).not.toHaveProperty("iteration");
    json("edit", independent.id, "--status", "cancelled");
    const terminal = json("tasks", independent.id);
    json("edit", independent.id, "--iteration", "");
    const rescheduled = json("tasks", independent.id);
    const { iteration: _previous, meta, ...record } = terminal;
    const { iteration: _override, ...unchanged } = meta;
    expect(rescheduled).toEqual({ ...record, meta: unchanged });
    expect(json("tasks", "--iteration", "", "--all")).toMatchObject([{ id: independent.id }]);
  } finally { fixture.cleanup(); }
});

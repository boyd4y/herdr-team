import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadProject } from "../scripts/lib/config.ts";
import { createTask, editTask, writeTaskMeta } from "../scripts/lib/task.ts";
import { taskWorkflow } from "../scripts/lib/legacy-workflow.ts";
import { validateProject } from "../scripts/lib/validate.ts";
import { makeBareProject, makeProject, roleMeta, writeRole } from "./helpers.ts";

const entry = join(import.meta.dir, "../scripts/cli.ts");
function run(root: string, args: string[]) {
  return Bun.spawnSync([process.execPath, entry, ...args, "--root", root], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
}

test("Skill onboarding has no CLI route; help exposes available commands without creating configuration", () => {
  const p = makeBareProject();
  try {
    rmSync(join(p.root, ".herdr"), { recursive: true });
    for (const command of ["onboard", "sidebar", "workflow"]) expect(run(p.root, [command, "--json"]).exitCode).toBe(2);
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
    const common = run(p.root, ["--help"]);
    expect(common.exitCode).toBe(0);
    expect(common.stdout.toString()).not.toContain("--all");
    const routes = [...readFileSync(entry, "utf8").matchAll(/^    case "([^"]+)":/gm)].map((match) => match[1]!);
    for (const command of routes) {
      expect(common.stdout.toString()).toMatch(new RegExp(`^  ${command}\\b`, "m"));
      expect(run(p.root, [command, "--help"]).exitCode).toBe(0);
    }
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
  } finally { p.cleanup(); }
});


test("removed workflow options fail without writing configuration or tasks", () => {
  const p = makeBareProject();
  try {
    rmSync(join(p.root, ".herdr"), { recursive: true });
    for (const option of ["--workflow", "--workflow-file"]) {
      expect(run(p.root, ["init", option, "old-value", "--plan", "cheap"]).exitCode).toBe(2);
      expect(existsSync(join(p.root, ".herdr"))).toBe(false);
    }
    expect(run(p.root, ["init", "--workflow=direct", "--plan", "cheap"]).exitCode).toBe(2);
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
    expect(run(p.root, ["init", "--roles", JSON.stringify([{ name: "builder", kind: "codex", body: "Implement changes" }])]).exitCode).toBe(0);
    expect(run(p.root, ["add", "Change", "--role", "builder", "--workflow", "direct"]).exitCode).toBe(2);
    expect(loadProject(p.root).tasks).toEqual([]);
  } finally { p.cleanup(); }
});

test("Skill agreements and old project defaults cannot implicitly configure new task chains", () => {
  const p = makeProject();
  try {
    for (const role of ["builder", "qa", "auditor"]) writeRole(p.root, role, roleMeta());
    const agreement = join(p.root, ".herdr/workflow.md");
    writeFileSync(agreement, "Use builder → qa → auditor; merge after approval.\n");
    // Old project JSON is now Skill input; even malformed contents cannot block the CLI.
    writeFileSync(join(p.root, ".herdr/workflow.json"), "old invalid configuration");
    const load = () => loadProject(p.root);
    expect(validateProject(load())).toEqual([]);
    createTask(load(), { title: "Direct", role: "builder", handoff: [], priority: "P2", body: "Criteria" });
    createTask(load(), { title: "Reviewed", role: "builder", handoff: ["qa", "auditor"], priority: "P2", body: "Criteria" });
    expect(load().tasks.map((task) => task.handoff)).toEqual([[], ["qa", "auditor"]]);
    expect(load().tasks.every((task) => task.meta.workflow === undefined)).toBe(true);
    writeFileSync(agreement, "Use builder → auditor for future tasks.\n");
    expect(load().tasks[1]!.handoff).toEqual(["qa", "auditor"]);
    editTask(load(), "0002", { handoff: ["auditor"] }, false);
    expect(load().tasks[1]!.handoff).toEqual(["auditor"]);
  } finally { p.cleanup(); }
});

test("initialization preserves role bodies, Skill agreements and legacy task snapshots", () => {
  const p = makeProject();
  try {
    const workflow = { name: "old-local", delivery: "local", merge: "manual", steps: [{ kind: "develop", role: "builder" }, { kind: "test", role: "qa" }] };
    for (const role of ["builder", "qa"]) writeRole(p.root, role, roleMeta(), "Existing responsibilities");
    const load = () => loadProject(p.root);
    createTask(load(), { title: "Existing", role: "builder", handoff: ["qa"], priority: "P2", body: "Criteria" });
    writeTaskMeta(load(), load().tasks[0]!, { workflow });
    const taskPath = join(p.root, ".herdr", load().tasks[0]!.dir, ".task.yaml");
    const before = readFileSync(taskPath, "utf8");
    const agreement = join(p.root, ".herdr/workflow.md"); writeFileSync(agreement, "Keep this agreement.\n");
    expect(run(p.root, ["init", "--roles", JSON.stringify([{ name: "builder", kind: "claude", body: "Replacement" }])]).exitCode).toBe(0);
    expect(load().roles.find((role) => role.name === "builder")!.body.trim()).toBe("Existing responsibilities");
    expect(readFileSync(agreement, "utf8")).toBe("Keep this agreement.\n");
    expect(readFileSync(taskPath, "utf8")).toBe(before);
    expect(taskWorkflow(load().tasks[0]!)).toEqual(workflow);
    expect(() => editTask(load(), "0001", { handoff: [] }, false)).toThrow(/Legacy/);
    expect(readFileSync(taskPath, "utf8")).toBe(before);
  } finally { p.cleanup(); }
});

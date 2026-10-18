import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadProject } from "../scripts/lib/config.ts";
import { createTask, writeTaskMeta } from "../scripts/lib/task.ts";
import { parseWorkflow, readWorkflow, taskWorkflow, workflowPreset, writeWorkflow } from "../scripts/lib/workflow.ts";
import { removeRole, tasksUsingRole } from "../scripts/lib/role.ts";
import { emitYaml, parseYaml } from "../scripts/lib/yaml.ts";
import { makeBareProject, makeProject, roleMeta, writeRole } from "./helpers.ts";

const entry = join(import.meta.dir, "../scripts/cli.ts");
function run(root: string, args: string[]) {
  return Bun.spawnSync([process.execPath, entry, ...args, "--root", root], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
}

test("Skill onboarding has no CLI route; internal operations remain callable outside default help", () => {
  const p = makeBareProject();
  try {
    rmSync(join(p.root, ".herdr"), { recursive: true });
    expect(run(p.root, ["onboard", "--json"]).exitCode).toBe(2);
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
    const common = run(p.root, ["--help"]);
    expect(common.exitCode).toBe(0);
    expect(common.stdout.toString()).not.toContain("sidebar");
    expect(common.stdout.toString()).not.toContain("claim <id>");
    const tools = run(p.root, ["--help", "--all"]);
    expect(tools.exitCode).toBe(0);
    expect(tools.stdout.toString()).toContain("sidebar");
    for (const command of ["sidebar", "claim", "handoff", "queue"]) {
      expect(run(p.root, [command, "--help"]).exitCode).toBe(0);
    }
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
  } finally { p.cleanup(); }
});

test("init saves the workflow and role definitions confirmed by the Skill", () => {
  const p = makeBareProject();
  try {
    rmSync(join(p.root, ".herdr"), { recursive: true });
    const selected = run(p.root, ["workflow", "set", "dev-test-review"]);
    expect(selected.exitCode).toBe(0); expect(loadProject(p.root).roles).toEqual([]);
    expect(existsSync(join(p.root, ".herdr/identity.md"))).toBe(false);
    const result = run(p.root, ["init", "--plan", "cheap"]);
    expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
    expect(loadProject(p.root).roles.map((role) => role.name)).toEqual(["dev", "lead", "review", "test"]);
    expect(readWorkflow(loadProject(p.root))?.merge).toBe("auto");
  } finally { p.cleanup(); }
});

test("custom workflow names roles by responsibility instead of hard-coding dev/test/review", () => {
  const p = makeBareProject();
  try {
    const workflow = parseWorkflow({ ...workflowPreset("dev-test-review"), name: "shipping", merge: "manual",
      steps: [{ kind: "develop", role: "builder" }, { kind: "test", role: "qa" }, { kind: "review", role: "auditor" }] });
    const file = join(p.root, "workflow-input.json"); writeFileSync(file, JSON.stringify(workflow));
    const result = run(p.root, ["init", "--workflow-file", file, "--plan", "balanced"]);
    expect(result.exitCode).toBe(0);
    const project = loadProject(p.root);
    expect(project.roles.map((role) => role.name)).toEqual(["auditor", "builder", "lead", "qa"]);
    expect(readWorkflow(project)).toEqual(workflow);
  } finally { p.cleanup(); }
});

test("incomplete workflow references or duplicate role definitions fail before init writes files", () => {
  const p = makeBareProject();
  try {
    rmSync(join(p.root, ".herdr"), { recursive: true });
    const missing = run(p.root, ["init", "--workflow", "direct", "--roles", JSON.stringify([{ name: "lead", kind: "codex" }])]);
    expect(missing.exitCode).toBe(2); expect(missing.stderr.toString()).toContain("requires role dev");
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
    const duplicate = run(p.root, ["init", "--workflow", "direct", "--roles", JSON.stringify([{ name: "lead", kind: "codex" }, { name: "lead", kind: "claude" }, { name: "dev", kind: "codex" }])]);
    expect(duplicate.exitCode).toBe(2); expect(duplicate.stderr.toString()).toContain("Duplicate role definition");
    expect(existsSync(join(p.root, ".herdr"))).toBe(false);
  } finally { p.cleanup(); }
});

test("reinitialization preserves role definitions and existing task workflow snapshots", () => {
  const p = makeBareProject();
  try {
    expect(run(p.root, ["init", "--workflow", "dev-test-review", "--plan", "cheap"]).exitCode).toBe(0);
    writeRole(p.root, "lead", roleMeta({ model: "custom-model" }), "Existing lead instructions");
    const leadBody = loadProject(p.root).roles.find((role) => role.name === "lead")!.body;
    createTask(loadProject(p.root), { title: "Existing work", role: "dev", handoff: [], priority: "P2", body: "Criteria" });
    const result = run(p.root, ["init", "--workflow", "direct", "--plan", "balanced", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(run(p.root, ["role", "list", "--json"]).stdout.toString())).toContainEqual(expect.objectContaining({ name: "lead", kind: "codex", model: "custom-model" }));
    const project = loadProject(p.root);
    expect(project.roles.find((role) => role.name === "lead")!.body).toBe(leadBody);
    expect(taskWorkflow(project.tasks[0]!)?.name).toBe("dev-test-review");
    expect(project.tasks[0]!.handoff).toEqual(["test", "review"]);
  } finally { p.cleanup(); }
});

test("project workflow changes affect future tasks and task snapshots round-trip through YAML", () => {
  const p = makeProject();
  try {
    for (const role of ["dev", "test", "review"]) writeRole(p.root, role, roleMeta());
    const project = () => loadProject(p.root);
    writeWorkflow(project(), workflowPreset("dev-test-review"));
    const create = (title: string) => createTask(project(), { title, role: "dev", handoff: [], priority: "P2", body: "Criteria" });
    create("First");
    expect(project().tasks[0]!.handoff).toEqual(["test", "review"]);
    writeWorkflow(project(), workflowPreset("direct"));
    create("Second");
    expect(taskWorkflow(project().tasks[0]!)?.name).toBe("dev-test-review");
    expect(taskWorkflow(project().tasks[1]!)?.name).toBe("direct");
    expect(parseYaml(emitYaml({ workflow: workflowPreset("dev-test-review") }))?.workflow).toEqual(workflowPreset("dev-test-review"));
    createTask(project(), { title: "Explicit chain", role: "dev", handoff: ["test"], priority: "P2", body: "Criteria", workflow: null });
    expect(taskWorkflow(project().tasks[2]!)).toBeUndefined();
    writeTaskMeta(project(), project().tasks[0]!, { status: "review", role: "review", handoff: [] });
    expect(tasksUsingRole(project(), "test")).toContain("0001");
    expect(() => removeRole(project(), "test")).toThrow(/active tasks/);
  } finally { p.cleanup(); }
});

test("an unstarted task can explicitly change workflow; active tasks cannot be moved silently", () => {
  const p = makeProject();
  try {
    for (const role of ["dev", "test", "review"]) writeRole(p.root, role, roleMeta());
    const project = () => loadProject(p.root);
    createTask(project(), { title: "First", role: "dev", handoff: [], priority: "P2", body: "Criteria" });
    expect(run(p.root, ["workflow", "apply", "0001", "--preset", "dev-test-review"]).exitCode).toBe(0);
    expect(project().tasks[0]!.handoff).toEqual(["test", "review"]);
    writeTaskMeta(project(), project().tasks[0]!, { status: "doing" });
    const result = run(p.root, ["workflow", "apply", "0001", "--preset", "direct"]);
    expect(result.exitCode).toBe(2); expect(result.stderr.toString()).toContain("unstarted todo");
    expect(taskWorkflow(project().tasks[0]!)?.name).toBe("dev-test-review");
  } finally { p.cleanup(); }
});

test("invalid workflow adjustments preserve the previous selection", () => {
  const p = makeProject();
  try {
    writeWorkflow(loadProject(p.root), workflowPreset("dev-test"));
    const before = readFileSync(join(p.root, ".herdr/workflow.json"), "utf8");
    const file = join(p.root, "bad.json");
    writeFileSync(file, JSON.stringify({ ...workflowPreset("dev-test-review"), steps: [{ kind: "review", role: "lead" }] }));
    expect(run(p.root, ["workflow", "set", "--file", file]).exitCode).toBe(1);
    expect(readFileSync(join(p.root, ".herdr/workflow.json"), "utf8")).toBe(before);
    expect(() => parseWorkflow({ ...workflowPreset("dev-test"), merge: "auto" })).toThrow(/requires/);
  } finally { p.cleanup(); }
});

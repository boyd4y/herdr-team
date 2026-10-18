import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NAME_RE, type Project, type TaskCard } from "./types.ts";

export type StepKind = "develop" | "test" | "review" | "work";
export interface Workflow {
  name: string;
  steps: Array<{ kind: StepKind; role: string }>;
  delivery: "local" | "pull-request";
  merge: "manual" | "auto";
}
export const WORKFLOW_NAMES = ["dev-test-review", "dev-test", "direct"] as const;
export function workflowPreset(name: string): Workflow {
  switch (name) {
    case "dev-test-review": return { name, steps: [{ kind: "develop", role: "dev" }, { kind: "test", role: "test" }, { kind: "review", role: "review" }], delivery: "pull-request", merge: "auto" };
    case "dev-test": return { name, steps: [{ kind: "develop", role: "dev" }, { kind: "test", role: "test" }], delivery: "local", merge: "manual" };
    case "direct": return { name, steps: [{ kind: "work", role: "dev" }], delivery: "local", merge: "manual" };
    default: throw new Error(`Unknown workflow ${name}; use ${WORKFLOW_NAMES.join(", ")} or --file`);
  }
}
export function parseWorkflow(value: unknown): Workflow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow must be a JSON object");
  const workflow = value as Workflow;
  if (typeof workflow.name !== "string" || !NAME_RE.test(workflow.name) || !Array.isArray(workflow.steps) || !workflow.steps.length ||
      !["local", "pull-request"].includes(workflow.delivery) || !["manual", "auto"].includes(workflow.merge)) throw new Error("Invalid workflow name, steps, delivery, or merge policy");
  const names = new Set<string>();
  for (const step of workflow.steps) {
    if (!step || !["develop", "test", "review", "work"].includes(step.kind) || typeof step.role !== "string" ||
        !NAME_RE.test(step.role) || names.has(step.role) || step.role === "lead") throw new Error("Workflow steps require distinct role names; lead stays the resident coordinator");
    names.add(step.role);
  }
  if (workflow.delivery === "pull-request" && (workflow.steps.length !== 3 || workflow.steps.map((step) => step.kind).join(",") !== "develop,test,review")) {
    throw new Error("The PR workflow requires develop, test, review steps in that order; role names are configurable");
  }
  if (workflow.delivery === "local" && workflow.merge === "auto") throw new Error("Automatic merge requires a tested and reviewed pull request");
  return JSON.parse(JSON.stringify(workflow));
}
export function readWorkflow(project: Pick<Project, "herdrDir">): Workflow | undefined {
  const file = join(project.herdrDir, "workflow.json");
  if (!existsSync(file)) return;
  return parseWorkflow(JSON.parse(readFileSync(file, "utf8")));
}
export function writeWorkflow(project: Pick<Project, "herdrDir">, workflow: Workflow): void {
  const value = parseWorkflow(workflow), file = join(project.herdrDir, "workflow.json");
  mkdirSync(project.herdrDir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
/** Existing tasks carry a snapshot, so editing project defaults never moves live work. */
export function taskWorkflow(task: Pick<TaskCard, "meta">): Workflow | undefined {
  return task.meta.workflow == null ? undefined : parseWorkflow(task.meta.workflow);
}
export function stepRole(task: TaskCard, kind: StepKind): string | undefined {
  return taskWorkflow(task)?.steps.find((step) => step.kind === kind)?.role;
}

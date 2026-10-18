// Read-only compatibility for workflow snapshots on existing tasks.
import { NAME_RE, type TaskCard } from "./types.ts";

export type StepKind = "develop" | "test" | "review" | "work";
export interface Workflow {
  name: string;
  steps: Array<{ kind: StepKind; role: string }>;
  delivery: "local" | "pull-request";
  merge: "manual" | "auto";
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
/** Existing tasks carry a snapshot, so editing project defaults never moves live work. */
export function taskWorkflow(task: Pick<TaskCard, "meta">): Workflow | undefined {
  return task.meta.workflow == null ? undefined : parseWorkflow(task.meta.workflow);
}
export function stepRole(task: TaskCard, kind: StepKind): string | undefined {
  return taskWorkflow(task)?.steps.find((step) => step.kind === kind)?.role;
}

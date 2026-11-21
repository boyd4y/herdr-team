import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTeamLock } from "../runtime/state.ts";
import { isTerminal, SLUG_MAX, SLUG_RE, type Project, type RoleCard, type TaskCard } from "../shared/types.ts";
import { loadProject } from "./project.ts";
import { findIssueMetadata } from "./issue-store.ts";
import { iterationVersion, taskIteration, validateIteration } from "./requirements.ts";
import { completedDeliveries } from "../dispatch/delivery.ts";

export class FeatureError extends Error {}
export interface FeatureScope { feature: string; iteration: string }
interface FeatureDelivery extends FeatureScope { tasks: string[]; confirmed_at: string }

export function validFeature(value: unknown): value is string {
  return typeof value === "string" && value.length <= SLUG_MAX && SLUG_RE.test(value);
}

export function validateFeature(value: string): string {
  if (value === "" || validFeature(value)) return value;
  throw new FeatureError("Use a feature name such as session-recovery (lowercase, digits and hyphens)");
}

export function featureKey(scope: FeatureScope): string {
  return `${scope.feature}@${scope.iteration}`;
}

export function deliveredTask(
  task: TaskCard | undefined, feature: string | undefined, iteration: string | undefined,
  delivery: string | undefined, confirmations: ReadonlyMap<string, FeatureDelivery>,
): task is TaskCard {
  if (!task || !feature || !iteration || !delivery || !isTerminal(task.status) || task.meta.pending_history) return false;
  const confirmed = confirmations.get(featureKey({ feature, iteration }));
  return Boolean(confirmed?.tasks.includes(task.id) && (task.status !== "done" || completedDeliveries(task).includes(delivery)));
}

const filename = (project: Project) => join(project.herdrDir, "feature-deliveries.json");

export function confirmedFeatures(project: Project): Map<string, FeatureDelivery> {
  let text: string;
  try { text = readFileSync(filename(project), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
  try {
    const records: FeatureDelivery[] = JSON.parse(text);
    if (!Array.isArray(records)) throw new Error();
    const result = new Map<string, FeatureDelivery>();
    for (const record of records) {
      if (!record || !validFeature(record.feature) || typeof record.iteration !== "string" ||
          iterationVersion(record.iteration) !== record.iteration || !record.iteration ||
          !Array.isArray(record.tasks) || !record.tasks.length || record.tasks.some(id => typeof id !== "string" || !/^\d{4}$/.test(id)) ||
          !Number.isFinite(Date.parse(record.confirmed_at)) || result.has(featureKey(record))) throw new Error();
      result.set(featureKey(record), record);
    }
    return result;
  } catch { throw new FeatureError("Invalid .herdr/feature-deliveries.json"); }
}

function scopeFor(project: Project, task: TaskCard): FeatureScope | undefined {
  const { feature, requirement } = task.meta;
  if (!validFeature(feature)) return;
  const explicit = typeof task.meta.iteration === "string" && iterationVersion(task.meta.iteration);
  const issue = !explicit && typeof requirement === "string"
    ? findIssueMetadata(project, requirement) : undefined;
  const iteration = taskIteration(task, new Map(issue ? [[issue.id, iterationVersion(issue.iteration)]] : []));
  if (iteration) return { feature, iteration };
}

export function dispatchFeature(project: Project, task: TaskCard, role?: RoleCard): FeatureScope | undefined {
  const scope = scopeFor(project, task);
  if (!scope && (role?.lifecycle === "temporary" || task.meta.feature)) {
    throw new FeatureError(`Task ${task.id} needs a feature and iteration before dispatch`);
  }
  if (scope && confirmedFeatures(project).has(featureKey(scope))) {
    throw new FeatureError(`Feature ${featureKey(scope)} is already delivered; schedule follow-up work in a new iteration`);
  }
  return scope;
}

/** The user's delivery confirmation is independent of task completion and iteration visibility. */
export function finishFeature(project: Project, feature: string, version: string): FeatureDelivery {
  const scope = { feature: validateFeature(feature), iteration: validateIteration(version) };
  if (!scope.feature || !scope.iteration) throw new FeatureError("A feature and iteration are required");
  return withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    const records = confirmedFeatures(fresh);
    const key = featureKey(scope);
    const saved = records.get(key);
    if (saved) return saved;
    const tasks = fresh.tasks.filter(task => task.meta.feature === feature && scopeFor(fresh, task)?.iteration === scope.iteration);
    if (!tasks.length) throw new FeatureError(`No tasks found for ${key}`);
    const open = tasks.filter(task => !isTerminal(task.status) || task.meta.pending_history);
    if (open.length) throw new FeatureError(`Finish the tasks for ${key} first: ${open.map(task => task.id).join(", ")}`);
    const record = { ...scope, tasks: tasks.map(task => task.id), confirmed_at: new Date().toISOString() };
    const destination = filename(fresh), temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify([...records.values(), record], null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { force: true }); }
    return record;
  });
}

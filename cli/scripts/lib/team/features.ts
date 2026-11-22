import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTeamLock } from "../runtime/state.ts";
import { featureWorkspace, isTerminal, SLUG_MAX, SLUG_RE, worktreeBranch, type Project, type RoleCard, type TaskCard } from "../shared/types.ts";
import { loadProject } from "./project.ts";
import { findIssueMetadata } from "./issue-store.ts";
import { iterationVersion, taskIteration, validateIteration } from "./requirements.ts";
import { completedDeliveries } from "../dispatch/delivery.ts";
import { acceptanceFor, git, taskRepo } from "../tasks/verification.ts";

export class FeatureError extends Error {}
export interface FeatureScope { feature: string; iteration: string }
interface FeatureDelivery extends FeatureScope { tasks: string[]; confirmed_at: string; commit?: string; base?: string }

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
          !Number.isFinite(Date.parse(record.confirmed_at)) || result.has(featureKey(record)) ||
          (record.commit !== undefined || record.base !== undefined) &&
            (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.commit ?? "") || typeof record.base !== "string" || !record.base)) throw new Error();
      result.set(featureKey(record), record);
    }
    return result;
  } catch { throw new FeatureError("Invalid .herdr/feature-deliveries.json"); }
}

export function scopeFor(project: Project, task: TaskCard): FeatureScope | undefined {
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
export function finishFeature(project: Project, feature: string, version: string, merge?: { commit: string; base: string }): FeatureDelivery {
  const scope = { feature: validateFeature(feature), iteration: validateIteration(version) };
  if (!scope.feature || !scope.iteration) throw new FeatureError("A feature and iteration are required");
  const finish = () => withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    const records = confirmedFeatures(fresh);
    const key = featureKey(scope);
    const saved = records.get(key);
    if (saved) {
      if (merge && (saved.base !== merge.base || !saved.commit?.startsWith(merge.commit))) throw new FeatureError(`Feature ${key} already has a different delivery record`);
      return saved;
    }
    const tasks = fresh.tasks.filter(task => task.meta.feature === feature && scopeFor(fresh, task)?.iteration === scope.iteration);
    if (!tasks.length) throw new FeatureError(`No tasks found for ${key}`);
    const open = tasks.filter(task => !isTerminal(task.status) || task.meta.pending_history);
    if (open.length) throw new FeatureError(`Finish the tasks for ${key} first: ${open.map(task => task.id).join(", ")}`);
    const shared = tasks.filter(featureWorkspace);
    if (shared.length && !merge) throw new FeatureError(`Merge the reviewed feature commit before confirming ${key}; use herdr-team feature merge`);
    if (merge && !shared.length) throw new FeatureError(`${key} has no shared feature workspace`);
    const integrated = merge ? mergeFeatureCheckout(fresh, shared, merge) : {};
    const record = { ...scope, tasks: tasks.map(task => task.id), confirmed_at: new Date().toISOString(), ...integrated };
    const destination = filename(fresh), temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify([...records.values(), record], null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { force: true }); }
    return record;
  });
  return merge ? withTeamLock(project, "integration", finish) : finish();
}

function mergeFeatureCheckout(project: Project, tasks: TaskCard[], target: { commit: string; base: string }) {
  const first = tasks[0]!;
  const repo = taskRepo(project, first), branch = worktreeBranch(first);
  if (tasks.some(task => taskRepo(project, task) !== repo || worktreeBranch(task) !== branch)) throw new FeatureError("Feature tasks must share one repository and branch");
  if (!/^[a-f0-9]{7,64}$/.test(target.commit)) throw new FeatureError("Provide the exact reviewed feature SHA with --commit");
  const commit = git(repo, "rev-parse", "--verify", `${target.commit}^{commit}`);
  if (git(repo, "rev-parse", "--verify", `refs/heads/${branch}`) !== commit) throw new FeatureError("Feature branch advanced; validate its current commit before merging");
  if (target.base === branch || git(repo, "branch", "--show-current") !== target.base) throw new FeatureError("Run from the intended base branch and name it with --base");
  if (git(repo, "status", "--porcelain")) throw new FeatureError("Base checkout has changes; commit or stash them before merging the feature");
  for (const task of tasks) {
    const acceptance = acceptanceFor(task);
    if (task.status === "done" && acceptance && git(repo, "merge-base", acceptance.commit, commit) !== acceptance.commit) {
      throw new FeatureError(`Feature commit does not contain the accepted SHA for #${task.id}`);
    }
  }
  if (git(repo, "merge-base", "HEAD", commit) !== commit) {
    try { git(repo, "merge-tree", "--write-tree", "HEAD", commit); }
    catch { throw new FeatureError(`Cannot merge ${branch} cleanly into ${target.base}; resolve it in the feature workspace and review the new SHA`); }
    git(repo, "merge", "--no-ff", "--no-edit", commit);
  }
  return { commit, base: target.base };
}

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireRunLock, isDesktopDemo } from "../demo/launch.ts";
import { deliveryFor, deliveryState } from "../dispatch/delivery.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import { daemonDirectory, readDaemonTeam, withRegistration } from "../runtime/daemon-binding.ts";
import { realDesktop, savedDesktopBinding } from "../runtime/desktop.ts";
import { cleanDesktopTasksForPurge } from "../runtime/desktop-cleanup.ts";
import { desktopWorktrees } from "../runtime/desktop-worktrees.ts";
import { processAlive, runtimePath, withTeamLock } from "../runtime/state.ts";
import { worktreeBranch, type Project } from "../shared/types.ts";
import { integrationFor, taskRepo } from "../tasks/verification.ts";
import { confirmedFeatures } from "./features.ts";
import { loadProject } from "./project.ts";
import { ISSUE_BACKUP, ISSUE_DIRECTORY, LEGACY_ISSUES, issueIds, listIssueMetadata } from "./issue-store.ts";
import { iterationRows } from "./requirements.ts";

function ensurePath(path: string, kind: "directory" | "file"): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!(kind === "file" ? stat.isFile() : stat.isDirectory())) {
    throw new Error(`Cannot purge unexpected ${kind} path ${path}. Inspect it before retrying.`);
  }
  return true;
}

function checkoutBlockers(project: Project, reclaim?: ReadonlySet<string>): string[] {
  const previews = runtimePath(project, "desktop/previews");
  if (ensurePath(previews, "directory") && readdirSync(previews).length) {
    return ["Managed feature previews remain. Finish and clean the feature before purging."];
  }
  for (const directory of ["desktop/tasks", "desktop/features", "desktop/checkouts", "tui/features"]) {
    const path = runtimePath(project, directory);
    if (ensurePath(path, "directory") && readdirSync(path).some(entry => !reclaim?.has(join(path, entry)))) {
      return [reclaim ? `Unverified managed worktree records remain in ${path}. Inspect their ownership before purging.`
        : "Managed worktrees remain. Run herdr-team task clean or use --force to reclaim verified Desktop worktrees."];
    }
  }
  const branchesByRepo = new Map<string, Set<string>>();
  for (const task of project.tasks) {
    const repo = taskRepo(project, task);
    const branches = branchesByRepo.get(repo) ?? new Set<string>();
    branches.add(worktreeBranch(task));
    branchesByRepo.set(repo, branches);
  }
  const blockers: string[] = [];
  for (const [repo, branches] of branchesByRepo) {
    const probe = spawnSync("git", ["-C", repo, "rev-parse", "--git-dir"], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 30_000,
    });
    if (probe.status === 128 && /not a git repository/.test(probe.stderr)) continue;
    if (probe.error || probe.status !== 0) {
      blockers.push(`Cannot verify task worktrees in ${repo}. Make the repository accessible before purging.`);
      continue;
    }
    for (const tree of desktopWorktrees(repo)) {
      if (branches.has(tree.branch) && !reclaim?.has(tree.path)) blockers.push(`Task checkout remains at ${tree.path}. Run herdr-team task clean or reclaim that Git worktree before purging.`);
    }
  }
  return blockers;
}

function purgePlan(root: string, demo: string | undefined, dryRun: boolean, force: boolean, desktopClient: typeof realDesktop) {
  const dir = join(root, ".herdr");
  const interrupted = readdirSync(dir).find(entry => entry.startsWith(".purging-"));
  if (interrupted) throw new Error(`An earlier purge left staged data at ${join(dir, interrupted)}. Inspect that directory before retrying.`);
  const hasTaskDirectory = ensurePath(join(dir, "tasks"), "directory");
  const files = [LEGACY_ISSUES, join(ISSUE_DIRECTORY, ISSUE_BACKUP), "iterations.json", "feature-deliveries.json"];
  if (demo) files.push("demo/run.json", "demo/result.json");
  const paths = files.filter(path => ensurePath(join(dir, path), "file"));
  if (ensurePath(join(dir, ISSUE_DIRECTORY), "directory")) {
    paths.push(...issueIds({ herdrDir: dir }).map(id => join(ISSUE_DIRECTORY, id)));
  }
  ensurePath(join(dir, ".retired-ids"), "file");
  const project = loadProject(root);
  const blockers = project.problems.filter(problem => problem.file.startsWith("tasks/")).map(problem =>
    `Cannot identify task data in ${problem.file}. Fix the record before purging.`);
  const current = projectKey(project);
  const demoService = demo && join(demo, "service");
  if (readDaemonTeam(current) || demoService && readDaemonTeam(current, false, demoService)) {
    blockers.push("Automatic delivery is enabled. Run herdr-team down.");
  }
  if (dryRun && demo && ensurePath(join(demo, "run.lock"), "file")) {
    const pid = Number(readFileSync(join(demo, "run.lock"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) blockers.push("A demo is already running in this project.");
  }
  const unfinished: string[] = [];
  for (const task of project.tasks) {
    if (!task.id || !ensurePath(join(dir, task.dir), "directory")) {
      blockers.push(`Cannot identify task data in ${task.dir}. Fix the record before purging.`);
      continue;
    }
    const delivery = deliveryState(task);
    if (!force && ((delivery && delivery !== "queued") || integrationFor(task)?.state === "running" || task.meta.pending_history)) {
      unfinished.push(`#${task.id}`);
    }
    paths.push(task.dir);
  }
  if (unfinished.length) blockers.push(`Tasks with unfinished delivery or integration: ${unfinished.join(", ")}. Use --force to discard them after stopping the team.`);
  const reclaim = new Set<string>();
  const binding = force && !blockers.length && project.tasks.length ? savedDesktopBinding(project) : null;
  let desktop: ReturnType<typeof realDesktop> | undefined;
  if (force && !blockers.length) {
    const unverified = project.tasks.filter(task => {
      const delivery = deliveryFor(task);
      return delivery?.pane_id || delivery?.runtime === "desktop" && delivery.space !== binding?.space;
    });
    if (unverified.length) blockers.push(`Cannot verify the assignment runtime for ${unverified.map(task => `#${task.id}`).join(", ")}. Reconcile these deliveries in their original workspace.`);
    if (binding && !blockers.length) {
      try {
        desktop = desktopClient();
        for (const item of cleanDesktopTasksForPurge(project, desktop, binding, true)) {
          if (item.action !== "removed" && item.action !== "absent") blockers.push(`#${item.id} ${item.note}`);
          for (const path of item.paths ?? []) reclaim.add(path);
        }
      } catch (error) { blockers.push(String(error instanceof Error ? error.message : error)); }
    }
  }
  if (hasTaskDirectory && (!force || !blockers.length)) blockers.push(...checkoutBlockers(project, force ? reclaim : undefined));
  const records = {
    tasks: project.tasks.map(task => task.id).sort(),
    issues: listIssueMetadata(project).map(issue => issue.id).sort(),
    iterations: iterationRows(project, true).map(iteration => iteration.version),
    featureDeliveries: [...confirmedFeatures(project).keys()].sort(),
  };
  return { project, paths, desktop, binding, result: { root, dryRun, blockers, records, tasks: records.tasks.length, issues: records.issues.length,
    iterations: records.iterations.length, featureDeliveries: records.featureDeliveries.length, files: paths.filter(path => files.includes(path)) } };
}

function removeRecords(project: Project, paths: string[]) {
  if (!paths.length) return;
  const retired = [...new Set([...project.retiredIds, ...project.tasks.map(task => task.id)])].sort();
  const stage = mkdtempSync(join(project.herdrDir, ".purging-"));
  const moved: { path: string; staged: string }[] = [];
  try {
    if (project.tasks.length) {
      const ids = join(stage, "retired");
      writeFileSync(ids, retired.join("\n") + "\n", { flag: "wx", mode: 0o600 });
      renameSync(ids, join(project.herdrDir, ".retired-ids"));
    }
    for (const entry of paths) {
      const path = join(project.herdrDir, entry), staged = join(stage, entry);
      mkdirSync(dirname(staged), { recursive: true });
      renameSync(path, staged);
      moved.push({ path, staged });
    }
  } catch (error) {
    try {
      for (const { path, staged } of moved.reverse()) renameSync(staged, path);
      rmSync(stage, { recursive: true });
    } catch {
      throw new Error(`Purge interrupted. Inspect the staged records in ${stage} before retrying.`, { cause: error });
    }
    throw error;
  }
  rmSync(stage, { recursive: true });
}

export function purgeProject(root: string, dryRun: boolean, force = false, desktopClient = realDesktop) {
  const dir = join(root, ".herdr");
  if (!ensurePath(dir, "directory")) throw new Error(`No team project configuration under ${root}`);
  const demo = isDesktopDemo(root) ? join(dir, "demo") : undefined;
  if (demo && !ensurePath(demo, "directory")) throw new Error("The demo project is missing its .herdr/demo directory.");
  if (dryRun) return purgePlan(root, demo, true, force, desktopClient).result;
  const key = projectKey({ root });
  const purge = () => withTeamLock({ root }, "integration", () => withTeamLock({ root }, "queue", () => {
    const { project, paths, result, desktop, binding } = purgePlan(root, demo, false, force, desktopClient);
    if (result.blockers.length) return result;
    if (desktop && binding) {
      try {
        for (const item of cleanDesktopTasksForPurge(project, desktop, binding, false)) {
          if (item.action !== "removed" && item.action !== "absent") result.blockers.push(`#${item.id} ${item.note}`);
        }
      } catch (error) { result.blockers.push(String(error instanceof Error ? error.message : error)); }
      if (!result.blockers.length) result.blockers.push(...checkoutBlockers(project, new Set()));
    }
    if (!result.blockers.length) removeRecords(project, paths);
    return result;
  }));
  if (!demo) return withRegistration(key, purge);
  const unlock = acquireRunLock(join(demo, "run.lock"));
  try {
    const service = join(demo, "service");
    return withRegistration(key, service === daemonDirectory() ? purge : () => withRegistration(key, purge, service));
  } finally { unlock(); }
}

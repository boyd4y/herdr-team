import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { releaseTaskResources, type CleanupResult } from "../dispatch/cleanup.ts";
import { deliveryFor } from "../dispatch/delivery.ts";
import { featureWorkspace, isTaskInactive, workspaceKey, worktreeBranch, type Project, type TaskCard } from "../shared/types.ts";
import { confirmedFeatures, deliveredTask } from "../team/features.ts";
import { loadProject } from "../team/project.ts";
import { findTask } from "../tasks/cards.ts";
import { git, integrationFor } from "../tasks/verification.ts";
import { inspectDesktopCheckout } from "./desktop-worktrees.ts";
import { DesktopError, desktopAgentProgram, desktopTaskSpaces, forgetDesktopTaskSpace, registeredDesktopBinding,
  type DesktopBinding, type DesktopClient, type DesktopTerminal } from "./desktop.ts";
import { runtimePath, withTeamLock } from "./state.ts";

function within(root: string, path: string | null | undefined): boolean {
  if (!path || !isAbsolute(path)) return false;
  let normalized = path;
  try { normalized = realpathSync(path); } catch { /* A finished terminal may report the old path. */ }
  const offset = relative(root, normalized);
  return offset !== ".." && !offset.startsWith("../") && !isAbsolute(offset);
}

function settledAgent(terminal: DesktopTerminal): boolean {
  const program = desktopAgentProgram(terminal);
  return program !== undefined && terminal.status?.app === program &&
    (terminal.status.state === "idle" || terminal.status.state === "done") &&
    Boolean(terminal.pid && terminal.foreground?.pid === terminal.pid);
}

type DesktopCleanupResult = CleanupResult & { paths?: string[] };

function cleanTask(project: Project, client: DesktopClient, binding: DesktopBinding, caller: string | undefined, task: TaskCard,
  purge?: { dryRun: boolean }): DesktopCleanupResult {
  const branch = worktreeBranch(task);
  const result = (action: CleanupResult["action"], note: string): CleanupResult => ({ id: task.id, branch, action, note });
  if (!purge && !isTaskInactive(task)) return result("not-terminal", `Task #${task.id} is still ${task.status}`);
  if (!purge && (task.meta.pending_history || integrationFor(task)?.state === "running")) {
    return result("retained", "Task history or integration is still being recorded; retry clean after it settles");
  }
  const key = workspaceKey(task);
  const shared = featureWorkspace(task) !== undefined;
  const members = shared ? project.tasks.filter(item => workspaceKey(item) === key) : [task];
  const confirmations = !purge && task.meta.feature ? confirmedFeatures(project) : undefined;
  if (!purge && shared && members.some(item => !isTaskInactive(item) || item.meta.pending_history || !confirmations?.get(key)?.tasks.includes(item.id))) {
    return result("retained", "Confirm feature delivery before reclaiming the shared checkout");
  }

  try {
    const { owner, pathExists, tree, expected, file } = inspectDesktopCheckout(project, binding, task);
    const alias = desktopTaskSpaces(client, binding).find(space => (space.task ?? space.feature) === key);
    if (!owner) {
      if (tree || pathExists || alias) return result("foreign", `No ownership record for ${branch}; its checkout and space were retained`);
      if (!purge?.dryRun) for (const member of members) releaseTaskResources(project, member, Boolean(purge));
      return result("absent", `No checkout for ${branch} (not created or already removed)`);
    }
    const checkout = tree ? realpathSync(expected.path) : join(realpathSync(dirname(expected.path)), basename(expected.path));
    if (alias && alias.checkout !== checkout) return result("foreign", "Task space and checkout ownership disagree");
    if (within(checkout, process.cwd())) return result("retained", "Run clean from a shell outside the task checkout");
    const changes = () => git(checkout, "status", "--porcelain=v1", "--untracked-files=normal", "--ignored=matching");
    if (tree?.locked) return result("retained", `Git has locked the checkout at ${checkout}`);
    if (tree && changes()) return result("dirty", `Checkout has modified, untracked or ignored files at ${checkout}`);

    const labels = { "team.project": binding.root, "team.owner_space": binding.space,
      [shared ? "team.workspace" : "team.task"]: key, "team.runtime": "desktop", "team.session": "task" };
    const memberIds = new Map(members.map(member => [member.id, member]));
    const owned = (terminal: DesktopTerminal) => !terminal.address.includes("/") &&
      Object.entries(labels).every(([key, value]) => terminal.labels[key] === value) &&
      memberIds.has(terminal.labels["team.task"] ?? "") &&
      (terminal.labels["herdr.space"] === binding.space || terminal.labels["herdr.space"] === alias?.space && Boolean(alias)) &&
      within(checkout, terminal.cwd);
    const { terminals } = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { all: true });
    const candidates = terminals.filter(owned);
    const addresses = new Set(candidates.map(terminal => terminal.address));
    const spaces = client.spaces();
    const child = spaces.find(space => space.id === alias?.space);
    if (child && (child.machine !== null || child.folder && !within(checkout, child.folder) ||
        child.tabs.some(tab => !tab.terminals.length || tab.terminals.some(item => !addresses.has(item.terminal))))) {
      return result("foreign", "Task space contains other panes or no longer belongs to this checkout");
    }
    const elsewhere = spaces.find(space => space.id !== alias?.space && (space.machine === null && within(checkout, space.folder) ||
      space.tabs.some(tab => tab.terminals.some(item => addresses.has(item.terminal))) && (space.machine !== null || space.id !== binding.space)));
    const occupied = terminals.find(terminal => terminal.state === "live" && !terminal.address.includes("/") && !owned(terminal) &&
      (terminal.labels["herdr.space"] === alias?.space && Boolean(alias) ||
        within(checkout, terminal.cwd) || within(checkout, terminal.foreground?.cwd)));
    if (elsewhere || occupied) return result("foreign", `Checkout is in use by ${occupied?.address ?? `space ${elsewhere?.id}`}`);
    const active = new Set(project.tasks.filter(item => !isTaskInactive(item)).map(item => deliveryFor(item))
      .filter(delivery => delivery?.runtime === "desktop" && delivery.space === binding.space).map(delivery => delivery?.terminal));
    const liveProblem = (terminal: DesktopTerminal) => {
      if (purge) return `Terminal ${terminal.address} is still running. Stop the team before purging.`;
      if (terminal.address === caller) return "Run clean from a shell outside the task session";
      if (active.has(terminal.address)) return `Terminal ${terminal.address} still has another active assignment`;
      if (!settledAgent(terminal) || !within(checkout, terminal.foreground?.cwd)) {
        return `Terminal ${terminal.address} has not reported an idle or settled task agent`;
      }
      if (confirmations && !deliveredTask(memberIds.get(terminal.labels["team.task"] ?? ""), terminal.labels["team.feature"], terminal.labels["team.iteration"],
        terminal.labels["team.delivery"], confirmations)) return `Confirm feature delivery before closing terminal ${terminal.address}`;
    };
    for (const terminal of candidates) {
      const problem = terminal.state === "live" ? liveProblem(terminal)
        : terminal.state !== "finished" ? `Terminal ${terminal.address} is in an unknown state` : undefined;
      if (problem) return result("retained", problem);
    }

    if (purge?.dryRun) {
      return { ...result("removed", `Would reclaim ${branch}`), paths: tree ? [file, expected.path, tree.path] : [file] };
    }

    for (const terminal of candidates) {
      try {
        const params = { terminal: terminal.address };
        const current = client.rpc<DesktopTerminal>("terminal.get", params);
        if (current.address !== terminal.address || !owned(current)) return result("foreign", `Terminal ${terminal.address} changed ownership`);
        if (current.state === "live") {
          if (terminal.state !== "live" || current.pid !== terminal.pid || current.turn !== terminal.turn || current.status_ms !== terminal.status_ms) {
            return result("retained", `Terminal ${terminal.address} changed while preparing to clean; retry after it settles`);
          }
          const problem = liveProblem(current);
          if (problem) return result("retained", problem);
          const ended = client.rpc<DesktopTerminal>("terminal.kill", params);
          if (ended.address !== current.address || ended.state !== "finished") throw new DesktopError("Core did not confirm the task agent stopped");
        } else if (current.state !== "finished") {
          return result("retained", `Terminal ${terminal.address} changed while preparing to clean`);
        }
        const removed = client.rpc<{ removed: string }>("terminal.rm", params);
        if (removed.removed !== current.address) throw new DesktopError("Core did not confirm terminal removal");
      } catch (error) {
        if (!(error instanceof DesktopError) || error.kind !== "not_found") throw error;
      }
    }
    if (alias) client.closeEmptyTaskSpace(alias.space, addresses);
    const latest = inspectDesktopCheckout(project, binding, task);
    if (latest.tree) {
      if (latest.tree.locked) return result("retained", `Git has locked the checkout at ${checkout}`);
      if (changes()) return result("dirty", `Checkout has modified, untracked or ignored files at ${checkout}`);
      git(expected.repo, "worktree", "remove", checkout);
    }
    if (alias) forgetDesktopTaskSpace(client, alias);
    for (const member of members) releaseTaskResources(project, member, Boolean(purge));
    unlinkSync(file);
    return result("removed", `Reclaimed task checkout and Desktop resources for ${branch}; branch retained`);
  } catch (error) {
    return result("failed", `Could not finish clean for ${branch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cleanTasks(project: Project, client: DesktopClient, binding: DesktopBinding, caller: string | undefined,
  tasks: readonly TaskCard[], purge?: { dryRun: boolean }): DesktopCleanupResult[] {
  const registered = registeredDesktopBinding(client, binding.space);
  if (registered?.root !== binding.root || registered.view_space) throw new DesktopError("Project space binding changed before cleanup");
  const cleaned = new Map<string, DesktopCleanupResult>();
  return tasks.map(task => {
    const key = workspaceKey(task);
    const previous = cleaned.get(key);
    if (previous) return { ...previous, id: task.id, action: previous.action === "removed" ? "absent" : previous.action };
    const result = cleanTask(project, client, binding, caller, task, purge);
    cleaned.set(key, result);
    return result;
  });
}

export function cleanDesktopTasks(project: Project, client: DesktopClient, binding: DesktopBinding, caller: string | undefined, ids?: readonly string[]): CleanupResult[] {
  return withTeamLock(project, "queue", () => withTeamLock(project, "desktop", () => {
    const fresh = loadProject(project.root);
    const tasks = ids === undefined ? fresh.tasks.filter(task => isTaskInactive(task)) : ids.map(id => findTask(fresh, id));
    return cleanTasks(fresh, client, binding, caller, tasks);
  }));
}

/** The caller holds the registration, integration and queue locks when applying a purge. */
export function cleanDesktopTasksForPurge(project: Project, client: DesktopClient, binding: DesktopBinding, dryRun: boolean): DesktopCleanupResult[] {
  const clean = () => {
    const { terminals } = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", {});
    const live = terminals.find(terminal => terminal.state === "live" && !terminal.address.includes("/") &&
      terminal.labels["team.project"] === binding.root && terminal.labels["team.runtime"] === "desktop");
    if (live) throw new DesktopError(`Team terminal ${live.address} is still running. Stop the team before purging.`);
    const spaces = new Set(desktopTaskSpaces(client, binding).map(space => space.feature ?? space.task));
    const tasks = project.tasks.filter(task => {
      const key = workspaceKey(task);
      const file = runtimePath(project, `desktop/${featureWorkspace(task) ? "features" : "tasks"}/${key}.json`);
      return spaces.has(key) || lstatSync(file, { throwIfNoEntry: false });
    });
    return cleanTasks(project, client, binding, undefined, tasks, { dryRun });
  };
  return dryRun ? clean() : withTeamLock(project, "desktop", clean);
}

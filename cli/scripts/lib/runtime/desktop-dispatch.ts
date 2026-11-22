import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Project, RoleCard, TaskCard } from "../shared/types.ts";
import { featureWorkspace, isTaskInactive, workspaceKey, worktreeBranch } from "../shared/types.ts";
import { acceptanceFor, reviewFor, taskEnvironment, taskRepo, taskScoped, verifyCheckout } from "../tasks/verification.ts";
import { deliveryFor, type Delivery } from "../dispatch/delivery.ts";
import { DeliveryRejected, type DeliveryTarget, type TaskRuntime } from "../dispatch/runtime.ts";
import type { CleanupResult } from "../dispatch/cleanup.ts";
import { DesktopError, desktopAgentProgram, desktopLaunchArgv, desktopTaskSpaces, ensureDesktopTaskSpace, registeredDesktopBinding, roleArgv, savedDesktopBinding, showDesktopBinding, terminalMatchesWorkspace, type DesktopBinding, type DesktopClient, type DesktopTerminal } from "./desktop.ts";
import { callerSpace } from "./context.ts";
import { withTeamLock } from "./state.ts";
import { findTask } from "../tasks/cards.ts";
import { desktopLaunchEnv } from "./agent-env.ts";
import { loadProject } from "../team/project.ts";
import { logDaemon } from "./daemon-log.ts";
import { confirmedFeatures, deliveredTask, dispatchFeature } from "../team/features.ts";
import { checkoutFor, desktopWorktrees } from "./desktop-worktrees.ts";
import { cleanDesktopTasks } from "./desktop-cleanup.ts";

export interface DesktopTaskRuntime extends TaskRuntime {
  clean(...ids: string[]): CleanupResult[];
}

function target(terminal: DesktopTerminal, space: string): DeliveryTarget {
  return { runtime: "desktop", space, terminal: terminal.address, ...(terminal.pid ? { process_id: terminal.pid } : {}) };
}

function attachTaskTerminal(client: DesktopClient, terminal: DesktopTerminal, space: string, owner: string): void {
  const attached = client.spaces().filter(item => item.tabs.some(tab => tab.terminals.some(t => t.terminal === terminal.address)));
  if (attached.some(item => item.machine !== null || item.id !== owner && item.id !== space)) throw new DesktopError(`Terminal ${terminal.address} has conflicting native space membership`);
  if (terminal.labels["herdr.space"] === space && attached.length === 1 && attached[0]!.id === space) return;
  // Labels opt a detached terminal into its destination; an existing model pane
  // must first be parked through the app, which keeps its program alive.
  if (attached.length) client.park(terminal.address);
  client.rpc("terminal.label", { terminal: terminal.address, labels: { "herdr.space": space, "herdr.tab": "" } });
}

/** Called on reconciliation events, not from the completing agent's CLI process. */
export function closeFinishedDesktopTaskAgents(project: Project, client: DesktopClient, binding: DesktopBinding): void {
  withTeamLock(project, "queue", () => {
    const fresh = loadProject(project.root);
    const deliveries = confirmedFeatures(fresh);
    if (!deliveries.size) return;
    const tasks = new Map(fresh.tasks.map(task => [task.id, task]));
    if (tasks.size !== fresh.tasks.length) throw new DesktopError("Ambiguous task IDs");
    if (!fresh.tasks.some(task => isTaskInactive(task))) return;
    const activeTerminals = new Set<string>();
    for (const task of fresh.tasks) {
      if (isTaskInactive(task)) continue;
      const delivery = deliveryFor(task);
      if (delivery?.runtime === "desktop" && delivery.space === binding.space && delivery.terminal) {
        activeTerminals.add(delivery.terminal);
      }
    }
    const spaces = new Map(desktopTaskSpaces(client, binding).map(space => [space.space, space]));
    const labels = { "team.project": binding.root, "team.owner_space": binding.space,
      "team.runtime": "desktop", "team.session": "task" };
    const { terminals } = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { labels });

    const readyTask = (terminal: DesktopTerminal) => {
      if (terminal.state !== "live" || terminal.address.includes("/") || activeTerminals.has(terminal.address) ||
          !Object.entries(labels).every(([key, value]) => terminal.labels[key] === value)) return;
      const task = tasks.get(terminal.labels["team.task"] ?? "");
      const space = spaces.get(terminal.labels["herdr.space"] ?? "");
      const delivery = terminal.labels["team.delivery"];
      const role = terminal.labels["team.role"];
      const feature = terminal.labels["team.feature"], iteration = terminal.labels["team.iteration"];
      if (!deliveredTask(task, feature, iteration, delivery, deliveries) || !space || !terminalMatchesWorkspace(space, terminal) || !role) return;
      const program = desktopAgentProgram(terminal);
      if (!program || terminal.status?.app !== program ||
          (terminal.status.state !== "done" && terminal.status.state !== "idle") ||
          typeof terminal.turn !== "number" || (task.status === "done" && terminal.turn < 1) ||
          !terminal.pid || terminal.foreground?.pid !== terminal.pid) return;
      const offset = relative(space.checkout, terminal.foreground.cwd);
      if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) return;
      return task;
    };

    for (const terminal of terminals) {
      const task = readyTask(terminal);
      if (!task) continue;
      const context = { project: project.root, space: binding.space, task: task.id, terminal: terminal.address,
        role: terminal.labels["team.role"], state: task.status, turn: terminal.turn,
        feature: terminal.labels["team.feature"], iteration: terminal.labels["team.iteration"] };
      try {
        // Core currently offers an unconditional kill. Recheck immediately and
        // only act on the same reported turn, process and recorded delivery.
        const current = client.rpc<DesktopTerminal>("terminal.get", { terminal: terminal.address });
        if (readyTask(current)?.id !== task.id || current.address !== terminal.address || current.pid !== terminal.pid ||
            current.turn !== terminal.turn || current.status_ms !== terminal.status_ms ||
            current.labels["team.delivery"] !== terminal.labels["team.delivery"] ||
            current.labels["team.feature"] !== terminal.labels["team.feature"] ||
            current.labels["team.iteration"] !== terminal.labels["team.iteration"] ||
            current.labels["team.role"] !== terminal.labels["team.role"]) continue;
        const ended = client.rpc<DesktopTerminal>("terminal.kill", { terminal: terminal.address });
        if (ended.address !== terminal.address || ended.state !== "finished") throw new DesktopError("Core did not confirm exit");
        logDaemon("task.agent_closed", context);
      } catch (error) {
        if (error instanceof DesktopError && ["not_found", "finished"].includes(error.kind ?? "")) continue;
        logDaemon("task.agent_close_failed", { ...context, errorType: error instanceof Error ? error.constructor.name : "Error" });
      }
    }
  });
}

/** One Core adapter for the shared queue and handoff engine. It never polls status or parses screens. */
export function desktopTaskRuntime(project: Project, client: DesktopClient, caller: DesktopTerminal | undefined,
  options: { registeredSpace?: string; proxyEnv?: Record<string, string> } = {}): DesktopTaskRuntime {
  const { registeredSpace, proxyEnv = {} } = options;
  const binding = savedDesktopBinding(project);
  if (!binding || (registeredSpace
    ? registeredSpace !== binding.space || registeredDesktopBinding(client, binding.space)?.root !== binding.root
    : showDesktopBinding(client, binding.space)?.root !== binding.root)) {
    throw new DesktopError("No valid project space binding; run herdr-team up first");
  }
  if (!caller && !registeredSpace) throw new DesktopError("A verified Desktop caller is required");
  if (caller) {
    const actual = client.rpc<DesktopTerminal>("terminal.get", { terminal: caller.address });
    const callerBinding = registeredDesktopBinding(client, actual.labels["herdr.space"] ?? "");
    if (actual.state !== "live" || actual.address !== caller.address || actual.address.includes("/") ||
      callerBinding?.root !== binding.root || callerBinding.space !== binding.space ||
      (registeredSpace ? actual.labels["herdr.space"] !== registeredSpace
        : callerSpace(actual, client, callerBinding.view_space, binding.space) !== (callerBinding.view_space ?? binding.space)) ||
      actual.labels["team.project"] && actual.labels["team.project"] !== binding.root ||
      callerBinding.view_space && (actual.labels["team.owner_space"] !== binding.space || !terminalMatchesWorkspace(callerBinding, actual))) {
      throw new DesktopError("Calling terminal does not belong to this project's bound Desktop space");
    }
  }
  const callerOptions = caller ? { caller: caller.address } : {};
  let taskSpaces = desktopTaskSpaces(client, binding);
  const belongs = (terminal: DesktopTerminal) => terminal.state === "live" && !terminal.address.includes("/") &&
    terminal.labels["team.project"] === binding.root && terminal.labels["team.owner_space"] === binding.space &&
    (terminal.labels["herdr.space"] === binding.space || taskSpaces.some(space => space.space === terminal.labels["herdr.space"] && terminalMatchesWorkspace(space, terminal))) &&
    terminal.labels["team.runtime"] === "desktop";
  const list = () => {
    taskSpaces = desktopTaskSpaces(client, binding);
    return client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", {
      labels: { "team.project": binding.root, "team.owner_space": binding.space },
    }).terminals.filter(belongs);
  };
  const programMatches = (terminal: DesktopTerminal, role: RoleCard) =>
    basename(terminal.argv[0] ?? "") === basename(roleArgv(role, client)[0]!);
  const runtime: DesktopTaskRuntime = {
    scope: { runtime: "desktop", space: binding.space },
    envOk: () => true,
    workspaceBusy(_project, task) {
      return featureWorkspace(task) !== undefined && list().some(terminal =>
        terminal.labels["team.workspace"] === workspaceKey(task) && terminal.labels["team.task"] !== task.id &&
        !["done", "idle"].includes(terminal.status?.state ?? ""));
    },
    assertDelivery(delivery) {
      if (delivery.pane_id || delivery.runtime && delivery.runtime !== "desktop" || delivery.space && delivery.space !== binding.space) {
        throw new DesktopError("Delivery belongs to another runtime or space; reconcile it before Desktop execution");
      }
    },
    residentReceiver(role) {
      const residents = list().filter(terminal => terminal.labels["herdr.space"] === binding.space &&
        terminal.labels["team.session"] === "resident" && terminal.labels["team.role"] === role.name);
      const receiver = residents[0];
      if (residents.length !== 1 || !receiver || !programMatches(receiver, role) ||
        realpathSync(receiver.foreground?.cwd ?? receiver.cwd) !== realpathSync(role.cwd ? resolve(binding.root, role.cwd) : binding.root)) return;
      const destination = target(receiver, binding.space);
      const status = receiver.status?.state;
      return { target: destination, status, canSubmit: status === "idle", submit(prompt) {
        try { client.rpc("terminal.send", { terminal: receiver.address, text: prompt, if: "idle", ...callerOptions }); }
        catch (error) {
          if (error instanceof DesktopError && ["blocked", "status_mismatch", "finished", "not_found", "invalid_params"].includes(error.kind ?? "")) {
            throw new DeliveryRejected(error.message);
          }
          throw error;
        }
        return destination;
      } };
    },
    receiver(fresh, role, task, delivery) {
      const argv = roleArgv(role, client);
      const scope = dispatchFeature(fresh, task, role);
      const resident = !taskScoped(task, role);
      const candidates = list().filter(terminal => terminal.labels["team.role"] === role.name &&
        terminal.labels["team.session"] === (resident ? "resident" : "task") && (resident || terminal.labels["team.task"] === task.id));
      const matches = candidates.filter(terminal => resident ||
        terminal.labels["team.feature"] === scope?.feature && terminal.labels["team.iteration"] === scope?.iteration);
      if (candidates.some(terminal => !matches.includes(terminal) && terminal.status?.state !== "done")) {
        throw new DesktopError("A live task session belongs to a different feature or iteration");
      }
      const current = matches.filter(terminal => terminal.labels["team.delivery"] === delivery.id);
      const active = matches.filter(terminal => terminal.status?.state !== "done");
      if (current.length > 1 || active.length > 1 || resident && matches.length > 1) throw new DesktopError(`Multiple task receivers for ${role.name}/${task.id}; inspect before retrying`);
      // Core's guarded send accepts idle only. A finished task turn can remain done;
      // give a later delivery its own native conversation instead of injecting unguarded input.
      const existing = resident ? matches[0] : current[0] ?? active[0];
      if (resident && !existing) return;
      const repo = taskRepo(fresh, task);
      const offset = role.cwd ? relative(repo, resolve(fresh.root, role.cwd)) : "";
      if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) throw new DesktopError("Role cwd is outside the task repository");
      const taskCheckout = !resident || featureWorkspace(task) ? checkoutFor(fresh, binding, task) : undefined;
      const checkout = resident ? binding.root : taskCheckout!;
      const workspace = workspaceKey(task);
      const taskSpace = taskCheckout ? ensureDesktopTaskSpace(fresh, client, binding, workspace, taskCheckout, Boolean(registeredSpace)) : null;
      if (taskSpace && !taskSpaces.some(item => item.space === taskSpace.space)) taskSpaces.push(taskSpace);
      const cwd = resident ? (role.cwd ? resolve(fresh.root, role.cwd) : binding.root) : join(checkout, offset);
      const review = reviewFor(task), accepted = acceptanceFor(task);
      if (review?.reviewer === role.name && (accepted?.role !== role.name || accepted?.commit !== review.commit)) {
        verifyCheckout(resident ? checkoutFor(fresh, binding, task, false) : checkout, review.commit);
      }
      if (existing) {
        if (!programMatches(existing, role) || realpathSync(existing.cwd) !== realpathSync(cwd)) throw new DesktopError("Task receiver's program or checkout changed; refusing to use a recovery shell or unrelated session");
        const current = existing.foreground?.cwd;
        if (current) {
          const offset = relative(checkout, realpathSync(current));
          if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) throw new DesktopError("Task receiver is outside its checkout");
        }
        if (!resident && taskSpace && existing.labels["herdr.space"] !== taskSpace.space) {
          attachTaskTerminal(client, existing, taskSpace.space, binding.space);
        }
        const status = existing.status?.state;
        return { target: target(existing, binding.space), status, canSubmit: status === "idle", submit(prompt) {
          try {
            client.rpc("terminal.label", { terminal: existing.address, labels: { "team.task": task.id, "team.delivery": delivery.id } });
            client.rpc("terminal.send", { terminal: existing.address, text: prompt, if: "idle", ...callerOptions });
          } catch (error) {
            if (error instanceof DesktopError && ["blocked", "status_mismatch", "finished", "not_found", "invalid_params"].includes(error.kind ?? "")) throw new DeliveryRejected(error.message);
            throw error;
          }
          return target(existing, binding.space);
        } };
      }
      // First assignment travels in native argv. No initialization turn or readiness polling is needed.
      const key = createHash("sha256").update(`${binding.root}\0${binding.space}\0${task.id}\0${role.name}\0${delivery.id}`).digest("hex").slice(0, 20);
      const env = { ...desktopLaunchEnv(proxyEnv, role.env), ...taskEnvironment(fresh, task, role.name) };
      const mock = Boolean(role.env?.HERDR_SMOKE_MANIFEST);
      return { target: runtime.scope, canSubmit: true, submit(prompt) {
        let terminal: DesktopTerminal;
        try {
          terminal = client.rpc("terminal.run", { argv: [...desktopLaunchArgv(role, argv, checkout, cwd), prompt], cwd, env,
            name: `team-${key}`,
            no_parent: true, outlive_parent: true, keep: false,
            labels: { "team.project": binding.root, "team.owner_space": binding.space, "herdr.space": taskSpace!.space,
              "team.role": role.name, "team.session": "task", "team.task": task.id, "team.delivery": delivery.id, "team.runtime": "desktop",
              ...(featureWorkspace(task) ? { "team.workspace": workspace } : {}),
              ...(mock ? { "team.mock": "1" } : {}),
              ...(scope ? { "team.feature": scope.feature, "team.iteration": scope.iteration } : {}) } });
        } catch (error) {
          if (error instanceof DesktopError && error.kind === "spawn_failed") throw new DeliveryRejected(error.message);
          throw error;
        }
        if (!belongs(terminal) || terminal.labels["team.task"] !== task.id || terminal.labels["team.role"] !== role.name || terminal.labels["team.delivery"] !== delivery.id) {
          throw new DesktopError("Core launch result is incomplete or program exited; inspect the delivery before retrying");
        }
        return target(terminal, binding.space);
      } };
    },
    alive(delivery) {
      const terminal = list().find(terminal => terminal.address === delivery.terminal);
      const role = project.roles.find(role => role.name === delivery.role);
      return Boolean(terminal && role && terminal.labels["team.delivery"] === delivery.id &&
        (!delivery.process_id || terminal.pid === delivery.process_id) && programMatches(terminal, role));
    },
    authorize(task, delivery) {
      if (!caller) throw new DesktopError("Only the assigned terminal can act on this delivery");
      taskSpaces = desktopTaskSpaces(client, binding);
      const terminal = client.rpc<DesktopTerminal>("terminal.get", { terminal: caller.address });
      if (!delivery || delivery.runtime !== "desktop" || delivery.space !== binding.space || delivery.terminal !== caller.address ||
          !belongs(terminal) || terminal.labels["team.task"] !== task.id || terminal.labels["team.role"] !== task.role ||
          terminal.labels["team.delivery"] !== delivery.id || delivery.process_id && terminal.pid !== delivery.process_id) {
        throw new DesktopError("Only this delivery's assigned Core terminal may claim or hand off the task");
      }
    },
    refresh() { /* Desktop mods react to Core facts and local task folder changes. */ },
    worktreeList: desktopWorktrees,
    clean(...ids) {
      return cleanDesktopTasks(project, client, binding, caller?.address, ids.length ? ids : undefined);
    },
    cleanup(fresh, task) {
      const branch = worktreeBranch(task), tree = desktopWorktrees(taskRepo(fresh, task)).find(tree => tree.branch === branch);
      return { id: task.id, branch, action: tree ? "retained" : "absent", note: tree
        ? featureWorkspace(task) ? `Feature checkout retained at ${tree.path}.` : `Task checkout retained at ${tree.path}. Run herdr-team clean ${task.id} from a team shell after delivery.`
        : `No checkout for ${branch}` };
    },
  };
  return runtime;
}

/** Attach existing owned task terminals to native worktree spaces, without input or process changes. */
export function syncDesktopTaskSpaces(project: Project, client: DesktopClient, id?: string) {
  return withTeamLock(project, "queue", () => {
    const binding = savedDesktopBinding(project);
    if (!binding || showDesktopBinding(client, binding.space)?.root !== binding.root) throw new DesktopError("No valid parent team binding; run up first");
    const tasks = id ? [findTask(project, id)] : project.tasks;
    const live = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { labels: { "team.project": binding.root, "team.owner_space": binding.space } }).terminals;
    return tasks.flatMap(task => {
      const terminals = live.filter(terminal => terminal.state === "live" && !terminal.address.includes("/") &&
        terminal.labels["team.project"] === binding.root && terminal.labels["team.owner_space"] === binding.space &&
        terminal.labels["team.task"] === task.id && terminal.labels["team.session"] === "task" && terminal.labels["team.runtime"] === "desktop");
      if (!terminals.length) return [];
      const checkout = checkoutFor(project, binding, task, false);
      const known = desktopTaskSpaces(client, binding);
      // Preflight every terminal before writing any labels.
      for (const terminal of terminals) {
        const role = project.roles.find(role => role.name === terminal.labels["team.role"]);
        const actualSpace = terminal.labels["herdr.space"];
        const offset = relative(checkout, realpathSync(terminal.cwd));
        if (!role || basename(terminal.argv[0] ?? "") !== basename(roleArgv(role, client)[0]!) ||
            offset === ".." || offset.startsWith("../") || isAbsolute(offset) ||
            actualSpace !== binding.space && !known.some(space => space.space === actualSpace && terminalMatchesWorkspace(space, terminal))) {
          throw new DesktopError(`Terminal ${terminal.address} has conflicting task ownership; no labels changed`);
        }
      }
      const space = ensureDesktopTaskSpace(project, client, binding, workspaceKey(task), checkout);
      for (const terminal of terminals) attachTaskTerminal(client, terminal, space.space, binding.space);
      return [{ id: task.id, space: space.space, owner_space: binding.space, checkout, terminals: terminals.map(terminal => terminal.address) }];
    });
  });
}

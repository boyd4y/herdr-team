import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, relative } from "node:path";
import { outsideRoot } from "../shared/paths.ts";
import { workspaceKey, type Project } from "../shared/types.ts";
import { confirmedFeatures } from "../team/features.ts";
import { readServiceCatalog, serviceName } from "../team/services.ts";
import { DesktopError, registeredDesktopBinding, type DesktopBinding, type DesktopClient, type DesktopTerminal } from "./desktop.ts";
import { inspectDesktopCheckout } from "./desktop-worktrees.ts";
import { withTeamLock } from "./state.ts";
import { availablePort, choosePort, claimedFeaturePorts, featurePorts, liveServicePorts, withServicePortLock } from "./service-ports.ts";

const stateName = "services.runtime.json";
const startupTimeout = 30_000;
const mainWorkspace = "project";
export type ServiceAction = "start" | "stop" | "restart";
export interface ServiceRequest { action: ServiceAction; space: string; name: string }
export function isServiceRequest(value: unknown): value is ServiceRequest {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ServiceRequest>;
  return (row.action === "start" || row.action === "stop" || row.action === "restart") &&
    typeof row.space === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.space) &&
    typeof row.name === "string" && serviceName.test(row.name);
}
interface ServiceRun {
  owner: string;
  feature: string;
  name: string;
  cwd: string;
  run: string;
  started: number;
  port: number;
  state: "starting" | "running" | "stopped" | "failed";
  reason?: string;
}
type ServiceProject = Pick<Project, "root" | "herdrDir">;

function runs(project: ServiceProject): ServiceRun[] {
  try { return JSON.parse(readFileSync(join(project.herdrDir, stateName), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function save(project: ServiceProject, records: ServiceRun[]): void {
  const file = join(project.herdrDir, stateName), temporary = file + "." + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(records), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function labels(root: string, row: ServiceRun) {
  return { "team.project": root, "team.owner_space": row.owner, "team.workspace": row.feature,
    "team.runtime": "desktop", "team.session": "service", "team.service": row.name,
    "team.service_run": row.run, "team.service_port": String(row.port) };
}

function owns(root: string, record: ServiceRun, terminal: DesktopTerminal): boolean {
  return !terminal.address.includes("/") && terminal.cwd === record.cwd &&
    Object.entries(labels(root, record)).every(([key, value]) => terminal.labels[key] === value);
}

function terminals(client: DesktopClient, scope: Record<string, string>) {
  return client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { all: true, labels: {
    "team.session": "service", ...scope,
  } }).terminals;
}

function serviceTerminal(project: ServiceProject, row: ServiceRun, candidates: DesktopTerminal[]) {
  const matches = candidates.filter(terminal => owns(project.root, row, terminal));
  if (matches.length > 1) throw new DesktopError(`Multiple terminals own ${row.name}; inspect them before proceeding`);
  return matches[0];
}

function publicRun(row: ServiceRun) {
  return { name: row.name, state: row.state, port: row.port, reason: row.reason,
    ...(row.state === "running" ? { url: `http://127.0.0.1:${row.port}/` } : {}) };
}

export function listDesktopServices(project: ServiceProject, client: DesktopClient, space: string) {
  const view = registeredDesktopBinding(client, space);
  if (!view || view.task || view.root !== project.root) throw new DesktopError("Use this project's local team or feature workspace");
  const workspace = view.feature ?? mainWorkspace;
  const ports = view.feature ? featurePorts(project, view, view.feature) : {};
  const scope = runs(project).filter(row => row.owner === view.space && row.feature === workspace);
  const removed = scope.filter(row => row.state !== "stopped");
  // Keep stop available after a spec edit, even if the edited file is invalid.
  let services: string[] = [], error: string | undefined;
  try { services = readServiceCatalog(project.root).services.map(item => item.name); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  return { error, services: [...new Set([...services, ...Object.keys(ports), ...removed.map(row => row.name)])].map(name => {
    const row = scope.find(record => record.name === name);
    const port = Object.hasOwn(ports, name) ? ports[name] : undefined;
    return { ...(row ? publicRun(row) : { name, state: "stopped" }), ...(port ? { port, reserved: true } : {}), declared: services.includes(name) };
  }) };
}

function stopTerminal(client: DesktopClient, project: ServiceProject, row: ServiceRun, terminal?: DesktopTerminal) {
  if (!terminal) return;
  const params = { terminal: terminal.address };
  try {
    const current = client.rpc<DesktopTerminal>("terminal.get", params);
    if (current.address !== terminal.address || !owns(project.root, row, current) ||
        current.state === "live" && terminal.pid !== current.pid) throw new DesktopError("Service terminal ownership changed");
    if (current.state === "live") {
      const ended = client.rpc<DesktopTerminal>("terminal.kill", params);
      if (ended.state !== "finished" || ended.address !== current.address) throw new DesktopError("Core did not confirm the service stopped");
    } else if (current.state !== "finished") throw new DesktopError("Service terminal is in an unknown state");
    const removed = client.rpc<{ removed: string }>("terminal.rm", params);
    if (removed.removed !== current.address) throw new DesktopError("Core did not confirm service terminal removal");
  } catch (error) {
    if (!(error instanceof DesktopError) || error.kind !== "not_found") throw error;
  }
}

export function changeDesktopService(project: Project, client: DesktopClient, owner: string, request: ServiceRequest) {
  return withTeamLock(project, "desktop", () => {
    const view = registeredDesktopBinding(client, request.space);
    if (!view || view.task || view.root !== project.root || view.space !== owner) {
      throw new DesktopError("Use a local team or feature workspace owned by the registered project");
    }
    const feature = view.feature ?? mainWorkspace;
    const records = runs(project);
    const previous = records.find(row => row.owner === owner && row.feature === feature && row.name === request.name);
    const update = (row: ServiceRun) => save(project, [...records.filter(record => record !== previous), row]);
    if (request.action === "stop") {
      if (!previous || previous.state === "stopped") return { name: request.name, state: "stopped" };
      const candidates = terminals(client, labels(project.root, previous));
      stopTerminal(client, project, previous, serviceTerminal(project, previous, candidates));
      const stopped: ServiceRun = { ...previous, state: "stopped", reason: undefined };
      update(stopped);
      return publicRun(stopped);
    }
    if (!client.spaces().some(space => space.id === request.space && space.machine === null)) {
      throw new DesktopError("Open the local Desktop workspace before starting a service");
    }
    let directory = project.root;
    if (view.feature) {
      if (confirmedFeatures(project).get(feature)?.commit) throw new DesktopError("The feature is merged; its workspace is being reclaimed");
      const task = project.tasks.find(item => workspaceKey(item) === feature);
      if (!task) throw new DesktopError("The feature workspace has no assigned tasks");
      const checkout = inspectDesktopCheckout(project, view, task);
      if (!checkout.owner || !checkout.tree || realpathSync(checkout.expected.path) !== view.checkout) {
        throw new DesktopError("Feature workspace checkout ownership changed");
      }
      directory = view.checkout;
    }
    const catalog = readServiceCatalog(project.root);
    const spec = catalog.services.find(item => item.name === request.name);
    if (!spec) throw new Error(`Service ${request.name} is not declared in herdr-services.json`);
    const cwd = realpathSync(join(directory, spec.cwd));
    if (outsideRoot(relative(directory, cwd)) || !lstatSync(cwd).isDirectory()) {
      throw new Error(`Service ${request.name} must run inside the workspace checkout`);
    }

    return withServicePortLock(() => {
      let candidates = terminals(client, {});
      const terminal = previous && serviceTerminal(project, previous, candidates);
      if (terminal?.state === "live" && request.action === "start") return publicRun(previous!);
      if (previous?.state === "starting" && !terminal) throw new DesktopError("Waiting for Core to confirm the previous launch");
      if (previous && terminal) {
        stopTerminal(client, project, previous, terminal);
        candidates = candidates.filter(item => item.address !== terminal.address);
      }
      const live = new Set(liveServicePorts(candidates));
      const ports = view.feature ? featurePorts(project, view, view.feature) : {};
      const reserved = Object.hasOwn(ports, request.name) ? ports[request.name] : undefined;
      let selected: number;
      try {
        if (reserved) {
          if (live.has(reserved) || !availablePort(reserved)) throw new Error(`Reserved port ${reserved} for ${spec.name} is in use`);
          selected = reserved;
        } else {
          for (const port of claimedFeaturePorts()) live.add(port);
          selected = choosePort(catalog.ports, live, previous?.port);
        }
      }
      catch (error) {
        if (previous && terminal) update({ ...previous, state: "failed", reason: "Service stopped; a port could not be allocated" });
        throw error;
      }
      const row: ServiceRun = { owner, feature, name: spec.name, cwd, run: randomUUID(), started: Date.now(), port: selected, state: "starting" };
      update(row);
      const replacement = (state: ServiceRun["state"], reason: string) => {
        const failed = { ...row, state, reason };
        update(failed);
        return publicRun(failed);
      };
      const args = spec.argv.map(arg => arg.replaceAll("{port}", String(row.port)));
      const path = process.env.PATH ?? process.env.Path;
      // The run label is persisted before launch so a lost Core reply can be reconciled.
      let launched: DesktopTerminal;
      try {
        launched = client.rpc("terminal.run", { argv: args, cwd, name: `svc-${row.run.replaceAll("-", "").slice(0, 24)}`,
          env: { PORT: String(row.port), HOST: "127.0.0.1", ...(path ? { PATH: path } : {}) }, labels: labels(project.root, row),
          no_notify: true, no_parent: true, outlive_parent: true, keep: false });
      } catch (error) {
        return replacement("starting", error instanceof Error ? error.message : String(error));
      }
      if (!owns(project.root, row, launched)) return replacement("starting", "Core could not confirm launch ownership");
      if (launched.state === "finished") return replacement("failed", "Service exited during startup");
      return publicRun(row);
    });
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 400 });
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export function hasWatchedDesktopServices(project: ServiceProject, owner: string): boolean {
  return runs(project).some(row => row.owner === owner && (row.state === "running" || row.state === "starting"));
}

export async function reconcileDesktopServices(project: ServiceProject, owner: string, connect: () => DesktopClient): Promise<number | undefined> {
  if (!hasWatchedDesktopServices(project, owner)) return;
  const snapshot = withTeamLock(project, "desktop", () => {
    const watching = runs(project).filter(row => row.owner === owner && (row.state === "running" || row.state === "starting"));
    const candidates = watching.length ? terminals(connect(), { "team.project": project.root, "team.owner_space": owner }) : [];
    return watching.map(row => ({ row, terminal: serviceTerminal(project, row, candidates) }));
  });
  const status = new Map(snapshot.map(({ row, terminal }) => [row.run, terminal?.state]));
  const ready = new Set(await Promise.all(snapshot.filter(({ row, terminal }) => row.state === "starting" && terminal?.state === "live")
    .map(async ({ row }) => await listening(row.port) ? row.run : "")));
  return withTeamLock(project, "desktop", () => {
    let deadline: number | undefined;
    const checkAgain = (elapsed: number) => {
      deadline = Math.min(deadline ?? Infinity, Date.now() + Math.min(2_000, Math.max(350, elapsed / 4)));
    };
    const records = runs(project);
    const updated = records.map(row => {
      if (!status.has(row.run) || row.state !== "running" && row.state !== "starting") return row;
      if (status.get(row.run) !== "live") {
        if (row.state === "starting" && row.reason && status.get(row.run) === undefined && Date.now() < row.started + startupTimeout) {
          checkAgain(Date.now() - row.started);
          return row;
        }
        return { ...row, state: "failed" as const, reason: row.reason ?? "Service process exited" };
      }
      if (row.state === "running") return row;
      if (ready.has(row.run)) return { ...row, state: "running" as const, reason: undefined };
      if (Date.now() >= row.started + startupTimeout) return { ...row, state: "failed" as const,
        reason: `Service did not listen on port ${row.port} within 30 seconds` };
      checkAgain(Date.now() - row.started);
      return row;
    });
    if (updated.some((row, index) => row !== records[index])) save(project, updated);
    return deadline;
  });
}

export function desktopServiceCleanup(project: ServiceProject, client: DesktopClient, binding: DesktopBinding,
  feature: string, checkout: string, candidates: DesktopTerminal[]) {
  const records = runs(project);
  const scope = records.filter(row => row.owner === binding.space && row.feature === feature &&
    !outsideRoot(relative(checkout, row.cwd)));
  const owned = (terminal: DesktopTerminal) => scope.some(row => owns(project.root, row, terminal));
  const stop = () => {
    for (const row of scope) stopTerminal(client, project, row, serviceTerminal(project, row, candidates));
    if (scope.some(row => row.state !== "stopped")) {
      save(project, records.map(row => scope.includes(row) ? { ...row, state: "stopped", reason: undefined } : row));
    }
  };
  const clear = () => { if (scope.length) save(project, records.filter(row => !scope.includes(row))); };
  return { owned, stop, clear };
}

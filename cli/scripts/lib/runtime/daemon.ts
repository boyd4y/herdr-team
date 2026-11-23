import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { needsQueuePass, nextQueueDeadline, pumpQueue, queueRows } from "../dispatch/queue.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import { loadProject } from "../team/project.ts";
import { closeRegisteredDesktopTaskAgents, daemonDirectory, daemonEndpoint, daemonEnv, daemonTeamKeys, daemonTeams, listRegisteredProjects, readDaemonTeam, registeredRuntime, tuiSubscriptionPath, withRegistration, type DaemonTeam } from "./daemon-binding.ts";
import { processAlive, withStateLock, withTeamLock } from "./state.ts";
import { daemonLogPath, deliveryLogReason, logDaemon } from "./daemon-log.ts";
import { startAgentMail, type AgentMailStatus } from "./agentmail.ts";
import { listMail } from "./mail-inbox.ts";
import { notifyMail } from "./mail-notifications.ts";
import { featureWorkspace, isTaskInactive, workspaceKey } from "../shared/types.ts";
import { confirmedFeatures } from "../team/features.ts";
import { closeDeliveredTuiAgents } from "./tui-feature-sessions.ts";
import { cleanupAll, cleanupIfDone, type CleanupResult } from "../dispatch/cleanup.ts";
import { findTask } from "../tasks/cards.ts";
import { spawnWindowsDaemon } from "./windows-daemon.ts";
import { realDesktop } from "./desktop.ts";
import { changeDesktopService, hasWatchedDesktopServices, isServiceRequest, reconcileDesktopServices, type ServiceRequest } from "./desktop-services.ts";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));
const infoFile = (directory = daemonDirectory()) => join(directory, "daemon.json");
const daemonLock = <T>(action: () => T) => withStateLock(join(daemonDirectory(), "daemon.lock"), action);

interface DaemonInfo { pid: number; token: string; port?: number }
interface TeamStatus { root: string; runtime: string; space: string; error?: string }
export interface DaemonStatus {
  state: "running" | "starting" | "stopping" | "unresponsive" | "stopped";
  pid?: number;
  teams?: TeamStatus[];
  agentmail?: AgentMailStatus;
  featureWorkspaces?: boolean;
}

function info(directory = daemonDirectory()): DaemonInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(infoFile(directory), "utf8"));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" ||
        value.port !== undefined && (!Number.isInteger(value.port) || value.port <= 0 || value.port > 65535)) {
      throw new Error("Invalid daemon state");
    }
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

function publish(value: DaemonInfo): void {
  const file = infoFile() + "." + value.token;
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  renameSync(file, infoFile());
}

async function request<T = DaemonStatus>(value: DaemonInfo, path: string, json?: unknown): Promise<T> {
  const payload = json === undefined ? undefined : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      hostname: "127.0.0.1", port: value.port, path, agent: false,
      headers: { Authorization: "Bearer " + value.token,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      method: path === "/status" ? "GET" : "POST",
      signal: AbortSignal.timeout(payload ? 45_000 : 800),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Team daemon rejected " + path)); return; }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    client.on("error", reject);
    client.end(payload);
  });
}

export async function requestDaemonCleanup(root: string, ids?: readonly string[]): Promise<CleanupResult[]> {
  const value = info();
  if (!value?.port || !processAlive(value.pid)) throw new Error("Start the team daemon before cleaning worktrees");
  const result = await request<{ results?: CleanupResult[]; error?: string }>(value, "/clean/" + projectKey({ root }), { ids });
  if (!result.results) throw new Error(result.error ?? "The team daemon did not return a cleanup result");
  return result.results;
}

export async function requestDaemonService(root: string, action: ServiceRequest) {
  const value = info();
  if (!value?.port || !processAlive(value.pid)) throw new Error("Start the team daemon before managing services");
  const response = await request<{ service?: ReturnType<typeof changeDesktopService>; error?: string }>(
    value, "/service/" + projectKey({ root }), action);
  if (!response.service) throw new Error(response.error ?? "The team daemon did not return a service result");
  return response.service;
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const value = info();
  if (!value || !processAlive(value.pid)) return { state: "stopped", teams: daemonTeamKeys().flatMap(key => {
    const team = readDaemonTeam(key);
    return team ? [{ root: team.root, runtime: team.kind, space: team.space }] : [];
  }) };
  if (!value.port) return { state: "starting", pid: value.pid };
  try { return await request(value, "/status"); }
  catch { return { state: "unresponsive", pid: value.pid }; }
}

export async function startDaemon(): Promise<DaemonStatus & { action: "started" | "reused" }> {
  mkdirSync(daemonDirectory(), { recursive: true, mode: 0o700 });
  const started = daemonLock(() => {
    const current = info();
    if (current && processAlive(current.pid)) return false;
    const token = randomUUID();
    const env = { ...daemonEnv(), HERDR_TEAM_DAEMON_TOKEN: token };
    if (process.platform === "win32") {
      const pid = spawnWindowsDaemon([process.execPath, cli, "daemon", "_serve"], daemonDirectory(), env, daemonLogPath());
      publish({ pid, token });
      return true;
    }
    const log = openSync(daemonLogPath(), "a", 0o600);
    try {
      const child = spawn(process.execPath, [cli, "daemon", "_serve"], {
        detached: true, cwd: daemonDirectory(), stdio: ["ignore", log, log],
        env,
      });
      child.on("error", error => console.error(error.message));
      if (!child.pid) throw new Error("Cannot start team daemon");
      publish({ pid: child.pid, token });
      child.unref();
      return true;
    } finally { closeSync(log); }
  });
  const until = Date.now() + 5000;
  do {
    const status = await daemonStatus();
    if (status.state === "running") {
      const action = started ? "started" : "reused";
      logDaemon("daemon.start", { action, daemonPid: status.pid, projects: status.teams?.length ?? 0 });
      return { ...status, action };
    }
    if (status.state === "stopped") break;
    await delay(50);
  } while (Date.now() < until);
  logDaemon("daemon.start_failed");
  throw new Error("Team daemon did not become ready. See " + daemonLogPath());
}

export async function stopDaemon(): Promise<DaemonStatus> {
  const value = info();
  if (!value || !processAlive(value.pid)) return { state: "stopped" };
  if (!value.port) throw new Error("Team daemon is starting; retry stop after it becomes ready");
  await request(value, "/stop");
  const until = Date.now() + 3000;
  do {
    if (info()?.token !== value.token) return { state: "stopped" };
    await delay(50);
  } while (Date.now() < until);
  return { state: "stopping", pid: value.pid };
}

export async function wakeDaemon(root: string, directory = daemonDirectory()): Promise<void> {
  const value = info(directory);
  if (value?.port && processAlive(value.pid)) {
    try { await request(value, "/wake/" + projectKey({ root })); }
    catch { logDaemon("delivery.wake_failed", { project: root, daemonPid: value.pid }); }
  }
}

function subscribe(team: DaemonTeam, panes: string[], wake: () => void, closed: () => void): () => void {
  const onLine = (line: string) => {
    try {
      const value = JSON.parse(line);
      if (value.error) { close(); closed(); return; }
      if (value.result || value.method !== "heartbeat") wake();
    } catch { /* Transport diagnostics aren't runtime events. */ }
  };
  let close: () => void;
  if (team.kind === "desktop") {
    const child = spawn("hc", ["connect"], { env: { ...daemonEnv(), ...team.env }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    close = () => { lines.close(); child.kill(); };
    child.on("error", closed).on("close", closed);
    child.stdin.on("error", () => close());
    child.stdin.write(JSON.stringify({ id: 1, jsonrpc: "2.0", method: "events.subscribe", params: {
      labels: { "team.project": team.root, "team.owner_space": team.space },
    } }) + "\n");
    lines.on("line", line => {
      const message = (() => { try { return JSON.parse(line); } catch { return {}; } })();
      if (message.id || message.method === "missed" || message.method === "event" &&
          !["size", "title", "keep"].includes(message.params?.type ?? message.params?.kind)) onLine(line);
    });
  } else {
    const socket = createConnection(tuiSubscriptionPath(team.endpoint));
    const lines = createInterface({ input: socket });
    close = () => { lines.close(); socket.destroy(); };
    socket.on("error", closed).on("close", closed);
    socket.on("connect", () => socket.write(JSON.stringify({ id: "team", method: "events.subscribe", params: {
      subscriptions: [
        ...["pane.agent_detected", "pane.created", "pane.closed", "pane.exited", "pane.moved", "workspace.created", "workspace.closed"]
          .map(type => ({ type })),
        ...panes.map(pane_id => ({ type: "pane.agent_status_changed", pane_id })),
      ],
    } }) + "\n"));
    lines.on("line", onLine);
  }
  return close;
}

type WorkerOperation = { ids?: string[] } | { service: ServiceRequest };

export async function daemonPass(key: string, operation?: WorkerOperation): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(key) || !process.env.HERDR_TEAM_DAEMON_TOKEN ||
      process.env.HERDR_TEAM_DAEMON_TOKEN !== info()?.token) throw new Error("Invalid daemon worker invocation");
  const result = withRegistration(key, () => {
    const service = operation && "service" in operation ? operation.service : undefined;
    const team = readDaemonTeam(key, !operation || Boolean(service));
    if (!team) {
      if (operation) throw new Error("Start the team with herdr-team team up before managing its resources");
      return;
    }
    if (operation && "service" in operation) {
      if (team.kind !== "desktop" || team.endpoint !== daemonEndpoint("desktop") || !isServiceRequest(operation.service)) {
        throw new Error("A local Desktop team is required to manage feature services");
      }
      const project = loadProject(team.root, { taskBodies: false, roleBodies: false });
      return { service: changeDesktopService(project, realDesktop(), team.space, operation.service) };
    }
    if (team.enabled === false) {
      return { team, project: { root: team.root, herdrDir: join(team.root, ".herdr") },
        response: { panes: [], deliveries: [], deadline: undefined } };
    }
    const project = loadProject(team.root);
    if (operation) {
      const runtime = registeredRuntime(project, team);
      const results = "clean" in runtime ? runtime.clean(...(operation.ids ?? [])) : withTeamLock(project, "queue", () => {
        const fresh = loadProject(project.root);
        return operation.ids ? operation.ids.map(id => cleanupIfDone(fresh, runtime, findTask(fresh, id))) : cleanupAll(fresh, runtime);
      });
      for (const result of results) logDaemon("task.cleaned", { project: project.root, task: result.id, state: result.action, reason: result.note });
      return { results };
    }
    let cleanupPanes: string[] = [];
    try {
      if (project.tasks.some(task => isTaskInactive(task)) && confirmedFeatures(project).size) {
        if (team.kind === "desktop") closeRegisteredDesktopTaskAgents(project, team);
        else {
          const backend = registeredRuntime(project, team);
          if ("paneList" in backend) {
            cleanupPanes = closeDeliveredTuiAgents(project, backend);
            withTeamLock(project, "queue", () => {
              const fresh = loadProject(project.root);
              const confirmed = confirmedFeatures(fresh);
              const seen = new Set<string>();
              for (const task of fresh.tasks) {
                const key = workspaceKey(task);
                if (!featureWorkspace(task) || !confirmed.get(key)?.commit || seen.has(key)) continue;
                seen.add(key);
                const result = cleanupIfDone(fresh, backend, task);
                if (result.action !== "absent") logDaemon("task.cleaned", { project: project.root, task: task.id, state: result.action, reason: result.note });
              }
            });
          }
        }
      }
    } catch (error) {
        logDaemon("task.agent_close_check_failed", { project: team.root, space: team.space,
          errorType: error instanceof Error ? error.constructor.name : "Error" });
    }
    const logRows = (snapshot: typeof project) => queueRows(snapshot).map(row => ({ ...row, reason: deliveryLogReason(row.reason) }));
    const taskWork = needsQueuePass(project);
    const projectId = key.slice(0, 12);
    const mailWork = listMail(projectId, null).some(item => item.state === "pending" || item.state === "sending");
    if (!taskWork && !mailWork) {
      return { team, project, response: { panes: cleanupPanes.sort(), deliveries: logRows(project), deadline: undefined } };
    }
    const runtime = registeredRuntime(project, team);
    // Each pass releases the queue lock after one successful submission, allowing
    // a receiver to claim and other CLI operations to progress between launches.
    const outcomes = taskWork ? pumpQueue(project, runtime) : [];
    const fresh = taskWork ? loadProject(team.root) : project;
    const mailPanes = mailWork && listRegisteredProjects().filter(entry => entry.id === projectId).length === 1 ?
      notifyMail(fresh, runtime, team.space) : [];
    const deadline = nextQueueDeadline(fresh);
    const taskPanes = "paneList" in runtime && needsQueuePass(fresh) ? (() => {
      const own = new Set(runtime.workspaceList().filter(space => space.tokens?.team_project === key).map(space => space.workspace_id));
      return runtime.paneList().filter(pane => own.has(pane.workspace_id)).map(pane => pane.pane_id).sort();
    })() : [];
    const panes = [...new Set([...taskPanes, ...mailPanes, ...cleanupPanes])].sort();
    const deliveries = logRows(fresh);
    return { team, project, response: { more: outcomes.some(row => row.state === "submitted"), deadline, panes, deliveries } };
  });
  if (!result) return;
  if (result.response) {
    if (result.team.kind === "desktop") {
      try {
        const deadline = await reconcileDesktopServices(result.project, result.team.space, () => {
          if (result.team.endpoint !== daemonEndpoint("desktop")) throw new Error("Registered Desktop Core instance changed");
          return realDesktop();
        });
        if (deadline !== undefined) result.response.deadline = Math.min(result.response.deadline ?? Infinity, deadline);
      } catch {
        logDaemon("service.check_failed", { project: result.team.root, space: result.team.space });
      }
    }
    process.stdout.write(JSON.stringify(result.response) + "\n");
  } else process.stdout.write(JSON.stringify(result) + "\n");
}

interface ActiveTeam {
  team: DaemonTeam;
  close(): void;
  status(): TeamStatus;
  running(): Promise<unknown> | undefined;
  kick(): void;
}

function runWorker(key: string, team: DaemonTeam, token: string, operation?: WorkerOperation) {
  const child = Bun.spawn([process.execPath, cli, "daemon", "_pass", key, ...(operation ? [JSON.stringify(operation)] : [])], {
    cwd: daemonDirectory(), env: { ...daemonEnv(), ...team.env, HERDR_TEAM_DAEMON_TOKEN: token },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}

function trackTeam(key: string, team: DaemonTeam, token: string): ActiveTeam {
  let stopped = false, dirty = false, connecting = false;
  let worker: Promise<unknown> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopSubscription: (() => void) | undefined;
  let error: string | undefined;
  let subscriptionError: string | undefined;
  let watchedPanes: string[] = [];
  let generation = 0;
  let deliveryStates = new Map<string, string>();
  const base = { root: team.root, runtime: team.kind, space: team.space };
  const context = { project: team.root, runtime: team.kind, space: team.space };
  const kick = () => {
    if (stopped) return;
    dirty = true;
    if (!worker && !pending) pending = setTimeout(run, 80);
  };
  function run() {
    pending = undefined;
    if (stopped || worker || !dirty) return;
    dirty = false;
    worker = runWorker(key, team, token)
      .then(([code, output, stderr]) => {
        if (deadline) clearTimeout(deadline);
        if (code) {
          const failure = stderr.trim().split("\n")[0] || "Team delivery check failed";
          if (error !== failure) logDaemon("delivery.check_failed", { ...context, exitCode: code });
          error = failure;
          return;
        }
        error = undefined;
        if (!output.trim() || stopped) return;
        const result = JSON.parse(output);
        const current = new Map<string, string>();
        for (const row of result.deliveries as ReturnType<typeof queueRows>) {
          const state = JSON.stringify([row.delivery, row.state, row.reason]);
          current.set(row.id, state);
          if (deliveryStates.get(row.id) !== state) logDaemon("delivery.changed", {
            ...context, task: row.id, role: row.role, delivery: row.delivery, state: row.state, reason: row.reason,
          });
        }
        deliveryStates = current;
        if (team.kind === "tui" && JSON.stringify(result.panes) !== JSON.stringify(watchedPanes)) {
          watchedPanes = result.panes;
          generation++;
          stopSubscription?.();
          clearTimeout(retry);
          connecting = false;
          connect();
        }
        if (result.more) dirty = true;
        if (Number.isFinite(result.deadline)) deadline = setTimeout(kick, Math.max(0, result.deadline - Date.now()));
      })
      .catch(() => {
        if (!error) logDaemon("delivery.check_failed", { ...context });
        error = "Team delivery check failed";
      })
      .finally(() => { worker = undefined; if (dirty) kick(); });
  }
  const connect = () => {
    if (stopped || connecting) return;
    connecting = true;
    const attempt = ++generation;
    let disconnected = false;
    stopSubscription = subscribe(team, watchedPanes, () => {
      if (attempt === generation) {
        if (subscriptionError) logDaemon("runtime.events_restored", context);
        subscriptionError = undefined;
        kick();
      }
    }, () => {
      if (stopped || disconnected || attempt !== generation) return;
      disconnected = true;
      connecting = false;
      if (!subscriptionError) logDaemon("runtime.events_disconnected", context);
      subscriptionError = "Herdr event connection unavailable; reconnecting";
      stopSubscription?.();
      retry = setTimeout(connect, 3000);
    });
  };
  connect();
  // Also reconcile on startup in case a status change predated the subscription.
  kick();
  return {
    team, kick, running: () => worker,
    status: () => ({ ...base, ...(error || subscriptionError ? { error: error ?? subscriptionError } : {}) }),
    close() {
      stopped = true;
      clearTimeout(pending); clearTimeout(retry); clearTimeout(deadline);
      stopSubscription?.();
    },
  };
}

export async function serveDaemon(): Promise<void> {
  const token = process.env.HERDR_TEAM_DAEMON_TOKEN;
  if (!token) throw new Error("Use herdr-team daemon start");
  const value = daemonLock(info);
  if (value?.token !== token || value.pid !== process.pid) throw new Error("Use herdr-team daemon start");
  const active = new Map<string, ActiveTeam>();
  const operations = new Set<Promise<Response>>();
  let stopping = false;
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const reload = () => {
    if (stopping) return;
    const keys = new Set(daemonTeamKeys());
    for (const [key, current] of active) {
      if (keys.has(key)) continue;
      current.close();
      active.delete(key);
      logDaemon("project.detached", { project: current.team.root });
    }
    for (const key of keys) {
      try {
        const team = readDaemonTeam(key, true);
        const current = active.get(key);
        if (!team || team.enabled === false && (team.kind !== "desktop" ||
            !hasWatchedDesktopServices({ root: team.root, herdrDir: join(team.root, ".herdr") }, team.space))) {
          if (current) {
            current.close();
            active.delete(key);
            logDaemon("project.detached", { project: current.team.root });
          }
          continue;
        }
        if (current && JSON.stringify(current.team) === JSON.stringify(team)) continue;
        current?.close();
        active.set(key, trackTeam(key, team, token));
        logDaemon("project.watched", { project: team.root, runtime: team.kind, space: team.space });
      } catch { logDaemon("project.registration_failed", { projectId: key.slice(0, 12) }); }
    }
  };
  mkdirSync(daemonTeams(), { recursive: true, mode: 0o700 });
  const registrationWatcher = watch(daemonTeams(), reload);
  const agentmail = startAgentMail(id => {
    const matches = [...active].filter(([key, current]) => current.team.enabled !== false && key.startsWith(id));
    if (matches.length === 1) matches[0]![1].kick();
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logDaemon("daemon.stopping", { projects: active.size });
    registrationWatcher.close();
    for (const current of active.values()) current.close();
    void Promise.allSettled([agentmail.stop(), ...operations, ...[...active.values()].map(current => current.running())]).then(finish);
  };
  const status = (): DaemonStatus => {
    const mail = agentmail.status();
    return { state: stopping ? "stopping" : "running", pid: process.pid, featureWorkspaces: true,
      teams: [...active.values()].filter(current => current.team.enabled !== false).map(current => current.status()),
      ...(mail ? { agentmail: mail } : {}) };
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 50,
    async fetch(req) {
      if (req.headers.get("Authorization") !== "Bearer " + token) return new Response(null, { status: 401 });
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/status") return Response.json(status());
      if (req.method === "POST" && /^\/clean\/[a-f0-9]{64}$/.test(path)) {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400 });
        const ids = "ids" in body ? body.ids : undefined;
        if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 9999 ||
          ids.some(id => typeof id !== "string" || !/^\d{4}$/.test(id)))) return new Response(null, { status: 400 });
        const key = path.slice(7), team = active.get(key)?.team;
        if (stopping || !team || team.enabled === false) return Response.json({ error: "Start the team with herdr-team team up before cleaning worktrees" });
        const result = runWorker(key, team, token, { ids })
          .then(([code, output, stderr]) => code === 0 ? new Response(output, { headers: { "Content-Type": "application/json" } })
            : Response.json({ error: stderr.trim().split("\n")[0] || "Team cleanup failed" }));
        operations.add(result);
        try { return await result; } finally { operations.delete(result); }
      }
      if (req.method === "POST" && /^\/service\/[a-f0-9]{64}$/.test(path)) {
        const service = await req.json().catch(() => null);
        if (!isServiceRequest(service)) return new Response(null, { status: 400 });
        const key = path.slice(9), team = readDaemonTeam(key, true);
        if (stopping || team?.kind !== "desktop") return Response.json({ error: "Register the local Desktop team before managing services" });
        const result = runWorker(key, team, token, { service })
          .then(([code, output, stderr]) => code === 0 ? new Response(output, { headers: { "Content-Type": "application/json" } })
            : Response.json({ error: stderr.trim().split("\n")[0] || "Team service operation failed" }));
        operations.add(result);
        try { return await result; }
        finally {
          operations.delete(result);
          reload();
          active.get(key)?.kick();
        }
      }
      if (req.method === "POST" && /^\/wake\/[a-f0-9]{64}$/.test(path)) {
        reload();
        active.get(path.slice(6))?.kick();
        return Response.json(status());
      }
      if (req.method === "POST" && path === "/stop") { setTimeout(stop, 0); return Response.json({ ...status(), state: "stopping" }); }
      return new Response(null, { status: 404 });
    },
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  reload();
  logDaemon("daemon.ready", { projects: active.size });
  publish({ ...value, port: server.port });
  try { await stopped; }
  finally {
    await server.stop();
    logDaemon("daemon.stopped");
    daemonLock(() => { if (info()?.token === token) unlinkSync(infoFile()); });
  }
}

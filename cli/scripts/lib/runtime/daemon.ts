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
import { closeRegisteredDesktopTaskAgents, daemonDirectory, daemonEnv, daemonTeamKeys, daemonTeams, listRegisteredProjects, readDaemonTeam, registeredRuntime, withRegistration, type DaemonTeam } from "./daemon-binding.ts";
import { processAlive, withStateLock } from "./state.ts";
import { daemonLogPath, deliveryLogReason, logDaemon } from "./daemon-log.ts";
import { startAgentMail, type AgentMailStatus } from "./agentmail.ts";
import { listMail } from "./mail-inbox.ts";
import { notifyMail } from "./mail-notifications.ts";
import { isTerminal } from "../shared/types.ts";
import { confirmedFeatures } from "../team/features.ts";
import { closeDeliveredTuiAgents } from "./tui-feature-sessions.ts";

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

async function request(value: DaemonInfo, path: string): Promise<DaemonStatus> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      hostname: "127.0.0.1", port: value.port, path, agent: false,
      headers: { Authorization: "Bearer " + value.token },
      method: path === "/status" ? "GET" : "POST",
      signal: AbortSignal.timeout(800),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Team daemon rejected " + path)); return; }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    client.on("error", reject);
    client.end();
  });
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
    const log = openSync(daemonLogPath(), "a", 0o600);
    try {
      const child = spawn(process.execPath, [cli, "daemon", "_serve"], {
        detached: true, cwd: daemonDirectory(), stdio: ["ignore", log, log],
        env: { ...daemonEnv(), HERDR_TEAM_DAEMON_TOKEN: token },
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
    const child = spawn("hc", ["connect"], { env: { ...daemonEnv(), ...team.env }, stdio: ["pipe", "pipe", "ignore"] });
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
    const socket = createConnection(team.endpoint);
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

export function daemonPass(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key) || !process.env.HERDR_TEAM_DAEMON_TOKEN ||
      process.env.HERDR_TEAM_DAEMON_TOKEN !== info()?.token) throw new Error("Invalid daemon worker invocation");
  withRegistration(key, () => {
    const team = readDaemonTeam(key);
    if (!team) return;
    const project = loadProject(team.root);
    let cleanupPanes: string[] = [];
    try {
      if (project.tasks.some(task => isTerminal(task.status)) && confirmedFeatures(project).size) {
        if (team.kind === "desktop") closeRegisteredDesktopTaskAgents(project, team);
        else {
          const backend = registeredRuntime(project, team);
          if ("paneList" in backend) cleanupPanes = closeDeliveredTuiAgents(project, backend);
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
      process.stdout.write(JSON.stringify({ panes: cleanupPanes.sort(), deliveries: logRows(project) }) + "\n");
      return;
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
    process.stdout.write(JSON.stringify({ more: outcomes.some(row => row.state === "submitted"), deadline, panes, deliveries }) + "\n");
  });
}

interface ActiveTeam {
  team: DaemonTeam;
  close(): void;
  status(): TeamStatus;
  running(): Promise<unknown> | undefined;
  kick(): void;
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
    const child = Bun.spawn([process.execPath, cli, "daemon", "_pass", key], {
      cwd: daemonDirectory(), env: { ...daemonEnv(), ...team.env, HERDR_TEAM_DAEMON_TOKEN: token },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    worker = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
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
        const team = readDaemonTeam(key);
        const current = active.get(key);
        if (!team) {
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
    const matches = [...active].filter(([key]) => key.startsWith(id));
    if (matches.length === 1) matches[0]![1].kick();
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logDaemon("daemon.stopping", { projects: active.size });
    registrationWatcher.close();
    for (const current of active.values()) current.close();
    void Promise.allSettled([agentmail.stop(), ...[...active.values()].map(current => current.running())]).then(finish);
  };
  const status = (): DaemonStatus => {
    const mail = agentmail.status();
    return { state: stopping ? "stopping" : "running", pid: process.pid,
      teams: [...active.values()].map(current => current.status()), ...(mail ? { agentmail: mail } : {}) };
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (req.headers.get("Authorization") !== "Bearer " + token) return new Response(null, { status: 401 });
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/status") return Response.json(status());
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

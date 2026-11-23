import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { projectKey } from "../dispatch/team-scope.ts";
import { featureWorkspace, workspaceKey, type Project } from "../shared/types.ts";
import { realHerdr } from "./herdr.ts";
import { realDesktop, registeredDesktopBinding, savedDesktopBinding } from "./desktop.ts";
import type { ManagedContext } from "./context.ts";
import { closeFinishedDesktopTaskAgents, desktopTaskRuntime } from "./desktop-dispatch.ts";
import { cleanDesktopTasks } from "./desktop-cleanup.ts";
import { confirmedFeatures } from "../team/features.ts";
import { logDaemon } from "./daemon-log.ts";
import { runtimePath, withStateLock } from "./state.ts";
import { isProxyEnv } from "./agent-env.ts";

export const daemonDirectory = () => resolve(process.env.HERDR_TEAM_HOME ?? join(homedir(), ".herdr-team"));
export const daemonTeams = (directory = daemonDirectory()) => join(directory, "teams");
const projectDirectory = () => join(daemonDirectory(), "projects");
export function withRegistration<T>(key: string, action: () => T, directory = daemonDirectory()): T {
  return withStateLock(join(directory, "locks", key + ".lock"), action);
}
const runtimeKeys = ["PATH", "HC_SESSION", "HC_SOCKET", "HERDR_APP_HOME", "HERDR_BIN_PATH", "HERDR_CONFIG_PATH",
  "HERDR_SOCKET_PATH", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "HERDR_PLUGIN_STATE_DIR",
  "HERDR_TEAM_TRUST_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;
const envKeys = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "PATH"];
const windowsEnvKeys = ["SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE", "USERNAME",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH"];

export interface DaemonTeam {
  root: string;
  kind: ManagedContext["kind"];
  endpoint: string;
  space: string;
  env: Record<string, string>;
  proxyEnv?: Record<string, string>;
  enabled?: boolean;
}

export function daemonEnv(): Record<string, string> {
  const keys = process.platform === "win32" ? [...envKeys, ...windowsEnvKeys] : envKeys;
  return { ...Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    HERDR_TEAM_HOME: daemonDirectory() };
}

function tuiSocket(): string {
  if (process.platform === "win32") {
    // Windows Herdr publishes the literal marker name. The named pipe uses
    // that spelling, so fs.realpath would change the identifier in some setups.
    const marker = process.env.HERDR_SOCKET_PATH;
    if (marker) return marker;
    const result = spawnSync(process.env.HERDR_BIN_PATH || "herdr", ["status", "server", "--json"], {
      encoding: "utf8", timeout: 3000,
    });
    const status = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (!status?.running || typeof status.socket !== "string" || !status.socket) {
      throw new Error("Windows Herdr server did not report its socket marker");
    }
    return status.socket;
  }
  return process.env.HERDR_SOCKET_PATH ?? join(process.env.HERDR_CONFIG_PATH
    ? dirname(process.env.HERDR_CONFIG_PATH)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr"), "herdr.sock");
}

function coreId(): string {
  const output = spawnSync("hc", ["server", "status"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (output.status !== 0) throw new Error("Desktop Core is unavailable");
  const id = JSON.parse(output.stdout)?.core?.id;
  if (typeof id !== "string" || !id) throw new Error("Desktop Core did not report its identity");
  return id;
}

export function daemonEndpoint(kind: DaemonTeam["kind"]): string {
  if (kind === "desktop") return coreId();
  const socket = tuiSocket();
  return process.platform === "win32" ? socket : realpathSync(socket);
}

export function tuiSubscriptionPath(endpoint: string, platform = process.platform): string {
  // Herdr uses interprocess's GenericNamespaced, which prepends the pipe
  // namespace to the marker verbatim. Keep the marker for Herdr CLI calls.
  return platform === "win32" ? "\\\\.\\pipe\\" + endpoint : endpoint;
}

export function makeDaemonTeam(project: Project, kind: DaemonTeam["kind"], endpoint: string, space: string, proxyEnv?: Record<string, string>): DaemonTeam {
  const env = Object.fromEntries(runtimeKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  if (kind === "tui") env.HERDR_SOCKET_PATH = endpoint;
  return { root: realpathSync(project.root), kind, endpoint, space, env, ...(proxyEnv === undefined ? {} : { proxyEnv }) };
}

function readRegistration(key: string, directory = daemonDirectory()): DaemonTeam | undefined {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid team registration key");
  let team: DaemonTeam;
  try { team = JSON.parse(readFileSync(join(daemonTeams(directory), key + ".json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!team || !isAbsolute(team.root ?? "") || projectKey(team) !== key || !["tui", "desktop"].includes(team.kind) ||
      !team.endpoint || typeof team.endpoint !== "string" || !team.space || typeof team.space !== "string" ||
      !team.env || Object.entries(team.env).some(([key, value]) => !runtimeKeys.some(allowed => allowed === key) || typeof value !== "string") ||
      (team.proxyEnv !== undefined && (team.kind !== "desktop" || !isProxyEnv(team.proxyEnv))) ||
      (team.enabled !== undefined && typeof team.enabled !== "boolean") ||
      team.kind === "tui" && team.env.HERDR_SOCKET_PATH !== team.endpoint) throw new Error("Invalid team daemon registration");
  return team;
}

export function readDaemonTeam(key: string, includePaused = false, directory = daemonDirectory()): DaemonTeam | undefined {
  const team = readRegistration(key, directory);
  return !includePaused && team?.enabled === false ? undefined : team;
}

function registrationKeys(directory: string): string[] {
  try { return readdirSync(directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => file.slice(0, -5)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export const daemonTeamKeys = () => registrationKeys(daemonTeams());

interface ProjectRegistration {
  id: string;
  root: string;
  enabled: boolean | null;
  runtime?: DaemonTeam["kind"];
  space?: string;
}

export function registerProjectRoot(project: Pick<Project, "root">): void {
  const root = realpathSync(project.root);
  const key = projectKey({ root });
  withRegistration(key, () => {
    writeRegistration(projectDirectory(), key, { root });
  });
}

export function unregisterProjectRoot(root: string): boolean {
  const key = projectKey({ root });
  return withRegistration(key, () => {
    const team = readRegistration(key);
    if (team && team.enabled !== false) throw new Error("The team is enabled. Run herdr-team team down before deleting its registration.");
    let removed = false;
    for (const file of [join(daemonTeams(), key + ".json"), join(projectDirectory(), key + ".json")]) {
      try { unlinkSync(file); removed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return removed;
  });
}

export function listRegisteredProjects(): ProjectRegistration[] {
  const projects = new Map<string, ProjectRegistration>();
  for (const key of registrationKeys(projectDirectory())) {
    const file = join(projectDirectory(), key + ".json");
    let value: { root?: unknown };
    try { value = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const root = value?.root;
    if (typeof root !== "string" || !isAbsolute(root) || projectKey({ root }) !== key) {
      throw new Error("Invalid local project registration");
    }
    projects.set(key, { id: key.slice(0, 12), root, enabled: null });
  }
  for (const key of daemonTeamKeys()) {
    const team = readRegistration(key);
    if (team) projects.set(key, { id: key.slice(0, 12), root: team.root, runtime: team.kind, space: team.space, enabled: team.enabled !== false });
  }
  return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
}

export type InboxProjectState = "registered" | "unregistered" | "ambiguous" | "missing_team_directory";

export function inboxProjectStates(): Map<string, InboxProjectState> {
  const projects = new Map<string, InboxProjectState>();
  for (const { id, root } of listRegisteredProjects()) {
    const state = projects.has(id) ? "ambiguous"
      : statSync(join(root, ".herdr"), { throwIfNoEntry: false })?.isDirectory() ? "registered" : "missing_team_directory";
    projects.set(id, state);
  }
  return projects;
}

export function assertDaemonOwner(project: Project, kind: DaemonTeam["kind"], endpoint: string, space?: string): void {
  assertRegistrationOwner(readDaemonTeam(projectKey(project)), kind, endpoint, space);
}

function assertRegistrationOwner(team: DaemonTeam | undefined, kind: DaemonTeam["kind"], endpoint: string, space?: string): void {
  if (team && (team.kind !== kind || team.endpoint !== endpoint || space !== undefined && space !== team.space)) {
    throw new Error("This project is registered in another Herdr runtime or space. Stop that team before moving it.");
  }
}

function writeRegistration(directory: string, key: string, record: { root: string }): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, key + ".json");
  const temp = file + "." + randomUUID();
  writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  try { renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export function registerDaemonTeam<T>(project: Project, launch: () => { result: T; team: DaemonTeam }): T {
  const key = projectKey(project);
  return withRegistration(key, () => {
    const { result, team } = launch();
    assertDaemonOwner(project, team.kind, team.endpoint, team.space);
    writeRegistration(daemonTeams(), key, team);
    return result;
  });
}

export function pauseDaemonTeam<T>(project: Project, kind: DaemonTeam["kind"], endpoint: string, space: string, afterPause: (paused: boolean) => T, directory = daemonDirectory()): T {
  const key = projectKey(project);
  return withRegistration(key, () => {
    const team = readRegistration(key, directory);
    assertRegistrationOwner(team, kind, endpoint, space);
    if (team && team.enabled !== false) {
      const paused: DaemonTeam = { ...team, enabled: false };
      writeRegistration(daemonTeams(directory), key, paused);
    }
    return afterPause(Boolean(team));
  }, directory);
}

export function registeredRuntime(project: Project, team: DaemonTeam) {
  if (team.endpoint !== daemonEndpoint(team.kind)) throw new Error("Registered Herdr instance changed");
  if (team.kind === "tui") {
    const herdr = realHerdr();
    const workspace = herdr.workspaceList().find(entry => entry.workspace_id === team.space);
    if (workspace?.tokens?.team_project !== projectKey(project) || workspace.tokens.team_root !== "1") {
      throw new Error("Registered TUI workspace no longer belongs to this team");
    }
    return { ...herdr, envOk: () => true };
  }
  const client = realDesktop();
  const binding = savedDesktopBinding(project);
  if (binding?.space !== team.space || binding.root !== team.root) throw new Error("Registered Desktop binding changed");
  return desktopTaskRuntime(project, client, undefined, { registeredSpace: team.space, proxyEnv: team.proxyEnv });
}

export function closeRegisteredDesktopTaskAgents(project: Project, team: DaemonTeam): void {
  if (team.kind !== "desktop" || team.endpoint !== daemonEndpoint("desktop")) throw new Error("Registered Desktop Core instance changed");
  const client = realDesktop();
  const binding = savedDesktopBinding(project);
  const space = registeredDesktopBinding(client, team.space);
  if (!binding || binding.space !== team.space || binding.root !== team.root ||
      space?.root !== binding.root || space.space !== binding.space || space.view_space) {
    throw new Error("Registered Desktop binding changed");
  }
  closeFinishedDesktopTaskAgents(project, client, binding);
  const confirmations = confirmedFeatures(project);
  const members = project.tasks.filter(task => {
    if (!featureWorkspace(task)) return false;
    const key = workspaceKey(task);
    return Boolean(confirmations.get(key)?.commit && existsSync(runtimePath(project, `desktop/features/${key}.json`)));
  });
  if (members.length) {
    for (const result of cleanDesktopTasks(project, client, binding, undefined, members.map(task => task.id))) {
      logDaemon("task.cleaned", { project: project.root, task: result.id, state: result.action, reason: result.note });
    }
  }
}

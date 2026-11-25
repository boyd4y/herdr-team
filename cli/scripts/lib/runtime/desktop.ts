import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withTeamLock } from "./state.ts";
import { desktopLaunchEnv } from "./agent-env.ts";
import { windowsAgentExecutable } from "./windows-agent.ts";
import { windowsMockArgv, windowsMockProgram } from "../demo/windows-launcher.ts";
import { outsideRoot } from "../shared/paths.ts";
import { startsResident, type Project, type RoleCard } from "../shared/types.ts";

export const desktopDocument = "herdr-team";
export class DesktopError extends Error {
  constructor(message: string, readonly kind?: string) { super(message); }
}
export interface DesktopBinding { root: string; space: string; machine: null }
export interface DesktopTaskSpace { root: string; space: string; owner_space: string; task?: string; feature?: string; checkout: string; machine: null }
export interface DesktopViewBinding extends DesktopBinding { view_space?: string; task?: string; feature?: string; checkout?: string }
interface Registry { schema: 1; spaces: Record<string, DesktopBinding>; tasks?: Record<string, DesktopTaskSpace> }
export interface DesktopTerminal {
  address: string; state: string; argv: string[]; cwd: string;
  name?: string | null;
  labels: Record<string, string>; status?: { app?: string; state: string } | null;
  turn?: number;
  status_ms?: number | null;
  pid?: number | null;
  foreground?: { cwd: string; argv: string[]; pid?: number } | null;
}
type Terminal = DesktopTerminal;
type AppSpace = { id: string; machine: string | null; folder?: string | null; tabs: { terminals: { terminal: string }[] }[] };
export interface DesktopClient {
  rpc<T>(method: string, params: Record<string, unknown>): T;
  spaces(): AppSpace[];
  executable(kind: string, env?: Record<string, string>): string;
  park(terminal: string): void;
  closeEmptyTaskSpace(space: string, removedTerminals: ReadonlySet<string>): void;
}

export function desktopAgentProgram(terminal: DesktopTerminal, platform = process.platform): string | undefined {
  if (platform === "win32" && terminal.labels["team.mock"] === "1") return windowsMockProgram(terminal.argv);
  const executable = terminal.argv[0] ?? "";
  const program = platform === "win32" ? win32.basename(executable).toLowerCase().replace(/\.exe$/, "") : basename(executable);
  if (program === "claude" || program === "codex" || program === "grok" && terminal.labels["team.mock"] === "1") return program;
}

export function desktopProgramMatches(terminal: DesktopTerminal, argv: string[], platform = process.platform): boolean {
  if (platform !== "win32") return basename(terminal.argv[0] ?? "") === basename(argv[0] ?? "");
  const mock = windowsMockProgram(argv);
  if (mock) return desktopAgentProgram(terminal, platform) === mock && terminal.labels["team.mock"] === "1";
  const actual = terminal.argv[0], expected = argv[0];
  return Boolean(actual && expected && win32.isAbsolute(actual) && win32.relative(actual, expected) === "");
}

export function realDesktop(): DesktopClient {
  function execute(command: string, args: string[], input?: string) {
    const result = spawnSync(command, args, { input, encoding: "utf8", timeout: 80_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new DesktopError(`${command}: ${result.error?.message ?? result.stderr.trim() ?? "Command failed"}`);
    return result.stdout;
  }
  const spaces = (): AppSpace[] => JSON.parse(execute("herdr-app", ["ls"])).spaces;
  return {
    rpc<T>(method: string, params: Record<string, unknown>): T {
      const response = execute("hc", ["connect"], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`)
        .split("\n").filter(Boolean).map(line => JSON.parse(line)).find(value => value.id === 1);
      if (!response) throw new DesktopError(`Core returned no response to ${method}; inspect live state before retrying`);
      if (response.error) throw new DesktopError(`${method}: ${response.error.message} ${JSON.stringify(response.error.data ?? {})}`, response.error.data?.kind);
      return response.result as T;
    },
    spaces,
    park(terminal) {
      execute("herdr-app", ["do", "terminal.park", JSON.stringify({ terminal })]);
      // The native command acknowledges before its layout edit settles. Wait only
      // for this explicit UI operation; never poll agent/Core status or send input.
      const deadline = Date.now() + 10_000;
      while (spaces().some(space => space.tabs.some(tab => tab.terminals.some(item => item.terminal === terminal)))) {
        if (Date.now() >= deadline) throw new DesktopError(`Native detach of ${terminal} has not settled; inspect the app before retrying`);
        Bun.sleepSync(100);
      }
    },
    closeEmptyTaskSpace(id, removedTerminals) {
      const deadline = Date.now() + 3000;
      let closeRequested = false;
      for (;;) {
        const space = spaces().find(item => item.id === id);
        if (!space) return;
        if (space.machine !== null || space.tabs.some(tab => !tab.terminals.length ||
            tab.terminals.some(item => !removedTerminals.has(item.terminal)))) {
          throw new DesktopError(`Task space ${id} still contains other panes; its checkout was retained`);
        }
        if (!space.tabs.length && !closeRequested) {
          execute("herdr-app", ["do", "space.close", JSON.stringify({ id, confirmed: true })]);
          closeRequested = true;
        }
        if (Date.now() >= deadline) throw new DesktopError(`Native closure of task space ${id} has not settled; retry clean`);
        Bun.sleepSync(100);
      }
    },
    executable(kind, env) {
      const mockManifest = env?.HERDR_SMOKE_MANIFEST;
      const command = kind === "claude" || kind === "codex" || kind === "grok" && mockManifest ? kind : null;
      if (!command) throw new DesktopError(`Desktop resident launch is not implemented for ${kind}`);
      const PATH = env?.PATH ?? process.env["PATH"];
      const nativeWindows = process.platform === "win32" && command !== "grok";
      const path = nativeWindows ? windowsAgentExecutable(command, PATH) : Bun.which(command, { PATH });
      if (!path) throw new DesktopError(nativeWindows
        ? `Cannot find the native Windows ${command}.exe. Install the official ${command} CLI and place it on PATH.`
        : `${command} is not on PATH`);
      if (kind === "grok" && path !== join(dirname(mockManifest!), "mock-bin", "grok")) {
        throw new DesktopError("The Grok demo launcher must be in the project's mock-bin");
      }
      return path;
    },
  };
}

function readRegistry(client: DesktopClient): { value: Registry; version: number } {
  const result = client.rpc<{ value: Registry | null; version: number }>("doc.get", { name: desktopDocument });
  const value = result.value ?? { schema: 1, spaces: {} };
  if (value.schema !== 1 || !value.spaces || typeof value.spaces !== "object" || Array.isArray(value.spaces)) {
    throw new DesktopError("Invalid Desktop team binding registry; preserving its contents");
  }
  for (const [space, binding] of Object.entries(value.spaces)) {
    if (!binding || binding.space !== space || !space || space.includes("/") || binding.machine !== null || !isAbsolute(binding.root)) {
      throw new DesktopError(`Invalid Desktop team binding for ${space}`);
    }
  }
  if (value.tasks !== undefined && (!value.tasks || typeof value.tasks !== "object" || Array.isArray(value.tasks))) throw new DesktopError("Invalid Desktop task space registry");
  const owners = new Set<string>();
  for (const [space, task] of Object.entries(value.tasks ?? {})) {
    const workspace = task?.task ?? task?.feature;
    if (!task || task.space !== space || !space || space.includes("/") || value.spaces[space] || task.machine !== null ||
        !workspace || task.task !== undefined && (task.feature !== undefined || !/^\d{4}$/.test(task.task)) ||
        task.feature !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*@v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(task.feature) ||
        !isAbsolute(task.checkout ?? "") || value.spaces[task.owner_space]?.root !== task.root) {
      throw new DesktopError(`Invalid Desktop task space binding for ${space}`);
    }
    const key = JSON.stringify([task.owner_space, workspace]);
    if (owners.has(key)) throw new DesktopError(`Multiple Desktop spaces for ${workspace}`);
    owners.add(key);
  }
  return { value, version: result.version };
}

function localSpace(client: DesktopClient, id: string) {
  const space = client.spaces().find(space => space.id === id);
  if (!space || space.machine !== null || id.includes("/")) throw new DesktopError(`No local Desktop space ${id}; use an actual ID from herdr-app ls`);
  return space;
}

/** Registry-only lookup also covers a reserved space before the app attaches its first terminal. */
export function registeredDesktopBinding(client: DesktopClient, space: string): DesktopViewBinding | null {
  const { value } = readRegistry(client);
  if (value.spaces[space]) return value.spaces[space]!;
  const task = value.tasks?.[space];
  return task ? { ...value.spaces[task.owner_space]!, view_space: space, checkout: task.checkout,
    ...(task.feature === undefined ? { task: task.task } : { feature: task.feature }) } : null;
}

export function terminalMatchesWorkspace(space: Pick<DesktopTaskSpace, "task" | "feature">, terminal: DesktopTerminal): boolean {
  const label = terminal.labels;
  return space.feature ? label["team.workspace"] === space.feature : Boolean(space.task && label["team.task"] === space.task);
}

export function showDesktopBinding(client: DesktopClient, space: string): DesktopViewBinding | null {
  localSpace(client, space);
  return registeredDesktopBinding(client, space);
}

export function desktopTaskSpaces(client: DesktopClient, binding: DesktopBinding): DesktopTaskSpace[] {
  return Object.values(readRegistry(client).value.tasks ?? {}).filter(task => task.owner_space === binding.space && task.root === binding.root);
}

/** Remove only the original alias. The caller holds the project delivery lock. */
export function forgetDesktopTaskSpace(client: DesktopClient, expected: DesktopTaskSpace): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    const registry = readRegistry(client);
    const current = registry.value.tasks?.[expected.space];
    if (!current) return;
    if (current.root !== expected.root || current.owner_space !== expected.owner_space ||
        current.task !== expected.task || current.feature !== expected.feature || current.checkout !== expected.checkout) {
      throw new DesktopError("Task space binding changed; its record was retained");
    }
    const tasks = { ...registry.value.tasks };
    delete tasks[expected.space];
    try {
      client.rpc("doc.set", { name: desktopDocument, version: registry.version, value: { ...registry.value, tasks } });
      return;
    } catch (error) {
      if (!(error instanceof DesktopError) || error.kind !== "conflict") throw error;
    }
  }
  throw new DesktopError("Task space registry is busy; retry clean");
}

/** A stable task space is reserved before launch; native Core opt-in creates its first tab. */
export function ensureDesktopTaskSpace(project: Pick<Project, "root">, client: DesktopClient, binding: DesktopBinding, workspace: string, checkout: string, headless = false): DesktopTaskSpace {
  return withTeamLock(project, "desktop", () => {
    const path = realpathSync(checkout);
    const scope = /^\d{4}$/.test(workspace) ? { task: workspace } : { feature: workspace };
    for (let attempt = 0; attempt < 5; attempt++) {
      const registry = readRegistry(client);
      if (registry.value.spaces[binding.space]?.root !== binding.root) throw new DesktopError("Invalid parent team binding for task space");
      const existing = Object.values(registry.value.tasks ?? {}).find(item => item.owner_space === binding.space && (item.task ?? item.feature) === workspace);
      if (existing) {
        if (existing.root !== binding.root || realpathSync(existing.checkout) !== path) throw new DesktopError("Task space checkout changed; refusing to rebind it");
        return existing;
      }
      const space = `sp${randomUUID().replaceAll("-", "")}`;
      if ((!headless && client.spaces().some(item => item.id === space)) || registry.value.spaces[space] || registry.value.tasks?.[space]) throw new DesktopError("Task space ID collision; retry without adopting an existing space");
      const result: DesktopTaskSpace = { root: binding.root, space, owner_space: binding.space, ...scope, checkout: path, machine: null };
      try {
        client.rpc("doc.set", { name: desktopDocument, version: registry.version, value: {
          ...registry.value, tasks: { ...registry.value.tasks, [space]: result },
        } });
        return result;
      } catch (error) {
        if (!(error instanceof DesktopError) || error.kind !== "conflict") throw error;
      }
    }
    throw new DesktopError("Task space registry is busy; retry after the current updates");
  });
}

function bindingAtRoot(registry: Registry, root: string): DesktopBinding | null {
  const records = Object.values(registry.spaces).filter(binding => binding.root === root);
  if (records.length > 1) throw new DesktopError("Multiple Desktop spaces are bound to this project; inspect the Core registry");
  return records[0] ?? null;
}

export function projectDesktopBinding(project: Pick<Project, "root">, client: DesktopClient): DesktopBinding | null {
  return bindingAtRoot(readRegistry(client).value, realpathSync(project.root));
}

/** Persist under a project lock and Core's document compare-and-swap; never bind by name/cwd. */
export function bindDesktop(project: Pick<Project, "root">, client: DesktopClient, explicitSpace?: string, coreCaller?: DesktopTerminal): DesktopBinding {
  const root = realpathSync(project.root);
  const registry = readRegistry(client);
  const recorded = bindingAtRoot(registry.value, root);
  const id = coreCaller ? coreCaller.labels["herdr.space"] : explicitSpace ?? recorded?.space;
  if (!id) throw new DesktopError("No space binding or verified caller space; run up from the project's Herdr terminal");
  // A remote Core may have no window process. Its verified caller has the
  // machine-local Space ID assigned by the Desktop window that opened it.
  if (coreCaller) {
    if (coreCaller.state !== "live" || coreCaller.address.includes("/") || id.includes("/") || explicitSpace !== undefined && explicitSpace !== id) {
      throw new DesktopError("Bind from a live terminal in the intended Space on this Core");
    }
  } else localSpace(client, id);
  if (recorded && recorded.space !== id) {
    throw new DesktopError("This project is already bound to another Desktop space; explicitly unbind it before moving the team");
  }
  const existing = registry.value.spaces[id];
  if (existing && existing.root !== root) throw new DesktopError(`Space ${id} is already bound to ${existing.root}; refusing to replace its team`);
  const binding: DesktopBinding = { root, space: id, machine: null };
  if (!existing) {
    client.rpc("doc.set", { name: desktopDocument, version: registry.version, value: {
      ...registry.value, spaces: { ...registry.value.spaces, [id]: binding },
    } });
  }
  return binding;
}

export function unbindDesktop(project: Pick<Project, "root">, client: DesktopClient): void {
  const registry = readRegistry(client);
  const root = realpathSync(project.root);
  const saved = bindingAtRoot(registry.value, root);
  if (!saved) throw new DesktopError("No Core space binding for this project");
  const live = client.rpc<{ terminals: Terminal[] }>("terminal.list", { labels: { "team.project": saved.root, "team.owner_space": saved.space } }).terminals;
  if (live.some(terminal => terminal.state === "live")) throw new DesktopError("Team terminals are still live; refusing to orphan their space binding");
  const spaces = { ...registry.value.spaces };
  delete spaces[saved.space];
  const tasks = Object.fromEntries(Object.entries(registry.value.tasks ?? {}).filter(([, task]) => task.owner_space !== saved.space));
  client.rpc("doc.set", { name: desktopDocument, version: registry.version, value: { ...registry.value, spaces, ...(registry.value.tasks ? { tasks } : {}) } });
}

export function roleArgv(role: RoleCard, client: DesktopClient) {
  const args = [...(role.args ?? [])];
  if (role.kind === "codex") {
    if (args.includes("--daemon")) throw new DesktopError(`Role ${role.name}: Desktop Codex must use --no-daemon`);
    if (!args.includes("--no-daemon")) args.push("--no-daemon");
    if (role.model && role.model !== "default" && !args.includes("-m") && !args.includes("--model")) args.push("-m", role.model);
  } else if (role.kind === "claude" && role.model && role.model !== "default" && !args.includes("--model")) args.push("--model", role.model);
  const command = process.platform === "win32" && role.env?.HERDR_SMOKE_MANIFEST
    ? windowsMockArgv(role.kind) : [client.executable(role.kind, role.env)];
  return [...command, ...args];
}

export function desktopLaunchArgv(role: RoleCard, argv: string[], checkout: string, cwd: string): string[] {
  if (role.kind !== "codex" || process.platform === "win32" && role.env?.HERDR_SMOKE_MANIFEST) return argv;
  const root = realpathSync(checkout), directory = realpathSync(cwd);
  const offset = relative(root, directory);
  if (outsideRoot(offset)) return argv;
  // Codex treats dots in -c keys as nesting, so pass paths as keys in a TOML table.
  const projects = [...new Set([root, directory])].map(path => `${JSON.stringify(path)}={trust_level="trusted"}`);
  return [argv[0]!, "-c", `projects={${projects.join(",")}}`, ...argv.slice(1)];
}

interface DesktopAgentAddress { role: string; terminal: string }
interface DesktopStopIssue extends DesktopAgentAddress { reason: string }

export function desktopDown(project: Project, client: DesktopClient, binding: DesktopBinding, caller: string) {
  // Hold the delivery lock while ending agents, including task-scoped sessions.
  return withTeamLock(project, "queue", () => {
    const taskSpaces = new Map(desktopTaskSpaces(client, binding).map(space => [space.space, space]));
    const { terminals } = client.rpc<{ terminals: Terminal[] }>("terminal.list", {
      labels: { "team.project": binding.root, "team.owner_space": binding.space, "team.runtime": "desktop" },
    });
    const stopped: DesktopAgentAddress[] = [];
    const skipped: DesktopStopIssue[] = [];
    const failed: DesktopStopIssue[] = [];
    for (const terminal of terminals) {
      const labels = terminal.labels;
      const role = labels["team.role"], session = labels["team.session"], space = labels["herdr.space"], task = labels["team.task"];
      if (terminal.state !== "live" || terminal.address.includes("/") ||
          labels["team.project"] !== binding.root || labels["team.owner_space"] !== binding.space ||
          labels["team.runtime"] !== "desktop" || !role || (session !== "resident" && session !== "task")) continue;
      if (session === "task" && (!task || !/^\d{4}$/.test(task))) continue;
      const workspace = space && taskSpaces.get(space);
      if (space && space !== binding.space && (session !== "task" || !workspace || !terminalMatchesWorkspace(workspace, terminal))) continue;
      const item = { role, terminal: terminal.address };
      if (!desktopAgentProgram(terminal)) {
        skipped.push({ ...item, reason: "Terminal now runs a different program" });
        continue;
      }
      if (terminal.address === caller) {
        failed.push({ ...item, reason: "Run down from a shell in the team space to stop this agent" });
        continue;
      }
      try {
        const ended = client.rpc<Terminal>("terminal.kill", { terminal: terminal.address });
        if (ended.address !== terminal.address || ended.state !== "finished") throw new DesktopError("Core did not confirm the program stopped");
        stopped.push(item);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof DesktopError && error.kind === "not_found") skipped.push({ ...item, reason: "Terminal already gone" });
        else failed.push({ ...item, reason });
      }
    }
    return { stopped, skipped, failed };
  });
}

export function desktopUp(project: Project, client: DesktopClient, options: { space?: string; proxyEnv?: Record<string, string> } = {}) {
  return withTeamLock(project, "desktop", () => {
    // Validate every resident launch before binding or starting any program.
    const commands = new Map(project.roles.filter(startsResident).map(role => [role.name, roleArgv(role, client)]));
    const existingBinding = projectDesktopBinding(project, client);
    const binding = bindDesktop(project, client, existingBinding ? undefined : options.space);
    const live = client.rpc<{ terminals: Terminal[] }>("terminal.list", {}).terminals
      .filter(terminal => terminal.state === "live" && !terminal.address.includes("/"));
    const occupiedNames = new Set(live.map(terminal => terminal.name));
    const roles: { role: string; action: string; terminal?: string; status?: string | null; failure?: string }[] = [];
    for (const role of project.roles) {
      const argv = commands.get(role.name);
      if (!argv) { roles.push({ role: role.name, action: "deferred" }); continue; }
      const matches = live.filter(t => t.labels["team.project"] === binding.root && t.labels["team.owner_space"] === binding.space &&
        t.labels["team.role"] === role.name && t.labels["team.session"] === "resident");
      if (matches.length > 1) throw new DesktopError(`Multiple resident terminals for ${role.name}; inspect before retrying`);
      const existing = matches[0];
      if (existing) {
        if (desktopProgramMatches(existing, argv)) {
          roles.push({ role: role.name, action: "reused", terminal: existing.address, status: existing.status?.state ?? null });
          continue;
        }
        if (desktopAgentProgram(existing) || existing.labels["team.task"] || existing.labels["team.delivery"] ||
            existing.labels["team.runtime"] !== "desktop" || existing.labels["herdr.space"] !== binding.space) {
          roles.push({ role: role.name, action: "failed", terminal: existing.address, failure: "Resident terminal has a conflicting program or task binding; inspect it before starting a replacement" });
          continue;
        }
      }
      const cwd = role.cwd ? resolve(binding.root, role.cwd) : binding.root;
      const prompt = `Read the installed herdr-team skill before operating the team.\nProject root: ${binding.root}\nRole: ${role.name}\nRead ${join(binding.root, "AGENTS.md")} and ${join(binding.root, "TEAM.md")}.\n${role.body}\nStartup only: confirm your role and wait for an explicit assignment. Do not call up, dispatch tasks, create other agents, or change task records during startup.`;
      const key = createHash("sha256").update(`${binding.root}\0${binding.space}\0${role.name}`).digest("hex").slice(0, 16);
      const baseName = `team-${key}`;
      let name = baseName;
      for (let suffix = 2; occupiedNames.has(name); suffix++) name = `${baseName}-${suffix}`;
      occupiedNames.add(name);
      try {
        if (existing) {
          // Core can keep the terminal after the managed program exits. Release only its role labels.
          const released = client.rpc<Terminal>("terminal.label", { terminal: existing.address, labels: {
            "team.project": "", "team.owner_space": "", "team.role": "", "team.session": "", "team.runtime": "", "team.mock": "",
          } });
          if (released.address !== existing.address || released.labels["team.role"] || released.labels["team.session"]) {
            throw new DesktopError("Core did not confirm release of the previous resident binding");
          }
        }
        const terminal = client.rpc<Terminal>("terminal.run", {
          argv: [...desktopLaunchArgv(role, argv, binding.root, cwd), prompt], cwd,
          env: desktopLaunchEnv(options.proxyEnv ?? {}, role.env), name,
          no_parent: true, outlive_parent: true, keep: false,
          labels: { "team.project": binding.root, "team.owner_space": binding.space, "herdr.space": binding.space,
            "team.role": role.name, "team.session": "resident", "team.runtime": "desktop",
            ...(role.env?.HERDR_SMOKE_MANIFEST ? { "team.mock": "1" } : {}) },
        });
        roles.push({ role: role.name, action: terminal.state === "finished" ? "failed" : "started", terminal: terminal.address,
          status: terminal.status?.state ?? null, ...(terminal.state === "finished" ? { failure: "Program exited during startup" } : {}) });
      } catch (error) {
        // Submission may have succeeded. Never retry launch or remove terminals here.
        roles.push({ role: role.name, action: "failed", failure: `${error instanceof Error ? error.message : error}. Inspect Core terminals before retrying.` });
      }
    }
    return { runtime: "desktop", binding, roles };
  });
}

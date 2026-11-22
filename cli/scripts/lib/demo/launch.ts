import { demoSettings } from "./config.ts";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callerSpace, managedContext } from "../runtime/context.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import { daemonDirectory, daemonEndpoint, pauseDaemonTeam, readDaemonTeam } from "../runtime/daemon-binding.ts";
import { realDesktop, registeredDesktopBinding } from "../runtime/desktop.ts";
import { stopDaemon, wakeDaemon } from "../runtime/daemon.ts";
import { processAlive } from "../runtime/state.ts";
import { replaceFile } from "../shared/atomic-file.ts";
import { loadProject } from "../team/project.ts";
import { listIssueMetadata } from "../team/issue-store.ts";
import { installMockRoles, runRelease, showcaseLanes } from "./release.ts";
import { command, team } from "./shared.ts";

const demoArea = (root: string) => join(root, ".herdr", "demo");
const demoAgreement = "# Release demo\n\nDevelop, test and review a pinned commit before integration.\n";
const demoIgnore = "/.herdr/\n";

export function isDesktopDemo(root: string): boolean {
  try {
    const record = JSON.parse(readFileSync(join(root, ".herdr", "demo.json"), "utf8"));
    return record.kind === "herdr-team-demo";
  } catch { return false; }
}

export function initDesktopDemo(path: string) {
  const target = resolve(path);
  command(["git", "--version"], process.cwd());
  mkdirSync(target, { recursive: true });
  const root = realpathSync(target);
  const configPath = join(root, ".herdr", "demo.json");
  const area = demoArea(root);
  if (isDesktopDemo(root)) {
    demoSettings(root);
    mkdirSync(area, { recursive: true, mode: 0o700 });
    const unlock = acquireRunLock(join(area, "run.lock"));
    try {
      installMockRoles(root, area, join(area, "service"));
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.enabled === undefined) replaceFile(configPath, JSON.stringify({ ...config, enabled: true }, null, 2) + "\n", 0o600);
    } finally { unlock(); }
    return { root, created: false };
  }
  const hasLocalConfig = existsSync(configPath);
  if (hasLocalConfig) demoSettings(root); // Validate before touching Git.
  const localConfigOnly = hasLocalConfig && readdirSync(join(root, ".herdr")).every(file => file === "demo.json");
  const gitRoot = command(["git", "rev-parse", "--show-toplevel"], root, true);
  const hasCommit = command(["git", "rev-parse", "--verify", "HEAD"], root, true).code === 0;
  if (gitRoot.code === 0 && realpathSync(gitRoot.stdout) !== root) {
    throw new Error("Choose a standalone folder for the demo project");
  }
  if (hasCommit) {
    const files = readdirSync(root);
    const changes = command(["git", "status", "--porcelain"], root).stdout;
    const originalDemo = !files.some(file => ![".git", ".gitignore", "TEAM.md", ...(localConfigOnly ? [".herdr"] : [])].includes(file)) &&
      command(["git", "branch", "--show-current"], root).stdout === "main" &&
      command(["git", "ls-tree", "--name-only", "HEAD"], root).stdout === ".gitignore\nTEAM.md" &&
      command(["git", "show", "HEAD:TEAM.md"], root, true).stdout === demoAgreement.trim() &&
      command(["git", "show", "HEAD:.gitignore"], root, true).stdout === demoIgnore.trim() &&
      command(["git", "diff", "--cached", "--quiet"], root, true).code === 0 &&
      (changes === "" || changes === "D TEAM.md");
    if (!originalDemo) throw new Error("Choose an empty folder or the original demo checkout");
    if (!files.includes("TEAM.md")) writeFileSync(join(root, "TEAM.md"), demoAgreement, { flag: "wx" });
  } else {
    if (readdirSync(root).some(entry => entry !== ".git" && !(entry === ".herdr" && localConfigOnly))) {
      throw new Error("Choose an empty folder outside existing repositories for the demo project");
    }
    for (const args of [["init", "-q", "-b", "main"], ["symbolic-ref", "HEAD", "refs/heads/main"],
                       ["config", "user.name", "Herdr Team Demo"], ["config", "user.email", "herdr-demo@example.invalid"]]) {
      command(["git", ...args], root);
    }
    writeFileSync(join(root, ".gitignore"), demoIgnore, { flag: "wx" });
    writeFileSync(join(root, "TEAM.md"), demoAgreement, { flag: "wx" });
    command(["git", "add", ".gitignore", "TEAM.md"], root);
    command(["git", "commit", "-qm", "Initialize the demo project"], root);
  }
  mkdirSync(area, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".herdr", "demo.json"), JSON.stringify({ enabled: true, speed: 1, concurrency: 3, paused: false,
    ...(hasLocalConfig ? JSON.parse(readFileSync(configPath, "utf8")) : {}), kind: "herdr-team-demo" }, null, 2) + "\n",
    { flag: hasLocalConfig ? "w" : "wx", mode: 0o600 });
  installMockRoles(root, area, join(area, "service"));
  return { root, created: true };
}

/** One release at a time per demo repository, including when two shells invoke up. */
export function acquireRunLock(path: string): () => void {
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, String(process.pid)); }
      finally { closeSync(fd); }
      return () => unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(owner) || owner < 1 || processAlive(owner)) {
        throw new Error("A demo is already running in this project");
      }
      unlinkSync(path);
    }
  }
}

async function refreshNativeRepository(quiet: boolean): Promise<void> {
  let fd: number;
  if (process.platform === "win32") {
    if (process.stderr.isTTY) fd = process.stderr.fd;
    else if (!quiet && process.stdout.isTTY) fd = process.stdout.fd;
    else return;
  } else {
    try { fd = openSync("/dev/tty", "w"); } catch { return; }
  }
  try {
    // Spaces rechecks Git when the first pane quits working. This also handles
    // a Space that had already probed the folder before init created .git.
    writeFileSync(fd, "\x1b]7501;state=working:app=herdr-team\x1b\\");
    await Bun.sleep(500);
    writeFileSync(fd, "\x1b]7501;state=clear\x1b\\");
    await Bun.sleep(500);
  } finally { if (process.platform !== "win32") closeSync(fd); }
}

export async function runDesktopDemo(root: string, fast: boolean, quiet: boolean) {
  if (!isDesktopDemo(root)) throw new Error("Initialize a standalone demo folder with HERDR_TEAM_DEMO=1 herdr-team team init, then run herdr-team team up in Herdr Desktop");
  const context = managedContext();
  if (context.kind !== "desktop") throw new Error("Run herdr-team team up inside a Herdr Desktop terminal");
  const client = realDesktop();
  const space = callerSpace(context.caller, client);
  const binding = registeredDesktopBinding(client, space);
  if (binding && (binding.root !== root || binding.view_space)) {
    throw new Error("This Space is already bound to another project or task. Use the demo project's own main Space.");
  }
  const first = client.spaces().find(item => item.id === space)?.tabs.flatMap(tab => tab.terminals)[0]?.terminal;
  if (first && first !== context.caller.address) {
    throw new Error("Run herdr-team team up in the first terminal of this Space so native Spaces can group its worktrees");
  }
  if (command(["git", "branch", "--show-current"], root).stdout !== "main" ||
      command(["git", "status", "--porcelain"], root).stdout) {
    throw new Error("Run the demo from a clean main checkout");
  }
  const area = demoArea(root);
  mkdirSync(area, { recursive: true, mode: 0o700 });
  const unlock = acquireRunLock(join(area, "run.lock"));
  const previousService = process.env.HERDR_TEAM_HOME;
  const previousDirectory = daemonDirectory();
  const previousCwd = process.cwd();
  process.env.HERDR_TEAM_HOME = join(area, "service");
  try {
    const project = loadProject(root);
    if (project.roles.some(role => role.env?.HERDR_SMOKE_MANIFEST !== join(area, "run.json") || role.lifecycle !== "temporary")) {
      throw new Error("This demo project contains a role outside the local mock team");
    }
    const key = projectKey(project);
    const previous = previousDirectory === daemonDirectory() ? undefined : readDaemonTeam(key, false, previousDirectory);
    if (previous?.kind === "desktop" && previous.space === space) {
      pauseDaemonTeam(project, "desktop", daemonEndpoint("desktop"), space, () => {}, previousDirectory);
      await wakeDaemon(root, previousDirectory);
    }
    const iterations = new Set(listIssueMetadata(project).map(issue => issue.iteration));
    let patch = 0;
    while (iterations.has(`v1.2.${patch}`)) patch++;
    const version = `v1.2.${patch}`;
    if (!quiet) console.log(`Launching ${showcaseLanes.length} demo tasks in this Space. Follow the Team Board and Agents.`);
    process.chdir(area);
    await refreshNativeRepository(quiet);
    const result = await runRelease(root, { area, version, fast, lanes: showcaseLanes, verifyGuards: true, startTeam: true });
    team(root, "down");
    return { ...result, root, space };
  } catch (error) {
    try {
      const registered = readDaemonTeam(projectKey({ root }));
      if (registered?.kind === "desktop" && registered.space === space) team(root, "down");
    } catch (cleanupError) { console.error(`Could not stop the demo agents. ${String(cleanupError)}`); }
    throw error;
  } finally {
    try { await stopDaemon(); }
    finally {
      process.chdir(previousCwd);
      if (previousService === undefined) delete process.env.HERDR_TEAM_HOME;
      else process.env.HERDR_TEAM_HOME = previousService;
      unlock();
    }
  }
}

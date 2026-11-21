import { View, div, image, svg } from "gpui-kit";
import { Button, Popover, TextView, h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, focused, knownAgents, layout, nextCommand, openOverlay, panes, props, run, settings, spaces, terminals, theme, watchFolder } from "herdr";
import { boardColumns, consoleBinding, flowNodes, issueFolder, iterationOptions, iterationVersion, listFilters, listTasks, readableDescription, requirementsForIteration,
  roleRows, sameTeam, scopedTerminals, sortTasks, taskAssignee, taskDocument, taskFolder, taskReviewPhase, tasksForIteration, tasksWithIterations, teamSpace, waitingOn } from "./model.js";
import { sample } from "./sample.js";

const ICON = name => `mods/workspace-chrome/${name}.svg`;
const LABEL = { blocked: "Blocked", "needs input": "Needs input", error: "Error", working: "Working", done: "Done", idle: "Idle", unknown: "Unknown",
  next: "Next", ready: "Ready", assigned: "Assigned", "awaiting handoff": "Awaiting handoff", archive: "Archived", trash: "In Trash",
  doing: "In progress", todo: "Todo", review: "Review" };
const label = status => LABEL[status] ?? status;
const REQUIREMENT_STATUS = { backlog: "Backlog", planned: "Planned", "in-progress": "In progress", ready: "Ready for acceptance", accepted: "Accepted" };
const REQUIREMENT_TYPES = [[null, "All"], ["requirement", "Requirements"], ["defect", "Defects"]];
const WIDE = 520;

// herdr-team is a bun script; GUI-launched apps often lack the user's shell PATH additions.
const team = (args, options) => exec("sh", ["-c", 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" exec herdr-team "$@"', "herdr-team", ...args], options);
const teamStateFolder = options => exec("sh", ["-c", 'cd -P "${HERDR_TEAM_HOME:-$HOME/.herdr-team}" && pwd -P'], options);
const firstLine = value => (value || "").trim().split("\n", 1)[0].replace(/^Error:\s*/, "");
const errorMessage = error => error instanceof Error ? error.message : String(error);
function teamJson(result, command, type = "object") {
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `Exit code ${result.code}.`;
    throw new Error(`${command} failed. ${detail.length > 140 ? detail.slice(0, 139) + "…" : detail}`);
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch {
    throw new Error(`${command} returned invalid data. Refresh to retry.`);
  }
  const matches = type === "array" ? Array.isArray(value) : value && typeof value === "object" && !Array.isArray(value);
  if (!matches) throw new Error(`${command} returned invalid data. Refresh to retry.`);
  return value;
}
async function initializedProject(cwd) {
  const result = await team(["project", "show", "--json"], { cwd, timeout: 10000 });
  if (result.code !== 0) return null;
  const project = teamJson(result, "project show");
  if (!project.registered || !project.root?.startsWith("/")) return null;
  const validation = await team(["team", "validate", "--root", project.root], { timeout: 10000 });
  return validation.code === 0 ? project.root : null;
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class TeamConsole extends View {
  init(_props, cx) {
    // The same mod draws the "Team" toggle in the tab bar; that copy reads nothing.
    if (props()?.tab) return;
    // Explicit props pin one team; without them the console follows the shown space.
    this.pinned = props()?.root && props()?.space ? { root: props().root, space: props().space, machine: props().machine ?? null } : null;
    this.binding = this.pinned;
    this.preview = props()?.sample === true;
    // A popped-out window shows one task's details; it is pinned to the team that opened it.
    this.popout = Boolean(props()?.task);
    this.tasks = []; this.roles = []; this.selected = props()?.task ?? null; this.error = null; this.loading = false;
    this.requirements = []; this.requirementDetails = new Map(); this.selectedRequirement = null; this.requirementError = null;
    this.issueFolder = "current"; this.issueAction = null;
    this.section = "tasks"; this.iteration = null; this.iterationMenu = false; this.requirementType = null;
    this.inboxFolder = "active"; this.inboxRows = []; this.inboxRequest = 0; this.mail = null;
    this.bodies = new Map();
    this.taskFolder = "current"; this.taskAction = null;
    this.view = localStorage.getItem("view") === "board" ? "board" : "list";
    this.demoView = "board";
    this.setup = null;
    this.filter = "all";
    this.agentPrograms = new Map();
    if (!checking() && !this.popout) cx.spawn(async cx => {
      try {
        const catalog = await knownAgents({ on: null });
        if (this.closed) return;
        this.agentPrograms = new Map(catalog.filter(program => program.agent).map(program => [program.key, program]));
        cx.notify();
      } catch { /* Live icons remain available even if the local catalog fails. */ }
    });
    if (!checking() && !this.popout) cx.spawn(async cx => {
      while (!this.closed) {
        const command = await nextCommand();
        if (this.closed) break;
        if (command === "list" || command === "board") this.setView(command, cx);
        else if (command.startsWith("filter-") && listFilters(this.preview ? sample().tasks : this.tasks).some(filter => filter.status === command.slice(7))) {
          this.filter = command.slice(7);
          this.setView("list", cx);
        }
      }
    });
    if (!checking() && !this.preview && this.pinned) this.load(cx);
  }

  // Space identity comes from the app; project ownership comes only from the CLI.
  target() {
    return teamSpace(spaces(), terminals());
  }

  followSetup(space, cx, force = false) {
    // The terminal directory only chooses the setup command's working directory.
    if (space && !space.machine && !this.binding) {
      const focus = focused();
      const tab = space.tabs.find(tab => tab.active);
      const cwd = (focus?.space === space.id ? focus.cwd : null) ??
        (tab && panes().find(pane => pane.tab === tab.id && pane.terminal && pane.cwd)?.cwd) ?? space.folder;
      if (cwd?.startsWith("/") && (force || this.setup?.space !== space.id || this.setup?.cwd !== cwd)) {
        if (this.setup?.cwd !== cwd) this.setPreview(false, cx);
        this.setupConfigWatch?.cancel();
        const setup = this.setup = { space: space.id, cwd, action: null, busy: true, error: "" };
        cx.spawn(async cx => {
          try {
            const root = await initializedProject(cwd);
            if (root) { setup.action = "up"; setup.root = root; }
          } catch (error) {
            setup.error = errorMessage(error);
          } finally {
            setup.action ??= "init";
            setup.busy = false;
            if (!this.closed && this.setup === setup) {
              if (setup.action === "up") {
                this.setPreview(false, cx);
                this.watchSetupConfig(setup, cx);
              } else this.loadSetupAgents(setup, cx);
              cx.notify();
            }
          }
        });
        return;
      }
      if (cwd?.startsWith("/")) return;
    }
    this.setupWatch?.cancel();
    this.setupConfigWatch?.cancel();
    this.setup = null;
  }

  watchSetupConfig(setup, cx, root = setup.root) {
    this.setupConfigWatch?.cancel();
    const config = `${root}/.herdr`;
    cx.spawn(async cx => {
      // Watch the parent so removing .herdr itself invalidates the ready state.
      while (!this.closed && this.setup === setup && !this.binding) {
        const pending = this.setupConfigWatch = watchFolder(root);
        try {
          const paths = await pending;
          if (!paths.length || this.setupConfigWatch !== pending || this.setup !== setup || this.closed) break;
          if (!paths.some(path => path === root || path === config || path.startsWith(config + "/roles/") ||
            path === `${root}/TEAM.md` || path === `${root}/agents.json`)) continue;
          if (setup.action === "up") {
            this.follow(cx, true);
            break;
          }
          const project = await initializedProject(setup.cwd);
          if (project && this.setup === setup && !this.closed) {
            setup.action = "up"; setup.root = project;
            this.setPreview(false, cx);
            cx.notify();
            if (project !== root) { this.watchSetupConfig(setup, cx); break; }
          }
        } catch { break; }
        finally { if (this.setupConfigWatch === pending) this.setupConfigWatch = null; }
      }
    });
  }

  clearBinding() {
    this.pendingWatch?.cancel();
    this.pendingWatch = null;
    this.taskLoad = null;
    this.loading = false;
    this.stopRuntimeWatch();
    this.resetInbox();
    this.binding = null; this.tasks = []; this.roles = []; this.selected = null; this.error = null; this.watchError = null; this.viewBinding = null;
    this.requirements = []; this.requirementDetails = new Map(); this.selectedRequirement = null; this.requirementError = null;
    this.issueFolder = "current"; this.issueAction = null;
    this.iteration = null; this.iterationMenu = false; this.requirementType = null;
    this.taskFolder = "current"; this.taskAction = null;
    this.bodies = new Map();
  }

  follow(cx, force = false) {
    if (this.pinned || this.popout || this.closed || checking()) return;
    const target = this.target();
    // Pane cwd can change without changing the Space or any team labels.
    if (target?.space.id === this.place?.id) this.followSetup(target?.space, cx, force);
    if (!force && (target?.key ?? null) === (this.following ?? null)) return;
    const generation = this.followGeneration = (this.followGeneration ?? 0) + 1;
    this.following = target?.key ?? null;
    const machine = target?.space.machine ?? null;
    const changedMachine = machine !== (this.place?.machine ?? null);
    const changedSpace = changedMachine || target?.space.id !== this.place?.id;
    if (changedMachine) this.clearBinding();
    if (changedSpace) {
      this.setupWatch?.cancel();
      this.setupConfigWatch?.cancel();
      this.setupWatch = null; this.setup = null;
      this.setPreview(false, cx);
    }
    this.place = target ? { name: target.space.name, id: target.space.id, folder: target.space.folder, machine } : null;
    this.resolving = false;
    if (!target) {
      this.clearBinding();
      this.setPreview(false, cx);
      return;
    }
    this.resolving = true;
    cx.spawn(async cx => {
      try {
        const args = ["space", "show", "--space", target.localId, "--json"];
        if (machine) args.push("--core");
        const result = await team(args, { on: machine, timeout: 10000 });
        if (this.closed || this.followGeneration !== generation) return;
        const record = teamJson(result, "space show").binding;
        const binding = consoleBinding(record, target.space);
        // Main/worktree switches keep one team, one watcher and the current selection.
        const teamChanged = Boolean(this.binding || binding) && !sameTeam(this.binding, binding);
        if (teamChanged) {
          this.demoView = "board";
          this.clearBinding(); this.binding = binding;
        }
        this.viewBinding = record;
        this.error = null;
        if (binding) {
          const wasPreview = this.preview;
          this.setPreview(false, cx);
          if (!wasPreview && (teamChanged || force)) this.load(cx);
        }
        this.watchRuntime(cx, force);
        this.followSetup(target.space, cx);
      } catch (error) {
        if (!this.closed && this.followGeneration === generation) {
          this.clearBinding();
          this.error = errorMessage(error);
        }
      } finally {
        if (!this.closed && this.followGeneration === generation) { this.resolving = false; cx.notify(); }
      }
    });
  }

  stopRuntimeWatch() {
    this.runtime?.pending?.cancel();
    this.runtime = null;
  }

  watchRuntime(cx, refresh) {
    const binding = this.binding;
    if (!binding || binding.machine || this.viewBinding?.view_space || this.viewBinding?.demo || this.pinned) {
      this.stopRuntimeWatch();
      return;
    }
    if (this.runtime?.binding === binding) {
      const runtime = this.runtime;
      if (refresh) cx.spawn(async cx => { await this.readRuntime(runtime, cx); });
      return;
    }
    this.stopRuntimeWatch();
    const runtime = this.runtime = { binding, running: null };
    cx.spawn(async cx => {
      try {
        const result = await teamStateFolder({ cwd: binding.root, timeout: 10000 });
        if (this.closed || this.runtime !== runtime) return;
        const path = result.stdout.trim();
        if (result.code !== 0 || !path.startsWith("/")) { await this.readRuntime(runtime, cx); return; }
        let changed = true;
        while (!this.closed && this.runtime === runtime) {
          runtime.pending = watchFolder(path);
          if (changed) await this.readRuntime(runtime, cx);
          const paths = await runtime.pending;
          if (!paths.length) break;
          changed = paths.some(file => file === path || file === `${path}/daemon.json` ||
            file === `${path}/teams` || (file.startsWith(`${path}/teams/`) && file.endsWith(".json")));
        }
      } catch {
        if (this.runtime === runtime && runtime.running === null) await this.readRuntime(runtime, cx);
      }
    });
  }

  async readRuntime(runtime, cx) {
    const binding = runtime.binding;
    const request = runtime.request = (runtime.request ?? 0) + 1;
    try {
      const result = await team(["daemon", "status", "--json"], { cwd: binding.root, timeout: 10000 });
      const status = teamJson(result, "daemon status");
      if (this.runtime !== runtime || runtime.request !== request || this.closed) return;
      runtime.running = status.state === "running" && Boolean(status.teams?.some(team =>
        team.runtime === "desktop" && team.root === binding.root && team.space === binding.space));
      runtime.starting = status.state === "starting";
      runtime.error = status.state === "unresponsive" ? "The team service is unresponsive. Use Refresh to check again." : "";
    } catch (error) {
      if (this.runtime !== runtime || runtime.request !== request || this.closed) return;
      runtime.error = errorMessage(error);
    }
    cx.notify();
  }

  load(cx) {
    if (this.closed || this.preview || !this.binding) return;
    if (this.section === "inbox") this.loadInbox(cx);
    const binding = this.binding;
    if (this.taskLoad?.binding === binding) { this.taskLoad.again = true; return; }
    const request = this.taskLoad = { binding, again: false };
    this.loading = true;
    this.watch(cx);
    cx.spawn(async cx => {
      try {
        const options = { cwd: binding.root, on: binding.machine, timeout: 10000 };
        // Existing read-only JSON contracts; no legacy runtime commands here.
        const records = Promise.all([
          team(["task", "list", "--all", "--root", binding.root, "--json"], options),
          team(["role", "list", "--root", binding.root, "--json"], options),
        ]);
        const backlog = this.popout ? Promise.resolve(null) : team(["issue", "list", "--all", "--root", binding.root, "--json"], options).then(result => {
          const cards = teamJson(result, "issue list", "array");
          return { cards };
        }).catch(error => ({ error: errorMessage(error) }));
        const [results, planning] = await Promise.all([records, backlog]);
        if (this.closed || this.preview || this.binding !== binding) return;
        const tasks = teamJson(results[0], "task list", "array");
        const roles = teamJson(results[1], "role list", "array");
        this.tasks = sortTasks(tasks); this.roles = roles; this.error = null;
        if (planning) {
          this.requirements = planning.cards ?? [];
          this.requirementError = planning.error ?? null;
          this.requirementDetails = new Map();
          if (this.iteration !== null && !iterationOptions([...tasksWithIterations(this.tasks, this.requirements), ...this.requirements]).includes(this.iteration)) {
            this.iteration = null;
          }
          if (this.selectedRequirement && !this.requirements.some(card => card.id === this.selectedRequirement)) this.selectedRequirement = null;
          if (this.selectedRequirement) this.loadRequirement(this.selectedRequirement, cx);
        }
        // Bodies may have changed with the records; refetch the one on screen.
        this.bodies = new Map();
        if (this.selected) this.loadBody(this.selected, cx);
      } catch (error) { if (!this.preview && this.binding === binding) this.error = errorMessage(error); }
      finally {
        if (this.taskLoad === request) {
          this.taskLoad = null;
          this.loading = false;
          if (request.again) this.load(cx);
          cx.notify();
        }
      }
    });
  }

  // One cancellable watch per binding; switching spaces cancels it.
  watch(cx) {
    const binding = this.binding;
    if (this.closed || this.preview || !binding || binding.machine || this.watchFor === binding) return;
    this.watchFor = binding;
    cx.spawn(async cx => {
      try {
        while (!this.closed && !this.preview && this.binding === binding) {
          const pending = this.pendingWatch = watchFolder(`${binding.root}/.herdr`);
          const paths = await pending;
          if (this.pendingWatch === pending) this.pendingWatch = null;
          if (this.closed || this.preview || this.binding !== binding) break;
          if (paths.length) this.load(cx);
        }
      } catch (error) {
        if (!this.preview && this.binding === binding) { this.watchError = `Live file updates unavailable; use Refresh. ${String(error)}`; cx.notify(); }
      } finally { if (this.watchFor === binding) this.watchFor = null; }
    });
  }

  // List JSON omits bodies; read one task's Markdown on demand.
  loadBody(id, cx) {
    const binding = this.binding, cache = this.bodies;
    if (this.preview || !binding || cache.has(id)) return;
    cache.set(id, null);
    cx.spawn(async cx => {
      try {
        const result = await team(["task", "show", id, "--root", binding.root, "--json"], { cwd: binding.root, on: binding.machine, timeout: 10000 });
        const { body } = teamJson(result, "task show");
        if (typeof body !== "string") throw new Error("Task details did not include the document.");
        cache.set(id, { body });
      } catch (error) { cache.set(id, { error: errorMessage(error) }); }
      if (!this.closed && this.binding === binding && this.bodies === cache) cx.notify();
    });
  }

  loadRequirement(id, cx) {
    const binding = this.binding, cache = this.requirementDetails;
    if (this.preview || !binding || cache.has(id)) return;
    cache.set(id, null);
    cx.spawn(async cx => {
      try {
        const result = await team(["issue", "show", id, "--root", binding.root, "--json"],
          { cwd: binding.root, on: binding.machine, timeout: 10000 });
        if (!this.closed && this.binding === binding && this.requirementDetails === cache) cache.set(id, teamJson(result, "issue show"));
      } catch (error) {
        if (!this.closed && this.binding === binding && this.requirementDetails === cache) cache.set(id, { error: errorMessage(error) });
      }
      if (!this.closed && this.binding === binding) cx.notify();
    });
  }

  resetInbox() {
    this.stopInboxWatch();
    this.inboxRequest++;
    this.inboxFolder = "active";
    this.inboxRows = []; this.inboxError = null; this.inboxLoading = false; this.mail = null;
  }

  stopInboxWatch() {
    this.inboxWatch?.pending?.cancel();
    this.inboxWatch = null;
  }

  showInbox(folder, cx) {
    const changed = this.inboxFolder !== folder;
    this.section = "inbox";
    this.selected = null; this.selectedRequirement = null; this.iterationMenu = false; this.mail = null;
    this.inboxFolder = folder;
    if (changed) { this.inboxRows = []; this.inboxError = null; }
    this.loadInbox(cx);
    cx.notify();
  }

  loadInbox(cx) {
    const binding = this.binding;
    if (this.closed || this.preview || !binding || this.section !== "inbox") return;
    const folder = this.inboxFolder, request = ++this.inboxRequest;
    const current = () => !this.closed && !this.preview && this.binding === binding && request === this.inboxRequest;
    this.inboxLoading = true;
    cx.spawn(async cx => {
      try {
        const command = folder === "active" ? "list" : "trash";
        const result = await team(["inbox", command, "--root", binding.root, "--json"],
          { cwd: binding.root, on: binding.machine, timeout: 10000 });
        if (!current()) return;
        this.inboxRows = teamJson(result, `inbox ${command}`, "array");
        this.inboxError = null;
        this.watchInbox(cx);
      } catch (error) {
        if (current()) this.inboxError = errorMessage(error);
      } finally {
        if (current()) { this.inboxLoading = false; cx.notify(); }
      }
    });
  }

  watchInbox(cx) {
    const binding = this.binding;
    if (!binding || binding.machine || this.section !== "inbox" || this.inboxWatch) return;
    const watch = {};
    this.inboxWatch = watch;
    const current = () => !this.closed && !this.preview && this.binding === binding && this.inboxWatch === watch;
    cx.spawn(async cx => {
      try {
        // Resolve the same local state directory as the CLI. Other files here,
        // including logs written by inbox reads, do not affect the mail view.
        const result = await teamStateFolder(
          { cwd: binding.root, on: binding.machine, timeout: 10000 });
        const path = result.stdout.trim();
        if (result.code !== 0 || !path.startsWith("/")) return;
        while (current()) {
          watch.pending = watchFolder(path);
          const paths = await watch.pending;
          if (current() && paths.some(changed => changed === path || changed === `${path}/agentmail` ||
              changed.startsWith(`${path}/agentmail/`))) this.loadInbox(cx);
        }
      } catch {
        // The refresh button remains available if the state directory cannot be watched.
      } finally { if (this.inboxWatch === watch) this.inboxWatch = null; }
    });
  }

  openMail(row, cx) {
    const binding = this.binding, selection = { row, content: this.preview ? row : null, error: null };
    this.mail = selection;
    cx.notify();
    if (this.preview || !binding) return;
    cx.spawn(async cx => {
      try {
        const result = await team(["inbox", "read", row.id, "--root", binding.root, "--json"],
          { cwd: binding.root, on: binding.machine, timeout: 10000 });
        selection.content = teamJson(result, "inbox read");
      } catch (error) { selection.error = errorMessage(error); }
      if (!this.closed && this.binding === binding && this.mail === selection) cx.notify();
    });
  }

  popOut(task) {
    const binding = this.binding;
    openOverlay({ mod: find(layout(), this.block())?.content?.mod ?? "herdr-team", kind: "window", key: "team-task", width: 640, height: 0.8,
      props: this.preview ? { task: task.id, sample: true } : { task: task.id, root: binding.root, space: binding.space, machine: binding.machine,
        showcase: this.viewBinding?.demo === true } });
  }

  close() { this.closed = true; this.pendingWatch?.cancel(); this.setupWatch?.cancel(); this.setupConfigWatch?.cancel(); this.stopInboxWatch(); this.stopRuntimeWatch(); }

  loadSetupAgents(setup, cx) {
    cx.spawn(async cx => {
      try { setup.agents = (await knownAgents({ on: null })).filter(agent => agent.installed && agent.agent && agent.run.length); }
      catch (error) { setup.agentError = `Cannot check installed agents. ${String(error)}`; }
      if (!this.closed && this.setup === setup) cx.notify();
    });
  }

  startSetupAgent(agent, cx) {
    const setup = this.setup;
    if (setup?.action !== "init" || setup.busy || this.binding || !setup.agents?.includes(agent)) return;
    setup.busy = true; setup.error = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        let root = setup.cwd;
        try {
          const git = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: setup.cwd, timeout: 3000 });
          if (git.code === 0 && git.stdout.trim().startsWith("/")) root = git.stdout.trim();
        } catch { /* A project can also be a standalone folder. */ }
        if (this.closed || this.setup !== setup || this.target()?.space.id !== setup.space || setup.action !== "init") return;
        const argv = agent.key === "codex" ? agent.run.filter((arg, index) => index === 0 || arg !== "--daemon") : agent.run;
        if (agent.key === "codex" && !argv.includes("--no-daemon")) argv.splice(1, 0, "--no-daemon");
        this.watchSetupConfig(setup, cx, root);
        run("tab.new", { name: `Team Setup · ${agent.name}`, space: setup.space, folder: setup.cwd, argv,
          task: "Use the installed herdr-team skill’s setup (onboard) entry to help me configure this project. Validate and register the team when the setup is complete. Leave team startup for the Up action in Herdr." });
        setup.agentStarted = true;
      } catch (error) { setup.error = String(error); }
      finally {
        setup.busy = false;
        if (!this.closed && this.setup === setup) cx.notify();
      }
    });
  }

  setupAction(cx) {
    const setup = this.setup;
    if (!setup || setup.busy || this.binding || this.resolving) return;
    const current = () => !this.closed && this.setup === setup && this.target()?.space.id === setup.space;
    setup.busy = true; setup.error = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (setup.action === "init") {
          const result = await team(["team", "init", "--json"], { cwd: setup.cwd, timeout: 15000 });
          const init = teamJson(result, "team init");
          if (!init.registered || !init.root?.startsWith("/")) throw new Error("Update the shared herdr-team CLI to register a project with Init.");
          setup.action = "up"; setup.root = init.root;
          if (current()) {
            this.setPreview(false, cx);
            this.watchSetupConfig(setup, cx);
          }
        } else {
          const validation = await team(["team", "validate", "--root", setup.root], { timeout: 10000 });
          if (!current()) return;
          if (validation.code !== 0) {
            this.follow(cx, true);
            return;
          }
          const folder = `${setup.root}/.herdr`;
          const watching = () => !this.closed && this.place?.id === setup.space && !this.binding;
          this.setupWatch?.cancel();
          cx.spawn(async cx => {
            while (watching()) {
              const pending = this.setupWatch = watchFolder(folder);
              try {
                const paths = await pending;
                if (!paths.length || !watching() || this.setupWatch !== pending) break;
                if (paths.some(path => path === folder || path.endsWith("/desktop.json"))) {
                  this.follow(cx, true); break;
                }
              } catch { break; }
              finally { if (this.setupWatch === pending) this.setupWatch = null; }
            }
          });
          this.launchTeam(setup);
        }
      } catch (error) { setup.error = String(error); }
      finally { setup.busy = false; if (current()) cx.notify(); }
    });
  }

  launchTeam({ root, space, cwd }) {
    run("tab.new", { name: "Team Up", space, folder: cwd, focus: true,
      argv: ["zsh", "-ilc", 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; herdr-team team up --root "$1" || exec zsh -i', "herdr-team", root] });
  }

  startStoppedTeam(cx) {
    const runtime = this.runtime;
    if (!runtime || runtime.running !== false || runtime.busy || runtime.starting || runtime.error) return;
    runtime.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await this.readRuntime(runtime, cx);
        if (this.runtime !== runtime || this.closed || runtime.running !== false || runtime.starting || runtime.error) return;
        const { root, space } = runtime.binding;
        if (this.target()?.localId !== space) return;
        this.launchTeam({ root, space, cwd: root });
      } catch (error) { runtime.error = String(error); }
      finally {
        runtime.busy = false;
        if (!this.closed && this.runtime === runtime) cx.notify();
      }
    });
  }

  setPreview(preview, cx) {
    if (preview || (!this.binding && this.setup?.action === "up")) this.section = "tasks";
    if (this.preview === preview) return;
    this.preview = preview;
    this.selected = null;
    this.selectedRequirement = null; this.iteration = null; this.iterationMenu = false; this.requirementType = null;
    this.issueFolder = "current"; this.issueAction = null;
    this.resetInbox();
    if (this.preview) { this.pendingWatch?.cancel(); this.watchFor = null; }
    else this.load(cx);
    cx.notify();
  }

  // The layout block holding this console; the tab-bar button toggles it.
  block() { return props()?.block ?? "team-console"; }

  teamIcon() { return `mods/${find(layout(), this.block())?.content?.mod ?? "herdr-team"}/users.svg`; }

  // A tab-bar button styled like the shipped Files/Changes buttons, toggling the console block.
  tabButton(t) {
    const node = find(layout(), this.block()), on = Boolean(node) && !node.hidden;
    return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("team-tab").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("layout.toggle", { id: this.block() }))
        .child(svg(this.teamIcon()).size(14)).child("Team"));
  }

  setView(view, cx) {
    this.stopInboxWatch();
    this.section = "tasks";
    const showcase = !this.preview && this.viewBinding?.demo === true;
    if (showcase) this.demoView = view;
    else this.view = view;
    this.selected = null;
    this.taskFolder = "current"; this.taskAction = null;
    this.selectedRequirement = null;
    this.iterationMenu = false;
    if (!showcase) localStorage.setItem("view", view);
    cx.notify();
  }

  select(id, cx) {
    this.stopInboxWatch();
    this.section = "tasks";
    this.selected = id;
    this.taskAction = null;
    this.selectedRequirement = null;
    this.iterationMenu = false;
    if (id) this.loadBody(id, cx);
    cx.notify();
  }

  changeTask(task, action, cx) {
    const binding = this.binding;
    if (this.preview || !binding || binding.machine || this.taskAction?.busy) return;
    const inProgress = taskFolder(task) === "current" && task.status !== "todo" && task.status !== "done";
    const request = this.taskAction = { id: task.id, action, busy: true };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const args = ["task", action, task.id, "--root", binding.root, "--json"];
        if (inProgress && action !== "restore") args.push("--force");
        const result = await team(args, { cwd: binding.root, timeout: 50_000 });
        const updated = teamJson(result, `task ${action}`);
        if (this.closed || this.binding !== binding) return;
        this.tasks = this.tasks.map(card => card.id === task.id ? { ...card, status: updated.status, meta: updated.meta } : card);
        if (this.taskAction === request) {
          this.taskFolder = taskFolder(updated);
          this.taskAction = null;
        }
        this.load(cx);
      } catch (error) {
        if (this.taskAction === request) this.taskAction = { ...request, busy: false, error: errorMessage(error) };
      } finally { if (!this.closed) cx.notify(); }
    });
  }

  showRequirements(id, cx) {
    this.stopInboxWatch();
    this.section = "requirements";
    this.selected = null;
    this.selectedRequirement = id;
    this.issueAction = null;
    this.iterationMenu = false;
    if (id) {
      const card = (this.preview ? sample().requirements : this.requirements).find(card => card.id === id);
      if (card) this.issueFolder = issueFolder(card);
      this.loadRequirement(id, cx);
    }
    cx.notify();
  }

  changeIssue(card, action, cx) {
    const binding = this.binding;
    if (this.preview || !binding || binding.machine || this.issueAction?.busy) return;
    const request = this.issueAction = { id: card.id, action, busy: true };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await team(["issue", action, card.id, "--root", binding.root, "--json"],
          { cwd: binding.root, timeout: 50_000 });
        const updated = teamJson(result, `issue ${action}`);
        if (this.closed || this.binding !== binding) return;
        this.requirements = this.requirements.map(row => row.id === card.id ? {
          ...row, acceptedAt: updated.acceptedAt, disposition: updated.disposition,
          status: updated.acceptedAt ? "accepted" : row.status,
        } : row);
        if (this.issueAction === request) {
          this.issueFolder = issueFolder(updated);
          this.issueAction = null;
        }
        this.load(cx);
      } catch (error) {
        if (this.issueAction === request) this.issueAction = { ...request, busy: false, error: errorMessage(error) };
      } finally { if (!this.closed) cx.notify(); }
    });
  }

  render(cx) {
    if (props()?.tab) return this.tabButton(theme());
    this.follow(cx);
    const t = theme(), mono = settings()?.font_family ?? "JetBrains Mono";
    const demo = this.preview ? sample() : null;
    const binding = demo?.binding ?? this.binding;
    const showcase = !this.preview && (this.viewBinding?.demo === true || props()?.showcase === true);
    const displayView = showcase ? this.demoView : this.view;
    const visibleRole = name => showcase ? name?.replace(/^demo-(dev|test|review)$/, "$1") : name;
    const remoteMachine = !this.preview && (this.pinned?.machine ?? this.place?.machine);
    const setup = !this.binding && !this.resolving ? this.setup : null;
    const requirements = demo?.requirements ?? this.requirements;
    const tasks = sortTasks(tasksWithIterations(demo?.tasks ?? this.tasks, requirements));
    const folderTasks = tasksForIteration(tasks, this.iteration);
    const iterationTasks = folderTasks.filter(task => taskFolder(task) === "current");
    const inbox = demo?.inbox?.[this.inboxFolder] ?? this.inboxRows;
    const live = scopedTerminals(demo?.terminals ?? terminals(), binding);
    const roles = roleRows(demo?.roles ?? this.roles, live);
    const inputColor = t.ansi3 ?? t.accent;
    const color = status => status === "error" ? t.blocked : status === "needs input" ? inputColor : status === "ready" ? t.accent : status === "awaiting handoff" ? t.done
      : status === "assigned" ? t.muted : t[status] ?? t.dim;

    // Small building blocks, in the shipped sidebar's vocabulary.
    const pill = (text, c) => div().flex_none().px(6).h(18).rounded(5).bg(c + "22").text_size(10.5).font_semibold().text_color(c)
      .flex().items_center().child(text);
    const heading = (text, count) => h_flex().items_center().gap(6).px(2)
      .child(div().text_size(11).font_semibold().text_color(t.dim).child(text))
      .when(count !== undefined, el => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
    const statusColor = status => status === "doing" ? t.working : status === "review" ? t.accent : status === "blocked" ? t.blocked : status === "done" ? t.done : t.dim;
    const taskDisplayLabel = task => taskFolder(task) === "current" ? taskReviewPhase(task) ?? label(task.status) : label(taskFolder(task));
    const taskDisplayColor = task => taskFolder(task) !== "current" ? t.muted : task.status === "review" && task.meta?.integration?.state === "blocked"
      ? t.blocked : statusColor(task.status);
    const emptyState = (title, description, icon = this.teamIcon(), detail) => v_flex().w_full().flex_1().min_h(220)
      .px(22).py(32).gap(10).items_center().justify_center().text_center()
      .child(div().size(42).flex_none().rounded(12).bg(t.surface).border(1).border_color(t.border)
        .flex().items_center().justify_center().child(svg(icon).size(20).text_color(t.muted)))
      .child(div().max_w(280).text_size(14).font_semibold().text_color(t.foreground).child(title))
      .child(div().max_w(280).text_size(12).line_height(1.5).text_color(t.muted).child(description))
      .when(Boolean(detail), el => el.child(div().max_w(280).mt(2).text_size(10.5).text_color(t.dim).child(detail)));
    const roleColor = name => {
      const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1].filter(Boolean);
      let hash = 0;
      for (const ch of name ?? "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      return palette[hash % palette.length] ?? t.accent;
    };
    const avatar = (name, size = 26) => div().size(size).flex_none().rounded(size > 20 ? 7 : 5).bg(roleColor(name) + "26")
      .text_size(size > 20 ? 12 : 10).font_bold().text_color(roleColor(name)).flex().items_center().justify_center()
      .child((name ?? "?").slice(0, 1).toUpperCase());
    const assigneeTooltip = ({ name, live, program, model, modelSource }) => [name,
      program?.name && `${live ? "Live agent" : "Configured agent"} · ${program.name}`,
      model && `${modelSource === "launch" ? "Launch model" : "Configured model"} · ${model}`,
    ].filter(Boolean).join("\n");
    const assignee = (assignment, compact = false) => {
      const { name, program, model } = assignment;
      const icon = program?.icon ? program.tint ? svg(program.icon).size(15).flex_none().text_color(t.foreground)
        : image(program.icon).size(15).flex_none() : compact ? avatar(name, 16) : null;
      return h_flex().gap(5).items_center().flex_1().min_w(0)
        .when(Boolean(icon), el => el.child(icon))
        .child(h_flex().gap(4).items_center().flex_1().min_w(0)
          .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(name))
          .when(!compact && Boolean(model), el => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim)
            .child(`· ${model}`))));
    };
    const priorityColor = p => p === "P0" ? t.blocked : p === "P1" ? t.working : t.muted;
    const taskReport = task => flowNodes(task, roles)[0]?.status;
    // Per-task glyph: recorded task status first, then what its current agent reports.
    const taskGlyph = task => {
      if (taskFolder(task) !== "current") return svg(ICON("minus")).size(14).flex_none().text_color(t.dim);
      if (task.status === "done") return svg(ICON("circle-check")).size(14).flex_none().text_color(t.done);
      if (task.status === "todo") return div().size(10).m(2).flex_none().rounded(5).border(1.5).border_color(t.dim);
      const report = taskReport(task);
      if (report === "working") return svg(ICON("spinner")).size(14).flex_none().text_color(t.working).spin(900);
      if (report === "needs input") return div().size(14).flex_none().rounded(4).bg(inputColor + "26")
        .text_size(10.5).font_bold().text_color(inputColor).flex().items_center().justify_center().child("?");
      if (report === "blocked" || report === "error") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26")
        .text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
      return div().size(10).m(2).flex_none().rounded(5).bg(t.accent);
    };

    const routeNote = task => {
      const waiting = waitingOn(task, tasks);
      return waiting.length ? `Waiting on ${waiting.map(id => `#${id}`).join(", ")}` : "";
    };

    const actionButton = (id, title, click, danger = false, disabled = false) => Button.new(id).flex_none().h(25).px(8)
      .rounded(6).border(1).border_color(t.border).text_size(11.5).text_color(disabled ? t.dim : danger ? t.blocked : t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(!disabled, el => el.hover(s => s.bg(t.hover)).on_click((_e, cx) => click(cx))).child(title);
    // Detail: one line per assignee with its harness and report.
    const steps = task => v_flex().gap(5).children(flowNodes(task, roles).map((node, index) => h_flex().gap(7).items_center().flex_wrap()
      .child(avatar(visibleRole(node.name), 18))
      .child(div().max_w(144).truncate().tooltip(visibleRole(node.name)).text_size(12).font_semibold().text_color(index ? t.muted : t.foreground).child(visibleRole(node.name)))
      .child(div().text_size(11).text_color(index ? t.dim : color(node.status)).child(index ? `Step ${index + 1}` : label(node.status)))
      .child(div().flex_1().min_w(0))
      .child(div().max_w(140).truncate().text_size(11).text_color(t.dim).child(`${node.harness} · ${node.model}`))));
    const detailPage = task => {
      const detail = this.preview ? { body: task.body ?? "" } : this.bodies.get(task.id);
      const { description, history } = taskDocument(detail?.body ?? "");
      const linkedId = task.meta?.requirement;
      const linked = requirements.find(card => card.id === linkedId);
      const linkedType = linked ? (linked.type === "defect" ? "Defect" : "Requirement") : "Issue";
      const linkedLabel = `${linkedType} ${linkedId}`;
      const folder = taskFolder(task);
      const action = this.taskAction?.id === task.id ? this.taskAction : null;
      const canEditTask = !this.preview && Boolean(binding) && !binding.machine;
      const running = folder === "current" && (Boolean(task.meta?.delivery) || !["todo", "done"].includes(task.status));
      const ask = (operation, cx) => { this.taskAction = { id: task.id, action: operation }; cx.notify(); };
      const back = div().id("back").h(24).pl(2).pr(8).gap(2).flex().items_center().rounded(6).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.select(null, cx))
        .child(svg(ICON("chevron-left")).size(14).text_color(t.muted)).child(div().text_size(12).text_color(t.muted).child("Tasks"));
      const popOut = div().id("pop-out").h(24).px(8).flex().items_center().rounded(6).border(1).border_color(t.border)
        .text_size(11.5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.popOut(task)).child("Pop out");
      return v_flex().w_full().max_w(680).min_w(0).gap(14)
        .when(!this.popout || canEditTask, el => el.child(h_flex().gap(6).items_center().flex_wrap()
          .when(!this.popout, el => el.child(back)).child(div().flex_1())
          .when(canEditTask && folder === "current", el => el.child(actionButton("task-archive", "Archive",
            cx => running ? ask("archive", cx) : this.changeTask(task, "archive", cx), false, action?.busy)))
          .when(canEditTask && folder !== "current", el => el.child(actionButton("task-restore", "Restore",
            cx => this.changeTask(task, "restore", cx), false, action?.busy)))
          .when(canEditTask && folder !== "trash", el => el.child(actionButton("task-delete", "Delete", cx => ask("delete", cx), true, action?.busy)))
          .when(!this.popout, el => el.child(popOut))))
        .when(Boolean(action && !action.busy && !action.error), el => el.child(v_flex().p(10).gap(8).rounded(7).bg(t.surface)
          .child(div().font_semibold().child(action.action === "delete" ? `Move #${task.id} to Trash?` : `Archive #${task.id}?`))
          .child(div().text_size(12).text_color(t.muted).child(running
            ? "The current delivery will end. Task history and Git work are kept."
            : "The task can be restored from Trash."))
          .child(h_flex().gap(6).flex_wrap()
            .child(actionButton("task-action-back", "Go back", cx => { this.taskAction = null; cx.notify(); }))
            .child(actionButton("task-action-confirm", action.action === "delete" ? "Move to Trash" : "Archive task",
              cx => this.changeTask(task, action.action, cx), action.action === "delete")))))
        .when(Boolean(action?.busy), el => el.child(div().text_size(12).text_color(t.muted).child("Updating task…")))
        .when(Boolean(action?.error), el => el.child(div().text_size(12).text_color(t.blocked).child(action?.error)))
        .child(v_flex().gap(7)
          .child(h_flex().gap(7).items_center().flex_wrap()
            .child(taskGlyph(task))
            .child(div().font_family(mono).text_size(11).text_color(t.dim).child(`#${task.id}`))
            .child(pill(taskDisplayLabel(task), taskDisplayColor(task)))
            .when(Boolean(task.priority), el => el.child(pill(task.priority, priorityColor(task.priority))))
            .when(Boolean(task.iteration), el => el.child(div().max_w(108).truncate().text_size(11).text_color(t.muted)
              .tooltip(task.meta?.iteration ? task.iteration : `${task.iteration} · From issue`).child(task.iteration)))
            .when(Boolean(task.meta?.feature), el => el.child(div().max_w(180).truncate().text_size(11).text_color(t.muted)
              .tooltip(task.meta?.feature ?? "").child(`Feature ${task.meta?.feature}`)))
            .when(Boolean(linkedId), el => el.child(div().id("linked-requirement").text_size(11).text_color(t.accent)
              .tooltip(linked?.title ?? linkedLabel)
              .when(Boolean(linked && !this.popout), el => el.hover(s => s.text_color(t.foreground))
                .on_click((_e, cx) => this.showRequirements(linkedId, cx)))
              .child(linkedLabel))))
          .child(div().text_size(16).font_semibold().line_height(1.35).child(task.title)))
        .child(v_flex().px(8).py(7).gap(5).rounded(7).bg(t.surface)
          .when(Boolean(task.handoff?.length), el => el.child(heading("Handoff")))
          .child(steps(task))
          .when(Boolean(task.dependsOn?.length), el => el.child(div().text_size(11).text_color(t.dim)
            .child(`Depends on ${task.dependsOn.map(id => `#${id}`).join(", ")}${routeNote(task) ? " · not finished" : ""}`))))
        // Selecting text must not drag a popped-out window.
        .child(v_flex().id("body").w_full().max_w(570).min_w(0).gap(14).pb(8)
          .text_size(13).line_height(1.6).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .when(detail == null, el => el.child(div().text_color(t.dim).child("Loading task details…")))
          .when(Boolean(detail?.error), el => el.child(v_flex().gap(6).items_start()
            .child(div().text_color(t.blocked).child(`Could not load task details. ${detail?.error}`))
            .child(actionButton("task-body-retry", "Retry", cx => {
              this.bodies.delete(task.id);
              this.loadBody(task.id, cx);
              cx.notify();
            }))))
          .when(detail?.body !== undefined && !description && !history,
            el => el.child(div().text_color(t.dim).child("No description or history recorded.")))
          .when(Boolean(description), el => el.child(TextView.markdown(`body-${task.id}-description`, readableDescription(description))
            .w_full().selectable(true).scrollable(false)))
          .when(Boolean(history), el => el.child(v_flex().id("task-history").gap(6)
            .when(Boolean(description), section => section.pt(12).border_t(1).border_color(t.border))
            .child(div().text_size(12).font_semibold().text_color(t.muted).child("History"))
            .child(TextView.markdown(`body-${task.id}-history`, history).w_full().selectable(true).scrollable(false)))));
    };

    // A. List: narrow-sidebar rows, explicit status filters and attention order.
    const taskRow = task => {
      const owner = taskAssignee(task, roles, this.agentPrograms);
      const needsInput = taskReport(task) === "needs input";
      owner.name = visibleRole(owner.name);
      return v_flex().id(`task-${task.id}`).px(6).py(7).gap(4).rounded(6).min_w(0)
        .tooltip([`#${task.id} · ${task.title}`, taskDisplayLabel(task), needsInput && "Needs input", assigneeTooltip(owner)].filter(Boolean).join("\n"))
        .hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.select(task.id, cx))
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().size(7).mx(3.5).flex_none().rounded(4).bg(taskDisplayColor(task)))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(task.status === "done" ? t.muted : t.foreground).child(task.title))
          .when(task.priority === "P0" || task.priority === "P1", el => el.child(pill(task.priority, priorityColor(task.priority)))))
        .child(h_flex().pl(22).gap(6).items_center().min_w(0).text_size(11)
          .child(div().flex_none().font_family(mono).text_color(t.dim).child(`#${task.id}`))
          .child(assignee(owner))
          .when(needsInput, el => el.child(div().flex_none().text_color(inputColor).child("Needs input")))
          .when(Boolean(task.iteration), el => el.child(div().max_w(76).truncate().text_color(t.dim).tooltip(task.iteration).child(task.iteration)))
          .child(div().flex_none().text_color(taskDisplayColor(task)).child(taskDisplayLabel(task))));
    };
    const filters = listFilters(iterationTasks);
    const activeFilter = filters.some(filter => filter.status === this.filter) ? this.filter : "all";
    const visibleTasks = listTasks(iterationTasks, activeFilter);
    const filterButton = ({ status, title, count }) => h_flex().id(`filter-${status}`).flex_none().h(25).px(7).gap(5).items_center().rounded(5)
      .bg(activeFilter === status ? t.selected : t.background)
      .text_color(activeFilter === status ? t.foreground : t.muted)
      .tooltip(status === "open" ? "Open tasks · blocked, review and in progress first." : `${title} tasks`)
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.filter = status; cx.notify(); })
      .child(div().text_size(11.5).font_medium().child(title))
      .child(div().text_size(10.5).text_color(t.dim).child(String(count)));
    const listView = v_flex().min_w(0).gap(8)
      .child(h_flex().flex_wrap().gap(4).pb(8).border_b(1).border_color(t.border).children(filters.map(filterButton)))
      .child(v_flex().min_w(0).gap(1).children(visibleTasks.map(taskRow))
        .when(!visibleTasks.length, el => el.child(div().px(6).py(14).text_size(12).text_color(t.muted)
          .child(this.iteration && !iterationTasks.length ? `No tasks in ${this.iteration}.`
            : activeFilter === "open" ? "No open tasks. Use Done to see completed tasks." : `No ${label(activeFilter).toLowerCase()} tasks.`))));

    // B. Board: one card in its recorded status column, with its current assignee.
    const card = task => {
      const next = visibleRole(task.handoff?.[0]), phase = taskReviewPhase(task);
      const needsInput = taskReport(task) === "needs input";
      const note = needsInput ? "Needs input" : phase ?? (routeNote(task) || (next ? `Next: ${next}` : ""));
      const owner = taskAssignee(task, roles, this.agentPrograms);
      owner.name = visibleRole(owner.name);
      return v_flex().id(`card-${task.id}`).min_w(0).p(8).gap(6).rounded(6).bg(t.background).border(1)
        .border_color(t.border).hover(s => s.bg(t.hover).border_color(t.input))
        .tooltip([`#${task.id} · ${task.title}`, [taskDisplayLabel(task), task.priority].filter(Boolean).join(" · "),
          assigneeTooltip(owner), task.iteration, note].filter(Boolean).join("\n"))
        .on_click((_e, cx) => this.select(task.id, cx))
        .child(div().text_size(12).font_semibold().line_height(1.35).text_color(t.foreground).child(task.title))
        .child(h_flex().gap(5).items_center().min_w(0).child(assignee(owner, true))
          .when(task.priority === "P0" || task.priority === "P1", el => el.child(pill(task.priority, priorityColor(task.priority)))))
        .when(Boolean(note), el => el.child(div().min_w(0).text_size(10.5).line_height(1.35)
          .text_color(needsInput ? inputColor : phase ? taskDisplayColor(task) : t.muted).child(note)))
        .child(div().font_family(mono).text_size(10).text_color(t.dim).child(`#${task.id}`));
    };
    const columns = boardColumns(iterationTasks);
    const columnGap = 8;
    const boardWidth = Math.max(0, (this.width ?? WIDE) - 38);
    const fit = Math.max(1, Math.floor((boardWidth + columnGap) / (144 + columnGap)));
    const populated = columns.filter(column => column.tasks.length);
    const compactBoard = populated.length > 0 && fit < columns.length;
    const visibleColumns = compactBoard ? populated : columns;
    const columnsPerRow = Math.min(visibleColumns.length, fit);
    const columnWidth = Math.floor((boardWidth - (columnsPerRow - 1) * columnGap) / columnsPerRow);
    const column = ({ status, title, tasks: cards }) => v_flex().w(columnWidth).flex_none().p(6).gap(6).rounded(8).bg(t.surface)
      .child(h_flex().gap(6).items_center().h(24).px(3)
        .child(div().size(7).flex_none().rounded(4).bg(statusColor(status)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().tooltip(title).child(title))
        .child(div().text_size(10.5).text_color(t.muted).child(String(cards.length))))
      .children(cards.map(card));
    const emptyColumns = compactBoard ? columns.filter(column => !column.tasks.length) : [];
    const boardView = v_flex().id("status-board").w_full().min_w(0).gap(8).pb(4)
      .when(emptyColumns.length > 0, el => el.child(h_flex().gap(8).flex_wrap().px(3).children(emptyColumns.map(({ status, title }) =>
        h_flex().gap(4).items_center().text_size(10.5).text_color(t.muted)
          .child(div().size(5).flex_none().rounded(3).bg(statusColor(status))).child(`${title} 0`)))))
      .child(h_flex().w_full().min_w(0).flex_wrap().gap(columnGap).items_start().children(visibleColumns.map(column)));

    const compactHeader = (this.width ?? WIDE) < 465;
    const narrowHeader = (this.width ?? WIDE) < 365;
    const segment = (id, text, on, action) => div().id(id).px(narrowHeader ? 4 : compactHeader ? 6 : 8).h(22).rounded(5).flex().items_center()
      .text_size(11.5).font_medium().text_color(on ? t.foreground : t.muted)
      .when(on, el => el.bg(t.background).border(1).border_color(t.border))
      .when(!on, el => el.hover(s => s.text_color(t.foreground)).on_click((_e, cx) => action(cx)))
      .child(text);

    const typePill = type => pill(type === "defect" ? "Defect" : "Requirement", type === "defect" ? t.blocked : t.accent);
    const folderTabs = (kind, selected, onSelect) => h_flex().self_start().flex_none().flex_wrap().gap(2).p(2).rounded(7).bg(t.raised)
      .children([["current", "Current"], ["archive", "Archive"], ["trash", "Trash"]].map(([folder, name]) =>
        segment(`${kind}-folder-${folder}`, name, selected === folder, cx => onSelect(folder, cx))));
    const requirementLabel = card => issueFolder(card) === "current" ? REQUIREMENT_STATUS[card.status] ?? card.status : label(issueFolder(card));
    const requirementColor = status => status === "accepted" ? t.done : status === "ready" ? t.accent : status === "in-progress" ? t.working : t.dim;
    const requirementRow = card => h_flex().id(`requirement-${card.id}`).gap(7).items_center().min_w(0).px(6).py(8).rounded(6)
      .tooltip(`${card.id} · ${card.title}\n${requirementLabel(card)} · ${card.progress.done}/${card.progress.total} tasks complete`)
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.showRequirements(card.id, cx))
      .child(div().size(7).flex_none().rounded(4).bg(issueFolder(card) === "current" ? requirementColor(card.status) : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(card.title))
      .child(typePill(card.type))
      .child(div().flex_none().font_family(mono).text_size(11).text_color(t.muted).child(`${card.progress.done}/${card.progress.total}`));
    const options = [null, ...iterationOptions([...tasks, ...requirements])];
    const iterationTitle = value => value ?? "All iterations";
    const visibleRequirements = requirementsForIteration(requirements, this.iteration, this.requirementType, this.issueFolder);
    const iterationFilter = Popover.new("iteration-filter").anchor("top_right").flex_none()
      .open(this.iterationMenu).on_open_change((open, cx) => { this.iterationMenu = open; cx.notify(); })
      .trigger(h_flex().w(narrowHeader ? 56 : compactHeader ? 82 : 124).gap(5).items_center().px(narrowHeader ? 4 : 7).h(24).rounded(6)
        .border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover))
        .tooltip(`Filter by iteration · ${iterationTitle(this.iteration)}`)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5)
          .child(compactHeader && this.iteration === null ? "All" : iterationTitle(this.iteration)))
        .child(svg(ICON("chevron-down")).size(12).flex_none()))
      .content(v_flex().id("iteration-options").w(172).max_h(180).overflow_y_scrollbar()
        .p(3).rounded(6).bg(t.surface).border(1).border_color(t.border)
        .children(options.map((value, index) => Button.new(`iteration-option-${index}`).w_full().h(26).px(7).rounded(4)
          .flex().items_center().gap(6).text_size(11.5).bg(value === this.iteration ? t.selected : t.surface)
          .tooltip(iterationTitle(value)).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.iteration = value; this.iterationMenu = false; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(iterationTitle(value)))
          .when(value === this.iteration, el => el.child(svg(ICON("check")).size(12).flex_none().text_color(t.accent))))));
    const requirementList = v_flex().min_w(0).gap(8)
      .child(folderTabs("issue", this.issueFolder, (folder, cx) => { this.issueFolder = folder; cx.notify(); }))
      .child(h_flex().gap(2).p(2).rounded(7).bg(t.raised).flex_wrap()
        .children(REQUIREMENT_TYPES.map(([type, name], index) => segment(`requirement-type-${index}`, name,
          type === this.requirementType, cx => { this.requirementType = type; cx.notify(); }))))
      .child(v_flex().gap(1).children(visibleRequirements.map(requirementRow))
        .when(!visibleRequirements.length, el => el.child(div().px(6).py(14).text_size(12).text_color(t.muted)
          .child(this.issueFolder === "archive" ? "No archived issues match." : this.issueFolder === "trash" ? "No deleted issues match."
            : requirements.length ? "No items match these filters." : "No requirements or defects yet."))));
    const requirementPage = card => {
      const detail = this.preview ? card : this.requirementDetails.get(card.id);
      const folder = issueFolder(card);
      const action = this.issueAction?.id === card.id ? this.issueAction : null;
      const canEditIssue = !this.preview && Boolean(binding) && !binding.machine;
      const canAccept = card.status !== "accepted" && card.progress.done === card.progress.total;
      const linked = (detail?.tasks ?? []).map(task => tasks.find(item => item.id === task.id) ?? task)
        .map(task => h_flex().id(`linked-task-${task.id}`).min_w(0)
        .gap(6).items_center().px(6).py(6).rounded(5).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.select(task.id, cx))
        .child(div().font_family(mono).flex_none().text_size(10.5).text_color(t.muted).child(`#${task.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(task.title))
        .child(div().text_size(10.5).flex_none().text_color(taskDisplayColor(task)).child(taskDisplayLabel(task))));
      return v_flex().w_full().max_w(680).gap(12).min_w(0)
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(h_flex().id("back-to-requirements").h(24).gap(4).items_center().rounded(6).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => this.showRequirements(null, cx))
            .child(svg(ICON("chevron-left")).size(14).text_color(t.muted)).child("Issues"))
          .child(div().flex_1())
          .when(canEditIssue && folder === "current" && canAccept, el => el.child(actionButton("issue-accept", "Accept",
            cx => this.changeIssue(card, "accept", cx), false, action?.busy)))
          .when(canEditIssue && folder === "current", el => el.child(actionButton("issue-archive", "Archive",
            cx => this.changeIssue(card, "archive", cx), false, action?.busy)))
          .when(canEditIssue && folder !== "current", el => el.child(actionButton("issue-restore", "Restore",
            cx => this.changeIssue(card, "restore", cx), false, action?.busy)))
          .when(canEditIssue && folder !== "trash", el => el.child(actionButton("issue-delete", "Delete", cx => {
            this.issueAction = { id: card.id, action: "delete" }; cx.notify();
          }, true, action?.busy))))
        .when(Boolean(action && !action.busy && !action.error), el => el.child(v_flex().p(10).gap(8).rounded(7).bg(t.surface)
          .child(div().font_semibold().child(`Move ${card.id} to Trash?`))
          .child(div().text_size(12).text_color(t.muted).child("The issue can be restored from Trash."))
          .child(h_flex().gap(6).flex_wrap()
            .child(actionButton("issue-action-back", "Go back", cx => { this.issueAction = null; cx.notify(); }))
            .child(actionButton("issue-action-confirm", "Move to Trash", cx => this.changeIssue(card, "delete", cx), true)))))
        .when(Boolean(action?.busy), el => el.child(div().text_size(12).text_color(t.muted).child("Updating issue…")))
        .when(Boolean(action?.error), el => el.child(div().text_size(12).text_color(t.blocked).child(action?.error)))
        .child(h_flex().gap(6).items_center().flex_wrap().child(typePill(card.type))
          .child(div().text_size(11).font_family(mono).text_color(t.muted).child(card.id))
          .child(pill(requirementLabel(card), folder === "current" ? requirementColor(card.status) : t.dim))
          .child(pill(card.priority, priorityColor(card.priority)))
          .when(Boolean(iterationVersion(card.iteration)), el => el.child(div().text_size(11).text_color(t.muted).child(iterationVersion(card.iteration)))))
        .child(div().text_size(16).font_semibold().line_height(1.35).child(card.title))
        .when(!detail, el => el.child(div().text_color(t.dim).child("Loading…")))
        .when(Boolean(detail?.error), el => el.child(div().text_color(t.blocked).child(detail?.error ?? "")))
        .when(Boolean(detail?.body), el => el.child(TextView.markdown(`description-${card.id}`, detail?.body ?? "").selectable(true)))
        .when(Boolean(detail && !detail.error), el => el
          .child(heading("ACCEPTANCE CRITERIA"))
          .child(detail?.acceptance ? TextView.markdown(`acceptance-${card.id}`, detail.acceptance).selectable(true)
            : div().text_color(t.dim).child("No acceptance criteria recorded."))
          .child(heading("TASKS", linked.length))
          .child(v_flex().gap(2).children(linked)));
    };

    const mailTime = row => row.received_at ? new Date(row.received_at).toLocaleString() : "";
    const inboxRow = row => {
      const mail = row.source === "agentmail";
      const openable = mail || tasks.some(task => task.id === row.id);
      const title = mail ? row.subject || "(No subject)" : row.title || `Task #${row.id}`;
      const metadata = (mail ? [row.sender, mailTime(row)] : [`Task #${row.id}`, visibleRole(row.role), row.label]).filter(Boolean).join(" · ");
      return v_flex().id(`inbox-${row.id}`).min_w(0).gap(3).px(7).py(7).rounded(6)
        .when(openable, el => el.hover(s => s.bg(t.hover))
          .on_click((_e, cx) => mail ? this.openMail(row, cx) : this.select(row.id, cx)))
        .tooltip([title, metadata, row.reason].filter(Boolean).join("\n"))
        .child(h_flex().items_center().gap(6)
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(title))
          .when(openable, el => el.child(svg(ICON("chevron-right")).size(12).flex_none().text_color(t.dim))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(metadata))
        .when(mail && row.state === "trashed" && Boolean(row.label), el => el.child(div().text_size(11).text_color(t.dim).child(row.label)))
        .when(Boolean(row.reason), el => el.child(div().min_w(0).text_size(11).text_color(t.dim).child(row.reason)));
    };
    const email = inbox.filter(row => row.source === "agentmail");
    const deliveries = inbox.filter(row => row.source !== "agentmail");
    const inboxList = v_flex().min_w(0).gap(12).when(!inbox.length, el => el.flex_1().min_h(0))
      .child(h_flex().self_start().flex_none().gap(2).p(2).rounded(7).bg(t.raised)
        .child(segment("inbox-active", "Active", this.inboxFolder === "active", cx => this.showInbox("active", cx)))
        .child(segment("inbox-trash", "Trash", this.inboxFolder === "trash", cx => this.showInbox("trash", cx))))
      .when(Boolean(inbox.length), el => el.child(v_flex().min_w(0).gap(4).child(heading("Email", email.length))
        .children(email.map(inboxRow))
        .when(!email.length, el => el.child(div().px(7).py(6).text_size(12).text_color(t.muted).child("No email in this Inbox.")))))
      .when(Boolean(deliveries.length), el => el.child(v_flex().min_w(0).gap(4)
        .child(heading("Task deliveries", deliveries.length)).children(deliveries.map(inboxRow))))
      .when(!inbox.length, el => el.child(this.inboxError && !this.preview
        ? emptyState("Inbox unavailable", this.inboxError)
        : this.inboxLoading && !this.preview ? emptyState("Loading Inbox…", "Reading deliveries and mail.")
        : emptyState(this.inboxFolder === "trash" ? "Trash is empty" : "Inbox is empty",
          this.inboxFolder === "trash" ? "Mail that could not be routed appears here." : "Deliveries and AgentMail for this team appear here.")));
    const mailPage = selection => {
      const row = selection.row, detail = selection.content;
      const field = (title, value) => h_flex().min_w(0).gap(8).text_size(12)
        .child(div().flex_none().w(66).text_color(t.muted).child(title))
        .child(div().flex_1().min_w(0).child(value));
      const body = typeof detail?.body === "string" ? detail.body : "";
      // Email text is external input. Escape it before using the native rich text view.
      const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r\n?|\n/g, "<br>");
      return v_flex().min_w(0).gap(12)
        .child(h_flex().id("back-to-inbox").self_start().h(24).gap(4).items_center().rounded(6).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.mail = null; cx.notify(); })
          .child(svg(ICON("chevron-left")).size(14).text_color(t.muted)).child(this.inboxFolder === "trash" ? "Trash" : "Inbox"))
        .child(v_flex().min_w(0).gap(9).p(12).rounded(8).border(1).border_color(t.border).bg(t.surface)
          .child(div().text_size(16).font_semibold().line_height(1.35).child(row.subject || "(No subject)"))
          .child(v_flex().gap(4).min_w(0)
            .child(field("From", row.sender || "Unknown sender"))
            .when(Boolean(row.inbox), el => el.child(field("Mailbox", row.inbox)))
            .when(Boolean(row.received_at), el => el.child(field("Received", mailTime(row))))
            .when(Boolean(row.role), el => el.child(field("Routed to", visibleRole(row.role))))
            .when(Boolean(row.label), el => el.child(field("Status", row.label)))))
        .child(v_flex().id("email-body").min_w(0).gap(7).px(4).pt(2)
          .child(heading("Message"))
          .child(selection.error ? div().text_color(t.blocked).child(selection.error)
            : !detail ? div().text_color(t.muted).child("Loading message…")
            : body.trim() ? TextView.html(`email-text-${row.id}`, `<p>${escaped}</p>`).selectable(true)
            : div().text_color(t.muted).child("No message body.")));
    };

    const setupLoading = this.resolving || setup?.action === null;
    const hasTeamView = Boolean(binding) || setup?.action === "up";
    const runtime = this.runtime;
    const teamTooltip = this.binding
      ? `${this.binding.root}\nMachine: ${this.binding.machine ?? "Local"}\nTeam space: ${this.binding.space}${this.viewBinding?.task ? `\nTask #${this.viewBinding.task}\nWorktree space: ${this.viewBinding.view_space}` : ""}`
      : "Team";
    const setupButton = () => Button.new("team-setup-action").flex_none().h(32).px(14).rounded(6)
      .flex().items_center().bg(t.accent + "29").text_size(13).font_semibold().text_color(setup?.busy ? t.dim : t.accent)
      .when(!setup?.busy, button => button.hover(s => s.bg(t.hover)).on_click((_e, cx) => this.setupAction(cx)))
      .tooltip(setup?.action === "up" ? `Start the team in this Space\n${setup.root}` : `Initialize and register the project\n${setup?.cwd}`)
      .child(setup?.busy ? "Working…" : setup?.action === "up" ? "Up" : "Initialize now");
    const setupPage = () => emptyState("Set up your team", "Initialize this project or use an agent to configure it.")
      .id("team-onboarding")
      .child(setupButton())
      .child(v_flex().w_full().max_w(400).min_w(0).gap(7).mt(4).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("Start with an agent"))
        .child(setup?.agents?.length
          ? h_flex().w_full().flex_wrap().justify_center().gap(6).children(setup.agents.map(agent => Button.new(`team-setup-agent-${agent.key}`)
            .h(28).px(9).rounded(5).bg(t.surface).text_size(12).flex().items_center().gap(6)
            .when(!setup.busy, button => button.hover(s => s.bg(t.hover)).on_click((_e, cx) => this.startSetupAgent(agent, cx)))
            .when(Boolean(agent.icon), button => button.child(agent.tint
              ? svg(agent.icon).size(14).flex_none().text_color(t.foreground)
              : image(agent.icon).size(14).flex_none()))
            .child(agent.name)))
          : div().text_size(12).text_color(t.muted).child(setup?.agentError ??
            (setup?.agents ? "No local agents are available." : "Checking installed agents…"))))
      .when(Boolean(setup?.agentStarted), el => el.child(div().text_size(12).text_color(t.muted).child("Continue setup in the agent tab.")))
      .child(Button.new("team-view-demo").h(28).px(10).rounded(5).text_size(12).text_color(t.muted)
        .when(!setup?.busy, button => button.hover(s => s.bg(t.hover)).on_click((_e, cx) => this.setPreview(true, cx)))
        .child("View demo"));
    const sampleBanner = () => h_flex().id("team-sample-banner").flex_none().flex_wrap().items_center().gap(8).mx(14).mt(12).px(12).py(8)
      .rounded(8).border(1).border_color(t.accent + "55").bg(t.accent + "12")
      .child(div().flex_1().min_w(0).text_size(13).font_semibold().child("You’re viewing demo data"))
      .child(Button.new("team-demo-back").flex_none().h(27).px(9).rounded(5).bg(t.surface).text_size(12)
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.setPreview(false, cx)).child("Back to setup"));
    const header = h_flex().h(44).flex_none().px(compactHeader ? 8 : 12).gap(compactHeader ? 5 : 8)
      .items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().flex().items_center().tooltip(teamTooltip)
        .child(svg(this.teamIcon()).size(15).text_color(t.muted)))
      .when(hasTeamView, el => el.child(h_flex().flex_none().p(2).gap(1).rounded(7).bg(t.raised)
        .child(segment("section-tasks", "Tasks", this.section === "tasks", cx => this.select(null, cx)))
        .child(segment("section-requirements", "Issues", this.section === "requirements", cx => this.showRequirements(null, cx)))
        .child(segment("section-inbox", "Inbox", this.section === "inbox", cx => this.showInbox(this.inboxFolder, cx)))))
      .child(div().flex_1().min_w(0))
      .when(hasTeamView && this.section === "tasks" && this.taskFolder === "current", el => el.child(h_flex().flex_none().p(2).gap(1).rounded(7).bg(t.raised)
        .child(segment("view-list", "List", displayView === "list", cx => this.setView("list", cx)))
        .child(segment("view-board", "Board", displayView === "board", cx => this.setView("board", cx)))))
      .when(Boolean(binding) && this.section !== "inbox" && !this.selected && !this.selectedRequirement,
        el => el.child(iterationFilter))
      .when(!this.preview || setup?.agentStarted, el => el.child(this.loading || this.resolving || this.section === "inbox" && this.inboxLoading
        ? div().size(22).flex_none().flex().items_center().justify_center().child(svg(ICON("spinner")).size(13).text_color(t.muted).spin(900))
        : div().id("refresh").size(22).flex_none().rounded(6).flex().items_center().justify_center().tooltip("Refresh").hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.pinned ? this.load(cx) : this.follow(cx, true)).child(div().text_size(14).text_color(t.muted).child("↻"))));

    const notices = [];
    if (this.error) notices.push(div().px(10).py(7).rounded(7).bg(t.blocked + "1a").text_size(11.5).text_color(t.blocked).child(this.error));
    if (this.watchError && !this.preview) notices.push(div().px(10).py(7).rounded(7).bg(t.surface).text_size(11.5).text_color(t.dim).child(this.watchError));
    if (setup?.error) notices.push(div().px(10).py(7).rounded(7).bg(t.blocked + "1a").text_size(11.5).text_color(t.blocked).child(setup.error));
    if (runtime?.error) notices.push(div().px(10).py(7).rounded(7).bg(t.blocked + "1a").text_size(11.5).text_color(t.blocked).child(runtime.error));

    const empty = this.error && !this.preview
      ? emptyState("Team unavailable", "Resolve the error above, then refresh.")
      : this.loading || this.resolving
        ? emptyState("Loading team…", "Reading the team connected to this space.")
        : binding || this.preview
          ? emptyState("No tasks yet", "Tasks will appear here once your team creates them.")
          : remoteMachine
            ? emptyState("Connect a team", "Run herdr-team space bind --core in this Space's project terminal, then Refresh.", ICON("server"), remoteMachine)
            : emptyState("Connect a team", "Open a local project terminal to set up this Space.", ICON("monitor"));

    const open = tasks.find(task => task.id === this.selected);
    const activeRequirement = requirements.find(card => card.id === this.selectedRequirement);
    const issues = this.requirementError && !this.preview ? emptyState("Issues unavailable", this.requirementError)
      : this.loading && !requirements.length && !this.preview ? emptyState("Loading issues…", "Reading requirements and defects.")
      : activeRequirement ? requirementPage(activeRequirement) : requirementList;
    const runtimePrompt = this.section === "tasks" && !open && runtime && !runtime.error && !runtime.running
      ? runtime.running === null || runtime.starting
        ? emptyState("Checking team…", "Waiting for the team service.")
        : emptyState("Team is stopped", "Start the team in this Space.").child(Button.new("team-restart")
          .h(32).px(14).rounded(6).bg(t.accent + "29").text_color(runtime.busy ? t.dim : t.accent).font_semibold()
          .when(!runtime.busy, el => el.hover(s => s.bg(t.hover)).on_click((_e, cx) => this.startStoppedTeam(cx)))
          .child(runtime.busy ? "Working…" : "Up"))
      : null;
    const hiddenTasks = folderTasks.filter(task => taskFolder(task) === this.taskFolder);
    const overviewEmpty = this.taskFolder === "current" ? Boolean(runtimePrompt) : !hiddenTasks.length;
    const taskOverview = v_flex().min_w(0).gap(12).when(overviewEmpty, el => el.flex_1().min_h(0))
      .child(folderTabs("task", this.taskFolder, (folder, cx) => {
        this.taskFolder = folder;
        this.taskAction = null;
        cx.notify();
      }))
      .child(this.taskFolder === "current" ? runtimePrompt ?? (displayView === "board" ? boardView : listView)
        : hiddenTasks.length ? v_flex().gap(1).children(hiddenTasks.map(taskRow))
        : emptyState(this.taskFolder === "archive" ? "Archive is empty" : "Trash is empty",
          this.taskFolder === "archive" ? "Archived tasks appear here." : "Deleted tasks can be restored from here."));
    const content = setupLoading ? emptyState("Loading team…", "Checking the project for this Space.")
      : setup?.action === "up" ? emptyState("Project initialized", "Start the team in this Space.").child(setupButton())
      : !this.preview && setup?.action === "init" ? setupPage()
      : open ? detailPage(open) : this.popout ? div().text_color(t.dim).child(this.loading ? "Loading…" : "Task not found.")
      : this.section === "requirements" ? binding && (!this.error || this.preview) ? issues : empty
      : this.section === "inbox" ? binding && (!this.error || this.preview) ? this.mail ? mailPage(this.mail) : inboxList : empty
      : binding && (!this.error || this.preview) && (tasks.length || !this.loading) ? taskOverview : empty;

    // A popped-out window: the window frame is the app's; its title bar drags it.
    if (this.popout) return v_flex().id("team-root").size_full().overflow_hidden().bg(t.background).text_color(t.foreground).text_size(12.8)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(this.teamIcon()).size(14).text_color(t.muted))
        .child(div().text_size(12.5).font_semibold().child(`Task #${this.selected}`))
        .when(this.preview, el => el.child(pill("SAMPLE", t.accent)))
        .child(div().flex_1())
        .child(div().id("close").size(24).rounded(6).flex().items_center().justify_center().hover(s => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props().overlay)).child(svg(ICON("x")).size(14).text_color(t.muted))))
      .child(v_flex().id("team-body").flex_1().min_h(0).overflow_y_scrollbar().p(18).gap(14)
        .when(Boolean(this.error), el => el.child(div().px(10).py(7).rounded(7).bg(t.blocked + "1a").text_size(11.5).text_color(t.blocked).child(this.error)))
        .child(content));

    return v_flex().id("team-root").relative().size_full().overflow_hidden().rounded(10).border(1).border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(12.8)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(header)
      .when(this.preview && !setupLoading, el => el.child(sampleBanner()))
      .child(v_flex().id("team-body").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(14)
        .children(notices)
        .child(content));
  }
}

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { makeProject, taskMeta, writeRole, writeTask } from "./helpers.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { bindDesktop, desktopDown, DesktopError, desktopUp, showDesktopBinding, type DesktopClient, type DesktopTerminal } from "../scripts/lib/runtime/desktop.ts";
import { closeFinishedDesktopTaskAgents, desktopTaskRuntime, syncDesktopTaskSpaces } from "../scripts/lib/runtime/desktop-dispatch.ts";
import { desktopWorktrees } from "../scripts/lib/runtime/desktop-worktrees.ts";
import { cleanDesktopTasks } from "../scripts/lib/runtime/desktop-cleanup.ts";
import { featurePreviewStatus, queueFeaturePreview, reconcileFeaturePreviews } from "../scripts/lib/runtime/feature-preview.ts";
import { dispatch } from "../scripts/lib/dispatch/launch.ts";
import { claimTask, pumpQueue, queueRows } from "../scripts/lib/dispatch/queue.ts";
import { editTask, writeTaskMeta } from "../scripts/lib/tasks/cards.ts";
import { CORE_START_UNCONFIRMED, deliveryFor } from "../scripts/lib/dispatch/delivery.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { git } from "../scripts/lib/tasks/verification.ts";
import { runtimePath } from "../scripts/lib/runtime/state.ts";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import { listMail, mailId, storeMail, withMailInbox } from "../scripts/lib/runtime/mail-inbox.ts";
import { notifyMail } from "../scripts/lib/runtime/mail-notifications.ts";
import { makeDaemonTeam, pauseDaemonTeam, readDaemonTeam, registerDaemonTeam } from "../scripts/lib/runtime/daemon-binding.ts";
import { readProxyEnv } from "../scripts/lib/runtime/agent-env.ts";
import { finishFeature } from "../scripts/lib/team/features.ts";
import { addRequirement, editRequirements } from "../scripts/lib/team/requirements.ts";
import { purgeProject } from "../scripts/lib/team/purge.ts";

function fixture(core: { doneGuard?: boolean; started?: boolean } = {}) {
  const f = makeProject("project with spaces 中文");
  writeRole(f.root, "dev", { kind: "codex", worktree: true });
  writeRole(f.root, "qa", { kind: "claude", worktree: true });
  writeTask(f.root, "0001-feature", taskMeta({ handoff: ["qa"] }));
  writeTask(f.root, "0002-other", taskMeta());
  writeFileSync(join(f.root, ".gitignore"), "/.herdr/\n");
  git(f.root, "init", "-q"); git(f.root, "config", "user.email", "test@example.com"); git(f.root, "config", "user.name", "Test");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "Initial");
  let document: any = null, version = 0;
  const caller: DesktopTerminal = { address: "caller", state: "live", argv: ["codex"], cwd: f.root, pid: 9, labels: { "herdr.space": "s1" } };
  const terminals = [caller];
  const appSpaces = [{ id: "s1", machine: null, tabs: [{ terminals: [{ terminal: caller.address }] }] }];
  const attach = (terminal: DesktopTerminal) => {
    for (const space of appSpaces) for (const tab of space.tabs) tab.terminals = tab.terminals.filter(item => item.terminal !== terminal.address);
    let space = appSpaces.find(space => space.id === terminal.labels["herdr.space"]);
    if (!space) { space = { id: terminal.labels["herdr.space"]!, machine: null, tabs: [] }; appSpaces.push(space); }
    space.tabs.push({ terminals: [{ terminal: terminal.address }] });
  };
  const calls: { method: string; params: Record<string, any> }[] = [];
  const client: DesktopClient = {
    executable: kind => `/bin/${kind}`,
    spaces: () => structuredClone(appSpaces),
    park(address) {
      calls.push({ method: "app.terminal.park", params: { terminal: address } });
      for (const space of appSpaces) for (const tab of space.tabs) tab.terminals = tab.terminals.filter(item => item.terminal !== address);
      delete terminals.find(terminal => terminal.address === address)!.labels["herdr.space"];
    },
    closeEmptyTaskSpace(id) {
      const index = appSpaces.findIndex(space => space.id === id);
      if (index < 0) return;
      if (appSpaces[index]!.tabs.length) throw new Error("Task space still has tabs");
      calls.push({ method: "app.space.close", params: { id } });
      appSpaces.splice(index, 1);
    },
    rpc<T>(method: string, params: Record<string, any>): T {
      calls.push({ method, params });
      if (method === "rpc.discover") {
        const type = core.doneGuard ? "SendIf" : "IdleOrWorking";
        return { methods: [{ name: "terminal.send", params: [{ name: "if", schema: { anyOf: [
          { $ref: `#/components/schemas/${type}` }, { type: "null" },
        ] } }] }], components: { schemas: { [type]: { enum: ["idle", "working", ...(core.doneGuard ? ["done"] : [])] } } } } as T;
      }
      if (method === "doc.get") return structuredClone({ value: document, version }) as T;
      if (method === "doc.set") {
        expect(params.version).toBe(version); document = structuredClone(params.value); version++;
        return { version } as T;
      }
      if (method === "terminal.list") return { terminals: structuredClone(terminals) } as T;
      if (method === "terminal.get") {
        const terminal = terminals.find(terminal => terminal.address === params.terminal);
        if (!terminal) throw new DesktopError("Not found", "not_found");
        return structuredClone(terminal) as T;
      }
      if (method === "terminal.run") {
        if (terminals.some(terminal => terminal.state === "live" && (terminal as any).name === params.name)) throw new DesktopError("Name exists", "name_taken");
        const terminal = { address: `t${terminals.length}`, state: "live", argv: params.argv, cwd: params.cwd,
          name: params.name, pid: terminals.length + 100, labels: params.labels, status: { app: "codex", state: "working" } };
        terminals.push(terminal); attach(terminal); return structuredClone(terminal) as T;
      }
      if (method === "terminal.label") {
        const terminal = terminals.find(terminal => terminal.address === params.terminal)!;
        for (const [name, value] of Object.entries(params.labels as Record<string, string>)) {
          if (value) terminal.labels[name] = value;
          else delete terminal.labels[name];
        }
        if (params.labels["herdr.space"]) attach(terminal);
        return structuredClone(terminal) as T;
      }
      if (method === "terminal.send") {
        const terminal = terminals.find(terminal => terminal.address === params.terminal)!;
        if (params.if !== "idle" && !(core.doneGuard && params.if === "done")) throw new DesktopError("Unsupported guard", "invalid_params");
        if (terminal.status?.state !== params.if) throw new DesktopError("Busy", "status_mismatch");
        if (core.started !== false) terminal.status = { state: "working" };
        return { turn: 1, started: core.started } as T;
      }
      if (method === "terminal.kill") {
        const terminal = terminals.find(terminal => terminal.address === params.terminal)!;
        terminal.state = "finished";
        return structuredClone(terminal) as T;
      }
      if (method === "terminal.rm") {
        const index = terminals.findIndex(terminal => terminal.address === params.terminal);
        if (index < 0) throw new DesktopError("Not found", "not_found");
        if (terminals[index]!.state !== "finished") throw new DesktopError("Still live", "live");
        terminals.splice(index, 1);
        for (const space of appSpaces) {
          for (const tab of space.tabs) tab.terminals = tab.terminals.filter(item => item.terminal !== params.terminal);
          space.tabs = space.tabs.filter(tab => tab.terminals.length > 0);
        }
        return { removed: params.terminal } as T;
      }
      throw new Error(`Unexpected Core method ${method}`);
    },
  };
  bindDesktop(loadProject(f.root), client, "s1");
  const load = () => loadProject(f.root);
  const task = (id = "0001") => load().tasks.find(task => task.id === id)!;
  const runtime = (who = caller) => desktopTaskRuntime(load(), client, who);
  const claim = (id = "0001", who = terminals.find(terminal => terminal.address === deliveryFor(task(id))!.terminal)!) => {
    const r = runtime(who);
    return claimTask(load(), id, deliveryFor(task(id))!.id, (task, delivery) => { r.assertDelivery(delivery); r.authorize!(task, delivery); });
  };
  const cleanup = () => {
    for (const tree of desktopWorktrees(f.root)) if (tree.path !== git(f.root, "rev-parse", "--show-toplevel")) git(f.root, "worktree", "remove", "--force", tree.path);
    f.cleanup();
  };
  return { ...f, cleanup, client, terminals, caller, calls, runtime, load, task, claim, appSpaces, attach };
}

test("Desktop dispatch starts exactly the selected task in an owned checkout with the assignment in argv", () => {
  const f = fixture();
  try {
    expect(dispatch(f.load(), f.runtime(), "0001")).toMatchObject([{ id: "0001", action: "dispatched", terminal: "t1", space: "s1" }]);
    const d = deliveryFor(f.task())!;
    expect(d).toMatchObject({ runtime: "desktop", terminal: "t1", space: "s1", state: "submitted", process_id: 101 });
    expect(d.pane_id).toBeUndefined();
    const launch = f.calls.find(call => call.method === "terminal.run")!.params;
    expect(launch.argv).toContain("--no-daemon");
    const trust = (launch.argv as string[]).find(arg => arg.startsWith("projects="))!;
    expect(Bun.TOML.parse(trust)).toEqual({ projects: { [launch.cwd]: { trust_level: "trusted" } } });
    expect(launch.argv.at(-1)).toContain(`claim 0001 --delivery ${d.id}`);
    expect(launch.argv.at(-1)).toContain(f.root);
    expect(launch.cwd).not.toBe(f.root);
    expect(git(launch.cwd, "branch", "--show-current")).toBe("feat/0001-feature");
    expect(launch.labels).toMatchObject({ "team.task": "0001", "team.owner_space": "s1", "team.delivery": d.id });
    expect(launch.labels["herdr.space"]).not.toBe("s1");
    expect(showDesktopBinding(f.client, launch.labels["herdr.space"])).toMatchObject({ root: realpathSync(f.root), space: "s1", view_space: launch.labels["herdr.space"], task: "0001", checkout: launch.cwd });
    expect(launch.env.HERDR_TEAM_TASK_ID).toBe("0001");
    expect(f.task("0002").status).toBe("todo"); expect(deliveryFor(f.task("0002"))).toBeUndefined();
    expect(() => dispatch(f.load(), f.runtime(), "0001")).toThrow("only todo");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("Desktop shares one workspace per feature, serializes assignments and cleans only the merged feature", () => {
  const f = fixture();
  try {
    const config = "herdr-preview.json";
    writeFileSync(join(f.root, config), JSON.stringify({ argv: ["tauri", "dev"], kind: "desktop", tauriBeforeDev: "bun run web:dev --port $PORT" }));
    git(f.root, "add", config); git(f.root, "commit", "-qm", "Configure preview");
    for (const id of ["0003", "0004"]) writeTask(f.root, `${id}-metrics`, taskMeta());
    for (const id of ["0001", "0002", "0003", "0004"]) {
      writeTaskMeta(f.load(), f.task(id), { feature: Number(id) < 3 ? "search" : "metrics", iteration: "v1.2", handoff: id === "0001" ? ["qa"] : [] });
    }
    for (const id of ["0001", "0002", "0003", "0004"]) dispatch(f.load(), f.runtime(), id);
    const workers = () => f.terminals.filter(t => t.labels["team.session"] === "task");
    expect(workers().map(t => t.labels["team.task"])).toEqual(["0001", "0003"]);
    expect(deliveryFor(f.task("0002"))?.reason).toContain("processing #0001");
    expect(deliveryFor(f.task("0004"))?.reason).toContain("processing #0003");
    const [first, other] = workers();
    expect(first!.cwd).not.toBe(other!.cwd);
    expect(git(first!.cwd, "branch", "--show-current")).toBe("feature/v1.2/search");
    expect(showDesktopBinding(f.client, first!.labels["herdr.space"]!)).toMatchObject({ feature: "search@v1.2", checkout: first!.cwd });
    const binding = showDesktopBinding(f.client, "s1")!;
    const search = { feature: "search", iteration: "v1.2" }, metrics = { ...search, feature: "metrics" };
    const searchPreview = queueFeaturePreview(f.load(), search), metricsPreview = queueFeaturePreview(f.load(), metrics);
    const reconcile = () => reconcileFeaturePreviews(f.load(), f.client, binding);
    reconcile(); reconcile();
    expect(searchPreview.port).not.toBe(metricsPreview.port);
    const previews = f.terminals.filter(t => t.labels["team.session"] === "preview");
    expect(previews).toHaveLength(2);
    const [metricsTerminal, searchTerminal] = previews;
    expect(searchTerminal!.cwd).toBe(first!.cwd);
    const configFor = (terminal: DesktopTerminal) => JSON.parse(terminal.argv.at(-1)!);
    expect(configFor(searchTerminal!).identifier).not.toBe(configFor(metricsTerminal!).identifier);
    expect(configFor(searchTerminal!).build.devUrl).toBe(`http://127.0.0.1:${searchPreview.port}`);
    writeFileSync(join(first!.cwd, "search.txt"), "search\n");
    git(first!.cwd, "add", "search.txt"); git(first!.cwd, "commit", "-qm", "Implement search");
    const sha = git(first!.cwd, "rev-parse", "HEAD");
    const settle = (worker: DesktopTerminal) => {
      worker.status = { app: basename(worker.argv[0]!), state: "done" };
      worker.foreground = { cwd: worker.cwd, argv: worker.argv, pid: worker.pid! };
      worker.turn = 1;
    };
    f.claim("0001", first);
    handoff(f.load(), f.runtime(first), "0001", new Date(), { delivery: deliveryFor(f.task())!.id, commit: sha });
    const reviewer = workers().at(-1)!;
    expect(reviewer.cwd).toBe(first!.cwd);
    settle(first!);
    f.claim("0001", reviewer);
    handoff(f.load(), f.runtime(reviewer), "0001", new Date(), { delivery: deliveryFor(f.task())!.id, accept: sha, summary: "Validated" });
    expect(f.task().status).toBe("done");
    expect(deliveryFor(f.task("0002"))?.state).toBe("queued");
    settle(reviewer);
    pumpQueue(f.load(), f.runtime());
    const next = workers().at(-1)!;
    expect(next.labels["team.task"]).toBe("0002");
    expect(next.cwd).toBe(first!.cwd);
    expect(next.labels["herdr.space"]).toBe(first!.labels["herdr.space"]);
    expect(f.runtime().clean("0001")[0]?.action).toBe("retained");
    f.claim("0002", next);
    handoff(f.load(), f.runtime(next), "0002", new Date(), { delivery: deliveryFor(f.task("0002"))!.id, summary: "Final check" });
    settle(next);
    const base = git(f.root, "branch", "--show-current");
    expect(finishFeature(f.load(), "search", "v1.2", { base, commit: sha })).toMatchObject({ commit: sha, tasks: ["0001", "0002"] });
    expect(git(f.root, "merge-base", "HEAD", sha)).toBe(sha);
    reconcile();
    expect(featurePreviewStatus(f.load(), search)).toBeUndefined();
    expect(metricsTerminal!.state).toBe("live");
    const [result] = cleanDesktopTasks(f.load(), f.client, binding, undefined, ["0001", "0002"]);
    expect(result).toMatchObject({ action: "removed" });
    expect(existsSync(first!.cwd)).toBe(false);
    expect(existsSync(other!.cwd)).toBe(true);
    expect(other!.state).toBe("live");
  } finally { f.cleanup(); }
});

test("a feature assignment to the resident lead waits for Core idle and stays in the project Space", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    writeTaskMeta(f.load(), f.task(), { role: "lead", feature: "search", iteration: "v1.2" });
    const lead = desktopUp(f.load(), f.client).roles.find(role => role.role === "lead")!;
    const terminal = f.terminals.find(item => item.address === lead.terminal)!;
    terminal.status = { app: "codex", state: "done" };
    expect(dispatch(f.load(), f.runtime(), "0001")).toMatchObject([{ action: "queued" }]);
    expect(deliveryFor(f.task())).toMatchObject({ state: "queued", reason: "Waiting for Core to report idle" });
    expect(f.calls.some(call => call.method === "terminal.send")).toBe(false);
    terminal.status = { app: "codex", state: "idle" };
    expect(pumpQueue(f.load(), f.runtime())).toMatchObject([{ state: "submitted" }]);
    expect(f.calls.filter(call => call.method === "terminal.send")).toMatchObject([{ params: { terminal: terminal.address, if: "idle" } }]);
    expect(f.terminals.filter(item => item.labels["team.role"] === "lead")).toHaveLength(1);
    expect(deliveryFor(f.task())?.terminal).toBe(terminal.address);
    expect(terminal.labels["herdr.space"]).toBe("s1");
    expect(desktopWorktrees(f.root).some(tree => tree.branch === "feature/v1.2/search")).toBe(true);
    f.claim("0001", terminal);
  } finally { f.cleanup(); }
});

test("a resident reporting done uses the advertised atomic Core guard", () => {
  const f = fixture({ doneGuard: true, started: true });
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    writeTaskMeta(f.load(), f.task(), { role: "lead" });
    const lead = desktopUp(f.load(), f.client).roles.find(role => role.role === "lead")!;
    const terminal = f.terminals.find(item => item.address === lead.terminal)!;
    terminal.status = { app: "codex", state: "done" };
    expect(dispatch(f.load(), f.runtime(), "0001")).toMatchObject([{ action: "dispatched" }]);
    expect(deliveryFor(f.task())).toMatchObject({ state: "submitted", terminal: terminal.address });
    expect(f.calls.filter(call => call.method === "terminal.send")).toMatchObject([{ params: { terminal: terminal.address, if: "done" } }]);
    expect(f.claim("0001", terminal).duplicate).toBe(false);
    expect(f.terminals.filter(item => item.labels["team.role"] === "lead")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("an unconfirmed Core send holds later deliveries without resending the first", () => {
  const f = fixture({ started: false });
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    for (const id of ["0001", "0002"]) writeTaskMeta(f.load(), f.task(id), { role: "lead" });
    const lead = desktopUp(f.load(), f.client).roles.find(role => role.role === "lead")!;
    const terminal = f.terminals.find(item => item.address === lead.terminal)!;
    terminal.status = { app: "codex", state: "idle" };
    expect(dispatch(f.load(), f.runtime(), "0001")).toMatchObject([{ action: "uncertain", reason: CORE_START_UNCONFIRMED }]);
    const first = deliveryFor(f.task())!;
    expect(first).toMatchObject({ state: "uncertain", terminal: terminal.address });
    expect(dispatch(f.load(), f.runtime(), "0002")).toMatchObject([{ action: "queued", reason: "Waiting to reconcile delivery #0001" }]);
    expect(f.calls.filter(call => call.method === "terminal.send")).toHaveLength(1);
    expect(f.claim("0001", terminal)).toMatchObject({ delivery: first.id, duplicate: false });
  } finally { f.cleanup(); }
});

test("Desktop up and delivery share a private project proxy snapshot; roles override both spellings", () => {
  const f = fixture();
  try {
    const inherited = "http://127.0.0.1:9500", override = "http://127.0.0.1:9600";
    const proxyEnv = readProxyEnv({ https_proxy: inherited, HTTPS_PROXY: inherited, no_proxy: "localhost", CUSTOM_TOKEN: "private" });
    expect(proxyEnv).toEqual({ https_proxy: inherited, HTTPS_PROXY: inherited, no_proxy: "localhost" });
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    writeRole(f.root, "dev", { kind: "codex", worktree: true, env: { HTTPS_PROXY: override } });
    const project = f.load();
    const { binding } = registerDaemonTeam(project, () => {
      const result = desktopUp(project, f.client, { proxyEnv });
      return { result, team: makeDaemonTeam(project, "desktop", "core-test", result.binding.space, proxyEnv) };
    });
    const registration = readDaemonTeam(projectKey(project))!;
    expect(registration.proxyEnv).toEqual(proxyEnv);
    expect(registration.env).not.toHaveProperty("https_proxy");
    const lead = f.terminals.find(terminal => terminal.labels["team.role"] === "lead")!;
    dispatch(project, desktopTaskRuntime(project, f.client, lead, {
      registeredSpace: binding.space, proxyEnv: registration.proxyEnv,
    }), "0001");
    const launches = f.calls.filter(call => call.method === "terminal.run");
    expect(launches[0]!.params.env).toMatchObject(proxyEnv);
    expect(launches[1]!.params.env).toMatchObject({ HTTPS_PROXY: override, no_proxy: "localhost" });
    expect(launches[1]!.params.env).not.toHaveProperty("https_proxy");
    expect(launches[1]!.params.env).not.toHaveProperty("CUSTOM_TOKEN");
    registerDaemonTeam(project, () => ({
      result: undefined, team: makeDaemonTeam(project, "desktop", "core-test", binding.space, {}),
    }));
    expect(readDaemonTeam(projectKey(project))?.proxyEnv).toEqual({});
  } finally { f.cleanup(); }
});

test("Desktop up starts its own resident when the old terminal runs a shell", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    const original = desktopUp(f.load(), f.client).roles.find(role => role.role === "lead")!;
    const old = f.terminals.find(terminal => terminal.address === original.terminal)!;
    old.argv = ["/bin/zsh", "-l"];
    old.foreground = { argv: ["codex"], cwd: f.root, pid: 900 };
    old.labels["personal"] = "keep";
    const oldProcess = old.pid;
    const oldName = old.name;
    const { roles } = desktopUp(f.load(), f.client);
    const replacement = roles.find(role => role.role === "lead")!;
    expect(replacement.action).toBe("started");
    expect(replacement.terminal).not.toBe(old.address);
    const managed = f.terminals.find(terminal => terminal.address === replacement.terminal)!;
    expect(managed.argv[0]).toBe("/bin/codex");
    expect(managed.argv).toContain("--no-daemon");
    expect(managed).toMatchObject({
      labels: { "team.project": realpathSync(f.root), "team.role": "lead", "team.session": "resident", "herdr.space": "s1" },
    });
    expect(old).toMatchObject({ state: "live", pid: oldProcess, name: oldName, foreground: { pid: 900 } });
    expect(old.labels).toEqual({ "herdr.space": "s1", personal: "keep" });
    expect(f.calls.filter(call => ["terminal.kill", "terminal.send", "app.terminal.park"].includes(call.method))).toEqual([]);
    expect(desktopUp(f.load(), f.client).roles.find(role => role.role === "lead")).toMatchObject({
      action: "reused", terminal: replacement.terminal,
    });
  } finally { f.cleanup(); }
});

test("Desktop down stops resident and task agents, preserves task work and ignores unrelated terminals", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    const { binding } = desktopUp(f.load(), f.client);
    dispatch(f.load(), f.runtime(), "0001");
    const [, lead, dev] = f.terminals;
    const project = f.load(), task = f.task();
    const worktrees = desktopWorktrees(f.root);
    f.terminals.push(
      { ...lead!, address: "foreign", labels: { ...lead!.labels, "team.owner_space": "elsewhere" } },
      { ...dev!, address: "moved", labels: { ...dev!.labels, "herdr.space": "elsewhere" } },
      { ...dev!, address: "remote/t2" },
      { ...dev!, address: "recovered", argv: ["/bin/zsh"] },
    );
    registerDaemonTeam(project, () => ({ result: undefined, team: {
      root: binding.root, kind: "desktop", endpoint: "core-test", space: binding.space, env: {},
    } }));
    const privateHome = join(f.root, ".herdr", "demo", "service");
    const privateTeams = join(privateHome, "teams");
    const registration = readDaemonTeam(projectKey(project))!;
    mkdirSync(privateTeams, { recursive: true });
    writeFileSync(join(privateTeams, `${projectKey(project)}.json`), JSON.stringify(registration));
    // Older Desktop down only paused delivery. A second down must still stop agents.
    pauseDaemonTeam(project, "desktop", "core-test", binding.space, () => {});
    expect(readDaemonTeam(projectKey(project), false, privateHome)).toEqual(registration);
    const result = pauseDaemonTeam(project, "desktop", "core-test", binding.space, paused => {
      expect(paused).toBe(true);
      return desktopDown(project, f.client, binding, f.caller.address);
    }, privateHome);
    expect(readDaemonTeam(projectKey(project), true, privateHome)?.enabled).toBe(false);
    expect(result.stopped).toEqual([{ role: "lead", terminal: lead!.address }, { role: "dev", terminal: dev!.address }]);
    expect(result.skipped).toMatchObject([{ terminal: "recovered" }]);
    expect(result.failed).toEqual([]);
    expect(f.calls.filter(call => call.method === "terminal.kill").map(call => call.params.terminal)).toEqual([lead!.address, dev!.address]);
    expect(f.terminals.filter(terminal => terminal.state === "live").map(terminal => terminal.address))
      .toEqual([f.caller.address, "foreign", "moved", "remote/t2", "recovered"]);
    expect(f.task()).toEqual(task);
    expect(desktopWorktrees(f.root)).toEqual(worktrees);
    expect(showDesktopBinding(f.client, binding.space)).toEqual(binding);
    expect(desktopDown(f.load(), f.client, binding, f.caller.address).stopped).toEqual([]);
  } finally { f.cleanup(); }
});

test("Desktop down reports an unconfirmed stop, keeps its caller alive, and can be retried", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    const { binding } = desktopUp(f.load(), f.client);
    dispatch(f.load(), f.runtime(), "0001");
    const [, lead, dev] = f.terminals;
    const rpc = f.client.rpc;
    f.client.rpc = <T>(method: string, params: Record<string, unknown>): T => {
      if (method === "terminal.kill" && params.terminal === dev!.address) throw new DesktopError("Core unavailable");
      return rpc<T>(method, params);
    };
    const result = desktopDown(f.load(), f.client, binding, lead!.address);
    expect(result.failed).toMatchObject([{ terminal: lead!.address, reason: expect.stringContaining("Run down from a shell") },
      { terminal: dev!.address, reason: "Core unavailable" }]);
    expect(f.calls.some(call => call.method === "terminal.kill" && call.params.terminal === lead!.address)).toBe(false);
    f.client.rpc = rpc;
    expect(desktopDown(f.load(), f.client, binding, f.caller.address).stopped).toHaveLength(2);
  } finally { f.cleanup(); }
});

test("Desktop closes only the confirmed feature iteration, preserving shared and resident sessions", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    writeTaskMeta(f.load(), f.task(), { feature: "search", iteration: "v1.1", feature_dispatched: true });
    writeTaskMeta(f.load(), f.task("0002"), { feature: "search", iteration: "v1.2", feature_dispatched: true });
    const { binding } = desktopUp(f.load(), f.client);
    dispatch(f.load(), f.runtime(), "0001");
    dispatch(f.load(), f.runtime(), "0002");
    const [, lead, finished, cancelled] = f.terminals;
    for (const terminal of [finished!, cancelled!]) {
      terminal.turn = 2;
      terminal.foreground = { cwd: terminal.cwd, argv: terminal.argv, pid: terminal.pid! };
    }
    const receipt = deliveryFor(f.task())!.id;
    writeTaskMeta(f.load(), f.task(), { status: "done", delivery: null, completed_deliveries: [receipt] });
    const reconcile = () => closeFinishedDesktopTaskAgents(f.load(), f.client, binding);
    reconcile();
    expect(f.calls.some(call => call.method === "terminal.kill")).toBe(false);
    finished!.status = { app: "codex", state: "done" };
    expect(finished!.labels).toMatchObject({ "team.feature": "search", "team.iteration": "v1.1" });
    reconcile();
    expect(f.calls.some(call => call.method === "terminal.kill")).toBe(false);
    finishFeature(f.load(), "search", "v1.1");
    const otherDelivery = deliveryFor(f.task("0002"))!;
    writeTaskMeta(f.load(), f.task("0002"), { status: "doing",
      delivery: { ...otherDelivery, state: "claimed", terminal: finished!.address, process_id: finished!.pid } });
    reconcile();
    expect(f.calls.some(call => call.method === "terminal.kill")).toBe(false);
    writeTaskMeta(f.load(), f.task("0002"), { status: "cancelled", delivery: null });
    cancelled!.status = { app: "codex", state: "idle" };
    f.terminals.push(
      { ...finished!, address: "unrelated", labels: { ...finished!.labels, "team.owner_space": "different" } },
      { ...finished!, address: "unreceipted", labels: { ...finished!.labels, "team.delivery": "not-completed" } },
      { ...finished!, address: "recovered", foreground: { ...finished!.foreground!, pid: 777 } },
      { ...finished!, address: "foreign/t1" },
    );
    const rpc = f.client.rpc;
    f.client.rpc = <T>(method: string, params: Record<string, unknown>): T => {
      const result = rpc<T>(method, params);
      if (method === "terminal.get" && params.terminal === finished!.address) {
        (result as DesktopTerminal).turn = finished!.turn! + 1;
      }
      return result;
    };
    const tasks = f.load().tasks, worktrees = desktopWorktrees(f.root);
    f.calls.length = 0;
    reconcile();
    expect(f.calls.filter(call => call.method === "terminal.kill")).toEqual([]);
    f.client.rpc = rpc;
    reconcile();
    reconcile();
    expect(f.calls.filter(call => call.method === "terminal.kill").map(call => call.params.terminal)).toEqual([finished!.address]);
    expect(cancelled!.state).toBe("live");
    finishFeature(f.load(), "search", "v1.2");
    reconcile();
    expect(f.calls.filter(call => call.method === "terminal.kill").map(call => call.params.terminal)).toEqual([finished!.address, cancelled!.address]);
    expect(f.calls.some(call => call.method === "terminal.send")).toBe(false);
    expect(lead!.state).toBe("live");
    expect(f.load().tasks).toEqual(tasks);
    expect(desktopWorktrees(f.root)).toEqual(worktrees);
  } finally { f.cleanup(); }
});

test("Desktop starts configured resident roles and requires a delivery scope for temporary roles", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", lifecycle: "resident" });
    writeRole(f.root, "qa", { kind: "claude", lifecycle: "resident", worktree: true });
    writeRole(f.root, "dev", { kind: "codex", lifecycle: "temporary", worktree: false });
    const { roles } = desktopUp(f.load(), f.client);
    expect(roles.map(role => [role.role, role.action])).toEqual([["dev", "deferred"], ["lead", "started"], ["qa", "started"]]);
    expect(() => dispatch(f.load(), f.runtime(), "0001")).toThrow("needs a feature and iteration");
    expect(deliveryFor(f.task())).toBeUndefined();
    writeTaskMeta(f.load(), f.task(), { role: "qa" });
    const qa = f.terminals.find(terminal => terminal.labels["team.role"] === "qa")!;
    qa.status = { state: "idle", app: "claude" };
    expect(dispatch(f.load(), f.runtime(), "0001")[0]?.action).toBe("dispatched");
    expect(deliveryFor(f.task())?.terminal).toBe(qa.address);
    expect(qa.labels["team.session"]).toBe("resident");
    expect(desktopWorktrees(f.root)).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("Desktop clean removes an owned checkout, task terminal and native space and retains the branch", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001");
    const worker = f.terminals[1]!;
    const child = worker.labels["herdr.space"]!;
    writeFileSync(join(worker.cwd, "result.txt"), "delivered\n");
    git(worker.cwd, "add", "result.txt");
    git(worker.cwd, "commit", "-qm", "Task result");
    const commit = git(worker.cwd, "rev-parse", "HEAD");
    const branch = git(worker.cwd, "branch", "--show-current");
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "not-terminal" });
    writeTaskMeta(f.load(), f.task(), { status: "done", delivery: null });
    worker.status = { app: "codex", state: "done" };
    worker.foreground = { argv: worker.argv, cwd: worker.cwd, pid: worker.pid! };
    expect(f.runtime().clean()).toMatchObject([{ id: "0001", branch, action: "removed" }]);
    expect(f.terminals).toEqual([f.caller]);
    expect(f.appSpaces.map(space => space.id)).toEqual(["s1"]);
    expect(f.client.rpc<any>("doc.get", {}).value.tasks[child]).toBeUndefined();
    expect(existsSync(worker.cwd)).toBe(false);
    expect(git(f.root, "rev-parse", branch)).toBe(commit);
    expect(f.task().status).toBe("done");
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "absent" });
  } finally { f.cleanup(); }
});

test("Desktop clean preserves ignored files, foreign panes and unconfirmed feature sessions", () => {
  const f = fixture();
  try {
    writeTaskMeta(f.load(), f.task(), { feature: "search", iteration: "v1.2", feature_dispatched: true });
    dispatch(f.load(), f.runtime(), "0001");
    const worker = f.terminals[1]!;
    writeTaskMeta(f.load(), f.task(), { status: "done", completed_deliveries: [deliveryFor(f.task())!.id], delivery: null });
    worker.status = { app: "codex", state: "idle" };
    worker.foreground = { argv: worker.argv, cwd: worker.cwd, pid: worker.pid! };
    const ignored = join(worker.cwd, ".herdr");
    writeFileSync(ignored, "ignored local data");
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "dirty" });
    expect(readFileSync(ignored, "utf8")).toBe("ignored local data");
    unlinkSync(ignored);
    const tab = { terminals: [{ terminal: "unrelated-pane" }] };
    f.appSpaces[1]!.tabs.push(tab);
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "foreign" });
    f.appSpaces[1]!.tabs.pop();
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "retained", note: expect.stringContaining("Confirm feature delivery") });
    expect(worker.state).toBe("live");
    expect(f.calls.some(call => call.method === "terminal.kill")).toBe(false);
    finishFeature(f.load(), "search", "v1.2");
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "removed" });
  } finally { f.cleanup(); }
});

test("forced project purge discards claimed assignments and reclaims their verified Desktop checkout", () => {
  const f = fixture();
  try {
    addRequirement(f.load(), { title: "Improve search", type: "requirement", priority: "P2", iteration: "v1.2", body: "", acceptance: "" });
    dispatch(f.load(), f.runtime(), "0001");
    f.claim();
    const worker = f.terminals[1]!;
    const purge = (dryRun: boolean) => purgeProject(f.load().root, dryRun, true, () => f.client);
    expect(purge(false).blockers).toEqual([expect.stringContaining("still running")]);
    worker.state = "finished";
    const local = join(worker.cwd, "untracked.txt");
    writeFileSync(local, "local data");
    expect(purge(false).blockers).toEqual([expect.stringContaining("modified, untracked or ignored files")]);
    expect(readFileSync(local, "utf8")).toBe("local data");
    unlinkSync(local);
    expect(purge(true)).toMatchObject({ tasks: 2, issues: 1, blockers: [] });
    expect(f.task().meta.delivery).toMatchObject({ state: "claimed" });
    expect(existsSync(worker.cwd)).toBe(true);
    expect(purge(false)).toMatchObject({ tasks: 2, issues: 1, blockers: [] });
    expect(existsSync(worker.cwd)).toBe(false);
    expect(f.terminals).toEqual([f.caller]);
    expect(f.appSpaces.map(space => space.id)).toEqual(["s1"]);
    expect(git(f.root, "branch", "--list", "feat/0001-feature")).toContain("feat/0001-feature");
    expect(purge(true)).toMatchObject({ tasks: 0, issues: 0, blockers: [] });
  } finally { f.cleanup(); }
});

test("Desktop clean keeps the checkout until native space cleanup succeeds and can be retried", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001");
    const worker = f.terminals[1]!;
    worker.state = "finished";
    writeTaskMeta(f.load(), f.task(), { status: "cancelled", delivery: null });
    const close = f.client.closeEmptyTaskSpace;
    f.client.closeEmptyTaskSpace = () => { throw new DesktopError("App unavailable"); };
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "failed", note: expect.stringContaining("App unavailable") });
    expect(f.terminals).toEqual([f.caller]);
    expect(existsSync(worker.cwd)).toBe(true);
    f.client.closeEmptyTaskSpace = close;
    expect(f.runtime().clean("0001")[0]).toMatchObject({ action: "removed" });
    expect(existsSync(worker.cwd)).toBe(false);
    expect(f.appSpaces.map(space => space.id)).toEqual(["s1"]);
  } finally { f.cleanup(); }
});

test("Dispatch pins the inherited feature iteration before the issue can be rescheduled", () => {
  const f = fixture();
  try {
    const issue = addRequirement(f.load(), { title: "Improve search", type: "requirement", priority: "P2",
      iteration: "v1.2", body: "", acceptance: "" });
    writeTaskMeta(f.load(), f.task(), { requirement: issue.id, feature: "search" });
    dispatch(f.load(), f.runtime(), "0001");
    editRequirements(f.load(), [issue.id], { iteration: "v1.3" });
    expect(f.task().meta).toMatchObject({ iteration: "v1.2", feature_dispatched: true });
    expect(f.terminals[1]!.labels).toMatchObject({ "team.feature": "search", "team.iteration": "v1.2" });
    expect(() => editTask(f.load(), "0001", { iteration: "v1.3" }, true)).toThrow("fixed after delivery starts");
    expect(() => finishFeature(f.load(), "search", "v1.3")).toThrow("No tasks found");
  } finally { f.cleanup(); }
});

test("Desktop AgentMail notification uses the bound resident terminal and Core's idle guard", () => {
  const f = fixture();
  try {
    writeRole(f.root, "lead", { kind: "codex", worktree: false });
    const project = f.load(), projectId = projectKey(project).slice(0, 12);
    const inbox = "team@agentmail.to", message = "desktop-test";
    withMailInbox(true, db => storeMail(db, {
      project: projectId, role: "lead", inbox, message_id: message, subject: "Test",
      sender: "test@example.com", received_at: new Date().toISOString(), body: "private message",
    }));
    Object.assign(f.caller.labels, { "team.project": realpathSync(project.root), "team.owner_space": "s1",
      "team.runtime": "desktop", "team.role": "lead", "team.session": "resident" });
    f.caller.status = { state: "working" };
    notifyMail(project, f.runtime(), "s1");
    expect(f.calls.some(call => call.method === "terminal.send")).toBe(false);
    f.caller.status = { state: "idle" };
    notifyMail(project, f.runtime(), "s1");
    const sends = f.calls.filter(call => call.method === "terminal.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.params).toMatchObject({ terminal: "caller", if: "idle" });
    expect(sends[0]!.params.text).toContain(mailId(inbox, message));
    expect(sends[0]!.params.text).not.toContain("private message");
    expect(listMail(projectId, "lead")).toMatchObject([{ state: "notified" }]);
    expect(f.calls.some(call => call.method === "terminal.run")).toBe(false);
    expect(deliveryFor(f.task())).toBeUndefined();
  } finally { f.cleanup(); }
});

test("only the assigned terminal can claim/handoff; explicit handoff reuses the task checkout and preserves Unicode", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001");
    const first = deliveryFor(f.task())!, dev = f.terminals[1]!;
    expect(() => f.claim("0001", f.caller)).toThrow("assigned Core terminal");
    expect(() => handoff(f.load(), f.runtime(f.caller), "0001", new Date(), { delivery: first.id })).toThrow("assigned Core terminal");
    expect(f.claim().duplicate).toBe(false); expect(f.claim().duplicate).toBe(true);
    dev.status = { state: "done" };
    expect(f.task().status).toBe("doing");
    const result = handoff(f.load(), f.runtime(dev), "0001", new Date(), { delivery: first.id, summary: "只读梳理完成；交给验证。" });
    expect(result).toMatchObject({ to: "qa", status: "review", prompted: true });
    const second = deliveryFor(f.task())!;
    expect(second.terminal).not.toBe(first.terminal);
    expect(f.terminals[2]!.cwd).toBe(dev.cwd);
    expect(f.terminals[2]!.labels["herdr.space"]).toBe(dev.labels["herdr.space"]);
    expect(readFileSync(join(f.root, ".herdr", f.task().dir, "task.md"), "utf8")).toContain("只读梳理完成");
    const before = JSON.stringify(f.task().meta);
    expect(handoff(f.load(), f.runtime(dev), "0001", new Date(), { delivery: first.id }).duplicate).toBe(true);
    expect(JSON.stringify(f.task().meta)).toBe(before);
    f.claim();
    const done = handoff(f.load(), f.runtime(f.terminals[2]!), "0001", new Date(), { delivery: second.id, summary: "验证完成" });
    expect(done.status).toBe("done"); expect(done.cleanup?.action).toBe("retained");
    expect(f.calls.some(call => ["terminal.kill", "terminal.remove"].includes(call.method))).toBe(false);
  } finally { f.cleanup(); }
});

test("a lost launch response becomes uncertain and never launches a duplicate automatically", () => {
  const f = fixture();
  try {
    const rpc = f.client.rpc;
    f.client.rpc = (method, params) => { const value = rpc(method, params); if (method === "terminal.run") throw new Error("Connection lost after launch"); return value; };
    expect(dispatch(f.load(), f.runtime(), "0001")[0]!.action).toBe("uncertain");
    expect(f.task().status).toBe("todo");
    expect(queueRows(f.load())[0]!.reason).toContain("Connection lost");
    pumpQueue(f.load(), f.runtime());
    expect(f.terminals).toHaveLength(2);
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("claimed process replacement needs reconciliation and never completes the task", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001"); f.claim();
    f.terminals[1]!.pid = 999;
    pumpQueue(f.load(), f.runtime());
    expect(deliveryFor(f.task())!.state).toBe("uncertain");
    expect(f.task().status).toBe("doing");
  } finally { f.cleanup(); }
});

test("ownership checks reject another space and an existing unowned task branch", () => {
  const f = fixture();
  try {
    f.caller.labels["herdr.space"] = "other";
    expect(() => f.runtime()).toThrow("space");
    expect(deliveryFor(f.task())).toBeUndefined();
    f.caller.labels["herdr.space"] = "s1";
    git(f.root, "branch", "feat/0001-feature");
    expect(dispatch(f.load(), f.runtime(), "0001")[0]).toMatchObject({ action: "queued" });
    expect(queueRows(f.load())[0]!.reason).toContain("without Desktop task ownership");
    expect(f.terminals).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("interrupted checkout creation is preserved and cannot be silently adopted", () => {
  const f = fixture();
  try {
    const file = runtimePath(f.load(), "desktop/tasks/0001.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ root: f.root, space: "s1", repo: f.root, branch: "feat/0001-feature", path: "/missing" }));
    expect(dispatch(f.load(), f.runtime(), "0001")[0]!.action).toBe("queued");
    expect(queueRows(f.load())[0]!.reason).toContain("creation was interrupted");
    expect(f.terminals).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("a repeated role gets a new delivery conversation when the earlier program reports done", () => {
  const f = fixture();
  try {
    writeTaskMeta(f.load(), f.task(), { handoff: ["qa", "dev"] });
    dispatch(f.load(), f.runtime(), "0001");
    const first = deliveryFor(f.task())!; f.claim();
    f.terminals[1]!.status = { state: "done" };
    handoff(f.load(), f.runtime(f.terminals[1]!), "0001", new Date(), { delivery: first.id });
    const second = deliveryFor(f.task())!; f.claim();
    const result = handoff(f.load(), f.runtime(f.terminals[2]!), "0001", new Date(), { delivery: second.id });
    expect(result.prompted).toBe(true);
    expect(f.terminals[3]!.cwd).toBe(f.terminals[1]!.cwd);
    expect(f.terminals[3]!.address).not.toBe(first.terminal);
    expect(f.terminals[1]!.labels["team.delivery"]).toBe(first.id);
    expect(f.calls.some(call => call.method === "terminal.send")).toBe(false);
  } finally { f.cleanup(); }
});

test("a busy receiving role stays queued and drains with an atomic idle guard", () => {
  const f = fixture();
  try {
    writeTaskMeta(f.load(), f.task(), { handoff: ["qa", "dev"] });
    dispatch(f.load(), f.runtime(), "0001");
    const first = deliveryFor(f.task())!; f.claim();
    handoff(f.load(), f.runtime(f.terminals[1]!), "0001", new Date(), { delivery: first.id });
    const second = deliveryFor(f.task())!; f.claim();
    const queued = handoff(f.load(), f.runtime(f.terminals[2]!), "0001", new Date(), { delivery: second.id });
    expect(queued.queueState).toBe("queued");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(2);
    f.terminals[1]!.status = { state: "idle" };
    pumpQueue(f.load(), f.runtime());
    expect(deliveryFor(f.task())!.state).toBe("submitted");
    expect(f.calls.find(call => call.method === "terminal.send")!.params.if).toBe("idle");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(2);
  } finally { f.cleanup(); }
});

test("Desktop cannot consume a TUI delivery and dependencies remain unsent", () => {
  const f = fixture();
  try {
    writeTaskMeta(f.load(), f.task(), { depends_on: ["0002"] });
    expect(dispatch(f.load(), f.runtime(), "0001")[0]!.action).toBe("waiting-on-deps");
    expect(f.terminals).toHaveLength(1);
    const d = deliveryFor(f.task())!;
    writeTaskMeta(f.load(), f.task(), { delivery: { id: d.id, role: "dev", state: "queued", phase: "dispatch", queued_at: d.queued_at, pane_id: "w1:p1" } });
    expect(() => pumpQueue(f.load(), f.runtime())).toThrow("another runtime");
    expect(f.terminals).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("commit review uses the shared exact-SHA gate in the existing task checkout", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001"); f.claim();
    const d = deliveryFor(f.task())!, dev = f.terminals[1]!;
    writeFileSync(join(dev.cwd, "feature.txt"), "feature\n");
    git(dev.cwd, "add", "feature.txt"); git(dev.cwd, "commit", "-qm", "Feature");
    const sha = git(dev.cwd, "rev-parse", "HEAD");
    handoff(f.load(), f.runtime(dev), "0001", new Date(), { delivery: d.id, commit: sha }); f.claim();
    const review = deliveryFor(f.task())!, qa = f.terminals[2]!;
    expect(qa.cwd).toBe(dev.cwd);
    expect(() => handoff(f.load(), f.runtime(qa), "0001", new Date(), { delivery: review.id })).toThrow("Review the assigned commit");
    const result = handoff(f.load(), f.runtime(qa), "0001", new Date(), { delivery: review.id, accept: sha, summary: "Validated exact SHA" });
    expect(result.queueState).toBe("merge-queued");
    expect(f.task().meta.integration).toMatchObject({ state: "queued", commit: sha });
    expect(f.task().status).toBe("review");
  } finally { f.cleanup(); }
});

test("native task-space sync migrates a legacy terminal without restarting or rewriting its delivery", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001"); f.claim();
    const terminal = f.terminals[1]!, oldChild = terminal.labels["herdr.space"]!;
    terminal.labels["herdr.space"] = "s1"; f.attach(terminal);
    const registry = f.client.rpc<any>("doc.get", { name: "herdr-team" });
    delete registry.value.tasks[oldChild];
    f.client.rpc("doc.set", { name: "herdr-team", version: registry.version, value: registry.value });
    const before = JSON.stringify(f.task().meta), pid = terminal.pid;
    const result = syncDesktopTaskSpaces(f.load(), f.client, "0001");
    expect(result).toHaveLength(1); expect(result[0]!.space).not.toBe("s1");
    expect(terminal.labels["herdr.space"]).toBe(result[0]!.space);
    expect(terminal.labels["team.owner_space"]).toBe("s1");
    expect(terminal.pid).toBe(pid); expect(terminal.status?.state).toBe("working");
    expect(JSON.stringify(f.task().meta)).toBe(before);
    const labels = f.calls.filter(call => call.method === "terminal.label").length;
    expect(syncDesktopTaskSpaces(f.load(), f.client, "0001")).toEqual(result);
    expect(f.calls.filter(call => call.method === "terminal.label")).toHaveLength(labels);
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(1);
    expect(f.calls.some(call => ["terminal.send", "terminal.kill"].includes(call.method))).toBe(false);
    expect(f.calls.filter(call => call.method === "app.terminal.park")).toHaveLength(1);
    // The same assigned terminal can still use the delivery after its UI space changes.
    expect(f.claim().duplicate).toBe(true);
  } finally { f.cleanup(); }
});

test("a registered task space supports claim before the app attaches its first pane", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001");
    const child = f.terminals[1]!.labels["herdr.space"]!;
    f.appSpaces.splice(f.appSpaces.findIndex(space => space.id === child), 1);
    // An older terminal can still be attached to its verified parent while native layout catches up.
    f.appSpaces[0]!.tabs.push({ terminals: [{ terminal: f.terminals[1]!.address }] });
    expect(f.claim().duplicate).toBe(false);
    const dev = f.terminals[1]!;
    dev.labels["team.task"] = "0002";
    expect(() => f.runtime(dev)).toThrow("bound Desktop space");
  } finally { f.cleanup(); }
});

test("task-space aliases cannot be redirected to another task or parent", () => {
  const f = fixture();
  try {
    dispatch(f.load(), f.runtime(), "0001");
    const child = f.terminals[1]!.labels["herdr.space"]!;
    const registry = f.client.rpc<any>("doc.get", { name: "herdr-team" });
    registry.value.tasks[child].owner_space = "foreign";
    f.client.rpc("doc.set", { name: "herdr-team", version: registry.version, value: registry.value });
    expect(() => showDesktopBinding(f.client, child)).toThrow("Invalid Desktop task space binding");
    expect(() => f.runtime(f.terminals[1]!)).toThrow("Invalid Desktop task space binding");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(1);
  } finally { f.cleanup(); }
});

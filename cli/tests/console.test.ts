import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { acquireConsole, ensureConsole, stopConsole } from "../scripts/lib/runtime/console.ts";
import { runtimePath } from "../scripts/lib/runtime/state.ts";
import { createConsoleEvents, notifyConsoleHerdr } from "../scripts/lib/runtime/console-events.ts";
import { enqueueTasks, needsQueuePass, nextQueueDeadline, pumpQueue } from "../scripts/lib/dispatch/queue.ts";
import { newDelivery, deliveryFor } from "../scripts/lib/dispatch/delivery.ts";
import { writeTaskMeta } from "../scripts/lib/tasks/cards.ts";
import { down, up } from "../scripts/lib/dispatch/launch.ts";
import { mountConsole } from "../scripts/lib/ui/console-view.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { claimCurrent, makeProject, runningWorkspace, taskMeta, twoResidentRoles, writeTask } from "./helpers.ts";

function fixture(run: (root: string, herdr: ReturnType<typeof runningWorkspace>) => void): void {
  const f = makeProject();
  try { twoResidentRoles(f.root); run(f.root, runningWorkspace()); } finally { f.cleanup(); }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Console event did not arrive");
    await Bun.sleep(10);
  }
}

test("task file changes invalidate snapshots; Herdr notices and reports do not reread tasks", async () => {
  const f = makeProject();
  twoResidentRoles(f.root);
  const events = createConsoleEvents(loadProject(f.root));
  let notices = 0;
  const unsubscribe = events.subscribe(() => { notices++; });
  try {
    events.load();
    // Native events from fixture creation may arrive after the watcher attaches.
    await Bun.sleep(250);
    const initial = events.load();
    expect(events.load()).toBe(initial);
    const beforeHerdr = notices;
    notifyConsoleHerdr(); await until(() => notices > beforeHerdr);
    expect(events.load()).toBe(initial);
    writeTask(f.root, "0001-added", taskMeta());
    await until(() => events.load().tasks.length === 1);
    let changed = events.load();
    expect(changed).not.toBe(initial);
    const taskDir = join(f.root, ".herdr/tasks/0001-added");
    writeFileSync(join(taskDir, "replacement"), "title: Atomic edit\npriority: P1\nstatus: todo\nrole: dev\n");
    renameSync(join(taskDir, "replacement"), join(taskDir, ".task.yaml"));
    await until(() => events.load().tasks[0]?.title === "Atomic edit");
    rmSync(taskDir, { recursive: true });
    await until(() => events.load().tasks.length === 0);
    changed = events.load();
    mkdirSync(join(f.root, ".herdr/reports"), { recursive: true });
    writeFileSync(join(f.root, ".herdr/reports/report.md"), "Output only");
    await Bun.sleep(180);
    expect(events.load()).toBe(changed);
    expect(events.load(true)).not.toBe(changed);
    const before = notices;
    stopConsole(loadProject(f.root)); // No owner: no stop notice is written.
    const lease = acquireConsole(loadProject(f.root));
    stopConsole(loadProject(f.root));
    await until(() => notices > before);
    expect(lease.stopped()).toBe(true); lease.close();
  } finally { unsubscribe(); events.close(); f.cleanup(); }
});

test("native events wake queued work when a busy receiver becomes idle without task edits", async () => {
  const f = makeProject();
  twoResidentRoles(f.root); writeTask(f.root, "0001-event", taskMeta());
  const h = runningWorkspace(); h.state.agents[0]!.agent_status = "working";
  h.state.agents[0]!.tokens = { ...h.state.agents[0]!.tokens, team_role: "dev", team_task_id: "0001" };
  enqueueTasks(loadProject(f.root), "0001");
  const events = createConsoleEvents(loadProject(f.root));
  const screen = await createTestRenderer({ width: 100, height: 30 });
  const app = mountConsole(screen.renderer, { initial: events.load(), load: events.load, herdr: h,
    subscribe: events.subscribe, intervalMs: 0, showAll: false, nextDeadline: nextQueueDeadline,
    tick: () => { const p = events.load(); if (needsQueuePass(p)) { pumpQueue(p, h); events.invalidate(); } } });
  try {
    expect(deliveryFor(loadProject(f.root).tasks[0]!)?.state).toBe("queued");
    h.state.agents[0]!.agent_status = "idle";
    notifyConsoleHerdr();
    await until(() => deliveryFor(loadProject(f.root).tasks[0]!)?.state === "submitted");
    expect(h.calls.filter(call => call.startsWith("agent prompt"))).toHaveLength(1);
    await Bun.sleep(180);
    expect(h.calls.filter(call => call.startsWith("agent prompt"))).toHaveLength(1);
    claimCurrent(f.root);
    h.state.agents = [];
    notifyConsoleHerdr();
    await until(() => deliveryFor(loadProject(f.root).tasks[0]!)?.state === "uncertain");
  } finally { app.dispose(); events.close(); await screen.dispose(); f.cleanup(); }
});

test("missing watched directories recover and closed readers stop receiving notices", async () => {
  const f = makeProject(); rmSync(join(f.root, ".herdr"), { recursive: true });
  const events = createConsoleEvents(loadProject(f.root));
  let notices = 0; events.subscribe(() => { notices++; });
  try {
    expect(events.load().tasks).toHaveLength(0);
    writeTask(f.root, "0001-recovered", taskMeta());
    expect(events.load().tasks).toHaveLength(1);
    events.close(); const before = notices;
    notifyConsoleHerdr(); await Bun.sleep(180);
    expect(notices).toBe(before);
    expect(() => events.load()).toThrow(/closed/);
  } finally { events.close(); f.cleanup(); }
});

test("Herdr notices are isolated by socket context", async () => {
  const f = makeProject(), previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = join(f.root, "a.sock");
  const a = createConsoleEvents(loadProject(f.root)); a.load();
  let aNotices = 0, bNotices = 0; a.subscribe(() => { aNotices++; });
  process.env.HERDR_SOCKET_PATH = join(f.root, "b.sock");
  const b = createConsoleEvents(loadProject(f.root)); b.load(); b.subscribe(() => { bNotices++; });
  try {
    await Bun.sleep(250); aNotices = 0; bNotices = 0;
    notifyConsoleHerdr(); await until(() => bNotices > 0);
    expect(aNotices).toBe(0);
  } finally {
    a.close(); b.close(); f.cleanup();
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = previous;
  }
});

test("submitted delivery deadlines reconcile without a periodic poll, and timers stop on disposal", async () => {
  const f = makeProject(); twoResidentRoles(f.root); writeTask(f.root, "0001-timeout", taskMeta());
  const p = loadProject(f.root), d = newDelivery("dev", "dispatch", new Date(Date.now() - 59_800));
  writeTaskMeta(p, p.tasks[0]!, { delivery: { ...d, state: "submitted" } });
  const h = runningWorkspace(); let ticks = 0;
  const screen = await createTestRenderer({ width: 100, height: 30 });
  const app = mountConsole(screen.renderer, { initial: loadProject(f.root), load: () => loadProject(f.root), herdr: h,
    intervalMs: 0, showAll: false, nextDeadline: nextQueueDeadline, tick: () => { ticks++; pumpQueue(p, h); } });
  try {
    await until(() => deliveryFor(loadProject(f.root).tasks[0]!)?.state === "uncertain");
    expect(ticks).toBe(2);
    app.dispose(); await Bun.sleep(80);
    expect(ticks).toBe(2);
    expect(h.calls.filter(call => call.startsWith("agent prompt"))).toHaveLength(0);
  } finally { app.dispose(); await screen.dispose(); f.cleanup(); }
});

test("up creates one owned Team Console tab in the project workspace", () => fixture((root, h) => {
  const p = loadProject(root);
  expect(up(p, h).console.action).toBe("started");
  const pane = h.state.panes.find((p) => p.tokens?.team_console_project)!;
  expect(pane.workspace_id).toBe("w1");
  expect(pane.cwd).toBe(root);
  const command = h.calls.find((c) => c.startsWith("pane run"))!;
  expect(command).toContain("console --root");
  const entry = /'([^']+cli\.ts)'/.exec(command)?.[1];
  expect(entry && existsSync(entry)).toBe(true);
  // Fake shell remains at a prompt; starting again must reuse the existing tab.
  ensureConsole(p, h, "w1");
  expect(h.calls.filter((c) => c.startsWith("tab create Team Console"))).toHaveLength(1);
  expect(h.calls.filter((c) => c.startsWith("pane run"))).toHaveLength(1);
  expect(h.calls.filter((c) => c.startsWith("agent prompt"))).toHaveLength(0);
}));

test("a live Console owner is reused, without sending more terminal input", () => fixture((root, h) => {
  const p = loadProject(root);
  const created = ensureConsole(p, h, "w1");
  const oldPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = created.paneId;
  const lease = acquireConsole(p);
  try {
    h.calls.length = 0;
    expect(ensureConsole(p, h, "w1")).toMatchObject({ action: "reused", paneId: created.paneId });
    expect(h.calls).toEqual([]);
    expect(() => acquireConsole(p)).toThrow(/already running/);
    expect(ensureConsole(p, h, "another").action).toBe("failed");
  } finally {
    lease.close();
    if (oldPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = oldPane;
  }
}));

test("Console can restart immediately after its registered owner exits", () => fixture((root, h) => {
  const p = loadProject(root);
  expect(ensureConsole(p, h, "w1").action).toBe("started");
  const lease = acquireConsole(p);
  lease.close();
  expect(ensureConsole(p, h, "w1").action).toBe("started");
  expect(h.calls.filter((call) => call.startsWith("pane run"))).toHaveLength(2);
  expect(h.calls.filter((call) => call.startsWith("tab create Team Console"))).toHaveLength(1);
}));

test("a busy Console pane is never overwritten", () => fixture((root, h) => {
  const p = loadProject(root);
  ensureConsole(p, h, "w1");
  h.paneIsShell = () => false;
  writeFileSync(runtimePath(p, "console-launch.json"), "{}");
  h.calls.length = 0;
  expect(ensureConsole(p, h, "w1", () => {})).toMatchObject({ action: "failed", failure: expect.stringContaining("busy") });
  expect(h.calls).toEqual([]);
}));

test("a stopped Console releases ownership; a fresh owner ignores the old stop request", () => fixture((root) => {
  const p = loadProject(root);
  const first = acquireConsole(p);
  expect(first.stopped()).toBe(false);
  stopConsole(p);
  expect(first.stopped()).toBe(true);
  first.close();
  const second = acquireConsole(p);
  try { expect(second.stopped()).toBe(false); } finally { second.close(); }
}));

test("dead Console owners can be recovered without signalling a process", () => fixture((root) => {
  const p = loadProject(root);
  const lease = acquireConsole(p);
  lease.close();
  writeFileSync(runtimePath(p, "console.json"), JSON.stringify({ pid: 2147483647, nonce: "old" }));
  const recovered = acquireConsole(p);
  recovered.close();
}));

test("down requests a graceful Console stop before closing agents", () => fixture((root, h) => {
  const p = loadProject(root), lease = acquireConsole(p);
  try {
    const close = h.paneClose;
    h.paneClose = (id) => { expect(lease.stopped()).toBe(true); close(id); };
    expect(down(p, h).stopped).toHaveLength(2);
  } finally { lease.close(); }
}));

test("Console drives queued delivery and restores the terminal when quitting", async () => {
  const f = makeProject();
  try {
    twoResidentRoles(f.root);
    writeTask(f.root, "0001-a", taskMeta());
    const p = loadProject(f.root), h = runningWorkspace();
    enqueueTasks(p);
    const screen = await createTestRenderer({ width: 120, height: 45 });
    try {
      mountConsole(screen.renderer, { initial: p, load: () => loadProject(f.root), herdr: h,
        intervalMs: 0, showAll: false,
        tick: () => { pumpQueue(loadProject(f.root), h); } });
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Team Console");
      screen.mockInput.pressKey("q");
      await screen.renderer.closed;
      expect(screen.renderer.isDestroyed).toBe(true);
    } finally { await screen.dispose(); }
    expect(h.calls.filter((c) => c.startsWith("agent prompt"))).toHaveLength(1);
  } finally { f.cleanup(); }
});


test("Console startup waits for transient shell initialization before sending one command", () => fixture((root, h) => {
  const p = loadProject(root);
  let checks = 0, waits = 0;
  h.paneIsShell = () => ++checks >= 4;
  const result = ensureConsole(p, h, "w1", (ms) => { expect(ms).toBe(100); waits++; });
  expect(result.action).toBe("started");
  expect(waits).toBe(3);
  expect(h.calls.filter((call) => call.startsWith("pane run"))).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("agent prompt"))).toHaveLength(0);
}));

test("Console startup has a bounded wait and reports the occupied pane without injecting input", () => fixture((root, h) => {
  let checks = 0, waits = 0;
  h.paneIsShell = () => { checks++; return false; };
  const result = ensureConsole(loadProject(root), h, "w1", () => { waits++; });
  expect(result.action).toBe("failed");
  expect(result.failure).toContain("Team Console pane w1:");
  expect(waits).toBe(20);
  expect(checks).toBe(21);
  expect(h.calls.some((call) => call.startsWith("pane run"))).toBe(false);
}));

test("console --sample works outside a team and Herdr without touching project or runtime files", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-console-sample-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const marker = join(root, "herdr-was-called");
    const herdr = join(bin, "herdr");
    writeFileSync(herdr, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, 'unexpected'); process.exit(1);\n`);
    chmodSync(herdr, 0o755);
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "console", "--sample", ...args], {
      cwd: root, env: { ...process.env, HERDR_ENV: "0", HERDR_PLUGIN_STATE_DIR: join(root, "state"), PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    const result = cli("--once");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("SAMPLE");
    expect(result.stdout.toString()).toContain("0083");
    expect(result.stdout.toString()).not.toContain("\x1b");
    expect(result.stderr.toString()).toBe("");
    expect(cli("--line").exitCode).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root)).toEqual(["bin"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

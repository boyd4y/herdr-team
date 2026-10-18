import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { loadProject } from "../scripts/lib/team/project.ts";
import { acquireConsole, ensureConsole, stopConsole } from "../scripts/lib/runtime/console.ts";
import { runtimePath } from "../scripts/lib/runtime/state.ts";
import { enqueueTasks, pumpQueue } from "../scripts/lib/dispatch/queue.ts";
import { down, up } from "../scripts/lib/dispatch/launch.ts";
import { mountConsole } from "../scripts/lib/ui/console-view.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { makeProject, runningWorkspace, taskMeta, twoResidentRoles, writeTask } from "./helpers.ts";

function fixture(run: (root: string, herdr: ReturnType<typeof runningWorkspace>) => void): void {
  const f = makeProject();
  try { twoResidentRoles(f.root); run(f.root, runningWorkspace()); } finally { f.cleanup(); }
}

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
        intervalMs: 0, intervalSeconds: 2, showAll: false,
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

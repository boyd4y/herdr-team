import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { deliveryFor, newDelivery } from "../scripts/lib/dispatch/delivery.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { dispatch } from "../scripts/lib/dispatch/launch.ts";
import { claimTask, enqueueTasks, flushTaskHistory, pumpQueue, queueRows, retryDelivery } from "../scripts/lib/dispatch/queue.ts";
import { editTask, writeTaskMeta } from "../scripts/lib/tasks/cards.ts";
import { claimCurrent, makeProject, runningWorkspace, taskMeta, twoResidentRoles, writeTask } from "./helpers.ts";

function fixture(run: (f: ReturnType<typeof setup>) => void): void {
  const f = setup();
  try { run(f); } finally { f.cleanup(); }
}
function setup() {
  const p = makeProject();
  twoResidentRoles(p.root);
  writeTask(p.root, "0001-a", taskMeta({ handoff: ["docs", "dev"] }));
  writeTask(p.root, "0002-b", taskMeta());
  const herdr = runningWorkspace();
  // Existing task sessions, distinct from any resident conversation tabs.
  herdr.state.agents[0]!.tokens = { ...herdr.state.agents[0]!.tokens, team_role: "dev", team_task_id: "0001" };
  herdr.state.agents[1]!.tokens = { ...herdr.state.agents[1]!.tokens, team_role: "docs", team_task_id: "0001" };
  const load = () => loadProject(p.root);
  const task = (id = "0001") => load().tasks.find((t) => t.id === id)!;
  const prompts = () => herdr.calls.filter((c) => c.startsWith("agent prompt"));
  return { ...p, herdr, load, task, prompts };
}

test("only explicitly enqueued cards are scheduled", () => fixture((f) => {
  expect(pumpQueue(f.load(), f.herdr)).toEqual([]);
  expect(f.prompts()).toEqual([]);
  enqueueTasks(f.load(), "0002");
  expect(pumpQueue(f.load(), f.herdr)).toMatchObject([{ id: "0002", state: "submitted" }]);
  expect(f.task().meta.delivery).toBeUndefined();
}));

test.each(["working", "blocked", "unknown"])("busy receiver %s waits on disk, then drains when idle", (status) => fixture((f) => {
  f.herdr.state.agents[0]!.agent_status = status;
  expect(dispatch(f.load(), f.herdr, "0001")[0]!.action).toBe("queued");
  const id = deliveryFor(f.task())!.id;
  enqueueTasks(f.load(), "0001");
  expect(deliveryFor(f.task())!.id).toBe(id);
  expect(f.prompts()).toHaveLength(0);
  f.herdr.state.agents[0]!.agent_status = "idle";
  expect(pumpQueue(loadProject(f.root), f.herdr)).toMatchObject([{ state: "submitted" }]);
  expect(deliveryFor(f.task())!.id).toBe(id);
}));

test("a claimed task session does not hold the role for other tasks", () => fixture((f) => {
  dispatch(f.load(), f.herdr);
  const first = claimCurrent(f.root);
  pumpQueue(f.load(), f.herdr);
  expect(deliveryFor(f.task("0002"))!.state).toBe("submitted");
  expect(f.prompts()).toHaveLength(2);
  const result = handoff(f.load(), f.herdr, "0001", new Date(), { delivery: first, summary: "Implementation complete" });
  expect(result.to).toBe("docs");
  // The released dev role and the docs handoff both remain durable; one send per pump.
  pumpQueue(f.load(), f.herdr);
  expect(deliveryFor(f.task("0002"))!.state).toBe("submitted");
  expect(deliveryFor(f.task())!.state).toBe("submitted");
  const before = readFileSync(join(f.root, ".herdr/tasks/0001-a/.task.yaml"), "utf8");
  expect(handoff(f.load(), f.herdr, "0001", new Date(), { delivery: first }).duplicate).toBe(true);
  expect(readFileSync(join(f.root, ".herdr/tasks/0001-a/.task.yaml"), "utf8")).toBe(before);
}));

test("handoff requires the exact claimed delivery, and a queued receiver cannot finish early", () => fixture((f) => {
  dispatch(f.load(), f.herdr, "0001");
  const d = deliveryFor(f.task())!;
  expect(() => handoff(f.load(), f.herdr, "0001", new Date(), { delivery: d.id })).toThrow(/Claim/);
  expect(() => claimTask(f.load(), "0001", "stale")).toThrow(/Stale/);
  claimCurrent(f.root);
  f.herdr.state.agents[1]!.agent_status = "working";
  handoff(f.load(), f.herdr, "0001", new Date(), { delivery: d.id });
  const next = deliveryFor(f.task())!;
  expect(next.state).toBe("queued");
  expect(() => claimTask(f.load(), "0001", next.id)).toThrow(/queued/);
  expect(f.task().handoff).toEqual(["dev"]);
}));

test.each(["sending", "submitted"])("restart reconciles an old %s delivery without resending", (state) => fixture((f) => {
  const now = new Date("2026-10-17T00:00:00Z");
  writeTaskMeta(f.load(), f.task(), { delivery: { ...newDelivery("dev", "dispatch", now), state, sent_at: now.toISOString() } });
  pumpQueue(f.load(), f.herdr, new Date(now.getTime() + 61_000));
  expect(deliveryFor(f.task())!.state).toBe("uncertain");
  expect(f.prompts()).toHaveLength(0);
  claimTask(f.load(), "0001", deliveryFor(f.task())!.id);
  expect(f.task().status).toBe("doing");
}));

test("a claimed agent that disappears requires reconciliation; retry uses a new token", () => fixture((f) => {
  dispatch(f.load(), f.herdr, "0001");
  const old = claimCurrent(f.root);
  f.herdr.state.agents = [];
  pumpQueue(f.load(), f.herdr);
  expect(deliveryFor(f.task())!.state).toBe("uncertain");
  retryDelivery(f.load(), "0001");
  expect(deliveryFor(f.task())!.id).not.toBe(old);
  expect(() => claimTask(f.load(), "0001", old)).toThrow(/Stale/);
  expect(() => retryDelivery(f.load(), "0001")).toThrow(/Only uncertain/);
}));

test("claimed deliveries reconcile against one agent snapshot per queue pass", () => fixture((f) => {
  f.herdr.state.agents = [];
  for (const id of ["0001", "0002"]) {
    f.herdr.live(`dev-${id}`);
    const pane = f.herdr.state.agents.at(-1)!.pane_id!;
    const project = f.load(), task = project.tasks.find(task => task.id === id)!;
    writeTaskMeta(project, task, { status: "doing", execution: "task",
      delivery: { ...newDelivery("dev", "dispatch", new Date()), state: "claimed", pane_id: pane } });
  }
  let reads = 0;
  const agentList = f.herdr.agentList;
  f.herdr.agentList = () => { reads++; return agentList(); };
  expect(pumpQueue(f.load(), f.herdr)).toEqual([]);
  expect(reads).toBe(2); // One reconciliation snapshot, one fresh sidebar snapshot.
  expect(f.load().tasks.every(task => deliveryFor(task)?.state === "claimed")).toBe(true);
}));

test.each(["cancelled", "reassign"])("%s invalidates an unsent assignment", (action) => fixture((f) => {
  enqueueTasks(f.load(), "0001");
  const old = deliveryFor(f.task())!.id;
  editTask(f.load(), "0001", action === "reassign" ? { role: "docs" } : { status: "cancelled" });
  pumpQueue(f.load(), f.herdr);
  expect(deliveryFor(f.task())).toBeUndefined();
  expect(f.prompts()).toHaveLength(0);
  expect(() => claimTask(f.load(), "0001", old)).toThrow(/Stale/);
}));

test("dependencies delay delivery, priority chooses the next eligible card", () => fixture((f) => {
  writeTask(f.root, "0001-a", taskMeta({ depends_on: ["0002"], priority: "P0" }));
  enqueueTasks(f.load());
  expect(pumpQueue(f.load(), f.herdr)).toMatchObject([{ id: "0001", state: "queued" }, { id: "0002", state: "submitted" }]);
  const d = claimCurrent(f.root, "0002");
  handoff(f.load(), f.herdr, "0002", new Date(), { delivery: d });
  expect(deliveryFor(f.task())!.state).toBe("submitted");
}));

test("pending history survives a restart and replays exactly once", () => fixture((f) => {
  const pending = "- resumed history\n<!-- team-operation:recovery-test -->";
  writeTaskMeta(f.load(), f.task(), { pending_history: pending });
  pumpQueue(f.load(), f.herdr);
  writeTaskMeta(f.load(), f.task(), { pending_history: pending });
  flushTaskHistory(f.load(), f.task());
  expect(f.task().body.match(/resumed history/g)).toHaveLength(1);
  expect(f.task().meta.pending_history).toBeNull();
}));

test("malformed delivery records stop the scheduler before sending", () => fixture((f) => {
  writeTaskMeta(f.load(), f.task(), { delivery: { id: "bad" } });
  expect(() => pumpQueue(f.load(), f.herdr)).toThrow(/delivery/);
  expect(f.prompts()).toHaveLength(0);
}));

test("stop request is rechecked inside the queue lock", () => fixture((f) => {
  enqueueTasks(f.load());
  expect(pumpQueue(f.load(), f.herdr, new Date(), () => true)).toEqual([]);
  expect(queueRows(f.load()).every((r) => r.state === "queued")).toBe(true);
  expect(f.prompts()).toHaveLength(0);
}));

test("concurrent claim processes commit a single acknowledgement", async () => {
  const f = setup();
  try {
    dispatch(f.load(), f.herdr, "0001");
    const id = deliveryFor(f.task())!.id;
    const script = join(f.root, "claim-worker.ts");
    writeFileSync(script, `import { loadProject } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/team/project.ts"))};\nimport { claimTask } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/dispatch/queue.ts"))};\nconsole.log(JSON.stringify(claimTask(loadProject(process.argv[2]), "0001", process.argv[3])));`);
    const results = await Promise.all([1, 2].map(async () => {
      const p = Bun.spawn([process.execPath, script, f.root, id], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return JSON.parse(output).duplicate;
    }));
    expect(results.sort()).toEqual([false, true]);
    expect(deliveryFor(f.task())!.state).toBe("claimed");
  } finally { f.cleanup(); }
});

import { demoContent } from "./content.ts";
import { demoDelay, demoSettings } from "./config.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completedDeliveries, deliveryFor } from "../dispatch/delivery.ts";
import { enqueueTask, shellQuote } from "../dispatch/queue.ts";
import { loadProject } from "../team/project.ts";
import { integrationFor, verifyCheckout } from "../tasks/verification.ts";
import { findTask, writeTaskMeta } from "../tasks/cards.ts";
import type { RoleCard, TaskCard } from "../shared/types.ts";
import { realDesktop, savedDesktopBinding, type DesktopTerminal } from "../runtime/desktop.ts";
import { managedContext } from "../runtime/context.ts";
import { wakeDaemon } from "../runtime/daemon.ts";
import { logDaemon } from "../runtime/daemon-log.ts";
import { desktopTaskRuntime } from "../runtime/desktop-dispatch.ts";
import { checkoutFor } from "../runtime/desktop-worktrees.ts";
import { smokeFixtures, type SmokeScenario } from "./scenario.ts";
import { checkArtifact, command, demoPath, handoffGate, team, teamCommand, type MockRun, type MockTask } from "./shared.ts";

interface Lane {
  label: string;
  slug: string;
  issue: string;
  priority?: TaskCard["priority"];
  rejectOnce?: boolean;
  dependsOn?: string;
}

export const showcaseLanes: Lane[] = [
  { label: "Restore relay sessions on reconnect", slug: "reconnect", issue: "Signal relay continuity", priority: "P1" },
  { label: "Render live signal traces", slug: "traces", issue: "Operator console" },
  { label: "Deduplicate queued signals", slug: "delivery", issue: "Fix duplicate signal deliveries", priority: "P0", rejectOnce: true },
  { label: "Track node health in real time", slug: "health", issue: "Operator console", priority: "P1" },
  { label: "Recover checkpoints after a restart", slug: "checkpoints", issue: "Fix dropped checkpoints", priority: "P1", rejectOnce: true },
  { label: "Ship keyboard navigation for the console", slug: "keyboard", issue: "Operator console" },
  { label: "Build the queue pressure chart", slug: "pressure", issue: "Queue visibility" },
  { label: "Make delivery receipts searchable", slug: "receipts", issue: "Queue visibility" },
  { label: "Record isolation boundaries per checkout", slug: "isolation", issue: "Checkout isolation", priority: "P1" },
  { label: "Summarize alerts on the release board", slug: "alerts", issue: "Operator console" },
  { label: "Replay relay sessions in sequence", slug: "replay", issue: "Signal relay continuity", dependsOn: "reconnect" },
  { label: "Write the signal audit trail", slug: "audit", issue: "Fix duplicate signal deliveries", dependsOn: "delivery" },
  { label: "Show checkpoint age in the activity feed", slug: "checkpoint-age", issue: "Fix dropped checkpoints", dependsOn: "checkpoints" },
  { label: "Verify long-running queue recovery", slug: "queue-recovery", issue: "Queue visibility", priority: "P1" },
  { label: "Reclaim expired sessions", slug: "reclaim", issue: "Checkout isolation" },
  { label: "Report lag across relay nodes", slug: "lag", issue: "Signal relay continuity" },
  { label: "Assemble release verification receipts", slug: "verification", issue: "Night-shift release" },
  { label: "Prepare the night-shift release notes", slug: "release-notes", issue: "Night-shift release" },
];

const roles = [
  { harness: "codex", stage: "dev", responsibility: "Implement the assigned change and run focused checks." },
  { harness: "claude", stage: "test", responsibility: "Verify the submitted commit and report test results." },
  { harness: "grok", stage: "review", responsibility: "Review the verified commit before integration." },
] as const;

interface CleanupRow { id: string; action: string; note: string }

export function installMockRoles(root: string, area: string, serviceHome = process.env.HERDR_TEAM_HOME) {
  const bin = join(area, "mock-bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const entry = fileURLToPath(new URL("task-agent.ts", import.meta.url));
  const shell = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`;
  const existing = team<RoleCard[]>(root, "role", "list", "--details");
  return roles.map(({ harness, stage, responsibility }) => {
    const legacy = existing.find(item => item.name === `demo-${stage}` && item.env?.HERDR_SMOKE_MANIFEST === join(area, "run.json"));
    const role = existing.some(item => item.name === stage) ? stage : legacy?.name ?? stage;
    const old = existing.find(item => item.name === role);
    if (old && old.env?.HERDR_SMOKE_MANIFEST !== join(area, "run.json")) {
      throw new Error(`Role ${role} already belongs to another workflow`);
    }
    const program = join(bin, harness);
    const stat = lstatSync(program, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`The demo launcher is not a regular file: ${program}`);
    if (stat && readFileSync(program, "utf8") !== shell) {
      if (!old) throw new Error(`The demo launcher path is already in use: ${program}`);
      writeFileSync(program, shell, { mode: 0o700 });
    } else if (!stat) writeFileSync(program, shell, { flag: "wx", mode: 0o700 });
    const environment = [`PATH=${demoPath(bin)}`, `HERDR_SMOKE_MANIFEST=${join(area, "run.json")}`,
      `HERDR_SMOKE_STEP=${stage}`, `HERDR_SMOKE_HARNESS=${harness}`];
    if (serviceHome) environment.push(`HERDR_TEAM_HOME=${serviceHome}`);
    team(root, "role", "add", role, "--kind", harness, "--lifecycle", "temporary",
      "--env", environment.join(","),
      "--body", responsibility,
      ...(old ? ["--force"] : []));
    return role;
  });
}

export interface ReleaseOptions {
  area: string;
  version: string;
  fast: boolean;
  lanes: Lane[];
  verifyGuards?: boolean;
  startTeam?: boolean;
  testDirtyCheckout?: boolean;
  scenario?: SmokeScenario;
}

export async function runRelease(root: string, options: ReleaseOptions) {
  const { area, version, fast, lanes, scenario } = options;
  const binding = scenario ? savedDesktopBinding({ root }) : null;
  if (scenario && (lanes.length !== 1 || !binding)) throw new Error("The manual merge smoke requires one task in a bound Desktop project");
  const originalHead = scenario ? command(["git", "rev-parse", "HEAD"], root).stdout : null;
  const expectation = scenario ? smokeFixtures[scenario.fixture].expectation : "The fixture matches its declared contract.";
  const feature = "night-shift-release";
  const before = loadProject(root).tasks;
  if (before.some(task => task.meta.iteration === version) ||
      team<unknown[]>(root, "backlog", "list", "--iteration", version).length) {
    throw new Error(`Choose an unused iteration. ${version} already contains demo work.`);
  }
  const [developer, ...handoff] = installMockRoles(root, area);
  const runtime = options.startTeam ? (() => {
    const enabled = process.env.HERDR_TEAM_DEMO;
    process.env.HERDR_TEAM_DEMO = "0";
    try { team(root, "up"); }
    finally {
      if (enabled === undefined) delete process.env.HERDR_TEAM_DEMO;
      else process.env.HERDR_TEAM_DEMO = enabled;
    }
    const context = managedContext();
    if (context.kind !== "desktop") throw new Error("A Desktop terminal is required for the showcase");
    return desktopTaskRuntime(loadProject(root), realDesktop(), context.caller);
  })() : null;
  const issueByTitle = new Map<string, string>();
  const taskBySlug = new Map<string, string>();
  const tasks: MockTask[] = [];
  for (const lane of lanes) {
    const content = scenario ? undefined : demoContent(lane, version);
    let issue = issueByTitle.get(lane.issue);
    if (!issue) {
      issue = team<{ id: string }>(root, "backlog", "add", lane.issue, "--type",
        lane.issue.startsWith("Fix ") ? "defect" : "requirement",
        "--priority", lane.priority ?? "P2", "--iteration", version, "--body", content?.background ?? expectation, "--acceptance",
        scenario ? expectation : lanes.filter(item => item.issue === lane.issue)
          .map(item => `${item.label}: ${demoContent(item, version).acceptance}`).join("\n\n")).id;
      issueByTitle.set(lane.issue, issue);
    }
    const dependency = lane.dependsOn ? taskBySlug.get(lane.dependsOn) : undefined;
    const task = team<{ id: string }>(root, "add", lane.label, "--role", developer!,
      "--handoff", handoff.join(","), "--requirement", issue,
      "--body", content?.body ?? `${lane.label}\n\n${expectation}`,
      "--feature", feature, "--priority", lane.priority ?? "P2", ...(dependency ? ["--depends-on", dependency] : []));
    // The showcase and its manual merge smoke teach the individual task merge gate.
    const project = loadProject(root);
    writeTaskMeta(project, findTask(project, task.id), { feature_dispatched: true, iteration: version });
    taskBySlug.set(lane.slug, task.id);
    // Workflow purges can reuse iteration names while retaining the integrated Git files.
    const filename = `${version.toLowerCase().replace(/\./g, "-")}-${task.id}-${lane.slug}.ts`;
    tasks.push({ id: task.id, artifact: `demo/${filename}`, ordinal: tasks.length + 1,
      ...(content ? { scenario: content.scenario, scope: content.scope } : {}),
      ...((scenario?.rejectOnce ?? lane.rejectOnce) ? { rejectOnce: true } : {}) });
  }
  const mockRun: MockRun = { root: realpathSync(root), fast, tasks, ...(scenario ? { scenario } : {}) };
  writeFileSync(join(area, "run.json"), JSON.stringify(mockRun, null, 2) + "\n", { mode: 0o600 });
  const ids = new Set(tasks.map(task => task.id));
  const cards = () => loadProject(root).tasks.filter(task => ids.has(task.id));
  if (options.verifyGuards) {
    const firstIssue = issueByTitle.values().next().value!;
    const unfinished = teamCommand(root, ["feature", "finish", feature, "--iteration", version], true);
    const acceptance = teamCommand(root, ["backlog", "accept", firstIssue], true);
    if (unfinished.code === 0 || acceptance.code === 0) throw new Error("An unfinished demo was accepted");
  }

  await demoDelay(root, 3000, fast);
  const schedule = tasks.map((task, index) => ({ id: task.id, after: fast ? 0 : index * 8000 }));

  const dispatched = new Set<string>();
  const deadline = Math.max(fast ? 55_000 : 100_000, tasks.length * (fast ? 5_000 : 120_000));
  let elapsed = 0;
  let lastTick = Date.now();
  let observed: { terminal: string; delivery: string; state: "done" | "blocked" } | undefined;
  for (;;) {
    const snapshot = cards();
    if (snapshot.every(card => card.status === "done")) break;
    const now = Date.now();
    const controls = demoSettings(root);
    if (fast || !controls.paused) elapsed += (now - lastTick) * (fast ? 1 : controls.speed);
    lastTick = now;
    if (!fast && controls.paused) { await Bun.sleep(250); continue; }
    if (elapsed > deadline) {
      throw new Error("The release stalled. Inspect the demo Tasks or Inbox for the current delivery.");
    }
    let slots = (fast ? 9 : controls.concurrency) - snapshot.filter(card => dispatched.has(card.id) && card.status !== "done").length;
    while (slots > 0 && schedule[0] && elapsed >= schedule[0].after) {
      const { id } = schedule.shift()!;
      if (runtime) {
        const project = loadProject(root);
        const queued = enqueueTask(project, id, new Date(), runtime.scope);
        logDaemon("dispatch.result", { project: root, task: id, role: snapshot.find(card => card.id === id)?.role, state: queued.state });
        await wakeDaemon(root);
      } else team(root, "dispatch", id);
      dispatched.add(id);
      slots--;
    }
    for (const card of snapshot) {
      const integration = integrationFor(card);
      const hold = scenario?.hold;
      const delivery = hold && !observed && card.status === "review" && card.role === handoff.at(-1) ? deliveryFor(card) : undefined;
      if (hold && delivery?.state === "claimed" && delivery.terminal) {
        command(["hc", "wait", "--timeout", "8", "--json", delivery.terminal], root);
        const terminal = realDesktop().rpc<DesktopTerminal>("terminal.get", { terminal: delivery.terminal });
        const current = cards().find(task => task.id === card.id);
        const inbox = team<{ id: string; role: string; state: string; delivery?: string }[]>(root, "inbox", "list");
        if (terminal.status?.state !== hold || terminal.labels["team.delivery"] !== delivery.id ||
            current?.status !== "review" || current.role !== card.role || integrationFor(current) ||
            !inbox.some(row => row.id === card.id && row.role === card.role && row.delivery === delivery.id && row.state === "claimed")) {
          throw new Error(`Expected agent ${hold} with the task still in review and the Inbox delivery still claimed`);
        }
        observed = { terminal: terminal.address, delivery: delivery.id, state: hold };
        writeFileSync(handoffGate(area, delivery.id), `Observed ${hold} with the delivery still claimed.\n`, { flag: "wx" });
      }
      if (integration?.state === "blocked") throw new Error(`Merge blocked for #${card.id}: ${integration.reason ?? ""}`);
      if (integration?.state === "queued") {
        if (scenario && binding) {
          const receipts = completedDeliveries(card);
          const checkout = checkoutFor(loadProject(root), binding, card, false);
          verifyCheckout(checkout, integration.commit);
          if ((scenario.hold && (!observed || !receipts.includes(observed.delivery))) ||
              receipts.length !== (scenario.rejectOnce ? 5 : 3) || !checkArtifact(mockRun, tasks[0]!, checkout) ||
              command(["git", "rev-parse", "HEAD"], root).stdout !== originalHead) {
            throw new Error("The smoke reached the merge queue without the expected handoff, tested commit or unchanged main");
          }
          const result = { iteration: version, feature, issues: [...issueByTitle.values()], state: "awaiting-merge",
            tasks: [{ id: card.id, status: card.status, iteration: card.meta.iteration, deliveries: receipts.length }],
            commit: integration.commit, checkout, terminalsReclaimed: 0, scenario, handoffCheckpoint: observed ?? null,
            ...(observed?.state === "done" ? { agentDoneBeforeHandoff: { terminal: observed.terminal, delivery: observed.delivery, checkout } } : {}),
            main: originalHead };
          writeFileSync(join(area, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
          return result;
        }
        team(root, "merge", card.id);
        await demoDelay(root, 3000, fast);
        elapsed += fast ? 0 : 3000;
        lastTick = Date.now();
      }
    }
    await Bun.sleep(fast ? 150 : 350);
  }

  if (scenario) throw new Error("The smoke did not stop at the merge queue");

  for (const task of tasks) {
    if (!checkArtifact(mockRun, task, root)) throw new Error(`Product acceptance failed for #${task.id}`);
  }
  for (const issue of issueByTitle.values()) team(root, "backlog", "accept", issue);
  const core = realDesktop();
  const terminals = () => core.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { all: true,
    labels: { "team.project": mockRun.root, "team.mock": "1", "team.iteration": version } }).terminals;
  const agents = terminals();
  const harnesses = new Set(agents.map(agent => agent.status?.app));
  if (roles.some(role => !harnesses.has(role.harness))) throw new Error("Core did not identify all three mock harnesses");
  await demoDelay(root, 8000, fast);
  team(root, "feature", "finish", feature, "--iteration", version);
  if (fast) await Bun.sleep(450);
  else await demoDelay(root, 8000);
  if (options.testDirtyCheckout) {
    const checkout = agents[0]!.cwd;
    const file = join(checkout, "mock-local-file.txt");
    writeFileSync(file, "Local data must survive the cleanup attempt.\n", { flag: "wx" });
    try {
      const dirty = teamCommand(root, ["feature", "clean", feature, "--iteration", version], true);
      const rows = JSON.parse(dirty.stdout) as CleanupRow[];
      if (dirty.code === 0 || !rows.some(row => row.action === "dirty") || !existsSync(file)) {
        throw new Error("The demo did not preserve a dirty checkout");
      }
    } finally { unlinkSync(file); }
  }
  let cleanup = teamCommand(root, ["feature", "clean", feature, "--iteration", version], true);
  if (cleanup.code !== 0 && cleanup.stdout) {
    await Bun.sleep(900);
    cleanup = teamCommand(root, ["feature", "clean", feature, "--iteration", version], true);
  }
  if (cleanup.code !== 0) throw new Error(cleanup.stderr || cleanup.stdout);
  const cleaned = JSON.parse(cleanup.stdout) as CleanupRow[];
  if (cleaned.length !== tasks.length || cleaned.some(row => !ids.has(row.id) || !["removed", "absent"].includes(row.action))) {
    throw new Error("Cleanup did not confirm every demo task");
  }
  if (terminals().length || agents.some(agent => existsSync(agent.cwd))) throw new Error("Demo terminals or worktrees remain");

  const receipts = cards().map(card => ({ id: card.id, status: card.status, iteration: card.meta.iteration,
    deliveries: Array.isArray(card.meta.completed_deliveries) ? card.meta.completed_deliveries.length : 0 }));
  const result = { iteration: version, feature, issues: [...issueByTitle.values()], tasks: receipts,
    harnesses: [...harnesses].filter(Boolean).sort(), terminalsReclaimed: agents.length, cleanup: cleaned };
  writeFileSync(join(area, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  return result;
}

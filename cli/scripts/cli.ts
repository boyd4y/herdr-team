#!/usr/bin/env bun
import { resolveProjectWorkspace, TeamScopeError } from "./lib/dispatch/team-scope.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAll, cleanupIfDone } from "./lib/dispatch/cleanup.ts";
import { findRoot, loadProject } from "./lib/team/project.ts";
import { mergeRows, mergeTask, retryMerge } from "./lib/integration/merge.ts";
import { handoff } from "./lib/tasks/handoff.ts";
import { init, InitError, parseRoleSpecs, readRolesFile } from "./lib/team/init.ts";
import { describePlan, isPlanName, PLAN_NAMES, planRoles } from "./lib/team/plans.ts";
import { addRole, describeRole, removeRole, RoleError } from "./lib/team/roles.ts";
import { realHerdr, type Herdr } from "./lib/runtime/herdr.ts";
import { refreshSidebar } from "./lib/ui/sidebar.ts";
import { syncWorkspaceGit } from "./lib/ui/workspace-git.ts";
import { acquireConsole } from "./lib/runtime/console.ts";
import { createConsoleEvents } from "./lib/runtime/console-events.ts";
import { claimTask, needsQueuePass, nextQueueDeadline, pumpQueue, queueRows, retryDelivery } from "./lib/dispatch/queue.ts";
import { dispatch, down, LaunchError, up, workspaceLabelFor } from "./lib/dispatch/launch.ts";
import { buildReport, formatReport, formatTaskDetail, formatTasks } from "./lib/ui/status.ts";
import { createTask, editTask, findTask, TaskError } from "./lib/tasks/cards.ts";
import { formatProblems, validateProject } from "./lib/team/validate.ts";
import { formatConsoleFrame, initialState, renderOnce, renderStatusLine } from "./lib/ui/console-model.ts";
import { isTerminal, type Project } from "./lib/shared/types.ts";

/** 所有碰 herdr 的命令都从这里拿，测试时能替换。 */
function herdrClient(): Herdr {
  return realHerdr();
}

/** 碰 herdr 前先确保 .herdr/ 本身是干净的。 */
function loadValidated(root: string): Project {
  const project = loadProject(root);
  const problems = validateProject(project);
  if (problems.length > 0) {
    throw new TaskError(`Invalid .herdr/ configuration; fix it first:\n${formatProblems(problems)}`);
  }
  return project;
}

const USAGE = `herdr-team - manage a Herdr agent team from .herdr/

Usage:
  herdr-team <command> [arguments] [options]

Team:
  init                 Save team configuration
  role <list|add|rm>    Read or update roles
  validate             Validate team configuration and references
  up                   Start or resume the team and Console
  status               Show task and live agent status
  console              Open Team Console
  down                 Stop team agents

Tasks:
  add <title>          Create a task
  edit <id>            Edit a task
  tasks [<id>]         List tasks or read full task details
  dispatch [<id>]      Enqueue tasks and attempt delivery
  claim <id>           Acknowledge the assigned delivery
  handoff <id>         Save results and advance the assignment

Maintenance:
  queue                Inspect, retry, or drain delivery records
  merge                Integrate accepted work serially
  clean [<id>]         Remove a terminal task worktree, or all terminal worktrees

Use the herdr-team skill for onboarding and task coordination.

Options:
  --root <DIR>         Project root; otherwise search parent directories
  --json               JSON output where supported
  -h, --help           Show help
  -v, --version        Show version

Run herdr-team <command> --help for command options.
`;

class UsageError extends Error {}

interface ParsedArgs {
  pos: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(args: string[], valued: readonly string[]): ParsedArgs {
  const takesValue = new Set(valued);
  const out: ParsedArgs = { pos: [], values: new Map(), flags: new Set() };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (!arg.startsWith("--")) {
      out.pos.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out.values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (takesValue.has(name)) {
      const next = args[++i];
      if (next === undefined) throw new UsageError(`--${name} requires a value`);
      out.values.set(name, next);
    } else {
      out.flags.add(name);
    }
  }
  return out;
}

/** 逗号分隔的列表参数。 */
function csv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function resolveRoot(explicit?: string): string {
  if (explicit !== undefined) {
    const abs = resolve(explicit);
    if (!existsSync(join(abs, ".herdr"))) throw new UsageError(`No .herdr/ directory under ${abs}`);
    return abs;
  }
  const found = findRoot(process.cwd());
  if (found === null) {
    throw new UsageError("No team project found in this directory or its parents; use --root");
  }
  return found;
}

function loadOrFail(root: string): Project {
  return loadProject(root);
}

/**
 * 给标签栏那条命令用的根目录解析。
 *
 * 标签栏命令的 cwd 未必是个团队项目 —— 自动找不到 `.herdr/` 时安静地返回 null
 * （什么都不打印、正常退出），否则你每进一个普通项目标签栏就挂个报错。
 * 但**显式给了 `--root` 就照常报错** —— 那是你自己写错了，该说。
 *
 * `--follow` 是给标签栏准备的：那种命令跑在 Herdr **服务器进程**里，cwd 是服务器
 * 启动时的目录（实测是 `$HOME`），从那儿往上找 `.herdr/` 永远找不到 —— 不跟焦点
 * 的话这行永远空白。跟着焦点 pane 的 cwd 走，才能显示你正在看的那个项目。
 */
function resolveRootQuiet(explicit: string | undefined, follow: boolean, herdr: Herdr): string | null {
  if (explicit !== undefined) return resolveRoot(explicit);
  if (follow) {
    try {
      const pane = herdr.paneCurrent();
      if (pane.cwd !== null) {
        const root = findRoot(pane.cwd);
        if (root !== null) return root;
      }
    } catch {
      // 问不到焦点就退回 cwd —— 宁可能显示不出来，也别让标签栏挂个报错。
    }
  }
  return findRoot(process.cwd());
}

function readBody(parsed: ParsedArgs): string {
  const inline = parsed.values.get("body");
  const file = parsed.values.get("body-file");
  if (inline !== undefined && file !== undefined) {
    throw new UsageError("Use only one of --body and --body-file");
  }
  if (inline !== undefined) return inline;
  if (file !== undefined) {
    if (!existsSync(file)) throw new UsageError(`File not found: ${file}`);
    return readFileSync(file, "utf8");
  }
  return "";
}

function out(parsed: ParsedArgs, payload: unknown, human: string): number {
  if (parsed.flags.has("json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
  return 0;
}

const BODY_USAGE = "List JSON omits body; use tasks <id> [--json] for full task details.\n";

/** 只投影卡片的 JSON 输出，内部卡片和用户元数据保持原样。 */
function cardForJson<T extends { body: string }>(card: T): Omit<T, "body"> {
  const { body: _body, ...metadata } = card;
  return metadata;
}

function cmdValidate(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team validate [--root DIR] [--json]\n");
    return 0;
  }
  const root = resolveRoot(parsed.values.get("root"));
  const problems = validateProject(loadOrFail(root));
  const ok = problems.length === 0;

  if (parsed.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ root, ok, problems }, null, 2)}\n`);
  } else {
    process.stdout.write(`root: ${root}\n${formatProblems(problems)}\n`);
  }
  return ok ? 0 : 1;
}

function cmdAdd(args: string[]): number {
  const parsed = parseArgs(args, ["root", "role", "handoff", "depends-on", "priority", "slug", "body", "body-file"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team add <title> --role R [--handoff a,b] [--depends-on id,id] [--priority Pn]\nThe skill supplies the explicit owner and handoff chain.\n");
    return 0;
  }

  if (parsed.flags.has("workflow") || parsed.values.has("workflow")) throw new UsageError("Workflow selection belongs to the skill; supply --role and --handoff");
  const title = parsed.pos.join(" ").trim();
  if (title === "") throw new UsageError("A title is required: herdr-team add \"<title>\" --role R");

  const role = parsed.values.get("role");
  if (role === undefined) throw new UsageError("--role is required; ask the user if the owner is unclear");

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  // 建卡前先全量校验 —— 卡片要引用角色，而角色可能本身就是坏的
  const problems = validateProject(project);
  if (problems.length > 0) {
    throw new TaskError(`Invalid .herdr/ configuration; fix it before adding tasks:\n${formatProblems(problems)}`);
  }

  const created = createTask(project, {
    title,
    role,
    handoff: csv(parsed.values.get("handoff")),
    dependsOn: csv(parsed.values.get("depends-on")),
    priority: parsed.values.get("priority") ?? "P2",
    body: readBody(parsed),
    slug: parsed.values.get("slug"),
  });

  return out(
    parsed,
    created,
    `✓ Created ${created.dir}\n  id=${created.id}  role=${role}  handoff=[${findTask(loadProject(root), created.id).handoff.join(", ")}]\n\nAsk lead to run \`herdr-team dispatch ${created.id}\`.`,
  );
}

function cmdEdit(args: string[]): number {
  const parsed = parseArgs(args, [
    "root",
    "title",
    "role",
    "handoff",
    "depends-on",
    "priority",
    "status",
    "body",
  ]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team edit <id> [--role R] [--handoff a,b] [--depends-on id,id] [--priority Pn] [--status S] [--force]\n");
    return 0;
  }

  const id = parsed.pos[0];
  if (id === undefined) throw new UsageError("A task ID is required: herdr-team edit <id> [options]");

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  const handoffRaw = parsed.values.get("handoff");
  const dependsOnRaw = parsed.values.get("depends-on");
  const body = readBody(parsed);
  const result = editTask(
    project,
    id,
    {
      title: parsed.values.get("title"),
      role: parsed.values.get("role"),
      handoff: handoffRaw === undefined ? undefined : csv(handoffRaw),
      dependsOn: dependsOnRaw === undefined ? undefined : csv(dependsOnRaw),
      priority: parsed.values.get("priority"),
      status: parsed.values.get("status"),
      body: body === "" ? undefined : body,
    },
    parsed.flags.has("force"),
  );

  refreshSidebar(project, herdrClient());
  return out(parsed, result, `✓ Updated ${result.dir}`);
}

/** init 可能在没有 .herdr/ 的目录里跑，所以不能用 resolveRoot。 */
function resolveInitRoot(explicit?: string): string {
  if (explicit !== undefined) return resolve(explicit);
  return findRoot(process.cwd()) ?? resolve(process.cwd());
}

function cmdInit(args: string[]): number {
  const parsed = parseArgs(args, ["root", "roles", "roles-file", "plan"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      `Usage: herdr-team init [--plan ${PLAN_NAMES.join("|")} | --roles-file F | --roles JSON] [--force] [--root DIR]\n\n` +
        PLAN_NAMES.map((p) => `  --plan ${p.padEnd(10)}${describePlan(p)}`).join("\n") +
        "\nProject .herdr/models.json preferences override plan model suggestions.\n--force rewrites role metadata and preserves existing prompt.md; use role add <name> --force --body T to update responsibilities.\n",
    );
    return 0;
  }

  const inline = parsed.values.get("roles");
  const file = parsed.values.get("roles-file");
  const plan = parsed.values.get("plan");
  if (["workflow", "workflow-file"].some((name) => parsed.flags.has(name) || parsed.values.has(name))) throw new UsageError("Workflow configuration belongs to the skill; save the agreement in root TEAM.md");
  const root = resolveInitRoot(parsed.values.get("root"));
  const project = loadProject(root);
  const given = [inline, file, plan].filter((v) => v !== undefined);
  if (given.length > 1) {
    throw new UsageError("Use only one of --plan, --roles, and --roles-file");
  }

  let specs: ReturnType<typeof parseRoleSpecs> = [];
  if (plan !== undefined) {
    if (!isPlanName(plan)) {
      throw new UsageError(`Unknown plan "${plan}". Available: ${PLAN_NAMES.join(" / ")}`);
    }
    specs = planRoles(plan, root);
  } else if (inline !== undefined) specs = parseRoleSpecs(inline);
  else if (file !== undefined) specs = parseRoleSpecs(readRolesFile(file));

  const result = init(project, specs, parsed.flags.has("force"));

  const lines: string[] = [];
  if (result.created.length > 0) lines.push(`created: ${result.created.join(", ")}`);
  if (result.roleMetadataWritten.length > 0) lines.push(`Role metadata written: ${result.roleMetadataWritten.join(", ")}`);
  if (result.roleBodiesWritten.length > 0) lines.push(`Role bodies written: ${result.roleBodiesWritten.join(", ")}`);
  if (result.roleBodiesPreserved.length > 0) lines.push(`Role bodies preserved: ${result.roleBodiesPreserved.join(", ")}`);
  if (result.skipped.length > 0) lines.push(`skipped: ${result.skipped.join(", ")}`);
  lines.push(`\nroot: ${root}`);

  // 分清「这次没给定义」和「这个项目还没有角色」—— 前者不该说成后者。
  if (given.length === 0) {
    const existing = project.roles.map((r) => r.name);
    if (existing.length > 0) {
      lines.push(`${existing.length} existing roles: ${existing.join(", ")}. No definitions supplied; roles unchanged.`);
      lines.push("Add: role add <name> --kind K; update: role add <name> --force --body T; remove: role rm <name>.");
    } else {
      lines.push("No roles yet. Supply confirmed role definitions with --roles-file.");
    }
  }

  return out(parsed, { root, ...result }, lines.join("\n"));
}

function cmdStatus(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team status [--all] [--root DIR] [--json]\n" + BODY_USAGE);
    return 0;
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const report = buildReport(project, herdrClient(), parsed.flags.has("all"));

  if (parsed.flags.has("json")) {
    return out(parsed, { ...report, tasks: report.tasks.map(cardForJson) }, "");
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  return 0;
}

/** `--interval` 的秒数。默认 2；0 = 只手动刷新。 */
function parseInterval(value: string | undefined): number {
  if (value === undefined) return 2;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new UsageError(`--interval must be a nonnegative number of seconds; received "${value}"`);
  }
  return seconds;
}

const CONSOLE_USAGE = `Usage: herdr-team console [--sample] [--all] [--interval SECONDS] [--once] [--root DIR]

Team Console displays tasks, agents, and queues. File changes and Herdr plugin events wake queued work.
Startup and periodic reconciliation recover missed events; delivery timeouts use their own deadlines.
Tasks are listed by ID, newest first. Search ranks matches, then breaks ties by newest ID.

Keys:
  Up/Down / k j    Select a task
  PgUp / PgDn     Scroll the focused panel (details by default)
  r               Refresh now
  s               Toggle sample preview (scheduling pauses during preview)
  Tab             Focus tasks, roles, flow, or details
  a               Toggle terminal tasks
  /               Search IDs, titles, and roles (Unicode supported)
  Enter           Keep the filter and leave search input
  Backspace       Delete one code point in search input
  Esc             Clear search; quit if no filter is active
  q / Ctrl-C      Quit (q is text while searching)

Closing Team Console pauses automatic delivery; queued work remains on disk.
Use dispatch to enqueue tasks and handoff to release the current assignment.
For non-interactive agent use, run herdr-team status [--json].

Options:
  --interval <seconds>  Fallback reconciliation (default 60; sample animation steps default 2)
  --all                 Include terminal tasks
  --once                Render one read-only frame and exit
  --observe             Show a live read-only Console without scheduling
  --sample              Run an animated in-memory demo; no project or Herdr needed
  --line                Print one tab-bar status line without interaction
  --follow              Follow the focused pane when --root is omitted
  --sync-git            With --line, refresh primary workspace Git details

Example status line:
  team: 1 doing 2 todo · 1 blocked · 1 ✗

Only nonzero counts are shown. Blocked tasks include missing agents, pending
input, and completed work awaiting handoff; each task is counted once.
The final count reports .herdr/ validation problems.
Quiet or non-team projects produce no status text.

Use --follow for a Herdr tab-bar command: the command's cwd can differ from
the focused project. Add --sync-git to refresh sidebar Git details as well.
`;

async function cmdConsole(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["root", "interval"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(CONSOLE_USAGE);
    return 0;
  }
  if (parsed.flags.has("json")) {
    throw new UsageError("console does not support --json; use `herdr-team status --json`");
  }
  if (parsed.flags.has("sync-git") && !parsed.flags.has("line")) throw new UsageError("--sync-git requires --line");

  if (parsed.flags.has("sample")) {
    if (parsed.flags.has("line") || parsed.flags.has("follow")) throw new UsageError("--sample cannot be combined with --line or --follow");
    const seconds = parseInterval(parsed.values.get("interval"));
    const showAll = parsed.flags.has("all");
    if (parsed.flags.has("once") || !process.stdout.isTTY || !process.stdin.isTTY) {
      const { sampleConsole } = await import("./lib/ui/console-sample.ts");
      const { model } = sampleConsole(initialState(showAll));
      process.stdout.write(`SAMPLE · simulated data · no project changes\n${formatConsoleFrame(model)}`);
      return 0;
    }
    const { runConsole } = await import("./lib/ui/console-view.ts");
    return runConsole({ sample: true, intervalMs: seconds * 1000, showAll });
  }

  // 标签栏那一行：不交互，而且没项目时要闭嘴而不是报错（见 resolveRootQuiet）。
  if (parsed.flags.has("line")) {
    if (parsed.flags.has("once")) throw new UsageError("Use only one of --line and --once");
    const herdr = herdrClient();
    if (parsed.flags.has("sync-git")) syncWorkspaceGit(herdr);
    const lineRoot = resolveRootQuiet(parsed.values.get("root"), parsed.flags.has("follow"), herdr);
    if (lineRoot === null) return 0;
    const line = renderStatusLine(loadProject(lineRoot), herdr);
    if (line !== "") process.stdout.write(`${line}\n`);
    return 0;
  }

  const root = resolveRoot(parsed.values.get("root"));
  const seconds = parseInterval(parsed.values.get("interval") ?? "60");
  const observe = parsed.flags.has("observe");
  if (seconds <= 0 && !parsed.flags.has("once") && !observe) throw new UsageError("Console refresh interval must be greater than zero");
  // 容错加载（**不是** loadValidated）：看板恰恰是 .herdr/ 出问题时最想看的东西，
  // 校验问题会在帧里的 ✗ 横幅报出来，而不是拦在门口。
  const project = loadProject(root);
  const showAll = parsed.flags.has("all");

  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (parsed.flags.has("once") || !interactive) {
    process.stdout.write(
      renderOnce(project, herdrClient(), {
        showAll,
      }),
    );
    if (!interactive && !parsed.flags.has("once")) {
      process.stderr.write("console: non-interactive terminal; rendered one read-only frame. Use an interactive terminal for scheduling.\n");
    }
    return 0;
  }

  // 注意这里绝不 process.exit() —— 终端还原全在 runConsole 的 finally 里，
  // 提前退出会把用户的 shell 留在 raw mode + 备屏里。
  const herdr = herdrClient();
  if (!observe && !herdr.envOk()) throw new LaunchError("Team Console requires a Herdr-managed pane");
  const { runConsole } = await import("./lib/ui/console-view.ts");
  const lease = observe ? undefined : acquireConsole(project);
  const events = createConsoleEvents(project, seconds > 0 ? seconds * 1000 : 60_000);
  let sidebarProject: Project | undefined;
  try { return await runConsole({
    initial: project,
    load: events.load,
    subscribe: events.subscribe,
    herdr,
    intervalMs: seconds * 1000,
    showAll,
    tick: observe ? undefined : () => {
      const current = events.load();
      if (needsQueuePass(current)) {
        const outcomes = pumpQueue(current, herdr, new Date(), () => lease!.stopped());
        events.invalidate();
        if (outcomes.some(outcome => outcome.state === "submitted")) events.request();
      } else if (current !== sidebarProject) refreshSidebar(current, herdr);
      sidebarProject = current;
    },
    nextDeadline: observe ? undefined : nextQueueDeadline,
    shouldQuit: () => lease?.stopped() ?? false,
  }); } finally { events.close(); lease?.close(); }
}

function cmdHandoff(args: string[]): number {
  const parsed = parseArgs(args, ["root", "summary", "summary-file", "delivery", "commit", "accept", "pr"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team handoff <id> [--delivery ID] [--summary TEXT | --summary-file FILE] [--commit SHA | --accept SHA [--pr URL] | --reject] [--root DIR] [--json]\n--commit submits a pinned version to the next owner. --accept records validation at that SHA; --pr attaches an existing tested PR and hands it to the next owner. Final approval queues integration; the skill explicitly invokes merge. --reject returns defects to the developer and repeats the recorded review path.\nQueue-managed tasks require their claimed delivery ID; repeated IDs do not advance twice.\n");
    return 0;
  }
  const id = parsed.pos[0];
  if (id === undefined) throw new UsageError("A task ID is required: herdr-team handoff <id>");
  if (parsed.pos.length !== 1) throw new UsageError("handoff accepts exactly one task ID");
  const inline = parsed.values.get("summary");
  const file = parsed.values.get("summary-file");
  if (inline !== undefined && file !== undefined) throw new UsageError("--summary and --summary-file cannot be combined");
  let summary = inline;
  if (file !== undefined) {
    try { summary = readFileSync(file, "utf8"); }
    catch (error) { throw new UsageError(`Failed to read delivery summary: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const result = handoff(project, herdrClient(), id, new Date(), { summary, delivery: parsed.values.get("delivery"), commit: parsed.values.get("commit"), accept: parsed.values.get("accept"), reject: parsed.flags.has("reject"), pr: parsed.values.get("pr") });

  return out(parsed, result, `✓ ${result.note}`);
}

function cmdMerge(args: string[]): number {
  const parsed = parseArgs(args, ["root", "migrate"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team merge [list | next | <id> | retry <id>] [--migrate COMMAND] [--root DIR] [--json]\nMerge approved PRs or accepted local commits under one integration lock. PR workflows require both test results and PR review at the exact head SHA; approval queues integration; the skill explicitly requests merge. Console never bypasses approval. Inspect blocked/interrupted operations before retrying.\n");
    return 0;
  }
  const project = loadValidated(resolveRoot(parsed.values.get("root")));
  const sub = parsed.pos[0] ?? "list";
  if (sub === "list" && parsed.pos.length <= 1) {
    const rows = mergeRows(project);
    return out(parsed, rows, rows.length ? rows.map((r) => `${r.id}  ${r.state}  ${r.commit}${r.reason ? `  ${r.reason}` : ""}`).join("\n") : "No accepted tasks awaiting integration.");
  }
  if (sub === "retry" && parsed.pos.length === 2) {
    retryMerge(project, parsed.pos[1]!);
    return out(parsed, { id: parsed.pos[1], state: "queued" }, `Requeued integration #${parsed.pos[1]} after reconciliation.`);
  }
  if (parsed.pos.length !== 1 || sub !== "next" && !/^\d{4}$/.test(sub)) throw new UsageError("Use merge list, merge next, merge <id>, or merge retry <id>");
  const result = mergeTask(project, sub === "next" ? undefined : sub, parsed.values.get("migrate"));
  return out(parsed, result, `Integrated #${result.id} at ${result.commit}.`);
}

function cmdUp(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team up [--fresh] [--root DIR] [--json]\nStart or resume resident roles and create or reuse a Team Console tab. Running agents are always reused. --fresh ignores saved sessions.\n");
    return 0;
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const result = up(project, herdrClient(), { fresh: parsed.flags.has("fresh") });

  const lines: string[] = [];
  lines.push(`workspace ${result.workspaceLabel} (${result.workspaceId})  ${result.workspaceAction}`);
  lines.push(`  console  ${result.console.action}${result.console.paneId ? `  →  ${result.console.paneId}` : ""}${result.console.failure ? `  ${result.console.failure}` : ""}`);
  for (const r of result.roles) {
    if (r.action === "deferred") {
      // 隔离角色本来就不预起 —— 没上报不是失败，也不是出了问题。
      lines.push(`  ${"deferred".padEnd(9)}${r.role}  (isolated role: starts in its own worktree when dispatched)`);
      continue;
    }
    if (r.action === "failed") {
      lines.push(`  ${"failed".padEnd(9)}${r.role}  →  ${r.paneId}\n      ${r.failure ?? ""}`);
      continue;
    }
    const meta = r.reported === false ? "  ⚠ Display metadata report failed" : "";
    lines.push(`  ${r.action.padEnd(9)}${r.role}  →  ${r.paneId}${meta}`);
    if (r.sessionWarning) lines.push(`      ⚠ ${r.sessionWarning}`);
  }

  const failed = result.roles.filter((r) => r.action === "failed");
  if (failed.length > 0) {
    lines.push("");
    lines.push(`${failed.length} roles failed to start. See startup or resume errors above.`);
  }
  return out(parsed, result, lines.join("\n"));
}

function cmdDispatch(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team dispatch [<id>] [--root DIR] [--json]\nEnqueue todo cards and attempt one delivery. Team Console drains the remaining work when roles are available.\n");
    return 0;
  }
  if (parsed.pos.length > 1) throw new UsageError("dispatch accepts at most one task ID");
  const root = resolveRoot(parsed.values.get("root"));
  const result = dispatch(loadValidated(root), herdrClient(), parsed.pos[0]);
  const lines = result.map((d) =>
    `  ${d.id}  ${d.role}  ${d.action}${d.reason === undefined ? "" : `  (${d.reason})`}`,
  );
  return out(parsed, result, lines.length === 0 ? "No todo tasks to dispatch." : lines.join("\n"));
}

function cmdClaim(args: string[]): number {
  const parsed = parseArgs(args, ["root", "delivery"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team claim <id> --delivery ID [--root DIR] [--json]\nAcknowledge the current delivery before working. A duplicate claim must not start a second copy.\n"); return 0;
  }
  if (parsed.pos.length !== 1 || !parsed.values.get("delivery")) throw new UsageError("claim requires one task ID and --delivery ID");
  if (!herdrClient().envOk()) throw new LaunchError("Run claim inside a Herdr-managed pane");
  const result = claimTask(loadValidated(resolveRoot(parsed.values.get("root"))), parsed.pos[0]!, parsed.values.get("delivery")!);
  return out(parsed, result, result.duplicate ? `Delivery already claimed; do not start another copy of #${result.id}.` : `Claimed #${result.id}.`);
}

function cmdQueue(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team queue [list | retry <id> | drain] [--root DIR] [--json]\nRetry only after checking that an uncertain delivery was not processed. Retries receive a new delivery ID.\n"); return 0;
  }
  const project = loadValidated(resolveRoot(parsed.values.get("root")));
  const sub = parsed.pos[0] ?? "list";
  if (sub === "list" && parsed.pos.length <= 1) {
    const rows = queueRows(project);
    return out(parsed, rows, rows.length ? rows.map((r) => `${r.id}  ${r.role}  ${r.state}  ${r.reason}`).join("\n") : "No queued or active deliveries.");
  }
  if (sub === "retry" && parsed.pos.length === 2) {
    const result = retryDelivery(project, parsed.pos[1]!);
    return out(parsed, result, `Requeued #${result.id}; Team Console will deliver it when its role is available.`);
  }
  if (sub === "drain" && parsed.pos.length === 1) {
    const result = pumpQueue(project, herdrClient());
    return out(parsed, result, result.length ? result.map((r) => `${r.id}  ${r.state}  ${r.reason ?? ""}`).join("\n") : "No pending deliveries.");
  }
  throw new UsageError("Use queue list, queue retry <id>, or queue drain");
}

function cmdDown(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      "Usage: herdr-team down [--workspace] [--root DIR] [--json]\n\n" +
        "Stops team agents and keeps the workspace by default.\n" +
        "--workspace also closes the workspace group and all its tabs.\n",
    );
    return 0;
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const herdr = herdrClient();
  const teamWorkspace = parsed.flags.has("workspace") ? resolveProjectWorkspace(project, herdr) : null;
  const result = down(project, herdr);

  const lines: string[] = [];
  if (result.stopped.length === 0) {
    lines.push("No running agents.");
  } else {
    lines.push(`✓ Stopped ${result.stopped.length} agents (workspace retained)`);
    for (const s of result.stopped) lines.push(`  ${s.agent.padEnd(16)}${s.paneId}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`⚠ Recognized agents without pane IDs: ${result.skipped.join(", ")}`);
  }

  let workspaceId: string | null = null;
  if (parsed.flags.has("workspace")) {
    const label = workspaceLabelFor(project);
    if (teamWorkspace !== null) {
      herdr.workspaceCloseGroup(teamWorkspace);
      workspaceId = teamWorkspace;
      lines.push(`\n⚠ Closed workspace "${label}" (${teamWorkspace}) and its tabs.`);
    }
  }

  return out(parsed, { ...result, workspaceId }, lines.join("\n"));
}

function cmdTasks(args: string[]): number {
  const parsed = parseArgs(args, ["root", "role", "status"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team tasks [<id>] [--all] [--role R] [--status S] [--root DIR] [--json]\n" + BODY_USAGE);
    return 0;
  }
  if (parsed.pos.length > 1) throw new UsageError("tasks accepts at most one task ID");
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const id = parsed.pos[0];
  if (id !== undefined) {
    const task = findTask(project, id);
    return out(parsed, task, formatTaskDetail(task));
  }

  const roleFilter = parsed.values.get("role");
  const statusFilter = parsed.values.get("status");
  const tasks = project.tasks
    .filter((t) => parsed.flags.has("all") || !isTerminal(t.status))
    .filter((t) => roleFilter === undefined || t.role === roleFilter)
    .filter((t) => statusFilter === undefined || t.status === statusFilter)
    .sort((a, b) =>
      a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority.localeCompare(b.priority),
    );

  if (parsed.flags.has("json")) {
    return out(parsed, tasks.map(cardForJson), "");
  } else {
    process.stdout.write(`${formatTasks(tasks, project.roles)}\n`);
  }
  return 0;
}

function cmdClean(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team clean [<id>] [--root DIR] [--json]\nRemove only terminal task worktrees and close their task workspaces and agents. Omit id to clean all terminal tasks; branches are retained.\n");
    return 0;
  }
  if (parsed.pos.length > 1) throw new UsageError("clean accepts at most one task ID");
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const herdr = herdrClient();
  const results = parsed.pos[0] ? [cleanupIfDone(project, herdr, findTask(project, parsed.pos[0]))] : cleanupAll(project, herdr);
  const failed = results.some((r) => !["removed", "absent"].includes(r.action));

  if (parsed.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return failed ? 1 : 0;
  }
  if (results.length === 0) {
    process.stdout.write("No terminal tasks to clean up.\n");
    return 0;
  }
  const lines = results.map((r) => `  ${r.id}  ${r.action.padEnd(13)}${r.note}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return failed ? 1 : 0;
}

/** `K=V,K=V` → 映射。 */
function pairs(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const item of csv(value)) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new UsageError(`--env expects KEY=VALUE; received "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

function cmdRole(args: string[]): number {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(
      "Usage: herdr-team role <list|add|rm> [options]\n\n" +
        "  list [--json]                     List roles (JSON omits body)\n" +
        "  add <name> [--kind K] [--model M] [--worktree] [--cwd C]\n" +
        "             [--args a,b] [--env K=V,K=V] [--body T | --body-file F] [--force]\n" +
        "  rm <name> [--force]               Remove a role; reject active task references\n\n" +
        "New roles require --kind; updates require --force and preserve omitted metadata.\n" +
        "Update responsibilities: role add <name> --force --body T (or --body-file F); omitted body preserves prompt.md.\n" +
        "Run `herdr-team up` after adding roles to start them and report metadata.\n",
    );
    return sub === undefined ? 2 : 0;
  }

  const parsed = parseArgs(rest, ["root", "kind", "model", "cwd", "args", "env", "body", "body-file"]);
  if (parsed.flags.has("help")) return cmdRole(["--help"]);

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  if (sub === "list") {
    if (project.roles.length === 0 && !parsed.flags.has("json")) {
      process.stdout.write("(no roles yet)\n");
      return 0;
    }
    const lines = project.roles.map((r) => `  ${describeRole(r)}`);
    return out(parsed, project.roles.map(cardForJson), lines.join("\n"));
  }

  const name = parsed.pos[0];
  if (name === undefined) throw new UsageError(`role ${sub} requires a role name`);

  if (sub === "add") {
    const kind = parsed.values.get("kind");
    const result = addRole(project, {
      name,
      kind,
      model: parsed.values.get("model"),
      worktree: parsed.flags.has("worktree") ? true : undefined,
      cwd: parsed.values.get("cwd"),
      args: parsed.values.has("args") ? csv(parsed.values.get("args")) : undefined,
      env: parsed.values.has("env") ? pairs(parsed.values.get("env")) : undefined,
      body: parsed.values.has("body") || parsed.values.has("body-file") ? readBody(parsed) : undefined,
      force: parsed.flags.has("force"),
    });
    return out(
      parsed,
      result,
      `${result.action === "added" ? "✓ Added" : "✓ Updated"} role ${result.name} (${result.dir})\n\nRun \`herdr-team up\` to start it.`,
    );
  }

  if (sub === "rm") {
    const result = removeRole(project, name, parsed.flags.has("force"));
    return out(parsed, result, `✓ Removed role ${result.name} (${result.dir})`);
  }

  throw new UsageError(`Unknown role subcommand "${sub}" (list / add / rm)`);
}

function readVersion(): string {
  try {
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit(rest);
    case "validate":
      return cmdValidate(rest);
    case "add":
      return cmdAdd(rest);
    case "edit":
      return cmdEdit(rest);
    case "merge":
      return cmdMerge(rest);
    case "handoff":
      return cmdHandoff(rest);
    case "role":
      return cmdRole(rest);
    case "tasks":
      return cmdTasks(rest);
    case "status":
      return cmdStatus(rest);
    case "console":
      return cmdConsole(rest);
    case "claim":
      return cmdClaim(rest);
    case "queue":
      return cmdQueue(rest);
    case "up":
      return cmdUp(rest);
    case "dispatch":
      return cmdDispatch(rest);
    case "clean":
      return cmdClean(rest);
    case "down":
      return cmdDown(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// main 是 async 的：`console` 要等驱动跑完（它的 finally 负责还原终端），
// 先 process.exit 就会赶在还原之前把进程杀掉。
try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  if (
    error instanceof UsageError ||
    error instanceof TaskError ||
    error instanceof LaunchError ||
    error instanceof InitError ||
    error instanceof TeamScopeError ||
    error instanceof RoleError
  ) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}

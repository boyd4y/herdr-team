#!/usr/bin/env bun
import { projectKey, resolveProjectWorkspace, TeamScopeError } from "./lib/dispatch/team-scope.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CleanupResult } from "./lib/dispatch/cleanup.ts";
import { findRoot, findTeamRoots, loadProject, type ProjectReadOptions } from "./lib/team/project.ts";
import { aliasesForProject, assignProjectAlias, ProjectAliasError, removeProjectAliases, rootForInboxProject } from "./lib/team/project-aliases.ts";
import { mergeRows, mergeTask, retryMerge } from "./lib/integration/merge.ts";
import { handoff } from "./lib/tasks/handoff.ts";
import { init, InitError, parseRoleSpecs, readRolesFile } from "./lib/team/init.ts";
import { checkAgentPresets, formatAgentChecks } from "./lib/runtime/agent-check.ts";
import { formatAgentTests, runAgentPreset, testAgentPresets } from "./lib/runtime/agent-test.ts";
import { sanitize } from "./lib/shared/text.ts";
import { formatAgentPresets, listAgentPresets } from "./lib/team/agents.ts";
import { describePlan, isPlanName, PLAN_NAMES, planRoles } from "./lib/team/plans.ts";
import { addRole, formatRoles, removeRole, RoleError } from "./lib/team/roles.ts";
import { realHerdr, type Herdr } from "./lib/runtime/herdr.ts";
import { refreshSidebar } from "./lib/ui/sidebar.ts";
import { claimTask, retryDelivery } from "./lib/dispatch/queue.ts";
import { inboxDeliveries, readInboxDelivery } from "./lib/dispatch/inbox.ts";
import { dispatch, down, LaunchError, up, workspaceLabelFor } from "./lib/dispatch/launch.ts";
import { agentStatusLabel, buildReport, formatReport, formatTaskDetail, formatTasks } from "./lib/ui/status.ts";
import { createTask, editTask, findTask, linkRequirementTask, setTaskDisposition, TaskError } from "./lib/tasks/cards.ts";
import { stamp } from "./lib/tasks/records.ts";
import { acceptRequirement, addRequirement, editRequirements, indexRequirementTasks, iterationRows, iterationVersion, matchesIteration,
  readHiddenIterations, REQUIREMENT_STATUSES, requirementDetail, requirementSummary, requirementType,
  setIterationState, setRequirementDisposition, taskIteration, validateIteration } from "./lib/team/requirements.ts";
import { listIssueMetadata, migrateIssueStore, readIssue, RequirementError, type Requirement } from "./lib/team/issue-store.ts";
import { formatProblems, validateProject } from "./lib/team/validate.ts";
import { canonicalKind, CARD_DISPOSITIONS, isRoleLifecycle, isTaskInactive, NAME_RE, STATUSES, taskDisposition, type Project } from "./lib/shared/types.ts";
import { confirmedFeatures, FeatureError, featureKey, finishFeature, scopeFor, validateFeature } from "./lib/team/features.ts";
import { callerSpace, managedContext } from "./lib/runtime/context.ts";
import { readProxyEnv } from "./lib/runtime/agent-env.ts";
import { bindDesktop, desktopDown, desktopUp, DesktopError, realDesktop, registeredDesktopBinding, savedDesktopBinding, showDesktopBinding, unbindDesktop, type DesktopTerminal } from "./lib/runtime/desktop.ts";
import { withTeamLock } from "./lib/runtime/state.ts";
import { desktopTaskRuntime, syncDesktopTaskSpaces, type DesktopTaskRuntime } from "./lib/runtime/desktop-dispatch.ts";
import { taskRuntime } from "./lib/dispatch/runtime.ts";
import { assertDaemonOwner, daemonDirectory, daemonEndpoint, inboxProjectStates, listRegisteredProjects, makeDaemonTeam, pauseDaemonTeam, readDaemonTeam, registerDaemonTeam, registerProjectRoot, unregisterProjectRoot } from "./lib/runtime/daemon-binding.ts";
import { daemonPass, daemonStatus, requestDaemonCleanup, requestDaemonService, serveDaemon, startDaemon, stopDaemon, wakeDaemon } from "./lib/runtime/daemon.ts";
import { isServiceRequest, listDesktopServices } from "./lib/runtime/desktop-services.ts";
import { daemonLogPath, deliveryLogReason, followDaemonLog, formatDaemonLog, logDaemon, readDaemonLog } from "./lib/runtime/daemon-log.ts";
import { addAgentMailRoute, AgentMailError, checkAgentMail, readAgentMailRoutes } from "./lib/runtime/agentmail.ts";
import { MAIL_ID, listMail, mailTrashReasonLabel, markMailRead, readMail, updateMailState } from "./lib/runtime/mail-inbox.ts";
import { initDesktopDemo, isDesktopDemo, runDesktopDemo } from "./lib/demo/launch.ts";
import { demoSettings } from "./lib/demo/config.ts";
import { purgeProject } from "./lib/team/purge.ts";

/** 所有碰 herdr 的命令都从这里拿，测试时能替换。 */
function herdrClient(): Herdr {
  return realHerdr();
}

function assertTuiProject(project: Project, herdr: Herdr, pane: string, requireBinding: boolean): void {
  const workspace = herdr.workspaceList().find(entry => pane.startsWith(entry.workspace_id + ":"));
  const owner = workspace?.tokens?.team_project;
  if (owner === projectKey(project) || owner === undefined && !requireBinding) return;
  if (owner === undefined) {
    const cwd = herdr.paneList(workspace?.workspace_id).find(entry => entry.pane_id === pane)?.cwd;
    if (cwd && findTeamRoots(cwd).includes(project.root)) return;
  }
  throw new LaunchError("Run this operation inside the selected project's Herdr workspace or task worktree.");
}

function executionRuntime(project: Project): Herdr | DesktopTaskRuntime {
  const context = managedContext();
  const key = projectKey(project);
  const registration = readDaemonTeam(key);
  if (registration) assertDaemonOwner(project, context.kind, daemonEndpoint(context.kind));
  if (context.kind === "desktop") {
    const team = registration ?? readDaemonTeam(key, true);
    return desktopTaskRuntime(project, realDesktop(), context.caller, { proxyEnv: team?.proxyEnv ?? readProxyEnv() });
  }
  const herdr = herdrClient();
  assertTuiProject(project, herdr, context.pane, Boolean(registration));
  return herdr;
}

/** 碰 herdr 前先确保 .herdr/ 本身是干净的。 */
function loadValidated(root: string, options?: ProjectReadOptions): Project {
  const project = loadProject(root, options);
  const problems = validateProject(project);
  if (problems.length > 0) {
    throw new TaskError(`Invalid .herdr/ configuration; fix it first:\n${formatProblems(problems)}`);
  }
  return project;
}

const USAGE = `Herdr Team · manage projects and agent teams

Usage:
  herdr-team <command> <subcommand> [arguments] [options]

Commands:
  project     List, show, register, rename, unregister, or purge projects
  team        Initialize, validate, start, or stop a team
  task        Manage tasks, delivery, integration, and cleanup
  issue       Manage requirements and defects
  iteration   Manage iteration visibility
  feature     Confirm deliveries and reclaim temporary worktrees
  service     List and control services in a local Desktop workspace
  role        Manage team roles
  agents      Inspect and run agent presets
  inbox       Read email and manage task deliveries
  space       Inspect and manage project bindings
  daemon      Manage the shared delivery service
  agentmail   Check AgentMail and route mail to projects

Options:
  --root <DIR>         Select a project by its root directory
  --project <ID>       Select a registered project by ID
  --json               Request JSON instead of text where supported
  -h, --help           Show help
  -v, --version        Show version

Project commands use the current directory and Git worktree by default.
If no single project matches, select it with --root or --project.
Run herdr-team <command> for its subcommands or add --help for details.
`;

const PROJECT_USAGE = `Usage: herdr-team project <list|show|create|update|delete|purge> [options]
  list                    List registrations on this machine
  show                    Show the selected project and its delivery state
  create [--name NAME]    Register an initialized project
  update --name NAME      Set the registered project's alias
  delete                  Unregister the project and retain its files
  purge --all [--force] [--dry-run] Clear the project's task, issue, iteration and feature records

Project actions use the current directory or --root DIR / --project ID.
All actions support --json. Use team init to initialize a new project.
`;

const PURGE_USAGE = `Usage: herdr-team project purge --all [--force] [--dry-run] [--root DIR | --project ID] [--json]

Removes workflow records from one project. Delivery history and demo results are included.
Team setup, registration, AgentMail Inbox, retired task IDs, and Git are retained.
Stop the team first. --force discards unfinished records and reclaims verified clean Desktop worktrees.
--dry-run shows counts and blockers without making changes.
`;

const TEAM_USAGE = `Usage: herdr-team team <init|validate|up|down|status> [options]
  init       Initialize and register this project
  validate   Check the project configuration
  up         Start the team and enable delivery
  down       Stop the team and pause delivery
  status     Show team and task status
`;

const TASK_USAGE = `Usage: herdr-team task <subcommand> [arguments] [options]
  list [--all]                List tasks in the selected project
  show ID                     Show one task and its history
  create "TITLE" --role ROLE  Create a task
  update ID [fields]          Change task fields
  archive ID                  Move a task to Archive
  restore ID                  Return a task from Archive or Trash
  delete ID                   Move a task to Trash
  dispatch ID                 Enqueue one task for delivery
  claim ID                    Claim a delivery
  handoff ID                  Advance a claimed delivery
  merge                       Integrate approved changes
  clean                       Reclaim finished worktrees

Use --root DIR or --project ID to select a project explicitly.
`;

const ISSUE_USAGE = `Usage: herdr-team issue <list|show|create|update|accept|archive|restore|delete|link|unlink|migrate> [options]
  list [--all] [--status STATUS] [--disposition archived] [--type requirement|defect] [--iteration VERSION]
  show ID
  create "TITLE" [--type requirement|defect]
  update ID [--title TITLE] [--iteration VERSION]
  accept ID
  archive ID                  Move an issue to Archive
  restore ID                  Return an issue from Archive
  delete ID                   Permanently delete an issue
  link ISSUE_ID TASK_ID
  unlink ISSUE_ID TASK_ID
  migrate                     Convert legacy issue storage to per-issue files
`;

class UsageError extends Error {}

interface ParsedArgs {
  pos: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(args: string[], valued: readonly string[]): ParsedArgs {
  const takesValue = new Set(valued);
  if (takesValue.has("root")) takesValue.add("project");
  const out: ParsedArgs = { pos: [], values: new Map(), flags: new Set() };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "-h") { out.flags.add("help"); continue; }

    if (!arg.startsWith("--")) {
      out.pos.push(arg);
      continue;
    }
    if (arg.startsWith("--json=")) throw new UsageError("Use --json without a value");
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
  if (takesValue.has("project") && out.values.has("project") && !out.flags.has("help")) {
    if (out.values.has("root")) throw new UsageError("Use either --root or --project");
    const id = out.values.get("project")!;
    const matches = listRegisteredProjects().filter(project => project.id === id);
    if (matches.length !== 1) {
      throw new UsageError(matches.length ? `Project ID ${id} is ambiguous; use --root` : `Unknown project ID ${id}; run herdr-team project list`);
    }
    out.values.delete("project");
    out.values.set("root", matches[0]!.root);
  }
  return out;
}

function checkOptions(parsed: ParsedArgs, values: readonly string[], flags: readonly string[] = []): void {
  const invalid = [...parsed.values.keys()].find(key => !values.includes(key)) ??
    [...parsed.flags].find(key => key !== "json" && !flags.includes(key));
  if (invalid) throw new UsageError(`Unknown option --${invalid}.`);
}

/** 逗号分隔的列表参数。 */
function csv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function resolveRoot(explicit?: string, includeAgentConfig = false): string {
  if (explicit !== undefined) {
    const abs = resolve(explicit);
    const hasState = statSync(join(abs, ".herdr"), { throwIfNoEntry: false })?.isDirectory();
    const hasPresets = includeAgentConfig && statSync(join(abs, "agents.json"), { throwIfNoEntry: false })?.isFile();
    if (!hasState && !hasPresets) throw new UsageError(`No team project configuration under ${abs}`);
    return realpathSync(abs);
  }
  const roots = findTeamRoots(process.cwd(), includeAgentConfig);
  if (!roots.length) {
    throw new UsageError("No team project found here. Run herdr-team team init, or select an existing project with --root DIR or --project ID.");
  }
  if (roots.length > 1) throw new UsageError(`Multiple team projects match this directory. Use --root or --project:\n  ${roots.join("\n  ")}`);
  return roots[0]!;
}

function compactIds(ids: string[]): string {
  const ranges: string[] = [];
  for (let start = 0; start < ids.length;) {
    let end = start;
    while (end + 1 < ids.length && Number(ids[end + 1]!.slice(-4)) === Number(ids[end]!.slice(-4)) + 1) end++;
    ranges.push(end === start ? ids[start]! : `${ids[start]}–${ids[end]}`);
    start = end + 1;
  }
  return ranges.join(", ");
}

function cmdProject(args: string[]): number {
  const parsed = parseArgs(args, ["root", "name"]);
  const sub = parsed.pos[0];
  if (parsed.flags.has("help")) {
    process.stdout.write(sub === "purge" ? PURGE_USAGE : PROJECT_USAGE);
    return 0;
  }
  const operation = sub === "current" ? "show" : sub === "register" ? "create" : sub;
  if (parsed.pos.length !== 1 || !operation || !["list", "show", "create", "update", "delete", "purge"].includes(operation)) {
    throw new UsageError("Choose a project subcommand: list, show, create, update, delete, or purge.");
  }
  if (operation === "purge") {
    checkOptions(parsed, ["root"], ["all", "force", "dry-run"]);
    if (!parsed.flags.has("all")) throw new UsageError("Use --all to select all project workflow records. Add --dry-run to preview.");
    const result = purgeProject(resolveRoot(parsed.values.get("root")), parsed.flags.has("dry-run"), parsed.flags.has("force"));
    const { records } = result;
    const runs = result.files.filter(path => path.startsWith("demo/"));
    const inventory = [
      ["Tasks", records.tasks, compactIds(records.tasks)],
      ["Issues", records.issues, compactIds(records.issues)],
      ["Iterations", records.iterations, records.iterations.join(", ")],
      ["Feature deliveries", records.featureDeliveries, records.featureDeliveries.join(", ")],
      ["Run records", runs, runs.join(", ")],
    ] as const;
    const total = inventory.reduce((count, [, ids]) => count + ids.length, 0);
    const title = result.blockers.length ? "Purge blocked" : result.dryRun ? "To delete" : "Deleted";
    const lines = inventory.flatMap(([label, ids, list]) => ids.length ? [`  ${label} (${ids.length})  ${list}`] : []);
    out(parsed, result, [`${title}: ${total} records.`, ...lines, ...result.blockers].join("\n"));
    return !result.dryRun && result.blockers.length ? 2 : 0;
  }
  if (operation === "list" && parsed.values.has("root")) throw new UsageError("Project list is global. Use herdr-team project show to select one project.");
  const name = parsed.values.get("name");
  if ([...parsed.flags].some(flag => flag !== "json") ||
      [...parsed.values.keys()].some(key => key !== "root" && !(key === "name" && ["create", "update"].includes(operation)))) {
    throw new UsageError("Unknown option for project " + operation);
  }
  if (operation === "list") {
    const projects = listRegisteredProjects();
    const lines = projects.map(project => {
      const state = project.enabled === null ? "registered" : project.enabled ? "enabled" : "paused";
      return `${project.id}  ${state}  ${project.root}`;
    });
    return out(parsed, projects, lines.length ? lines.join("\n") : "No registered projects. Run herdr-team team init in a project directory.");
  }
  const explicit = parsed.values.get("root");
  const explicitRegistration = explicit !== undefined && operation === "show"
    ? listRegisteredProjects().find(item => projectKey(item) === projectKey({ root: resolve(explicit) })) : undefined;
  const root = explicitRegistration?.root ?? (explicit !== undefined && operation === "delete" ? resolve(explicit) : resolveRoot(explicit));
  if (operation === "delete") {
    const removed = unregisterProjectRoot(root);
    if (removed) removeProjectAliases(root);
    return out(parsed, { root, registered: false, removed }, removed
      ? `Unregistered ${root}. Project files were retained.`
      : `No project registration for ${root}.`);
  }
  if (operation === "update") {
    if (!name) throw new UsageError("Set a name with herdr-team project update --name NAME.");
    if (!listRegisteredProjects().some(item => item.root === root)) throw new UsageError("Register this project with herdr-team project create before updating it.");
    assignProjectAlias(name, root, true);
  }
  if (operation === "create") {
    const project = loadValidated(root);
    if (name !== undefined) assignProjectAlias(name, project.root);
    registerProjectRoot(project);
    logDaemon("project.registered", { project: project.root, action: "local" });
  }
  const registration = listRegisteredProjects().find(project => project.root === root);
  const project = registration ?? { root, id: projectKey({ root }).slice(0, 12), enabled: null };
  const registered = Boolean(registration);
  const aliases = aliasesForProject(root);
  const daemonState = project.enabled === null ? "unregistered" : project.enabled ? "enabled" : "paused";
  return out(parsed, { ...project, aliases, registered, daemonState }, [
    `Project ID  ${project.id}`,
    `Aliases     ${aliases.join(", ") || "(none)"}`,
    `Root        ${root}`,
    `Registration  ${registered ? "registered" : "unregistered"}`,
    `Daemon      ${daemonState}`,
  ].join("\n"));
}

function loadOrFail(root: string): Project {
  return loadProject(root);
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

const BODY_USAGE = "List JSON omits body. Use herdr-team task show ID --json for full task details.\n";

/** 只投影卡片的 JSON 输出，内部卡片和用户元数据保持原样。 */
function cardForJson<T extends { body: string }>(card: T): Omit<T, "body"> {
  const { body: _body, ...metadata } = card;
  return metadata;
}

function cmdValidate(args: string[], name = "validate"): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} [--root DIR | --project ID] [--json]\n`);
    return 0;
  }
  checkOptions(parsed, ["root"]);
  if (parsed.pos.length) throw new UsageError("Validation takes project options only.");
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

function cmdAdd(args: string[], name = "add"): number {
  const values = ["root", "role", "handoff", "depends-on", "priority", "slug", "body", "body-file", "requirement", "feature", "iteration"];
  const parsed = parseArgs(args, values);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} "TITLE" --role ROLE [--handoff ROLES] [--depends-on IDS] [--priority Pn] [--requirement ID] [--feature NAME] [--iteration VERSION] [--root DIR | --project ID] [--json]\nTemporary roles need a feature and iteration on the dispatched task. A task can inherit its linked issue's iteration.\n`);
    return 0;
  }

  if (parsed.flags.has("workflow") || parsed.values.has("workflow")) throw new UsageError("Workflow selection belongs to the skill; supply --role and --handoff");
  checkOptions(parsed, values);
  const title = parsed.pos.join(" ").trim();
  if (title === "") throw new UsageError('Provide a task title and role, for example herdr-team task create "Fix the login form" --role dev.');

  const role = parsed.values.get("role");
  if (!role) throw new UsageError("Choose a task owner with --role ROLE. Use herdr-team role list to see available roles.");

  const root = resolveRoot(parsed.values.get("root"));
  const created = withTeamLock({ root }, "queue", () => createTask(loadValidated(root), {
    title,
    role,
    handoff: csv(parsed.values.get("handoff")),
    dependsOn: csv(parsed.values.get("depends-on")),
    priority: parsed.values.get("priority") ?? "P2",
    body: readBody(parsed),
    slug: parsed.values.get("slug"),
    requirement: parsed.values.get("requirement"),
    iteration: parsed.values.get("iteration"),
    feature: parsed.values.get("feature"),
  }));
  logDaemon("task.created", { project: root, task: created.id, role, state: "todo" });

  return out(
    parsed,
    created,
    `Created task #${created.id} for ${role}.\n${created.dir}\nTo dispatch it, run herdr-team task dispatch ${created.id}.`,
  );
}

function cardListFilters(parsed: ReturnType<typeof parseArgs>, statuses: readonly string[], dispositions: readonly string[]) {
  const suppliedStatus = parsed.values.get("status");
  const legacy = suppliedStatus !== undefined && dispositions.includes(suppliedStatus) ? suppliedStatus : undefined;
  const status = legacy ? undefined : suppliedStatus;
  const disposition = parsed.values.get("disposition") ?? legacy;
  if (status !== undefined && !statuses.includes(status)) throw new UsageError(`Use one of these statuses: ${statuses.join(", ")}.`);
  if (disposition !== undefined && (!dispositions.includes(disposition) || legacy && legacy !== disposition)) {
    throw new UsageError(`Use one disposition: ${dispositions.join(", ")}.`);
  }
  return { status, disposition };
}

function cmdBacklog(args: string[], name = "backlog"): number {
  const parsed = parseArgs(args, ["root", "type", "iteration", "status", "disposition", "title", "priority", "body", "body-file", "acceptance"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      `Usage: herdr-team ${name} list [--all] [--status STATUS] [--disposition archived] [--type requirement|defect] [--iteration VERSION]\n` +
      `       herdr-team ${name} ${name === "issue" ? "create" : "add"} "TITLE" [--type requirement|defect] [--priority Pn] [--iteration VERSION] [--body TEXT] [--acceptance TEXT]\n` +
      `       herdr-team ${name} ${name === "issue" ? "update" : "edit"} ID [--title TITLE] [--priority Pn] [--type TYPE] [--body TEXT] [--acceptance TEXT] [--iteration VERSION]\n` +
      `       herdr-team ${name} <show|accept> ID\n` +
      `       herdr-team ${name} <link|unlink> ISSUE_ID TASK_ID\n` +
      `Status values: ${REQUIREMENT_STATUSES.join(", ")}. --all includes Archive.\n` +
      "Use a version such as v1.1. Use --iteration '' to show items without an iteration or clear an assignment. Supports --root DIR, --project ID and --json.\n",
    );
    return 0;
  }
  const [operation = "list", ...values] = parsed.pos;
  const allowed: Record<string, string[]> = {
    list: ["type", "iteration", "status", "disposition"], add: ["type", "iteration", "priority", "body", "body-file", "acceptance"],
    edit: ["type", "iteration", "title", "priority", "body", "body-file", "acceptance"],
    show: [], accept: [], link: [], unlink: [],
  };
  const options = Object.hasOwn(allowed, operation) ? allowed[operation] : undefined;
  if (!options || [...parsed.flags].some(flag => flag !== "json" && !(flag === "all" && operation === "list")) ||
      [...parsed.values.keys()].some(key => key !== "root" && !options.includes(key))) {
    throw new UsageError(`Invalid command or option; run herdr-team ${name} --help`);
  }
  const project = loadValidated(resolveRoot(parsed.values.get("root")), { taskBodies: false, roleBodies: false });
  const iteration = parsed.values.get("iteration");
  const type = parsed.values.get("type");
  const render = (card: ReturnType<typeof requirementSummary>) =>
    `${card.id}  ${card.type === "defect" ? "Defect" : "Requirement"}  ${card.priority}  ${card.iteration || "—"}  ${card.status}${card.disposition ? ` [${card.disposition}]` : ""}  ${card.progress.done}/${card.progress.total}  ${sanitize(card.title)}`;
  if (operation === "list") {
    if (values.length) throw new UsageError(`Use herdr-team ${name} list without an issue ID`);
    const selectedType = type === undefined ? undefined : requirementType(type);
    const selectedVersion = iteration === undefined ? undefined : validateIteration(iteration);
    const { status, disposition } = cardListFilters(parsed, REQUIREMENT_STATUSES, ["archived"]);
    const includeHidden = parsed.flags.has("all") || disposition !== undefined;
    const hidden = readHiddenIterations(project);
    const linkedTasks = indexRequirementTasks(project);
    const rows = listIssueMetadata(project)
      .filter(card => {
        const version = iterationVersion(card.iteration);
        return card.disposition !== "deleted" && matchesIteration(version, selectedVersion, hidden) &&
          (includeHidden || card.disposition === undefined) && (disposition === undefined || card.disposition === disposition) &&
          (selectedType === undefined || card.type === selectedType);
      })
      .sort((a, b) => a.priority.localeCompare(b.priority) || b.id.localeCompare(a.id))
      .map(card => requirementSummary(card, linkedTasks.get(card.id) ?? []))
      .filter(card => status === undefined || card.status === status);
    return out(parsed, rows, rows.length ? rows.map(render).join("\n") : "No issues match. Use issue list --all to include Archive.");
  }
  if (operation === "add") {
    const card = addRequirement(project, {
      title: values.join(" "), type: requirementType(type ?? "requirement"), priority: parsed.values.get("priority") ?? "P2",
      iteration: iteration ?? "", body: readBody(parsed), acceptance: parsed.values.get("acceptance") ?? "",
    });
    return out(parsed, card, `Created ${card.id}  ${sanitize(card.title)}`);
  }
  if (operation === "edit") {
    const patch: Partial<Pick<Requirement, "title" | "iteration" | "priority" | "type" | "body" | "acceptance">> = {};
    for (const key of ["title", "iteration", "priority", "acceptance"] as const) {
      const value = parsed.values.get(key);
      if (value !== undefined) patch[key] = value;
    }
    if (type !== undefined) patch.type = requirementType(type);
    if (parsed.values.has("body") || parsed.values.has("body-file")) patch.body = readBody(parsed);
    const keys = Object.keys(patch);
    if (!values.length || !keys.length || values.length > 1 && (keys.length !== 1 || keys[0] !== "iteration")) {
      throw new UsageError(`Provide one issue ID and fields, or several IDs with --iteration only. See herdr-team ${name} --help.`);
    }
    const updated = editRequirements(project, values, patch);
    return out(parsed, updated, `Updated ${updated.map(card => card.id).join(", ")}`);
  }
  const id = values[0];
  if ((operation === "link" || operation === "unlink") && values.length === 2 && id) {
    linkRequirementTask(project, id, values[1]!, operation === "unlink");
    return out(parsed, { id, task: values[1], linked: operation === "link" },
      `${operation === "link" ? "Linked" : "Unlinked"} ${id} and task ${values[1]}`);
  }
  if (!id || values.length !== 1) throw new UsageError(`Run herdr-team ${name} --help for the required IDs`);
  if (operation === "accept") {
    const card = acceptRequirement(project, id);
    return out(parsed, card, `Accepted ${card.id}  ${sanitize(card.title)}`);
  }
  if (operation !== "show") throw new UsageError("Linking requires a requirement ID and a task ID");
  const detail = requirementDetail(project, readIssue(project, id));
  return out(parsed, detail, [render(detail),
    ...(detail.body ? ["", sanitize(detail.body, true)] : []),
    ...(detail.acceptance ? ["", "Acceptance criteria", sanitize(detail.acceptance, true)] : []),
    ...(detail.tasks.length ? ["", "Tasks", ...detail.tasks.map(task => `  #${task.id}  ${task.status}  ${sanitize(task.title)}`)] : []),
  ].join("\n"));
}

function cmdIssueDisposition(args: string[], action: "archive" | "delete" | "restore"): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team issue ${action} ID [--root DIR | --project ID] [--json]\n`);
    return 0;
  }
  checkOptions(parsed, ["root"]);
  const id = parsed.pos[0];
  if (!id || parsed.pos.length !== 1) throw new UsageError(`Provide one issue ID to ${action}.`);
  const project = loadValidated(resolveRoot(parsed.values.get("root")), { taskBodies: false, roleBodies: false });
  const card = setRequirementDisposition(project, id, action === "archive" ? "archived" : action === "delete" ? "deleted" : undefined);
  return out(parsed, card, `${action === "archive" ? "Archived" : action === "delete" ? "Deleted" : "Restored"} issue ${id}.`);
}

function cmdIssueMigrate(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team issue migrate [--root DIR | --project ID] [--json]\n");
    return 0;
  }
  checkOptions(parsed, ["root"]);
  if (parsed.pos.length) throw new UsageError("Run herdr-team issue migrate without an issue ID");
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root, { taskBodies: false, roleBodies: false });
  const migrated = withTeamLock(project, "queue", () => migrateIssueStore(project));
  return out(parsed, { migrated }, migrated ? `Migrated ${migrated} issues to .herdr/issues.` : "No legacy issues to migrate.");
}

function cmdIteration(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      "Usage: herdr-team iteration list [--all]\n" +
      "       herdr-team iteration <archive|delete|restore> <version>\n" +
      "Archived iterations can be browsed with an explicit --iteration filter. Restore returns them to default lists.\n" +
      "Supports --root DIR, --project ID and --json. Use --all to include hidden iterations.\n",
    );
    return 0;
  }
  const [operation = "list", version] = parsed.pos;
  const all = parsed.flags.has("all");
  const states = { archive: "archived", delete: "deleted", restore: "active" } as const;
  if ([...parsed.values.keys()].some(key => key !== "root") ||
      [...parsed.flags].some(flag => flag !== "json" && !(flag === "all" && operation === "list")) ||
      (operation === "list" ? version !== undefined : parsed.pos.length !== 2 || !Object.hasOwn(states, operation))) {
    throw new UsageError("Invalid iteration command or option; run herdr-team iteration --help");
  }
  const project = loadValidated(resolveRoot(parsed.values.get("root")), { taskBodies: false, roleBodies: false });
  if (operation === "list") {
    const rows = iterationRows(project, all);
    return out(parsed, rows, rows.length ? rows.map(row => `${row.version}  ${row.state}`).join("\n") : "No iterations.");
  }
  const row = setIterationState(project, version!, states[operation as keyof typeof states]);
  return out(parsed, row, `Iteration ${row.version} is ${row.state}.`);
}

async function cmdFeature(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["iteration", "root", "commit", "base"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team feature <finish|merge|clean> <name> --iteration VERSION [--root DIR | --project ID] [--json]\n" +
      "  merge    Integrate the validated feature with --base BRANCH --commit SHA and let the daemon reclaim its workspace.\n" +
      "  finish   Confirm an existing task-scoped delivery.\n" +
      "  clean    Reclaim only the confirmed delivery's worktrees, terminals and spaces.\n");
    return 0;
  }
  const [op, name] = parsed.pos;
  const version = parsed.values.get("iteration");
  const commit = parsed.values.get("commit"), base = parsed.values.get("base");
  if (op !== "finish" && op !== "merge" && op !== "clean" || parsed.pos.length !== 2 || !name || !version ||
      op === "merge" && (!commit || !base) ||
      [...parsed.flags].some(flag => flag !== "json") ||
      [...parsed.values.keys()].some(key => key !== "root" && key !== "iteration" && (op !== "merge" || key !== "commit" && key !== "base"))) {
    throw new UsageError("Run herdr-team feature --help for the required arguments");
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  if (op === "clean") {
    const scope = { feature: validateFeature(name), iteration: validateIteration(version) };
    const key = featureKey(scope);
    const confirmation = confirmedFeatures(project).get(key);
    if (!confirmation) throw new FeatureError(`Confirm delivery of ${key} before cleaning it`);
    return printCleanup(parsed, await cleanTasks(project, confirmation.tasks));
  }
  const result = finishFeature(project, name, version, op === "merge" ? { commit: commit!, base: base! } : undefined);
  logDaemon("feature.delivered", { project: root, feature: result.feature, iteration: result.iteration, count: result.tasks.length });
  await wakeDaemon(root);
  return out(parsed, result, op === "merge" ? `Integrated ${featureKey(result)} into ${base}. The daemon will reclaim eligible workspace resources.`
    : `Confirmed delivery of ${featureKey(result)}. The daemon will close eligible temporary sessions.`);
}

async function cmdService(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["root", "space"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team service list --space ID [--root DIR | --project ID] [--json]\n" +
      "       herdr-team service <start|stop|restart> NAME --space ID [--root DIR | --project ID] [--json]\n" +
      "Services are declared in herdr-services.json and run in a local Desktop team or feature workspace.\n");
    return 0;
  }
  const [action, name] = parsed.pos;
  const space = parsed.values.get("space");
  const request = { action, name, space };
  const list = action === "list" && parsed.pos.length === 1;
  if (!space || !/^[A-Za-z0-9_-]{1,128}$/.test(space) ||
      (!list && (parsed.pos.length !== 2 || !isServiceRequest(request))) ||
      [...parsed.flags].some(flag => flag !== "json") || [...parsed.values.keys()].some(key => key !== "root" && key !== "space")) {
    throw new UsageError("Run herdr-team service --help for the required arguments");
  }
  const root = resolveRoot(parsed.values.get("root"));
  if (isServiceRequest(request)) {
    const row = await requestDaemonService(root, request);
    return out(parsed, row, `${row.name}  ${row.state}${"port" in row ? `  ${row.port}` : ""}${"reason" in row && row.reason ? `  ${row.reason}` : ""}`);
  }
  const result = listDesktopServices({ root, herdrDir: join(root, ".herdr") }, realDesktop(), space);
  const lines = result.services.map(row => `${row.name}  ${row.state}${"port" in row ? `  ${row.port}` : ""}${"reason" in row && row.reason ? `  ${row.reason}` : ""}`);
  return out(parsed, result, [result.error, ...lines].filter(Boolean).join("\n") || "No services declared.");
}

async function cmdEdit(args: string[], name = "edit"): Promise<number> {
  const values = [
    "root",
    "title",
    "role",
    "handoff",
    "depends-on",
    "priority",
    "status",
    "body",
    "iteration",
    "feature",
  ];
  const parsed = parseArgs(args, values);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} ID [--title TITLE] [--role ROLE] [--handoff ROLES] [--depends-on IDS] [--priority Pn] [--status STATUS] [--feature NAME] [--iteration VERSION] [--force] [--root DIR | --project ID] [--json]\nUse --iteration '' to clear the override and inherit the issue’s iteration.\n`);
    return 0;
  }

  const id = parsed.pos[0];
  checkOptions(parsed, values, ["force"]);
  if (!id || parsed.pos.length !== 1) throw new UsageError("Provide one task ID, for example herdr-team task update 0001 --priority P1.");
  if (![...parsed.values.keys()].some(key => key !== "root")) throw new UsageError("Specify at least one field to update, such as --title or --priority.");
  const status = parsed.values.get("status");
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new UsageError(`Use one of these task statuses: ${STATUSES.join(", ")}.`);

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  const handoffRaw = parsed.values.get("handoff");
  const dependsOnRaw = parsed.values.get("depends-on");
  const body = readBody(parsed);
  const { schedulingOnly, ...result } = editTask(
    project,
    id,
    {
      title: parsed.values.get("title"),
      role: parsed.values.get("role"),
      handoff: handoffRaw === undefined ? undefined : csv(handoffRaw),
      dependsOn: dependsOnRaw === undefined ? undefined : csv(dependsOnRaw),
      priority: parsed.values.get("priority"),
      status,
      iteration: parsed.values.get("iteration"),
      feature: parsed.values.get("feature"),
      body: parsed.values.has("body") || parsed.values.has("body-file") ? body : undefined,
    },
    parsed.flags.has("force"),
  );

  logDaemon("task.edited", { project: root, task: id });
  if (!schedulingOnly) {
    refreshSidebar(project, herdrClient());
    await wakeDaemon(root);
  }
  return out(parsed, result, `✓ Updated ${result.dir}`);
}

/** Configuration commands do not require local task/runtime state. */
function resolveConfigRoot(explicit?: string): string {
  if (explicit !== undefined) return resolve(explicit);
  if (findTeamRoots(process.cwd(), true).length) return resolveRoot(undefined, true);
  return findRoot(process.cwd()) ?? resolve(process.cwd());
}

function cmdInit(args: string[], name = "init"): number {
  const parsed = parseArgs(args.map(arg => arg === "-demo" ? "--demo" : arg), ["root", "roles", "roles-file", "plan"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      `Usage: herdr-team ${name} [--plan ${PLAN_NAMES.join("|")} | --roles-file FILE | --roles JSON] [--force] [--root DIR | --project ID] [--json]\n\n` +
        PLAN_NAMES.map((p) => `  --plan ${p.padEnd(10)}${describePlan(p)}`).join("\n") +
        "\nInit registers the project on this computer. Run herdr-team team up when ready to start the team.\nProject root agents.json defines the agent presets referenced by role plans.\n--force rewrites role metadata and preserves existing prompt.md.\n",
    );
    return 0;
  }
  if (parsed.flags.has("demo") || demoSettings(resolve(parsed.values.get("root") ?? process.cwd())).enabled) {
    if (parsed.pos.length || [...parsed.values.keys()].some(key => key !== "root") ||
        [...parsed.flags].some(flag => flag !== "demo" && flag !== "json")) {
      throw new UsageError("For a configured demo, use herdr-team team init [--root DIR] [--json]");
    }
    const demo = initDesktopDemo(parsed.values.get("root") ?? process.cwd());
    registerProjectRoot(loadValidated(demo.root));
    logDaemon("project.registered", { project: demo.root, action: "init" });
    return out(parsed, { ...demo, registered: true }, `Demo project initialized and registered: ${demo.root}`);
  }

  const inline = parsed.values.get("roles");
  const file = parsed.values.get("roles-file");
  const plan = parsed.values.get("plan");
  if (["workflow", "workflow-file"].some((name) => parsed.flags.has(name) || parsed.values.has(name))) throw new UsageError("Workflow configuration belongs to the skill; save the agreement in root TEAM.md");
  checkOptions(parsed, ["root", "roles", "roles-file", "plan"], ["force"]);
  if (parsed.pos.length) throw new UsageError("Initialize the current directory or specify it with --root DIR.");
  const root = resolveConfigRoot(parsed.values.get("root"));
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
  registerProjectRoot(loadValidated(root));
  logDaemon("project.registered", { project: root, action: "init" });

  const lines: string[] = [];
  if (result.created.length > 0) lines.push(`created: ${result.created.join(", ")}`);
  if (result.roleMetadataWritten.length > 0) lines.push(`Role metadata written: ${result.roleMetadataWritten.join(", ")}`);
  if (result.roleBodiesWritten.length > 0) lines.push(`Role bodies written: ${result.roleBodiesWritten.join(", ")}`);
  if (result.roleBodiesPreserved.length > 0) lines.push(`Role bodies preserved: ${result.roleBodiesPreserved.join(", ")}`);
  if (result.skipped.length > 0) lines.push(`skipped: ${result.skipped.join(", ")}`);
  lines.push(`\nroot: ${root}`);
  lines.push("Project registered. Run herdr-team team up to start the team.");

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

  return out(parsed, { root, ...result, registered: true }, lines.join("\n"));
}

function cmdStatus(args: string[], name = "status"): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} [--all] [--root DIR | --project ID] [--json]\n` + BODY_USAGE);
    return 0;
  }
  checkOptions(parsed, ["root"], ["all"]);
  if (parsed.pos.length) throw new UsageError("Team status takes project options only.");
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root, { taskBodies: false, roleBodies: false });
  // Status is also a data query used by integrations with no terminal caller.
  const context = process.env["HC_TERMINAL_ID"] ? managedContext() : null;
  if (context?.kind === "desktop") {
    const client = realDesktop();
    const binding = savedDesktopBinding(project);
    if (!binding || showDesktopBinding(client, binding.space)?.root !== binding.root) throw new DesktopError("No valid project space binding; run up first");
    const agents = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { labels: { "team.project": binding.root, "team.owner_space": binding.space } }).terminals;
    const result = { binding, agents, tasks: project.tasks.filter(task => parsed.flags.has("all") || !isTaskInactive(task)).map(cardForJson) };
    return out(parsed, result, [`space ${binding.space}  ${binding.root}`, ...agents.map(agent =>
      `${agent.labels["team.role"] ?? "?"}  ${agent.address}  ${agentStatusLabel(agent.status?.state ?? "unknown")}`),
    formatTasks(project.tasks, project.roles)].join("\n"));
  }
  const report = buildReport(project, herdrClient(), parsed.flags.has("all"));

  if (parsed.flags.has("json")) {
    return out(parsed, { ...report, tasks: report.tasks.map(cardForJson) }, "");
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  return 0;
}

async function cmdHandoff(args: string[], name = "handoff"): Promise<number> {
  const values = ["root", "summary", "summary-file", "delivery", "commit", "accept", "pr"];
  const parsed = parseArgs(args, values);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} ID [--delivery ID] [--summary TEXT | --summary-file FILE] [--commit SHA | --accept SHA [--pr URL] | --reject] [--root DIR | --project ID] [--json]\nUse --commit to submit a revision, --accept to approve it, or --reject to return it to the developer. Final approval queues integration.\n`);
    return 0;
  }
  checkOptions(parsed, values, ["reject"]);
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
  const result = handoff(project, executionRuntime(project), id, new Date(), { summary, delivery: parsed.values.get("delivery"), commit: parsed.values.get("commit"), accept: parsed.values.get("accept"), reject: parsed.flags.has("reject"), pr: parsed.values.get("pr"), deferDelivery: true });
  logDaemon("task.handoff", { project: root, task: result.id, from: result.from, to: result.to,
    state: result.status, delivery: result.delivery, deliveryState: result.queueState, duplicate: result.duplicate ?? false });
  await wakeDaemon(root);

  return out(parsed, result, `✓ ${result.note}`);
}

async function cmdMerge(args: string[], name = "merge"): Promise<number> {
  const parsed = parseArgs(args, ["root", "migrate"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} [list | next | ID | retry ID] [--migrate COMMAND] [--root DIR | --project ID] [--json]\nIntegrate an approved PR or local commit. Inspect blocked or interrupted integrations before retrying.\n`);
    return 0;
  }
  checkOptions(parsed, ["root", "migrate"]);
  const project = loadValidated(resolveRoot(parsed.values.get("root")));
  const sub = parsed.pos[0] ?? "list";
  if (sub === "list" && parsed.pos.length <= 1) {
    const rows = mergeRows(project);
    return out(parsed, rows, rows.length ? rows.map((r) => `${r.id}  ${r.state}  ${r.commit}${r.reason ? `  ${r.reason}` : ""}`).join("\n") : "No accepted tasks awaiting integration.");
  }
  if (sub === "retry" && parsed.pos.length === 2) {
    retryMerge(project, parsed.pos[1]!);
    logDaemon("integration.retry", { project: project.root, task: parsed.pos[1] });
    return out(parsed, { id: parsed.pos[1], state: "queued" }, `Requeued integration #${parsed.pos[1]} after reconciliation.`);
  }
  if (parsed.pos.length !== 1 || sub !== "next" && !/^\d{4}$/.test(sub)) throw new UsageError("Use merge list, merge next, merge <id>, or merge retry <id>");
  const result = mergeTask(project, sub === "next" ? undefined : sub, parsed.values.get("migrate"));
  logDaemon("integration.result", { project: project.root, task: result.id, state: result.state });
  await wakeDaemon(project.root);
  return out(parsed, result, `Integrated #${result.id} at ${result.commit}.`);
}

async function cmdAgentMail(args: string[]): Promise<number> {
  const writing = args[0] === "route" && args[1] === "add";
  const options = ["root", "inbox", "role", "subject-contains", "subject-not-contains", "label"];
  const parsed = parseArgs(args, writing ? options : []);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      "Usage: herdr-team agentmail check [--json]\n" +
      "       herdr-team agentmail route list [--json]\n" +
      "       herdr-team agentmail route add <id> --inbox EMAIL --role ROLE [--root DIR | --project ID]\n" +
      "         [--subject-contains TEXT] [--subject-not-contains TEXT] [--label LABEL] [--json]\n" +
      "Routes are global. Add selects the current project unless specified. Check verifies AgentMail inbox access.\n");
    return 0;
  }
  const [command, operation, id] = parsed.pos;
  if ([...parsed.flags].some(flag => flag !== "json") ||
      [...parsed.values.keys()].some(key => !writing || !options.includes(key))) {
    throw new UsageError("Unknown AgentMail option; run herdr-team agentmail --help");
  }
  const describe = (route: NonNullable<ReturnType<typeof readAgentMailRoutes>>[number]) =>
    `${route.id}  ${route.inbox} → ${route.project}/${route.role}`;
  if (command === "route" && operation === "list" && parsed.pos.length === 2) {
    const routes = readAgentMailRoutes() ?? [];
    return out(parsed, routes, routes.length ? routes.map(route => {
      const filters = [route.subject_contains && `subject contains ${JSON.stringify(route.subject_contains)}`,
        route.subject_not_contains && `subject excludes ${JSON.stringify(route.subject_not_contains)}`,
        route.label && `label ${JSON.stringify(route.label)}`].filter(Boolean);
      return filters.length ? `${describe(route)}  ·  ${filters.join(" · ")}` : describe(route);
    }).join("\n") : "No AgentMail routes configured.");
  }
  if (writing && id && parsed.pos.length === 3) {
    const inbox = parsed.values.get("inbox"), role = parsed.values.get("role");
    if (!NAME_RE.test(id)) throw new UsageError("Invalid AgentMail route ID; use up to 32 lowercase letters, digits and hyphens, starting with a letter");
    if (!inbox || !role) throw new UsageError("AgentMail route add requires --inbox EMAIL and --role ROLE");
    const project = loadValidated(resolveRoot(parsed.values.get("root")));
    if (!project.roles.some(card => card.name === role)) throw new UsageError(`Unknown role ${role} in the selected project`);
    const projectId = projectKey(project).slice(0, 12);
    const registration = inboxProjectStates().get(projectId) ?? "unregistered";
    const route = addAgentMailRoute({
      id, inbox: inbox.toLowerCase(), project: projectId, role,
      subject_contains: parsed.values.get("subject-contains"),
      subject_not_contains: parsed.values.get("subject-not-contains"),
      label: parsed.values.get("label"),
    });
    logDaemon("agentmail.route_added", { projectId, inbox: route.inbox, role, rule: id });
    const notice = registration === "unregistered" ? "\nProject is unregistered. Run herdr-team project register to route new mail to the active Inbox." :
      registration !== "registered" ? `\n${mailTrashReasonLabel(registration)}.` : "";
    return out(parsed, route, `Added AgentMail route ${describe(route)}${notice}`);
  }
  if (command !== "check" || parsed.pos.length !== 1) {
    throw new UsageError("Use agentmail check, agentmail route list, or agentmail route add; run herdr-team agentmail --help");
  }
  const result = await checkAgentMail();
  return out(parsed, result, [
    `AgentMail connected (${result.inboxes.length} inbox${result.inboxes.length === 1 ? "" : "es"})`,
    "Configured Inbox routes",
    ...result.routes.map(route => `  ${describe(route)}`),
  ].join("\n"));
}

async function cmdDaemon(args: string[]): Promise<number> {
  if (args[0] === "_pass" && (args.length === 2 || args.length === 3)) {
    await daemonPass(args[1]!, args[2] === undefined ? undefined : JSON.parse(args[2]));
    return 0;
  }
  if (args[0] === "_serve" && args.length === 1) { await serveDaemon(); return 0; }
  const parsed = parseArgs(args.map(arg => arg === "-f" ? "--follow" : arg), ["lines"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team daemon <start | status | stop> [--json]\n" +
      "       herdr-team daemon logs [--lines N] [-f | --follow] [--json]\n" +
      "Follow appends new entries until interrupted. Use --lines 0 with follow to skip existing entries. JSON follow emits one record per line.\n" +
      "Manage the shared service. up registers each project. stop preserves project registrations and pending work.\n");
    return 0;
  }
  const operation = parsed.pos[0] ?? "status";
  if (parsed.pos.length > 1 || !["start", "status", "stop", "logs"].includes(operation)) {
    throw new UsageError("Use daemon start, daemon status, daemon stop, or daemon logs");
  }
  const follow = parsed.flags.has("follow");
  if ([...parsed.flags].some(flag => flag !== "json" && !(operation === "logs" && flag === "follow")) ||
      [...parsed.values].some(([key]) => operation !== "logs" || key !== "lines")) {
    throw new UsageError("Unknown option for daemon " + operation);
  }
  if (operation === "logs") {
    const lines = Number(parsed.values.get("lines") ?? "50");
    const minimum = follow ? 0 : 1;
    if (!Number.isInteger(lines) || lines < minimum || lines > 1000) throw new UsageError(`--lines must be an integer between ${minimum} and 1000`);
    const decode = (line: string): unknown => {
      try { return JSON.parse(line); } catch { return line; }
    };
    if (follow) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      const json = parsed.flags.has("json");
      let returned = 0;
      let outputError: NodeJS.ErrnoException | undefined;
      const failedOutput = (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") outputError = error;
        stop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stdout.on("error", failedOutput);
      try {
        await followDaemonLog(lines, line => {
          const record = decode(line);
          process.stdout.write((json ? JSON.stringify(record) : formatDaemonLog(record)) + "\n", error => {
            if (error) failedOutput(error);
          });
          returned++;
        }, controller.signal);
        if (outputError) throw outputError;
        return 0;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        logDaemon("daemon.logs", { lines, returned, follow: true });
      }
    }
    const entries = readDaemonLog(lines);
    logDaemon("daemon.logs", { lines, returned: entries.length });
    const records = entries.map(decode);
    return out(parsed, records, entries.length ? records.map(formatDaemonLog).join("\n") : `No daemon log entries yet. Log file: ${daemonLogPath()}`);
  }
  const result = operation === "start" ? await startDaemon() : operation === "stop" ? await stopDaemon() : await daemonStatus();
  if (operation !== "start") logDaemon(`daemon.${operation}`, {
    state: result.state, daemonPid: result.pid, projects: result.teams?.length ?? 0,
  });
  const directory = daemonDirectory();
  return out(parsed, operation === "status" ? { ...result, directory: existsSync(directory) ? realpathSync(directory) : directory } : result, [
    `Team daemon ${result.state}${result.pid ? ` (PID ${result.pid})` : ""}`,
    ...(result.teams ?? []).map(team => `  ${team.runtime} ${team.space}  ${team.root}${team.error ? `  (${team.error})` : ""}`),
    ...(result.state === "running" && !result.teams?.length ? ["  No active projects."] : []),
    ...(result.agentmail ? [`  AgentMail ${result.agentmail.state}${result.agentmail.error ? `  (${result.agentmail.error})` : ` (${result.agentmail.inboxes} inbox${result.agentmail.inboxes === 1 ? "" : "es"})`}`] : []),
  ].join("\n"));
}

async function cmdUp(args: string[], command = "up"): Promise<number> {
  const parsed = parseArgs(args.map(arg => arg === "-demo" ? "--demo" : arg), ["root", "name"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${command} [--name NAME] [--fresh] [--root DIR | --project ID] [--json]\n` +
      "Start a project team in the current Desktop Space.\n");
    return 0;
  }
  // Mock workers call up internally; they must not recursively start a showcase.
  const demoRoot = resolveRoot(parsed.values.get("root"));
  if (!process.env.HERDR_SMOKE_MANIFEST &&
      (parsed.flags.has("demo") || demoSettings(demoRoot).enabled)) {
    if (parsed.pos.length || [...parsed.values.keys()].some(key => key !== "root") ||
        [...parsed.flags].some(flag => !["demo", "fast", "json"].includes(flag))) {
      throw new UsageError("Demo startup accepts only --root and --json");
    }
    const demo = await runDesktopDemo(realpathSync(demoRoot), parsed.flags.has("fast"), parsed.flags.has("json"));
    return out(parsed, demo, `Demo complete: ${demo.tasks.length} tasks integrated, ${demo.terminalsReclaimed} mock agents reclaimed.`);
  }
  if (parsed.flags.has("fast")) throw new UsageError("--fast requires demo mode");
  checkOptions(parsed, ["root", "name"], ["fresh"]);
  if (parsed.pos.length) throw new UsageError("Start the current team or select a project with --root DIR or --project ID.");
  const root = resolveRoot(parsed.values.get("root"));
  const context = managedContext();
  const project = loadValidated(root);
  const name = parsed.values.get("name");
  if (name !== undefined) assignProjectAlias(name, root);
  const projectLabel = name !== undefined ? [`  project  ${name}`] : [];
  const endpoint = daemonEndpoint(context.kind);
  if (context.kind === "desktop") {
    const client = realDesktop();
    const space = callerSpace(context.caller, client);
    const proxyEnv = readProxyEnv();
    const result = registerDaemonTeam(project, () => {
      assertDaemonOwner(project, context.kind, endpoint, space);
      const result = desktopUp(project, client, { space, proxyEnv });
      return { result, team: makeDaemonTeam(project, context.kind, endpoint, result.binding.space, proxyEnv) };
    });
    logDaemon("project.registered", { project: root, runtime: context.kind, space: result.binding.space,
      proxyVariables: Object.keys(proxyEnv).join(", ") || undefined });
    const daemon = await startDaemon();
    await wakeDaemon(root);
    out(parsed, { ...result, daemon, ...(name === undefined ? {} : { projectName: name }) }, [`space ${result.binding.space}  ${result.binding.root}`,
      ...projectLabel,
      `  daemon  ${daemon.action} (PID ${daemon.pid})`,
      ...(result.roles.length ? [] : ["  No roles configured."]),
      ...result.roles.map(role => `  ${role.action.padEnd(9)}${role.role}${role.terminal ? `  →  ${role.terminal}` : ""}${role.action === "deferred" ? "  (isolated role: starts when dispatched)" : ""}${role.failure ? `\n      ${role.failure}` : ""}`)].join("\n"));
    return result.roles.some(role => role.action === "failed") ? 2 : 0;
  }
  const herdr = herdrClient();
  const result = registerDaemonTeam(project, () => {
    const existing = readDaemonTeam(projectKey(project));
    assertDaemonOwner(project, context.kind, endpoint, existing ? resolveProjectWorkspace(project, herdr) ?? "" : undefined);
    assertTuiProject(project, herdr, context.pane, false);
    const result = up(project, herdr, { fresh: parsed.flags.has("fresh") });
    return { result, team: makeDaemonTeam(project, context.kind, endpoint, result.workspaceId) };
  });
  logDaemon("project.registered", { project: root, runtime: context.kind, space: result.workspaceId });
  const daemon = await startDaemon();
  await wakeDaemon(root);

  const lines: string[] = [];
  lines.push(`workspace ${result.workspaceLabel} (${result.workspaceId})  ${result.workspaceAction}`);
  lines.push(...projectLabel);
  lines.push(`  daemon  ${daemon.action} (PID ${daemon.pid})`);
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
  return out(parsed, { ...result, daemon, ...(name === undefined ? {} : { projectName: name }) }, lines.join("\n"));
}

function cmdSpace(args: string[]): number {
  const parsed = parseArgs(args, ["root", "space"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team space <show|bind|unbind|sync [TASK]> [--space ID] [--root DIR] [--json]\nup binds the verified caller space automatically. Task spaces resolve to their parent team. sync attaches existing owned task terminals to native worktree spaces without restarting them. show is read-only.\nUse bind --core from a terminal in the Space to connect a project when no window runs on that machine. show --core --space ID reads the binding from that machine's Core registry.\n");
    return 0;
  }
  const operation = parsed.pos[0] ?? "show";
  const core = parsed.flags.has("core"), space = parsed.values.get("space");
  if (core && (parsed.pos.length !== 1 || !["show", "bind"].includes(operation) ||
      space?.includes("/") || operation === "show" && (!space || parsed.values.has("root")))) {
    throw new UsageError("Use space show --core --space ID or space bind --core with a machine-local Space ID");
  }
  const client = realDesktop();
  if (operation === "show" && space) {
    const binding = core ? registeredDesktopBinding(client, space) : showDesktopBinding(client, space);
    const view = binding && isDesktopDemo(binding.root) ? { ...binding, demo: true } : binding;
    return out(parsed, { binding: view }, binding ? `${binding.space}  ${binding.root}` : "No team bound to this space.");
  }
  const root = resolveRoot(parsed.values.get("root"));
  if (operation === "show") {
    const saved = savedDesktopBinding({ root });
    const binding = saved ? showDesktopBinding(client, saved.space) : null;
    const view = binding && isDesktopDemo(binding.root) ? { ...binding, demo: true } : binding;
    return out(parsed, { binding: view }, binding ? `${binding.space}  ${binding.root}` : "No team bound to this project.");
  }
  if (operation === "sync") {
    if (parsed.pos.length > 2) throw new UsageError("space sync accepts at most one task ID");
    const context = managedContext();
    if (context.kind !== "desktop") throw new DesktopError("Task space sync requires a verified Desktop caller");
    const project = loadValidated(root);
    desktopTaskRuntime(project, client, context.caller);
    const result = syncDesktopTaskSpaces(project, client, parsed.pos[1]);
    return out(parsed, result, result.length ? result.map(task => `${task.id}  ${task.space}  ${task.checkout}`).join("\n") : "No live task terminals to attach.");
  }
  if (operation !== "bind" && operation !== "unbind") throw new UsageError("Use space show, space bind or space unbind");
  const context = managedContext();
  if (context.kind !== "desktop") throw new DesktopError("This operation requires a verified space-backed caller");
  return withTeamLock({ root }, "desktop", () => {
    if (operation === "unbind") {
      if (readDaemonTeam(projectKey({ root }))) throw new DesktopError("Run herdr-team down before removing the project space binding");
      unbindDesktop({ root }, client);
      return out(parsed, { unbound: true }, "Project space binding removed.");
    }
    loadValidated(root);
    const binding = core ? bindDesktop({ root }, client, space, context.caller)
      : bindDesktop({ root }, client, space ?? callerSpace(context.caller, client));
    return out(parsed, { binding }, `Bound ${binding.space} to ${binding.root}`);
  });
}

async function cmdDispatch(args: string[], name = "dispatch"): Promise<number> {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} ID [--root DIR | --project ID] [--json]\nEnqueue one todo task. The shared daemon delivers assignments for running teams.\n`);
    return 0;
  }
  if (parsed.flags.has("all") || parsed.values.has("all")) throw new UsageError("dispatch --all is not supported; use dispatch <id>");
  if ([...parsed.flags].some(flag => flag !== "json") || [...parsed.values.keys()].some(key => key !== "root")) {
    throw new UsageError("Unknown option for dispatch; use dispatch --help");
  }
  const [id] = parsed.pos;
  if (parsed.pos.length !== 1 || id === undefined || !/^\d{4}$/.test(id)) {
    throw new UsageError("dispatch requires exactly one task ID, for example dispatch 0001");
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const task = findTask(project, id);
  if (taskDisposition(task)) throw new TaskError(`Restore task ${id} before dispatching it`);
  if (task.status === "todo" && !readDaemonTeam(projectKey(project))) {
    throw new TaskError("Start the team with herdr-team team up before dispatching tasks");
  }
  if (task.status === "todo" && scopeFor(project, task)) {
    const daemon = await daemonStatus();
    if (daemon.state === "running" && !daemon.featureWorkspaces) {
      throw new FeatureError("Restart the team daemon to enable shared feature workspaces");
    }
  }
  const result = dispatch(project, executionRuntime(project), id, true);
  logDaemon("dispatch.completed", { project: root, task: id, count: result.length });
  for (const delivery of result) logDaemon("dispatch.result", { project: root, task: delivery.id,
    role: delivery.role, state: delivery.action, reason: deliveryLogReason(delivery.reason) });
  await wakeDaemon(root);
  const lines = result.map((d) =>
    `  ${d.id}  ${d.role}  ${d.action}${d.reason === undefined ? "" : `  (${d.reason})`}`,
  );
  return out(parsed, result, lines.join("\n"));
}

async function cmdClaim(args: string[], name = "claim"): Promise<number> {
  const parsed = parseArgs(args, ["root", "delivery"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} ID --delivery ID [--root DIR | --project ID] [--json]\nClaim the current delivery before working on the task.\n`); return 0;
  }
  checkOptions(parsed, ["root", "delivery"]);
  if (parsed.pos.length !== 1 || !parsed.values.get("delivery")) throw new UsageError("claim requires one task ID and --delivery ID");
  const project = loadValidated(resolveRoot(parsed.values.get("root")));
  const runtime = taskRuntime(executionRuntime(project));
  if (!runtime.envOk()) throw new LaunchError("Run claim inside a verified Herdr terminal");
  const result = claimTask(project, parsed.pos[0]!, parsed.values.get("delivery")!, (task, delivery) => {
    runtime.assertDelivery(delivery); runtime.authorize?.(task, delivery);
  });
  logDaemon("task.claimed", { project: project.root, task: result.id, delivery: result.delivery, duplicate: result.duplicate });
  await wakeDaemon(project.root);
  return out(parsed, result, result.duplicate ? `Delivery already claimed; do not start another copy of #${result.id}.` : `Claimed #${result.id}.`);
}

async function cmdDown(args: string[], name = "down"): Promise<number> {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      `Usage: herdr-team ${name} [--workspace] [--root DIR | --project ID] [--json]\n\n` +
        "Stops this project's agents and pauses automatic delivery. Desktop keeps Spaces, worktrees, and other terminals.\n" +
        "TUI only: --workspace also closes the workspace group and all its tabs.\n",
    );
    return 0;
  }
  if (parsed.pos.length || [...parsed.flags].some(flag => flag !== "workspace" && flag !== "json") ||
      [...parsed.values.keys()].some(key => key !== "root")) throw new UsageError("Invalid option for down; run herdr-team down --help");
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const context = managedContext();
  if (context.kind === "desktop") {
    if (parsed.flags.has("workspace")) throw new DesktopError("Desktop down cannot close a space");
    const client = realDesktop();
    desktopTaskRuntime(project, client, context.caller);
    const binding = savedDesktopBinding(project)!;
    const demoService = join(root, ".herdr", "demo", "service");
    const endpoint = daemonEndpoint(context.kind);
    // The registration lock excludes a concurrent daemon pass or up until
    // shutdown finishes. The queue lock inside desktopDown excludes delivery.
    const pause = (afterPause: (paused: boolean) => ReturnType<typeof desktopDown> & { paused: boolean }, directory?: string) =>
      pauseDaemonTeam(project, context.kind, endpoint, binding.space, afterPause, directory);
    const stop = (paused: boolean) => ({ paused, ...desktopDown(project, client, binding, context.caller.address) });
    const privateService = isDesktopDemo(root) && demoService !== daemonDirectory() &&
      readDaemonTeam(projectKey(project), false, demoService) ? demoService : undefined;
    const result = privateService
      ? pause(paused => pause(demoPaused => stop(paused || demoPaused), privateService))
      : pause(stop);
    logDaemon("project.down", { project: root, runtime: context.kind, space: binding.space,
      paused: result.paused, stopped: result.stopped.length, failed: result.failed.length });
    await wakeDaemon(root);
    if (privateService) await wakeDaemon(root, privateService);
    const lines = [
      `Delivery paused. Stopped ${result.stopped.length} agents.`,
      ...result.skipped.map(({ role, terminal, reason }) => `  Skipped ${role}  ${terminal}  ${reason}`),
      ...result.failed.map(({ role, terminal, reason }) => `  Could not stop ${role}  ${terminal}  ${reason}`),
    ];
    out(parsed, { ...result, workspaceId: null }, lines.join("\n"));
    return result.failed.length ? 2 : 0;
  }
  const registered = readDaemonTeam(projectKey(project));
  const herdr = herdrClient();
  assertTuiProject(project, herdr, context.pane, Boolean(registered));
  if (registered) {
    const space = resolveProjectWorkspace(project, herdr);
    if (!space) throw new LaunchError("Cannot verify this team's registered TUI workspace");
    pauseDaemonTeam(project, context.kind, daemonEndpoint(context.kind), space, () => {});
    await wakeDaemon(root);
  }
  const teamWorkspace = parsed.flags.has("workspace") ? resolveProjectWorkspace(project, herdr) : null;
  const result = down(project, herdr);
  logDaemon("project.down", { project: root, runtime: context.kind, paused: Boolean(registered), stopped: result.stopped.length });

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

async function cmdInbox(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["root", "role"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("Usage: herdr-team inbox [list] [--role ROLE] [--root DIR | --project ID] [--all] [--json]\n" +
      "       herdr-team inbox [list] ROLE@PROJECT [--all] [--json]\n" +
      "       herdr-team inbox trash [ROLE@PROJECT | --role ROLE] [--root DIR] [--json]\n" +
      "       herdr-team inbox retry <id> [--root DIR] [--json]\n" +
      "       herdr-team inbox read <mail-id | delivery-id | task-id> [--root DIR] [--json]\n" +
      "       herdr-team inbox <ack | restore> <mail-id> [--root DIR] [--json]\n" +
      "--all includes handled internal deliveries and acknowledged email. Inbox trash shows email and its routing reason.\n" +
      "Retry only after verifying that an uncertain delivery was not processed. Retries receive a new delivery ID.\n");
    return 0;
  }
  if ([...parsed.flags].some(flag => flag !== "json" && flag !== "all") ||
      [...parsed.values.keys()].some(key => key !== "root" && key !== "role")) {
    throw new UsageError("Unknown option for inbox; run inbox --help");
  }
  const retry = parsed.pos[0] === "retry" && parsed.pos.length === 2 && !parsed.values.has("role");
  const operation = parsed.pos[0];
  const mailId = parsed.pos[1];
  const deliveryRead = operation === "read" && parsed.pos.length === 2 && !parsed.values.has("role") &&
    /^(?:\d{4}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(mailId ?? "");
  const mailOperation = (operation === "read" || operation === "ack" || operation === "restore") &&
    mailId && MAIL_ID.test(mailId) &&
    parsed.pos.length === 2 && !parsed.values.has("role");
  const trash = operation === "trash";
  const listArgs = operation === "list" || trash ? parsed.pos.slice(1) : parsed.pos;
  const all = parsed.flags.has("all");
  let root = parsed.values.get("root"), role = parsed.values.get("role");
  if (retry || mailOperation || deliveryRead) {
    if (all) throw new UsageError("--all is only available when listing the Inbox");
  } else if (listArgs.length) {
    const [recipient, projectName, extra] = listArgs[0]!.split("@");
    if (listArgs.length !== 1 || !recipient || !NAME_RE.test(recipient) || !projectName || extra !== undefined) {
      throw new UsageError("Use inbox list, trash, read <id>, ack <mail-id>, restore <mail-id>, or retry <task-id>");
    }
    if (root !== undefined || role !== undefined) throw new UsageError("Use ROLE@PROJECT or the project and role options");
    root = rootForInboxProject(projectName);
    role = recipient;
  }
  const project = loadValidated(resolveRoot(root), { taskBodies: false, roleBodies: false });
  const projectId = projectKey(project).slice(0, 12);
  const messageLines = (message: { sender: string | null; recipient: string; subject: string; body: string }, reason?: string) => [
    `From: ${sanitize(message.sender ?? "") || "Unknown sender"}`,
    `To: ${sanitize(message.recipient)}`,
    `Subject: ${sanitize(message.subject) || "(No subject)"}`,
    ...(reason ? [`Reason: ${reason}`] : []),
    "", sanitize(message.body, true),
  ].join("\n");
  if (deliveryRead) {
    const item = readInboxDelivery(project, mailId!);
    if (!item) throw new TaskError("Internal message was not found in this project's Inbox");
    return out(parsed, item, messageLines(item));
  }
  if (mailOperation) {
    const item = readMail(projectId, mailId!);
    if (!item) throw new TaskError("AgentMail message was not found in this project's Inbox");
    const fields = { project: project.root, role: item.role, mail: item.id };
    if (operation === "restore") {
      const state = inboxProjectStates().get(projectId) ?? "unregistered";
      if (state === "unregistered") throw new TaskError("Register this project before restoring mail. Run herdr-team project register");
      if (state !== "registered") throw new TaskError(mailTrashReasonLabel(state));
      if (!updateMailState(projectId, item.id, "pending", "trashed")) throw new TaskError("Only trashed mail can be restored");
      logDaemon("agentmail.restored", fields);
      await wakeDaemon(project.root);
      return out(parsed, { id: item.id, state: "pending" }, `Restored ${item.id} to Inbox`);
    }
    if (operation === "ack") {
      if (item.state === "trashed") throw new TaskError("Restore this message before acknowledging it");
      if (item.state !== "acknowledged" && !updateMailState(projectId, item.id, "acknowledged", item.state)) {
        throw new TaskError("Inbox message changed; retry acknowledgment");
      }
      logDaemon("agentmail.acknowledged", fields);
      await wakeDaemon(project.root);
      return out(parsed, { id: item.id, state: "acknowledged" }, `Acknowledged ${item.id}`);
    }
    if (!item.read) markMailRead(projectId, item.id);
    logDaemon("agentmail.read", fields);
    const message = { ...item, source: "agentmail", recipient: item.inbox, read: true };
    return out(parsed, message, messageLines(message, item.state === "trashed" ? mailTrashReasonLabel(item.trash_reason) : undefined));
  }
  if (retry) {
    const runtime = taskRuntime(executionRuntime(project));
    const daemon = await daemonStatus();
    if (daemon.state !== "running" || !daemon.teams?.some(team => team.root === project.root)) {
      throw new TaskError("Run herdr-team up to enable automatic delivery for this project before retrying.");
    }
    const result = retryDelivery(project, parsed.pos[1]!, runtime);
    logDaemon("inbox.retry", { project: project.root, task: result.id, state: result.state });
    await wakeDaemon(project.root);
    return out(parsed, result, `#${result.id} is waiting for automatic delivery.`);
  }
  const rows = trash ? [] : inboxDeliveries(project, all, role)
    .map(({ summary_ref: _ref, summary_length: _length, ...row }) => row)
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
  const mailStates = { conflict: "Routing conflict", pending: "Waiting to notify", sending: "Notifying",
    notified: "Awaiting acknowledgment", uncertain: "Notification needs review", acknowledged: "Acknowledged" };
  const mail = listMail(projectId, role ?? null, trash ? "trash" : all ? "all" : "active")
    .sort((a, b) => {
      const left = Date.parse(a.received_at), right = Date.parse(b.received_at);
      return (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity) || a.id.localeCompare(b.id);
    })
    .map(item => ({ ...item, source: "agentmail", recipient: item.inbox,
      label: item.state === "trashed" ? mailTrashReasonLabel(item.trash_reason) : mailStates[item.state] }));
  const mailTime = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown time" : `${stamp(date)}:${String(date.getSeconds()).padStart(2, "0")}`;
  };
  const lines = [
    ...rows.map(row => [`#${row.id}`, sanitize(row.sender ?? "") || "Unknown sender", `→ ${sanitize(row.recipient)}`,
      row.read ? "Read" : "Unread", sanitize(row.subject), row.delivery].join("  ")),
    ...mail.map(item => [mailTime(item.received_at), sanitize(item.subject) || "(No subject)", sanitize(item.sender) || "Unknown sender",
      `→ ${sanitize(item.recipient)}`, item.read ? "Read" : "Unread", item.id, ...(trash ? [item.label] : [])].join("  ")),
  ];
  logDaemon("inbox.checked", { project: project.root, role, all, ...(trash ? { folder: "trash" } : {}), count: lines.length });
  return out(parsed, [...rows, ...mail], lines.length ? lines.join("\n") : trash ? "Inbox trash is empty." : "Inbox is empty.");
}

function cmdTasks(args: string[], mode?: "list" | "show"): number {
  const parsed = parseArgs(args, ["root", "role", "status", "disposition", "iteration"]);
  if (parsed.flags.has("help")) {
    const command = mode ? `task ${mode}` : "tasks";
    const filters = "[--all] [--role ROLE] [--status STATUS] [--disposition archived|deleted] [--iteration VERSION]";
    process.stdout.write(`Usage: herdr-team ${command} ${mode === "show" ? "ID" : (mode === "list" ? filters : "[ID] " + filters)} [--root DIR | --project ID] [--json]\n`);
    return 0;
  }
  if (parsed.pos.length > 1 || mode === "list" && parsed.pos.length || mode === "show" && parsed.pos.length !== 1) {
    throw new UsageError("Use herdr-team task list to browse tasks or herdr-team task show ID for details.");
  }
  checkOptions(parsed, parsed.pos.length ? ["root"] : ["root", "role", "status", "disposition", "iteration"], parsed.pos.length ? [] : ["all"]);
  const { status, disposition } = cardListFilters(parsed, STATUSES, CARD_DISPOSITIONS);
  const root = resolveRoot(parsed.values.get("root"));
  const id = parsed.pos[0];
  const project = loadValidated(root, { taskBodies: id ?? false, roleBodies: false });
  const selected = parsed.values.get("iteration");
  const version = selected === undefined ? undefined : validateIteration(selected);
  const cards = id === undefined ? project.tasks : [findTask(project, id)];
  const inherited = new Set<string>();
  for (const task of cards) {
    if (!task.meta.iteration && typeof task.meta.requirement === "string") inherited.add(task.meta.requirement);
  }
  const issueIterations = new Map(listIssueMetadata(project, inherited).map(card => [card.id, iterationVersion(card.iteration)] as const));
  const scheduled = cards.map(task => ({ ...task, iteration: taskIteration(task, issueIterations) || undefined }));
  if (id !== undefined) {
    if (version !== undefined) throw new UsageError("Use --iteration with the task list");
    const task = scheduled[0]!;
    return out(parsed, task, formatTaskDetail(task));
  }

  const roleFilter = parsed.values.get("role");
  const all = parsed.flags.has("all");
  const hiddenIterations = readHiddenIterations(project);
  const tasks = scheduled
    .filter(t => matchesIteration(t.iteration ?? "", version, hiddenIterations))
    .filter(t => disposition !== undefined ? taskDisposition(t) === disposition
      : all || (status !== undefined ? taskDisposition(t) === undefined : !isTaskInactive(t)))
    .filter((t) => roleFilter === undefined || t.role === roleFilter)
    .filter((t) => status === undefined || t.status === status)
    .sort((a, b) =>
      a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority.localeCompare(b.priority),
    );

  if (parsed.flags.has("json")) {
    return out(parsed, tasks.map(cardForJson), "");
  }
  if (tasks.length) return out(parsed, tasks, formatTasks(tasks, project.roles));
  if (roleFilter !== undefined || status !== undefined || disposition !== undefined || version !== undefined) {
    return out(parsed, tasks, "No tasks match these filters.");
  }
  return out(parsed, tasks, project.tasks.length
    ? "No open tasks. Run herdr-team task list --all to include completed, archived and deleted tasks."
    : 'No tasks yet. Run herdr-team task create "TITLE" --role ROLE to add one.');
}

async function cmdTaskDisposition(args: string[], action: "archive" | "delete" | "restore"): Promise<number> {
  const parsed = parseArgs(args, ["root"]);
  const disposition = action === "archive" ? "archived" : action === "delete" ? "deleted" : undefined;
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team task ${action} ID${disposition ? " [--force]" : ""} [--root DIR | --project ID] [--json]\n`
      + (disposition ? `Move a task to ${action === "archive" ? "Archive" : "Trash"}. --force allows ending an in-progress assignment.\n`
        : "Restore a task from Archive or Trash. Unfinished tasks return to Todo.\n"));
    return 0;
  }
  checkOptions(parsed, ["root"], disposition ? ["force"] : []);
  const id = parsed.pos[0];
  if (!id || parsed.pos.length !== 1) throw new UsageError(`Provide one task ID to ${action}.`);
  const root = resolveRoot(parsed.values.get("root"));
  const task = setTaskDisposition(loadValidated(root), id, disposition, parsed.flags.has("force"));
  logDaemon("task.edited", { project: root, task: id, state: disposition ?? task.status });
  if (task.status !== "done") await wakeDaemon(root);
  return out(parsed, task, `${action === "archive" ? "Archived" : action === "delete" ? "Moved to Trash:" : "Restored"} task #${id}.`);
}

async function cleanTasks(project: Project, ids?: readonly string[]): Promise<CleanupResult[]> {
  executionRuntime(project);
  const team = readDaemonTeam(projectKey(project));
  if (!team) throw new TaskError("Start the team with herdr-team team up before cleaning worktrees");
  const context = managedContext();
  if (context.kind === "desktop" ? context.caller.labels["herdr.space"] !== team.space : !context.pane.startsWith(team.space + ":")) {
    throw new TaskError("Request cleanup from the project's main team workspace");
  }
  return requestDaemonCleanup(project.root, ids);
}

function printCleanup(parsed: ReturnType<typeof parseArgs>, results: CleanupResult[]): number {
  const failures = results.filter(r => r.action !== "removed" && r.action !== "absent");
  const removed = results.filter(r => r.action === "removed").length;
  const absent = results.length - removed - failures.length;
  const summary = [`${removed} removed`, `${absent} already clear`, ...(failures.length ? [`${failures.length} need attention`] : [])];
  const message = results.length ? [`Task resources: ${summary.join(", ")}.`,
    ...failures.map(r => `  #${r.id}  ${r.note}`)].join("\n") : "No finished task resources to clean.";
  out(parsed, results, message);
  return failures.length ? 1 : 0;
}

async function cmdClean(args: string[], name = "clean"): Promise<number> {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(`Usage: herdr-team ${name} [ID] [--root DIR | --project ID] [--json]\nAsk the daemon to reclaim worktrees, terminals and Spaces for finished tasks. Task cards and Git branches are retained.\n`);
    return 0;
  }
  checkOptions(parsed, ["root"]);
  if (parsed.pos.length > 1) throw new UsageError("clean accepts at most one task ID");
  const project = loadValidated(resolveRoot(parsed.values.get("root")));
  return printCleanup(parsed, await cleanTasks(project, parsed.pos.length ? parsed.pos : undefined));
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

async function cmdAgents(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || ["--help", "-h", "help"].includes(sub)) {
    process.stdout.write(
      "Usage: herdr-team agents <list|check|run|test> [options]\n\n" +
      "  list [--kind K] [--json]           List configured presets\n" +
      "  check [kind/preset] [--kind K]     Check local CLI installation, version and login\n" +
      "  run <kind/preset>                 Start a preset interactively\n" +
      "  test <kind/preset> [--json]        Test one model response\n" +
      "  test --all [--kind K] [--json]     Test all matching presets\n\n" +
      "Options: --root DIR, --json (except run), --timeout-ms MS (check: 5000, test: 60000)\n" +
      "Uses repository-root agents.json. Checks send no model requests; unknown login status is not a login failure.\nTests perform real model requests in temporary directories.\n" +
      "Unsupported response-test adapters are reported as skipped. No team tasks or workspaces are created.\n",
    );
    return sub === undefined ? 2 : 0;
  }
  if (!["list", "check", "run", "test"].includes(sub)) throw new UsageError(`Unknown agents subcommand "${sub}" (list / check / run / test)`);
  const parsed = parseArgs(rest, ["root", "kind", "timeout-ms"]);
  if (parsed.flags.has("help") || parsed.pos.includes("-h")) return cmdAgents(["--help"]);
  const allowedFlags = sub === "test" ? ["json", "all"] : ["list", "check"].includes(sub) ? ["json"] : [];
  const allowedValues = sub === "run" ? ["root"] : sub === "list" ? ["root", "kind"] : ["root", "kind", "timeout-ms"];
  for (const flag of parsed.flags) if (!allowedFlags.includes(flag)) throw new UsageError(`Unknown option --${flag} for agents ${sub}`);
  for (const key of parsed.values.keys()) if (!allowedValues.includes(key)) throw new UsageError(`Unknown option --${key} for agents ${sub}`);
  const selector = parsed.pos[0];
  if (sub === "list" && parsed.pos.length) throw new UsageError("agents list does not accept positional arguments");
  if (sub === "check" && parsed.pos.length > 1) throw new UsageError("agents check accepts at most one kind/preset");
  if (sub === "run" && parsed.pos.length !== 1) throw new UsageError("agents run requires one kind/preset");
  if (sub === "test" && (parsed.pos.length > 1 || Boolean(selector) === parsed.flags.has("all"))) throw new UsageError("Use agents test <kind/preset> or agents test --all");
  if (selector && parsed.values.has("kind")) throw new UsageError("Use either kind/preset or --kind K");
  if (selector && (selector.indexOf("/") <= 0 || selector.endsWith("/"))) throw new UsageError("Expected kind/preset, for example codex/dev");
  const timeout = Number(parsed.values.get("timeout-ms") ?? (sub === "check" ? 5000 : 60000));
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new UsageError("--timeout-ms must be a positive integer up to 2147483647");
  const root = resolveRoot(parsed.values.get("root"), true);
  let rows: ReturnType<typeof listAgentPresets>;
  try {
    rows = listAgentPresets(root, parsed.values.get("kind"));
    if (selector) {
      const split = selector.indexOf("/");
      rows = rows.filter(row => row.kind === canonicalKind(selector.slice(0, split)) && row.preset === selector.slice(split + 1));
      if (!rows.length) throw new Error(`Unknown agent preset ${selector} in agents.json`);
    }
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  if (sub === "list") return out(parsed, rows, formatAgentPresets(rows));
  if (sub === "run") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError("agents run requires an interactive terminal; use agents test for non-interactive checks");
    try { return await runAgentPreset(root, rows[0]!); }
    catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    if (sub === "check") {
      const results = await checkAgentPresets(rows, timeout, controller.signal);
      out(parsed, results, formatAgentChecks(results));
      return controller.signal.aborted ? 130 : results.some(row => row.issues.length || row.auth === "not-logged-in") ? 1 : 0;
    }
    const results = await testAgentPresets(rows, timeout, controller.signal, parsed.flags.has("json") ? undefined : row => {
      process.stderr.write(`Testing ${sanitize(`${row.kind}/${row.preset}`)}...\n`);
    });
    out(parsed, results, formatAgentTests(results));
    return controller.signal.aborted ? 130 : results.some(row => row.status === "failed") ? 1 : results.length && results.every(row => row.status === "skipped") ? 2 : 0;
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

function cmdRole(args: string[]): number {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(
      "Usage: herdr-team role <list|add|rm> [options]\n\n" +
        "  list [--json] [--details]         List roles; --details includes responsibilities\n" +
        "  add <name> [--kind K] [--preset P | --model M] [--lifecycle resident|temporary] [--worktree] [--cwd C]\n" +
        "             [--args a,b] [--env K=V,K=V] [--body T | --body-file F] [--force]\n" +
        "  rm <name> [--force]               Remove a role; reject active task references\n\n" +
        "New roles require --kind; updates require --force and preserve omitted metadata.\n" +
        "Agent settings: --preset P references root agents.json; use --preset \"\" to return to explicit model/args/env.\n" +
        "Update responsibilities: role add <name> --force --body T (or --body-file F); omitted body preserves prompt.md.\n" +
        "Run `herdr-team up` to start resident roles. Temporary roles start when dispatched.\n",
    );
    return sub === undefined ? 2 : 0;
  }

  const parsed = parseArgs(rest, ["root", "kind", "preset", "model", "lifecycle", "cwd", "args", "env", "body", "body-file"]);
  if (parsed.flags.has("help")) return cmdRole(["--help"]);

  const root = resolveRoot(parsed.values.get("root"));
  if (sub === "list") {
    const project = loadProject(root, { taskBodies: false, roleBodies: parsed.flags.has("details") ? undefined : false });
    return out(parsed, parsed.flags.has("details") ? project.roles : project.roles.map(cardForJson), formatRoles(project.roles));
  }
  const project = loadOrFail(root);

  const name = parsed.pos[0];
  if (name === undefined) throw new UsageError(`role ${sub} requires a role name`);

  if (sub === "add") {
    const kind = parsed.values.get("kind");
    const lifecycle = parsed.values.get("lifecycle");
    if (lifecycle !== undefined && !isRoleLifecycle(lifecycle)) throw new UsageError("Use --lifecycle resident or temporary");
    const result = addRole(project, {
      name,
      kind,
      preset: parsed.values.get("preset"),
      model: parsed.values.get("model"),
      lifecycle,
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
      `${result.action === "added" ? "✓ Added" : "✓ Updated"} role ${result.name} (${result.dir})`,
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

type CommandAction = (args: string[]) => number | Promise<number>;

function runGroup(args: string[], usage: string, commands: Record<string, CommandAction>): number | Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || ["--help", "-h", "help"].includes(subcommand)) {
    process.stdout.write(usage);
    return 0;
  }
  if (!Object.hasOwn(commands, subcommand)) {
    throw new UsageError(`Unknown subcommand "${subcommand}". Choose one of ${Object.keys(commands).join(", ")}.`);
  }
  return commands[subcommand]!(rest);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "help" && args.length) return main([...args, "--help"]);
  const rest = args.length || command === "down" ? [...args] : ["--help"];
  if (rest[0] === "help") rest[0] = "--help";
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (["project", "team", "task", "issue", "iteration", "feature", "role", "agents", "inbox", "space", "daemon", "agentmail"].includes(command) &&
      rest[0]?.startsWith("-") && !["-h", "--help"].includes(rest[0])) {
    throw new UsageError(`Choose a ${command} subcommand before specifying options.`);
  }

  switch (command) {
    case "project":
      return cmdProject(rest);
    case "team":
      return runGroup(rest, TEAM_USAGE, {
        init: args => cmdInit(args, "team init"),
        validate: args => cmdValidate(args, "team validate"),
        up: args => cmdUp(args, "team up"),
        down: args => cmdDown(args, "team down"),
        status: args => cmdStatus(args, "team status"),
      });
    case "task":
      return runGroup(rest, TASK_USAGE, {
        list: args => cmdTasks(args, "list"),
        show: args => cmdTasks(args, "show"),
        create: args => cmdAdd(args, "task create"),
        update: args => cmdEdit(args, "task update"),
        archive: args => cmdTaskDisposition(args, "archive"),
        restore: args => cmdTaskDisposition(args, "restore"),
        delete: args => cmdTaskDisposition(args, "delete"),
        dispatch: args => cmdDispatch(args, "task dispatch"),
        claim: args => cmdClaim(args, "task claim"),
        handoff: args => cmdHandoff(args, "task handoff"),
        merge: args => cmdMerge(args, "task merge"),
        clean: args => cmdClean(args, "task clean"),
      });
    case "issue":
      return runGroup(rest, ISSUE_USAGE, {
        list: args => cmdBacklog(["list", ...args], "issue"),
        show: args => cmdBacklog(["show", ...args], "issue"),
        create: args => cmdBacklog(["add", ...args], "issue"),
        update: args => cmdBacklog(["edit", ...args], "issue"),
        accept: args => cmdBacklog(["accept", ...args], "issue"),
        archive: args => cmdIssueDisposition(args, "archive"),
        restore: args => cmdIssueDisposition(args, "restore"),
        delete: args => cmdIssueDisposition(args, "delete"),
        link: args => cmdBacklog(["link", ...args], "issue"),
        unlink: args => cmdBacklog(["unlink", ...args], "issue"),
        migrate: cmdIssueMigrate,
      });
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
    case "agents":
      return cmdAgents(rest);
    case "tasks":
      return cmdTasks(rest);
    case "backlog":
      return cmdBacklog(rest);
    case "iteration":
      return cmdIteration(rest);
    case "feature":
      return cmdFeature(rest);
    case "service":
      return cmdService(rest);
    case "status":
      return cmdStatus(rest);
    case "claim":
      return cmdClaim(rest);
    case "inbox":
      return cmdInbox(rest);
    case "daemon":
      return cmdDaemon(rest);
    case "agentmail":
      return cmdAgentMail(rest);
    case "up":
      return cmdUp(rest);
    case "space":
      return cmdSpace(rest);
    case "dispatch":
      return cmdDispatch(rest);
    case "clean":
      return cmdClean(rest);
    case "down":
      return cmdDown(rest);
    default:
      process.stderr.write(`Unknown command "${command}". Run herdr-team --help to see available commands.\n`);
      return 2;
  }
}

try {
  // Piped stdout can still be draining after write() returns.
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const command = process.argv[2];
  const subcommand = process.argv[3];
  if (command !== undefined && ["daemon", "agentmail", "up", "down", "add", "edit", "dispatch", "claim", "handoff", "inbox", "merge"].includes(command) &&
      !(command === "daemon" && subcommand === "_pass")) {
    const operation = command === "daemon" && ["start", "status", "stop", "logs", "_serve"].includes(subcommand ?? "") ? subcommand :
      command === "agentmail" && subcommand === "check" ? "check" :
      command === "agentmail" && subcommand === "route" && process.argv[4] === "add" ? "route add" : undefined;
    logDaemon("action.failed", { command, operation,
      errorType: error instanceof Error ? error.constructor.name : "Error" });
  }
  if (
    error instanceof UsageError ||
    error instanceof AgentMailError ||
    error instanceof ProjectAliasError ||
    error instanceof TaskError ||
    error instanceof RequirementError ||
    error instanceof FeatureError ||
    error instanceof LaunchError ||
    error instanceof InitError ||
    error instanceof TeamScopeError ||
    error instanceof RoleError ||
    error instanceof DesktopError
  ) {
    process.stderr.write(`Error: ${error.message}\n`);
    if (error instanceof UsageError && command) process.stderr.write(`Run herdr-team ${command} --help for usage.\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `Error: ${error instanceof Error ? (process.env.HERDR_TEAM_DEBUG === "1" ? error.stack ?? error.message : error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

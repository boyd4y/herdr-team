#!/usr/bin/env bun
import { resolveProjectWorkspace, TeamScopeError } from "./lib/team-scope.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAll } from "./lib/cleanup.ts";
import { findRoot, loadProject } from "./lib/config.ts";
import { handoff } from "./lib/handoff.ts";
import { init, InitError, parseRoleSpecs, readRolesFile } from "./lib/init.ts";
import { describePlan, isPlanName, PLAN_NAMES, planRoles } from "./lib/plans.ts";
import { addRole, describeRole, removeRole, RoleError } from "./lib/role.ts";
import { realHerdr, type Herdr } from "./lib/herdr.ts";
import { refreshSessionSidebar, refreshSidebar } from "./lib/sidebar.ts";
import { syncWorkspaceBadges } from "./lib/workspace-badges.ts";
import { dispatch, down, LaunchError, up, workspaceLabelFor } from "./lib/launch.ts";
import { buildReport, formatReport, formatTaskDetail, formatTasks } from "./lib/status.ts";
import { createTask, editTask, findTask, TaskError } from "./lib/task.ts";
import { formatProblems, validateProject } from "./lib/validate.ts";
import {
  realTerminal,
  renderOnce,
  renderStatusLine,
  resolveSize,
  runWatch,
} from "./lib/watch.ts";
import { isTerminal, type Project } from "./lib/types.ts";

/** 所有碰 herdr 的命令都从这里拿，测试时能替换。 */
function herdrClient(): Herdr {
  return realHerdr();
}

/** 碰 herdr 前先确保 .herdr/ 本身是干净的。 */
function loadValidated(root: string): Project {
  const project = loadProject(root);
  const problems = validateProject(project);
  if (problems.length > 0) {
    throw new TaskError(`.herdr/ 本身有问题，先修好再动：\n${formatProblems(problems)}`);
  }
  return project;
}

const USAGE = `herdr-team —— 用项目内 .herdr/ 驱动 Herdr agent 团队

用法:
  herdr-team <命令> [参数] [选项]

命令:
  init [--plan P]              创建 .herdr/ 骨架并写角色卡（方案：cheap / balanced / strong）
  validate                     校验 .herdr/（角色卡、任务卡、引用完整性）
  add <title>                  建一张任务卡
  edit <id>                    改一张任务卡
  handoff <id>                 推进一张卡的流转（状态机）
  role <list|add|rm>          运行期增删角色（加完 up 就纳入管理）
  tasks [<id>]                 列出任务，或查看单张卡详情（含正文；不问 Herdr）
  status                       合并任务卡与 Herdr 两侧状态
  watch                        实时看板（只读；给人看的，agent 里别跑 —— 会一直挂到按 q）
                               --line 则只打一行给 Herdr 标签栏用
  up                           起常驻角色、纳入新角色（不派活；需在 Herdr pane 内）
  dispatch [<id>]              派所有 todo 任务，或只派指定任务（需在 Herdr pane 内）
  clean                        回收已结束任务的 worktree
  down [--workspace]           关停团队的 agent（默认不动 workspace）
  sidebar                      刷新归属编号与现有 agent 的两行信息（不启动 agent）

选项:
  --root <DIR>                 项目根（默认从当前目录向上找含 .herdr/ 的目录）
  --json                       机器可读输出；tasks / status / role list 列表不带正文 body
                               tasks <id> --json 返回单张卡详情（含 body）

add 专用:
  --role <role>                执行者（必填）
  --handoff <a,b>              做完依次交给谁
  --depends-on <id,id>         依赖的任务 id，逗号分隔；空串表示清空
  --priority <P0..P3>          默认 P2
  --slug <slug>                标题非英文时，给出英文 slug
  --body <text>                卡片正文（任务描述）
  --body-file <path>           从文件读正文

edit 专用:
  --title / --role / --handoff / --depends-on / --priority / --status / --body
  --depends-on <id,id>         替换全部依赖；空串表示清空，省略则保留
  --force                      改已派出（非 todo）的卡

watch 专用:
  --interval <秒>              自动刷新间隔，默认 2；0 = 只手动刷新（按 r）
  --all                        一进来就显示已结束的卡（TUI 里按 a 切换）
  --once                       只渲染一帧就退出（不需要真终端，适合管道）

  -h, --help                   显示帮助
  -v, --version                显示版本
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
      if (next === undefined) throw new UsageError(`--${name} 需要跟一个值`);
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
    if (!existsSync(join(abs, ".herdr"))) throw new UsageError(`${abs} 下没有 .herdr/`);
    return abs;
  }
  const found = findRoot(process.cwd());
  if (found === null) {
    throw new UsageError("从当前目录向上找不到含 .herdr/ 的项目根（用 --root 指定）");
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
    throw new UsageError("--body 和 --body-file 只能用其中一个");
  }
  if (inline !== undefined) return inline;
  if (file !== undefined) {
    if (!existsSync(file)) throw new UsageError(`找不到 ${file}`);
    return readFileSync(file, "utf8");
  }
  return "";
}

function out(parsed: ParsedArgs, payload: unknown, human: string): number {
  if (parsed.flags.has("json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
  return 0;
}

const BODY_USAGE = "列表 --json 不带卡片正文 body；用 tasks <id> [--json] 查看单张任务详情（含正文）。\n";

/** 只投影卡片的 JSON 输出，内部卡片和用户元数据保持原样。 */
function cardForJson<T extends { body: string }>(card: T): Omit<T, "body"> {
  const { body: _body, ...metadata } = card;
  return metadata;
}

function cmdValidate(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team validate [--root DIR] [--json]\n");
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
    process.stdout.write("用法: herdr-team add <title> --role R [--handoff a,b] [--depends-on id,id] [--priority Pn]\n");
    return 0;
  }

  const title = parsed.pos.join(" ").trim();
  if (title === "") throw new UsageError("需要给一个标题：herdr-team add \"<title>\" --role R");

  const role = parsed.values.get("role");
  if (role === undefined) throw new UsageError("--role 是必填的（不知道派给谁就问用户，别猜）");

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  // 建卡前先全量校验 —— 卡片要引用角色，而角色可能本身就是坏的
  const problems = validateProject(project);
  if (problems.length > 0) {
    throw new TaskError(`.herdr/ 本身有问题，先修好再建卡：\n${formatProblems(problems)}`);
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
    `✓ 建卡 ${created.dir}\n  id=${created.id}  role=${role}  handoff=[${csv(parsed.values.get("handoff")).join(", ")}]\n\n由 lead 跑 \`herdr-team dispatch ${created.id}\` 派出。`,
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
    process.stdout.write("用法: herdr-team edit <id> [--role R] [--handoff a,b] [--depends-on id,id] [--priority Pn] [--status S] [--force]\n");
    return 0;
  }

  const id = parsed.pos[0];
  if (id === undefined) throw new UsageError("需要给一个任务 id：herdr-team edit <id> [选项]");

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  const handoffRaw = parsed.values.get("handoff");
  const dependsOnRaw = parsed.values.get("depends-on");
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
      body: readBody(parsed) === "" ? undefined : readBody(parsed),
    },
    parsed.flags.has("force"),
  );

  refreshSidebar(project, herdrClient());
  return out(parsed, result, `✓ 已更新 ${result.dir}`);
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
      `用法: herdr-team init [--plan ${PLAN_NAMES.join("|")} | --roles-file F | --roles JSON] [--force] [--root DIR]\n\n` +
        PLAN_NAMES.map((p) => `  --plan ${p.padEnd(10)}${describePlan(p)}`).join("\n") +
        "\n--force 只重写角色元数据，已有 prompt.md 保留；改职责用 role add <name> --force --body T。\n",
    );
    return 0;
  }

  const inline = parsed.values.get("roles");
  const file = parsed.values.get("roles-file");
  const plan = parsed.values.get("plan");
  const given = [inline, file, plan].filter((v) => v !== undefined);
  if (given.length > 1) {
    throw new UsageError("--plan / --roles / --roles-file 只能用其中一个");
  }

  let specs: ReturnType<typeof parseRoleSpecs> = [];
  if (plan !== undefined) {
    if (!isPlanName(plan)) {
      throw new UsageError(`没有 "${plan}" 这个方案。可选：${PLAN_NAMES.join(" / ")}`);
    }
    specs = planRoles(plan);
  } else if (inline !== undefined) specs = parseRoleSpecs(inline);
  else if (file !== undefined) specs = parseRoleSpecs(readRolesFile(file));

  const root = resolveInitRoot(parsed.values.get("root"));
  const project = loadProject(root);
  const result = init(project, specs, parsed.flags.has("force"));

  const lines: string[] = [];
  if (result.created.length > 0) lines.push(`created: ${result.created.join(", ")}`);
  if (result.roleMetadataWritten.length > 0) lines.push(`角色元数据已写入: ${result.roleMetadataWritten.join(", ")}`);
  if (result.roleBodiesWritten.length > 0) lines.push(`角色正文已写入: ${result.roleBodiesWritten.join(", ")}`);
  if (result.roleBodiesPreserved.length > 0) lines.push(`角色正文已保留（未覆盖）: ${result.roleBodiesPreserved.join(", ")}`);
  if (result.skipped.length > 0) lines.push(`skipped: ${result.skipped.join(", ")}`);
  lines.push(`\nroot: ${root}`);

  // 分清「这次没给定义」和「这个项目还没有角色」—— 前者不该说成后者。
  if (given.length === 0) {
    const existing = project.roles.map((r) => r.name);
    if (existing.length > 0) {
      lines.push(`已有 ${existing.length} 个角色：${existing.join(", ")}。这次没给角色定义，所以角色没动。`);
      lines.push("新增角色用 role add <name> --kind K；改职责用 role add <name> --force --body T；删除用 role rm <name>。");
    } else {
      lines.push("还没有角色 —— 用 --roles-file 给出确认过的角色定义。");
    }
  }

  return out(parsed, { root, ...result }, lines.join("\n"));
}

function cmdSidebar(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team sidebar [--root DIR] [--json] [--auto | --badges-only]\n刷新归属编号及现有 agent 的角色、harness、模型和任务 ID，不启动 agent。\n--auto 自动发现会话内的团队项目并刷新，不依赖当前目录。\n--badges-only 仅同步归属编号，不要求当前目录是团队项目。\n");
    return 0;
  }
  if (parsed.flags.has("auto") && parsed.flags.has("badges-only")) throw new UsageError("--auto 和 --badges-only 不能同时使用");
  const automatic = parsed.flags.has("auto");
  const project = parsed.flags.has("badges-only") || automatic ? null : loadValidated(resolveRoot(parsed.values.get("root")));
  const herdr = herdrClient();
  if (!herdr.envOk()) throw new LaunchError("这个命令要在 Herdr 的 pane 里跑（HERDR_ENV=1）。");
  const badges = syncWorkspaceBadges(herdr);
  const result = automatic ? refreshSessionSidebar(herdr) : project === null ? badges : refreshSidebar(project, herdr);
  if (project !== null || automatic) result.failed += badges.failed;
  out(parsed, result, `已刷新 ${result.updated} ${project === null && !automatic ? "项归属标记" : "个 agent"}${result.failed ? `；${result.failed} 项上报失败` : ""}`);
  return result.failed ? 1 : 0;
}

function cmdStatus(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team status [--all] [--root DIR] [--json]\n" + BODY_USAGE);
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
    throw new UsageError(`--interval 要是个不小于 0 的秒数，收到 "${value}"`);
  }
  return seconds;
}

/** 上色与否。`NO_COLOR` 按它的规范：存在且非空就关。 */
function useColor(): boolean {
  const noColor = process.env["NO_COLOR"];
  return process.stdout.isTTY === true && (noColor === undefined || noColor === "");
}

const WATCH_USAGE = `用法: herdr-team watch [--all] [--interval 秒] [--once] [--root DIR]

只读实时看板：任务卡 × Herdr agent × 两者对不上的地方，一屏看完。默认每 2 秒刷新。

按键:
  ↑↓ / k j           选任务
  PgUp / PgDn        翻详情正文
  r                  立刻刷新
  a                  切换是否显示已结束的卡
  /                  搜索 id、标题、角色（子序列，支持中文）
  Enter              保留过滤并退出搜索输入
  Backspace          搜索输入中删除一个码点
  Esc                退出输入并清空过滤；输入外且无过滤时退出看板
  q / Ctrl-C         退出（输入中 q 作为文本，Ctrl-C 始终退出）

TUI 里不做任何写操作 —— 派活、交棒、收尾仍走各自命令。

**这不是给 agent 跑的命令**：它会一直占着终端直到有人按键。
要非交互地看状态，用 \`herdr-team status\`（可加 --json）。

watch 专用:
  --interval <秒>    自动刷新间隔，默认 2；0 = 只手动刷新
  --all              一进来就显示已结束的卡
  --once             只渲染一帧就退出（不需要真终端，适合管道）
  --line             只打一行给标签栏用，不交互
  --follow           跟着 UI 焦点所在的 pane 找项目（给标签栏用；只在没给 --root 时生效）

--line 的形状:
  team: 1 doing 2 todo · 1 blocked · 1 ✗

  前半段   未结束的卡按 doing / review / todo 计数，只列非零的
  blocked  卡住、等你处理的卡，按卡去重 —— 卡片自己写着 blocked，或者 agent 在
           等你 / agent 掉了 / 干完没交棒，同一张卡只算一次（所以它**包含**
           状态为 blocked 的卡，前半段不再重复列）
  ✗        .herdr/ 的校验问题数（坏卡会被静默跳过，所以必须报出来）

**没事就不输出**（和 herdr-projects 的 needs-you --line 一个规矩），
不在团队项目里（没找到 .herdr/）也什么都不输出并正常退出。

放进 Herdr 标签栏时要加 --follow：标签栏命令跑在 Herdr 服务器进程里，
cwd 是服务器启动时的目录（通常是你家目录），不跟着焦点 pane 走就永远找不到项目。
`;

async function cmdWatch(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["root", "interval"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(WATCH_USAGE);
    return 0;
  }
  if (parsed.flags.has("json")) {
    throw new UsageError("watch 没有 --json —— 要机器可读输出用 `herdr-team status --json`");
  }

  // 标签栏那一行：不交互，而且没项目时要闭嘴而不是报错（见 resolveRootQuiet）。
  if (parsed.flags.has("line")) {
    if (parsed.flags.has("once")) throw new UsageError("--line 和 --once 只能用其中一个");
    const herdr = herdrClient();
    const lineRoot = resolveRootQuiet(parsed.values.get("root"), parsed.flags.has("follow"), herdr);
    if (lineRoot === null) return 0;
    const line = renderStatusLine(loadProject(lineRoot), herdr);
    if (line !== "") process.stdout.write(`${line}\n`);
    return 0;
  }

  const root = resolveRoot(parsed.values.get("root"));
  const seconds = parseInterval(parsed.values.get("interval"));
  // 容错加载（**不是** loadValidated）：看板恰恰是 .herdr/ 出问题时最想看的东西，
  // 校验问题会在帧里的 ✗ 横幅报出来，而不是拦在门口。
  const project = loadProject(root);
  const showAll = parsed.flags.has("all");

  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (parsed.flags.has("once") || !interactive) {
    const size = resolveSize(process.stdout.columns, process.stdout.rows, process.env);
    process.stdout.write(
      renderOnce(project, herdrClient(), {
        width: size.width,
        height: size.height,
        color: useColor(),
        showAll,
        intervalSeconds: seconds,
      }),
    );
    if (!interactive && !parsed.flags.has("once")) {
      process.stderr.write("watch: 不是交互终端，只打了一帧（实时看板要在真终端里跑）\n");
    }
    return 0;
  }

  // 注意这里绝不 process.exit() —— 终端还原全在 runWatch 的 finally 里，
  // 提前退出会把用户的 shell 留在 raw mode + 备屏里。
  return await runWatch({
    io: realTerminal(),
    initial: project,
    load: () => loadProject(root),
    herdr: herdrClient(),
    intervalMs: seconds * 1000,
    intervalSeconds: seconds,
    showAll,
    color: useColor(),
  });
}

function cmdHandoff(args: string[]): number {
  const parsed = parseArgs(args, ["root", "summary", "summary-file"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team handoff <id> [--summary TEXT | --summary-file FILE] [--root DIR] [--json]\n摘要可选，提供后追加到任务 task.md，再通知下游读取。省略时保持旧的流转行为，并明确标注未提供摘要。\n");
    return 0;
  }
  const id = parsed.pos[0];
  if (id === undefined) throw new UsageError("需要给一个任务 id：herdr-team handoff <id>");
  if (parsed.pos.length !== 1) throw new UsageError("handoff 只接受一个任务 id");
  const inline = parsed.values.get("summary");
  const file = parsed.values.get("summary-file");
  if (inline !== undefined && file !== undefined) throw new UsageError("--summary 和 --summary-file 不能同时使用");
  let summary = inline;
  if (file !== undefined) {
    try { summary = readFileSync(file, "utf8"); }
    catch (error) { throw new UsageError(`读取交付摘要失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const result = handoff(project, herdrClient(), id, new Date(), { summary });

  return out(parsed, result, `✓ ${result.note}`);
}

function cmdUp(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team up [--root DIR] [--json]\n");
    return 0;
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const result = up(project, herdrClient());

  const lines: string[] = [];
  lines.push(`workspace ${result.workspaceLabel} (${result.workspaceId})  ${result.workspaceAction}`);
  for (const r of result.roles) {
    if (r.action === "deferred") {
      // 隔离角色本来就不预起 —— 没上报不是失败，也不是出了问题。
      lines.push(`  ${"deferred".padEnd(9)}${r.role}  （隔离角色：派任务给它才起，在独立 worktree 里）`);
      continue;
    }
    if (r.action === "failed") {
      lines.push(`  ${"failed".padEnd(9)}${r.role}  →  ${r.paneId}\n      ${r.failure ?? ""}`);
      continue;
    }
    const meta = r.reported === false ? "  ⚠ 显示名上报失败" : "";
    lines.push(`  ${r.action.padEnd(9)}${r.role}  →  ${r.paneId}${meta}`);
  }

  const failed = result.roles.filter((r) => r.action === "failed");
  if (failed.length > 0) {
    lines.push("");
    lines.push(`${failed.length} 个角色没起来。多半是那个 tab 里的 shell 正忙 —— 关掉它再跑一次 up。`);
  }
  return out(parsed, result, lines.join("\n"));
}

function cmdDispatch(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team dispatch [<id>] [--root DIR] [--json]\n");
    return 0;
  }
  if (parsed.pos.length > 1) throw new UsageError("dispatch 最多指定一个任务 id");
  const root = resolveRoot(parsed.values.get("root"));
  const result = dispatch(loadValidated(root), herdrClient(), parsed.pos[0]);
  const lines = result.map((d) =>
    `  ${d.id}  ${d.role}  ${d.action}${d.reason === undefined ? "" : `  (${d.reason})`}`,
  );
  return out(parsed, result, lines.length === 0 ? "没有 todo 任务可派。" : lines.join("\n"));
}

function cmdDown(args: string[]): number {
  const parsed = parseArgs(args, ["root"]);
  if (parsed.flags.has("help")) {
    process.stdout.write(
      "用法: herdr-team down [--workspace] [--root DIR] [--json]\n\n" +
        "默认只关停 agent，**不动 workspace**（那是你的项目容器）。\n" +
        "--workspace 才会连整个 workspace 组一起关 —— 你放在里面的 tab 也会没。\n",
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
    lines.push("没有在跑的 agent。");
  } else {
    lines.push(`✓ 已关停 ${result.stopped.length} 个 agent（workspace 没动）`);
    for (const s of result.stopped) lines.push(`  ${s.agent.padEnd(16)}${s.paneId}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`⚠ 认得出来但拿不到 pane：${result.skipped.join(", ")}`);
  }

  let workspaceId: string | null = null;
  if (parsed.flags.has("workspace")) {
    const label = workspaceLabelFor(project);
    if (teamWorkspace !== null) {
      herdr.workspaceCloseGroup(teamWorkspace);
      workspaceId = teamWorkspace;
      lines.push(`\n⚠ 连 workspace "${label}"（${teamWorkspace}）一起关了 —— 里面的 tab 也没了。`);
    }
  }

  return out(parsed, { ...result, workspaceId }, lines.join("\n"));
}

function cmdTasks(args: string[]): number {
  const parsed = parseArgs(args, ["root", "role", "status"]);
  if (parsed.flags.has("help")) {
    process.stdout.write("用法: herdr-team tasks [<id>] [--all] [--role R] [--status S] [--root DIR] [--json]\n" + BODY_USAGE);
    return 0;
  }
  if (parsed.pos.length > 1) throw new UsageError("tasks 最多指定一个任务 id");
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
    process.stdout.write("用法: herdr-team clean [--root DIR] [--json]\n");
    return 0;
  }
  const root = resolveRoot(parsed.values.get("root"));
  const project = loadValidated(root);
  const results = cleanupAll(project, herdrClient());

  if (parsed.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  if (results.length === 0) {
    process.stdout.write("没有已结束的任务，没什么可收的。\n");
    return 0;
  }
  const lines = results.map((r) => `  ${r.id}  ${r.action.padEnd(13)}${r.note}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return results.some((r) => r.action === "dirty" || r.action === "closed") ? 1 : 0;
}

/** `K=V,K=V` → 映射。 */
function pairs(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const item of csv(value)) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new UsageError(`--env 要写成 KEY=VALUE，收到 "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

function cmdRole(args: string[]): number {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(
      "用法: herdr-team role <list|add|rm> [选项]\n\n" +
        "  list [--json]                     列出角色（JSON 不带正文 body）\n" +
        "  add <name> [--kind K] [--model M] [--worktree] [--cwd C]\n" +
        "             [--args a,b] [--env K=V,K=V] [--body T | --body-file F] [--force]\n" +
        "  rm <name> [--force]               删角色；还有没结束的任务用它就拒绝\n\n" +
        "新角色必填 --kind；已有角色需 --force，未提供的元数据字段保留。\n" +
        "改职责: role add <name> --force --body T（也可用 --body-file F）；省略正文则保留 prompt.md。\n" +
        "加完跑 `herdr-team up` 就会把它一起拉起来并上报状态。\n",
    );
    return sub === undefined ? 2 : 0;
  }

  const parsed = parseArgs(rest, ["root", "kind", "model", "cwd", "args", "env", "body", "body-file"]);
  if (parsed.flags.has("help")) return cmdRole(["--help"]);

  const root = resolveRoot(parsed.values.get("root"));
  const project = loadOrFail(root);

  if (sub === "list") {
    if (project.roles.length === 0 && !parsed.flags.has("json")) {
      process.stdout.write("（还没有角色）\n");
      return 0;
    }
    const lines = project.roles.map((r) => `  ${describeRole(r)}`);
    return out(parsed, project.roles.map(cardForJson), lines.join("\n"));
  }

  const name = parsed.pos[0];
  if (name === undefined) throw new UsageError(`role ${sub} 需要一个角色名`);

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
      `${result.action === "added" ? "✓ 加了" : "✓ 改了"}角色 ${result.name}（${result.dir}）\n\n跑 \`herdr-team up\` 让它起来。`,
    );
  }

  if (sub === "rm") {
    const result = removeRole(project, name, parsed.flags.has("force"));
    return out(parsed, result, `✓ 删了角色 ${result.name}（${result.dir}）`);
  }

  throw new UsageError(`role 没有 "${sub}" 这个子命令（list / add / rm）`);
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
    case "handoff":
      return cmdHandoff(rest);
    case "role":
      return cmdRole(rest);
    case "tasks":
      return cmdTasks(rest);
    case "status":
      return cmdStatus(rest);
    case "sidebar":
      return cmdSidebar(rest);
    case "watch":
      return cmdWatch(rest);
    case "up":
      return cmdUp(rest);
    case "dispatch":
      return cmdDispatch(rest);
    case "clean":
      return cmdClean(rest);
    case "down":
      return cmdDown(rest);
    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// main 是 async 的：`watch` 要等驱动跑完（它的 finally 负责还原终端），
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

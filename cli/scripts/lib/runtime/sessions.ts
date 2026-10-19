import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentInfo, AgentSessionInfo, Herdr } from "./herdr.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import { worktreeBranch, type Project, type RoleCard } from "../shared/types.ts";

interface SavedSession {
  version: 1;
  project: string;
  role: string;
  cwd: string;
  taskId?: string;
  session: AgentSessionInfo;
  confirmed?: true;
}

export interface TaskSessionScope { taskId: string; cwd: string }

/** Resolve task identity from its known checkout, never from a guessed recent session. */
export function scopeForTaskSession(project: Project, herdr: Herdr, role: RoleCard, taskId: string): TaskSessionScope {
  const task = project.tasks.find((task) => task.id === taskId);
  if (!task) throw new Error(`Cannot find task ${taskId} for session recovery`);
  const repo = resolve(project.root, task.repo);
  const offset = role.cwd === undefined ? "" : relative(repo, resolve(project.root, role.cwd));
  if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) throw new Error("Role cwd is outside the task repository");
  const trees = herdr.worktreeList(repo).filter((tree) => tree.branch === worktreeBranch(task));
  if (trees.length !== 1) throw new Error("Cannot identify this task checkout for session recovery");
  return { taskId, cwd: join(trees[0]!.path, offset) };
}

function roleCwd(project: Project, role: RoleCard, scope?: TaskSessionScope): string {
  if (scope && (!/^[0-9]{4}$/.test(scope.taskId) || !isAbsolute(scope.cwd))) throw new Error("Invalid task session scope");
  return canonicalCwd(scope?.cwd ?? resolve(project.root, role.cwd ?? "."));
}

function canonicalCwd(cwd: string): string {
  try { return realpathSync(cwd); }
  catch { return cwd; }
}

/** Project-scoped, independent of transient workspace IDs and Herdr sockets. */
export function roleSessionPath(project: Project, role: RoleCard, scope?: TaskSessionScope): string {
  const state = process.env["HERDR_PLUGIN_STATE_DIR"] ?? join(
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "herdr", "plugins", "herdr-team",
  );
  if (scope) roleCwd(project, role, scope);
  return join(state, "agent-sessions", projectKey(project), ...(scope ? ["tasks", scope.taskId] : []), `${role.name}.json`);
}

/** Mirrors Herdr's official native-session restore syntax; no --last guessing. */
export function resumeArgs(kind: string, session: AgentSessionInfo): string[] | undefined {
  const source = kind === "agy" ? "antigravity_cli" : kind;
  if (session.agent !== kind || session.source !== `herdr:${source}` ||
    typeof session.value !== "string" || !session.value || /[\x00-\x1f\x7f]/.test(session.value) ||
    session.value.startsWith("-")) return;
  if (session.kind === "path") {
    if (!["pi", "omp"].includes(kind) || !isAbsolute(session.value)) return;
  } else if (session.kind !== "id") return;
  const value = session.value;
  switch (kind) {
    case "codex": return ["resume", value];
    case "copilot": case "omp": return [`--resume=${value}`];
    case "pi": case "kimi": case "opencode": case "kilo": return ["--session", value];
    case "mastracode": return ["--thread", value];
    case "agy": return ["--conversation", value];
    case "letta": return value.startsWith("default:")
      ? value.length > 8 ? ["--conversation", "default", "--agent", value.slice(8)] : undefined
      : ["--conversation", value];
    case "claude": case "grok": case "devin": case "droid": case "hermes":
    case "qodercli": case "qwen": case "cursor": return ["--resume", value];
  }
}

export function hasSessionArgs(role: RoleCard): boolean {
  const flags = ["--resume", "--session", "--session-id", "--continue", "--conversation", "--thread"];
  if (role.kind !== "codex") flags.push("-r", "-c");
  return (role.args ?? []).some((arg) => flags.includes(arg.split("=")[0]!) ||
    (role.kind === "codex" && ["resume", "fork"].includes(arg)));
}

const needsMessageConfirmation = (kind: string) => kind === "claude" || kind === "codex";

/** Both harnesses can report a startup ID before a resumable conversation exists. */
function hasMessages(role: RoleCard, id: string, cwd: string): boolean {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return false;
  const claude = role.kind === "claude";
  const key = claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const config = resolve(cwd, role.env?.[key] ?? process.env[key] ?? join(homedir(), claude ? ".claude" : ".codex"));
  const patterns = claude ? [`projects/*/${id}.jsonl`]
    : [`sessions/*/*/*/*-${id}.jsonl`, `archived_sessions/*-${id}.jsonl`];
  try {
    for (const pattern of patterns) for (const file of new Bun.Glob(pattern).scanSync({ cwd: config, onlyFiles: true })) {
      let content: string;
      try { content = readFileSync(join(config, file), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (content.split("\n").some(line => {
        try {
          const event = JSON.parse(line);
          const message = claude ? event.message : event.type === "response_item" && event.payload?.type === "message" ? event.payload : undefined;
          const role = claude ? event.type : message?.role;
          return ["user", "assistant"].includes(role) && message?.content?.length > 0;
        } catch { return false; } // A final JSONL record may still be being written.
      })) return true;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return false;
}

export function savedResumeArgs(project: Project, role: RoleCard, scope?: TaskSessionScope): string[] | undefined {
  if ((!scope && role.worktree && role.name !== "lead") || hasSessionArgs(role)) return;
  let saved: SavedSession;
  try { saved = JSON.parse(readFileSync(roleSessionPath(project, role, scope), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Failed to read session record for ${role.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (saved?.version !== 1 || saved.project !== projectKey(project) || saved.role !== role.name ||
    saved.taskId !== scope?.taskId || saved.cwd !== roleCwd(project, role, scope) || !saved.session) return;
  const args = resumeArgs(role.kind, saved.session);
  // Older records need the same message confirmation as a new native report.
  if (args && needsMessageConfirmation(role.kind) && saved.confirmed !== true &&
      !rememberRoleSession(project, role, { agent_session: saved.session, cwd: saved.cwd }, scope)) return;
  return args;
}

export function forgetRoleSession(project: Project, role: RoleCard, scope?: TaskSessionScope): void {
  try { unlinkSync(roleSessionPath(project, role, scope)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Called only with a project-verified role/agent pair. Missing reports keep prior IDs. */
export function rememberRoleSession(project: Project, role: RoleCard, agent: AgentInfo, scope?: TaskSessionScope): boolean {
  if ((!scope && ((role.worktree && role.name !== "lead") || agent.tokens?.team_task_id)) ||
      (scope && agent.tokens?.team_task_id !== undefined && agent.tokens.team_task_id !== scope.taskId) ||
      !agent.agent_session || !resumeArgs(role.kind, agent.agent_session)) return false;
  const actualCwd = agent.foreground_cwd ?? agent.cwd;
  if (actualCwd !== undefined && canonicalCwd(actualCwd) !== roleCwd(project, role, scope)) return false;
  const record: SavedSession = {
    version: 1, project: projectKey(project), role: role.name,
    cwd: roleCwd(project, role, scope), ...(scope ? { taskId: scope.taskId } : {}), session: agent.agent_session,
    ...(needsMessageConfirmation(role.kind) ? { confirmed: true as const } : {}),
  };
  const file = roleSessionPath(project, role, scope);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  try { if (readFileSync(file, "utf8") === content) return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Confirm each ID after messages persist. Confirmed IDs never reread transcripts
  // during steady status updates, and an unconfirmed ID cannot replace a good one.
  if (needsMessageConfirmation(role.kind) && !hasMessages(role, agent.agent_session.value, record.cwd)) return false;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return true;
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runtimePath } from "../runtime/state.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import type { Project, RoleCard, TaskCard } from "../shared/types.ts";

export function taskScoped(task: TaskCard, role?: RoleCard): boolean {
  if ((role?.name ?? task.role) === "lead") return false;
  return task.meta.execution === "task" || role?.worktree === true;
}

export interface Review { commit: string; developer: string; reviewer: string; reviewers?: string[] }
export interface Acceptance { commit: string; role: string }
export interface Integration { commit: string; state: "queued" | "running" | "blocked" | "done"; reason?: string; queued_at?: string }
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function reviewFor(task: TaskCard): Review | undefined {
  const v = task.meta.review;
  if (v == null) return;
  const r = v as Review;
  if (!SHA.test(r.commit) || typeof r.developer !== "string" || typeof r.reviewer !== "string") throw new Error("Invalid task review record");
  if (r.reviewers !== undefined && (!Array.isArray(r.reviewers) || !r.reviewers.length || r.reviewers.some((role) => typeof role !== "string" || !role) || r.reviewers.at(-1) !== r.reviewer)) throw new Error("Invalid task review path");
  return r;
}
export function acceptanceFor(task: TaskCard): Acceptance | undefined {
  const v = task.meta.acceptance;
  if (v == null) return;
  const a = v as Acceptance;
  if (!SHA.test(a.commit) || typeof a.role !== "string") throw new Error("Invalid task acceptance record");
  return a;
}
export function integrationFor(task: TaskCard): Integration | undefined {
  const v = task.meta.integration;
  if (v == null) return;
  const i = v as Integration;
  if (!SHA.test(i.commit) || !["queued", "running", "blocked", "done"].includes(i.state) || i.reason !== undefined && typeof i.reason !== "string" || i.queued_at !== undefined && !Number.isFinite(Date.parse(i.queued_at))) throw new Error("Invalid task integration record");
  return i;
}
export function git(cwd: string, ...args: string[]): string {
  const p = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Error(`Git failed: ${p.error?.message ?? (p.stderr || p.stdout).trim()}`);
  return p.stdout.trim();
}
export function taskRepo(project: Project, task: TaskCard): string { return resolve(project.root, task.repo); }
export function commitId(project: Project, task: TaskCard, value: string): string {
  if (!/^[a-fA-F0-9]{7,64}$/.test(value)) throw new Error("Supply an explicit commit SHA (at least 7 hexadecimal characters)");
  return git(taskRepo(project, task), "rev-parse", "--verify", `${value}^{commit}`);
}

export function verifyCheckout(path: string, commit: string): string {
  if (git(path, "rev-parse", "HEAD") !== commit || git(path, "status", "--porcelain")) {
    throw new Error("Review checkout changed; restore the assigned clean commit or submit a new review");
  }
  return path;
}

/** Names are stable per project/task; ports are allocated by the OS, not ID arithmetic. */
export function taskEnvironment(project: Project, task: TaskCard, role = "execution"): Record<string, string> {
  const path = runtimePath(project, `resources/${task.id}-${role}.json`);
  const namespace = `ht_${projectKey(project).slice(0, 12)}_${task.id}`;
  let port: number;
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.namespace !== namespace || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) throw new Error("Invalid task resource record");
    port = saved.port;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    const allocated = new Set(readdirSync(dirname(path)).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dirname(path), name), "utf8")).port));
    let attempts = 0;
    do {
      if (++attempts > 128) throw new Error("No unassigned task port is available; clean completed task resources");
      const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      port = socket.port!;
      socket.stop(true);
    } while (allocated.has(port));
    writeFileSync(path, JSON.stringify({ namespace, port }), { mode: 0o600, flag: "wx" });
  }
  // A service outside this team may take a released port. Fail instead of sharing it.
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
  } catch { throw new Error(`Task port ${port} is in use; stop the conflicting service before retrying`); }
  return { HERDR_TEAM_TASK_ID: task.id, HERDR_TEAM_NAMESPACE: namespace,
    HERDR_TEAM_TEST_DATABASE: `${namespace}_${role}_test`, HERDR_TEAM_REDIS_PREFIX: `${namespace}:${role}:test:`,
    HERDR_TEAM_PORT: String(port), PORT: String(port) };
}

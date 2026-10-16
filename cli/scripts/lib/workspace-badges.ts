import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Herdr, WorkspaceInfo } from "./herdr.ts";

export const BADGE_COLOR_COUNT = 8; // Must match the fixed sidebar color slots in bin/configure.js.
interface Badge { label: string; slot: number }

interface Registry { next: number; assignments: Record<string, number> }

export function badgeLabel(number: number): string {
  if (number <= 20) return String.fromCodePoint(0x2460 + number - 1);
  if (number <= 35) return String.fromCodePoint(0x3251 + number - 21);
  if (number <= 50) return String.fromCodePoint(0x32b1 + number - 36);
  return `[${number}]`;
}

export function badgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env["HERDR_PLUGIN_STATE_DIR"] ?? join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "herdr", "plugins", "herdr-team");
  const session = createHash("sha256").update(env["HERDR_SOCKET_PATH"] ?? "default").digest("hex").slice(0, 24);
  return join(state, "workspace-badges", `${session}.json`);
}

function readRegistry(file: string): Registry {
  if (!existsSync(file)) return { next: 1, assignments: {} };
  const data = JSON.parse(readFileSync(file, "utf8")) as Registry;
  if (!Number.isSafeInteger(data.next) || data.next < 1 || !data.assignments || typeof data.assignments !== "object" || Array.isArray(data.assignments) ||
    Object.values(data.assignments).some((n) => !Number.isSafeInteger(n) || n < 1 || n >= data.next)) {
    throw new Error(`Invalid workspace badge registry: ${file}`);
  }
  return data;
}

function assignBadges(workspaces: WorkspaceInfo[], registry: Registry): Map<string, Badge> {
  const badges = new Map<string, Badge>();
  // Assign a group's parent first, even if a child precedes it in API order.
  const ordered = [...workspaces].sort((a, b) => Number(a.worktree?.is_linked_worktree ?? false) - Number(b.worktree?.is_linked_worktree ?? false));
  for (const workspace of ordered) {
    const key = `workspace:${workspace.workspace_id}`;
    const group = workspace.worktree ? `repo:${workspace.worktree.repo_key}` : undefined;
    const number = (group === undefined ? undefined : registry.assignments[group]) ?? registry.assignments[key] ?? registry.next++;
    registry.assignments[key] = number;
    if (group !== undefined) registry.assignments[group] = number;
    badges.set(workspace.workspace_id, { label: badgeLabel(number), slot: (number - 1) % BADGE_COLOR_COUNT });
  }
  return badges;
}

/** All writes use metadata only; neither labels nor semantic agent state change. */
export function syncWorkspaceBadges(herdr: Herdr, file = badgeStatePath()): { updated: number; failed: number } {
  if (!herdr.envOk()) throw new Error("Workspace badges require a Herdr-managed pane or plugin hook");
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 15_000;
  let descriptor: number;
  for (;;) {
    try { descriptor = openSync(lock, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      Bun.sleepSync(25);
    }
  }
  try {
    const workspaces = herdr.workspaceList();
    const agents = herdr.agentList();
    const registry = readRegistry(file);
    const badges = assignBadges(workspaces, registry);
    const next = JSON.stringify(registry);
    // Persist assignments before reporting: retries must retain the same numbers.
    if (!existsSync(file) || readFileSync(file, "utf8") !== next) {
      const temp = `${file}.${process.pid}.tmp`;
      try { writeFileSync(temp, next, { flag: "wx" }); renameSync(temp, file); }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    const result = { updated: 0, failed: 0 };
    const report = (scope: "workspace" | "pane", id: string, tokens: Record<string, string> = {}, badge: Badge | undefined) => {
      if (tokens["team_workspace"] === badge?.label && Array.from({ length: BADGE_COLOR_COUNT }, (_, slot) => slot)
        .every((slot) => tokens[`team_workspace_c${slot}`] === (slot === badge?.slot ? badge.label : undefined))) return;
      try { herdr.reportBadge(scope, id, badge?.label ?? null, badge?.slot); result.updated++; }
      catch { result.failed++; }
    };
    const parentRepos = new Set(workspaces.filter((workspace) => workspace.worktree && !workspace.worktree.is_linked_worktree)
      .map((workspace) => workspace.worktree!.repo_key));
    for (const workspace of workspaces) {
      const nested = workspace.worktree?.is_linked_worktree && parentRepos.has(workspace.worktree.repo_key);
      report("workspace", workspace.workspace_id, workspace.tokens, nested ? undefined : badges.get(workspace.workspace_id));
    }
    for (const agent of agents) {
      if (agent.pane_id && agent.workspace_id) report("pane", agent.pane_id, agent.tokens, badges.get(agent.workspace_id));
    }
    return result;
  } finally { closeSync(descriptor); unlinkSync(lock); }
}

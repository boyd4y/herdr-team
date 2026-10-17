import { spawnSync } from "node:child_process";
import type { Herdr } from "./herdr.ts";

export interface WorkspaceGit {
  files: number;
  branch?: string;
  ahead?: number;
  behind?: number;
}

/** Porcelain v2 -z keeps paths (including rename sources) NUL-delimited. */
export function parseWorkspaceGit(porcelain: string): WorkspaceGit {
  const git: WorkspaceGit = { files: 0 };
  const records = porcelain.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const branch = record.slice("# branch.head ".length);
      if (branch !== "(detached)") git.branch = branch;
    } else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (!match) throw new Error("Invalid git ahead/behind record");
      git.ahead = Number(match[1]);
      git.behind = Number(match[2]);
    } else if (record.startsWith("# ") || record.startsWith("! ")) {
      continue;
    } else if (/^[12u?] /.test(record)) {
      git.files++;
      if (record.startsWith("2 ")) {
        if (!records[++i]) throw new Error("Missing git rename source");
      }
    } else {
      throw new Error("Invalid git status record");
    }
  }
  return git;
}

/** One local snapshot, with no fetch. Undefined means unavailable, never clean. */
export function readWorkspaceGit(cwd: string): WorkspaceGit | undefined {
  const result = spawnSync("git", ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v2", "--branch", "--ahead-behind", "--renames", "-z", "--untracked-files=all"], {
    encoding: "utf8", timeout: 1500, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) return;
  return parseWorkspaceGit(result.stdout);
}

function gitSummary(git: WorkspaceGit): string {
  const changes = [`📄${git.files}`];
  if (git.ahead) changes.push(`↑${git.ahead}`);
  if (git.behind) changes.push(`↓${git.behind}`);
  return [git.branch, changes.join(" ")].filter(Boolean).join(" · ");
}

/** Root-only second row: Herdr cannot condition native git_status on linkage. */
export function syncWorkspaceGit(herdr: Herdr, read = readWorkspaceGit): { updated: number; failed: number } {
  const result = { updated: 0, failed: 0 };
  if (!herdr.envOk()) return result;
  const panes = herdr.paneList();
  const snapshots = new Map<string, WorkspaceGit | undefined>();
  for (const workspace of herdr.workspaceList()) {
    const cwd = workspace.worktree?.checkout_path ?? panes.find((p) => p.workspace_id === workspace.workspace_id && p.cwd)?.cwd;
    let summary: string | null = null;
    let readFailed = false;
    if (cwd && !workspace.worktree?.is_linked_worktree) {
      if (!snapshots.has(cwd)) {
        try { snapshots.set(cwd, read(cwd)); }
        catch { snapshots.set(cwd, undefined); readFailed = true; }
      }
      const git = snapshots.get(cwd);
      if (git) summary = gitSummary(git);
    }
    try {
      // Clear the legacy file-count field on upgrade as well as stale summaries.
      const tokens = { team_git_files: null, team_git_summary: summary };
      if (!Object.entries(tokens).every(([key, value]) => workspace.tokens?.[key] === (value ?? undefined))) {
        herdr.reportWorkspaceMetadata(workspace.workspace_id, tokens, "herdr-team-git");
        result.updated++;
      }
      if (readFailed) result.failed++;
    } catch { result.failed++; }
  }
  return result;
}

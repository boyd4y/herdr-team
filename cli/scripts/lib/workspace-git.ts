import { spawnSync } from "node:child_process";
import type { Herdr } from "./herdr.ts";

/** Porcelain -z has a second NUL-delimited pathname for renames/copies. */
export function changedFileCount(porcelain: string): number {
  const records = porcelain.split("\0");
  let count = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid git status record");
    if (!record.startsWith("!!")) count++;
    if (/[RC]/.test(record.slice(0, 2))) i++;
  }
  return count;
}

/** Undefined means unavailable, never a guessed clean working tree. */
export function readChangedFileCount(cwd: string): number | undefined {
  const result = spawnSync("git", ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "utf8", timeout: 1500, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) return;
  return changedFileCount(result.stdout);
}

/** One snapshot per checkout, including ordinary workspaces without .herdr/. */
export function syncWorkspaceGit(herdr: Herdr, read = readChangedFileCount): { updated: number; failed: number } {
  const result = { updated: 0, failed: 0 };
  if (!herdr.envOk()) return result;
  const panes = herdr.paneList();
  const counts = new Map<string, number | undefined>();
  for (const workspace of herdr.workspaceList()) {
    const cwd = workspace.worktree?.checkout_path ?? panes.find((p) => p.workspace_id === workspace.workspace_id && p.cwd)?.cwd;
    let token: string | null = null;
    try {
      if (cwd) {
        if (!counts.has(cwd)) counts.set(cwd, read(cwd));
        const count = counts.get(cwd);
        if (count !== undefined) token = `📄${count}`;
      }
      if (workspace.tokens?.team_git_files === (token ?? undefined)) continue;
      herdr.reportWorkspaceMetadata(workspace.workspace_id, { team_git_files: token }, "herdr-team-git");
      result.updated++;
    } catch { result.failed++; }
  }
  return result;
}

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { projectKey } from "../dispatch/team-scope.ts";
import type { Project } from "../shared/types.ts";

export function runtimeDirectory(): string {
  return process.env["HERDR_PLUGIN_STATE_DIR"] ?? join(
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "herdr", "plugins", "herdr-team",
  );
}

export function runtimePath(project: Pick<Project, "root">, name: string): string {
  return join(runtimeDirectory(), "teams", projectKey(project), name);
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Serialize task changes, including Herdr's bounded agent startup. */
export function withTeamLock<T>(project: Project, name: string, action: () => T): T {
  const file = runtimePath(project, `${name}.lock`);
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 45_000;
  let fd: number;
  for (;;) {
    try { fd = openSync(file, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(readFileSync(file, "utf8"));
        if (Number.isSafeInteger(owner) && owner > 0 && !processAlive(owner)) { unlinkSync(file); continue; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; }
      if (Date.now() >= deadline) throw new Error(`Team ${name} is locked by another process; retry shortly`);
      Bun.sleepSync(25);
    }
  }
  try { writeFileSync(fd, String(process.pid)); return action(); }
  finally { closeSync(fd); unlinkSync(file); }
}

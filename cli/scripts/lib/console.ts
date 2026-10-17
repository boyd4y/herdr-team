import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Herdr } from "./herdr.ts";
import { processAlive, runtimePath, withTeamLock } from "./runtime.ts";
import { projectKey } from "./team-scope.ts";
import { shellQuote } from "./queue.ts";
import type { Project } from "./types.ts";

interface ConsoleOwner { pid: number; nonce: string; paneId?: string }
export interface ConsoleOutcome { action: "started" | "reused" | "failed"; paneId?: string; tabId?: string; failure?: string }

function writeRecord(file: string, record: object): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); renameSync(temp, file); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

function owner(project: Project): ConsoleOwner | undefined {
  const file = runtimePath(project, "console.json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as ConsoleOwner;
    if (!Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.nonce !== "string") throw new Error("Invalid console owner record");
    return data;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

export function acquireConsole(project: Project): { stopped(): boolean; close(): void } {
  const record: ConsoleOwner = { pid: process.pid, nonce: randomUUID(), paneId: process.env["HERDR_PANE_ID"] };
  const file = runtimePath(project, "console.json"), stop = runtimePath(project, "console.stop");
  withTeamLock(project, "console", () => {
    const current = owner(project);
    if (current && processAlive(current.pid)) throw new Error("Team Console is already running for this project");
    writeRecord(file, record);
  });
  return {
    stopped: () => existsSync(stop) && readFileSync(stop, "utf8") === record.nonce,
    close: () => withTeamLock(project, "console", () => { if (owner(project)?.nonce === record.nonce) unlinkSync(file); }),
  };
}

export function stopConsole(project: Project): void {
  withTeamLock(project, "console", () => {
    const current = owner(project);
    if (current) writeFileSync(runtimePath(project, "console.stop"), current.nonce, { mode: 0o600 });
  });
}

export function ensureConsole(project: Project, herdr: Herdr, workspaceId: string): ConsoleOutcome {
  try {
    return withTeamLock(project, "console-launch", () => {
      const panes = herdr.paneList(workspaceId);
      const current = owner(project);
      if (current && processAlive(current.pid)) {
        const stop = runtimePath(project, "console.stop");
        if (existsSync(stop) && readFileSync(stop, "utf8") === current.nonce) throw new Error("Team Console is stopping; run up again after it exits");
        const pane = panes.find((p) => p.pane_id === current.paneId);
        if (!pane) throw new Error("Team Console is running outside this workspace; stop it before starting another");
        return { action: "reused", paneId: pane.pane_id, tabId: pane.tab_id };
      }
      const matches = panes.filter((p) => p.tokens?.team_console_project === projectKey(project));
      if (matches.length > 1) throw new Error("Multiple Team Console panes found; refusing to guess");
      let paneId: string, tabId: string;
      if (matches[0]) {
        paneId = matches[0].pane_id; tabId = matches[0].tab_id;
      } else {
        const made = herdr.tabCreate(workspaceId, "Team Console", project.root, {});
        paneId = made.paneId; tabId = made.tabId;
        herdr.reportMetadata(paneId, "herdr-team-console", "Team Console", { team_console_project: projectKey(project) });
      }
      const ticket = runtimePath(project, "console-launch.json");
      if (existsSync(ticket)) {
        const launching = JSON.parse(readFileSync(ticket, "utf8")) as { paneId?: string; at?: number };
        if (launching.paneId === paneId && typeof launching.at === "number" && Date.now() - launching.at < 30_000) {
          return { action: "reused", paneId, tabId };
        }
      }
      if (!herdr.paneIsShell(paneId)) throw new Error("Team Console pane is busy; leave it at a shell prompt and run up again");
      const entry = join(import.meta.dir, "..", "cli.ts");
      writeRecord(ticket, { paneId, at: Date.now() });
      try { herdr.paneRun(paneId, `${shellQuote(process.execPath)} ${shellQuote(entry)} console --root ${shellQuote(project.root)}`); }
      catch (error) { unlinkSync(ticket); throw error; }
      return { action: "started", paneId, tabId };
    });
  } catch (error) { return { action: "failed", failure: error instanceof Error ? error.message : String(error) }; }
}

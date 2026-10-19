import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Herdr } from "./herdr.ts";
import { processAlive, runtimePath, withTeamLock } from "./state.ts";
import { projectKey } from "../dispatch/team-scope.ts";
import type { Project } from "../shared/types.ts";

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
  withTeamLock(project, "console-launch", () => withTeamLock(project, "console", () => {
    const current = owner(project);
    if (current && processAlive(current.pid)) throw new Error("Team Console is already running for this project");
    writeRecord(file, record);
    const ticket = runtimePath(project, "console-launch.json");
    if (existsSync(ticket)) unlinkSync(ticket);
  }));
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

export function ensureConsole(project: Project, herdr: Herdr, workspaceId: string, focus = false): ConsoleOutcome {
  try {
    return withTeamLock(project, "console-launch", () => {
      const panes = herdr.paneList(workspaceId);
      const tabs = herdr.tabList(workspaceId);
      const nameTab = (tabId: string) => {
        if (tabs.find(tab => tab.tab_id === tabId)?.label !== "Console") herdr.tabRename(tabId, "Console");
      };
      const current = owner(project);
      if (current && processAlive(current.pid)) {
        const stop = runtimePath(project, "console.stop");
        if (existsSync(stop) && readFileSync(stop, "utf8") === current.nonce) throw new Error("Team Console is stopping; run up again after it exits");
        const pane = panes.find((p) => p.pane_id === current.paneId);
        if (!pane) throw new Error("Team Console is running outside this workspace; stop it before starting another");
        nameTab(pane.tab_id);
        if (focus) herdr.tabFocus(pane.tab_id);
        return { action: "reused", paneId: pane.pane_id, tabId: pane.tab_id };
      }
      const ticket = runtimePath(project, "console-launch.json");
      if (existsSync(ticket)) {
        const launching = JSON.parse(readFileSync(ticket, "utf8")) as { paneId?: string; at?: number };
        const pane = panes.find(pane => pane.pane_id === launching.paneId);
        if (pane && typeof launching.at === "number" && Date.now() - launching.at < 30_000) {
          nameTab(pane.tab_id);
          if (focus) herdr.tabFocus(pane.tab_id);
          return { action: "reused", paneId: pane.pane_id, tabId: pane.tab_id };
        }
      }
      const { paneId, tabId } = herdr.pluginPaneOpen(workspaceId, project.root, focus);
      // The child acquires console-launch before claiming its lease, so it cannot
      // clear this ticket until the native launch and ownership metadata are saved.
      writeRecord(ticket, { paneId, at: Date.now() });
      nameTab(tabId);
      herdr.reportMetadata(paneId, "herdr-team-console", "Console", { team_console_project: projectKey(project) });
      return { action: "started", paneId, tabId };
    });
  } catch (error) { return { action: "failed", failure: error instanceof Error ? error.message : String(error) }; }
}

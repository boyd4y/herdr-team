import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadProject } from "../team/project.ts";
import type { Project } from "../shared/types.ts";
import { runtimeDirectory, runtimePath } from "./state.ts";

function herdrNoticePath(): string {
  const config = process.env.HERDR_CONFIG_PATH;
  const socket = process.env.HERDR_SOCKET_PATH ?? join(config ? dirname(config) :
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr"), "herdr.sock");
  return join(runtimeDirectory(), "console-events", createHash("sha256").update(socket).digest("hex"));
}

/** A wakeup only; Herdr remains the source of runtime state. No task data or agent input. */
export function notifyConsoleHerdr(): void {
  const file = herdrNoticePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, randomUUID(), { mode: 0o600 });
}

/** Native file notifications invalidate the project snapshot; Herdr notifications do not. */
export function createConsoleEvents(initial: Project, resyncMs = 60_000) {
  const notice = herdrNoticePath(), stop = runtimePath(initial, "console.stop");
  let snapshot = initial, dirty = true, readAt = 0, closed = false;
  let projectWatch: FSWatcher | undefined;
  const watches: FSWatcher[] = [];
  let listener: (() => void) | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    if (closed || pending) return;
    pending = setTimeout(() => { pending = undefined; listener?.(); }, 100);
  };
  const invalidate = () => { dirty = true; };
  const attachProject = () => {
    projectWatch?.close(); projectWatch = undefined;
    try {
      const current = watch(initial.herdrDir, { recursive: true, persistent: false }, (_event, file) => {
        const top = file?.toString().split(/[\\/]/)[0];
        if (!top || [".herdr", "tasks", "roles", "models.json", ".retired-ids"].includes(top)) {
          if (!top || top === ".herdr") { current.close(); if (projectWatch === current) projectWatch = undefined; }
          invalidate(); request();
        }
      });
      current.on("error", () => {
        current.close();
        if (projectWatch === current) { projectWatch = undefined; invalidate(); request(); }
      });
      projectWatch = current;
    } catch { /* Unavailable watchers fall back to fresh reads on reconciliation. */ }
  };
  const watchDirectory = (directory: string, accept: (file: string | null) => boolean) => {
    try {
      mkdirSync(directory, { recursive: true });
      const current = watch(directory, { persistent: false }, (_event, file) => { if (accept(file?.toString() ?? null)) request(); });
      current.on("error", () => { current.close(); request(); });
      watches.push(current);
    } catch { /* Periodic reconciliation still detects missed notices and stop requests. */ }
  };
  const attachNotices = () => {
    for (const current of watches.splice(0)) current.close();
    watchDirectory(initial.root, file => {
      if (file !== null && file !== "TEAM.md") return false;
      invalidate();
      return true;
    });
    watchDirectory(dirname(notice), file => file === null || file === notice.slice(dirname(notice).length + 1));
    watchDirectory(dirname(stop), file => file === null || file === "console.stop");
  };
  return {
    invalidate, request,
    load(force = false): Project {
      if (closed) throw new Error("Console event reader is closed");
      const reconcile = force || Date.now() - readAt >= resyncMs;
      if (dirty || !projectWatch || reconcile) {
        if (!projectWatch || reconcile) attachProject();
        if (reconcile) attachNotices();
        // Clear before reading: notifications queued during the read invalidate the next snapshot.
        dirty = false;
        try { snapshot = loadProject(initial.root); readAt = Date.now(); }
        catch (error) { dirty = true; throw error; }
      }
      return snapshot;
    },
    subscribe(onChange: () => void): () => void { listener = onChange; return () => { listener = undefined; }; },
    close() {
      if (closed) return;
      closed = true; listener = undefined;
      if (pending) clearTimeout(pending);
      projectWatch?.close();
      for (const current of watches) current.close();
    },
  };
}

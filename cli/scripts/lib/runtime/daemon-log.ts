import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, watch } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { deliveryReasonLabel } from "../dispatch/delivery.ts";
import { daemonDirectory } from "./daemon-binding.ts";
import { sanitize } from "../shared/text.ts";
import { stamp } from "../tasks/records.ts";

export const daemonLogPath = () => join(daemonDirectory(), "daemon.log");

type Fields = Record<string, string | number | boolean | null | undefined>;
let warned = false;

export function logDaemon(event: string, fields: Fields = {}): void {
  try {
    mkdirSync(daemonDirectory(), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...fields });
    appendFileSync(daemonLogPath(), line + "\n", { mode: 0o600 });
  } catch {
    // Logging failures must not turn a completed delivery into a failed command.
    if (!warned) process.stderr.write(`Cannot write daemon log: ${daemonLogPath()}\n`);
    warned = true;
  }
}

function readLog<T>(read: (fd: number) => T): T | undefined {
  let fd: number;
  try { fd = openSync(daemonLogPath(), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try { return read(fd); }
  finally { closeSync(fd); }
}

function readTail(fd: number, position: number, lines: number): Buffer {
  let breaks = 0;
  const chunks: Buffer[] = [];
  while (position > 0 && breaks <= lines) {
    const size = Math.min(position, 16_384);
    position -= size;
    const bytes = Buffer.allocUnsafe(size);
    const read = bytes.subarray(0, readSync(fd, bytes, 0, size, position));
    chunks.push(read);
    for (const byte of read) if (byte === 10) breaks++;
  }
  return Buffer.concat(chunks.reverse());
}

export function readDaemonLog(lines: number): string[] {
  return readLog(fd => readTail(fd, fstatSync(fd).size, lines).toString("utf8").split("\n").filter(Boolean).slice(-lines)) ?? [];
}

export function followDaemonLog(lines: number, write: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const directory = daemonDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let position = 0;
  let identity: string | undefined;
  let decoder = new StringDecoder("utf8"), remainder = "";
  function consume(bytes: Buffer, limit?: number): void {
    const parts = (remainder + decoder.write(bytes)).split("\n");
    remainder = parts.pop() ?? "";
    const complete = parts.filter(Boolean);
    for (const line of limit === undefined ? complete : limit ? complete.slice(-limit) : []) write(line);
  }
  return new Promise((resolve, reject) => {
    const abort = () => finish();
    const watcher = watch(directory, (_event, filename) => {
      if (!filename || filename === "daemon.log") readLatest(false);
    });
    function finish(error?: unknown): void {
      watcher.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    function readLatest(initial: boolean): void {
      try {
        readLog(fd => {
          const stat = fstatSync(fd);
          const current = `${stat.dev}:${stat.ino}`;
          if (current !== identity || stat.size < position) {
            identity = current;
            position = 0;
            decoder = new StringDecoder("utf8");
            remainder = "";
          }
          if (initial) {
            consume(readTail(fd, stat.size, lines), lines);
            position = stat.size;
            return;
          }
          const buffer = Buffer.allocUnsafe(Math.min(16_384, Math.max(0, stat.size - position)));
          while (position < stat.size) {
            const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
            if (!bytes) break;
            position += bytes;
            consume(buffer.subarray(0, bytes));
          }
        });
      } catch (error) { finish(error); }
    }
    watcher.once("error", finish);
    signal.addEventListener("abort", abort, { once: true });
    readLatest(true);
  });
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "daemon.ready": "Daemon ready",
  "daemon.status": "Daemon status",
  "daemon.start_failed": "Daemon failed to start",
  "daemon.stopping": "Daemon stopping",
  "daemon.stopped": "Daemon stopped",
  "daemon.stop": "Stop requested",
  "daemon.logs": "Logs viewed",
  "project.registered": "Project registered",
  "project.watched": "Project monitoring started",
  "project.detached": "Project monitoring ended",
  "project.down": "Project stopped",
  "project.registration_failed": "Project registration failed",
  "runtime.events_disconnected": "Herdr connection lost; reconnecting",
  "runtime.events_restored": "Herdr connection restored",
  "delivery.wake_failed": "Failed to notify daemon",
  "delivery.check_failed": "Delivery check failed",
  "dispatch.completed": "Dispatch completed",
  "dispatch.result": "Dispatch result",
  "task.created": "Task created",
  "task.edited": "Task updated",
  "task.claimed": "Task claimed",
  "task.handoff": "Task handed off",
  "feature.delivered": "Feature delivery confirmed",
  "task.agent_closed": "Task agent closed",
  "task.cleaned": "Task cleanup",
  "task.agent_close_failed": "Could not close task agent",
  "task.agent_close_check_failed": "Could not check task agents for cleanup",
  "inbox.retry": "Delivery retried",
  "inbox.checked": "Inbox checked",
  "agentmail.checked": "AgentMail connection checked",
  "agentmail.route_added": "AgentMail route added",
  "agentmail.baseline": "AgentMail event cursor initialized",
  "agentmail.connected": "AgentMail connected",
  "agentmail.config_failed": "AgentMail configuration failed",
  "agentmail.sync_failed": "AgentMail sync failed",
  "agentmail.synced": "AgentMail events synced",
  "agentmail.unmatched": "AgentMail message matched no route",
  "agentmail.routed": "AgentMail message routed",
  "agentmail.trashed": "AgentMail message moved to Inbox trash",
  "agentmail.restored": "AgentMail message restored to Inbox",
  "agentmail.conflict": "AgentMail routing conflict",
  "agentmail.notification_pending": "AgentMail notification waiting to send",
  "agentmail.notification_notified": "AgentMail role notified",
  "agentmail.notification_uncertain": "AgentMail notification needs review",
  "agentmail.read": "AgentMail message viewed",
  "agentmail.acknowledged": "AgentMail message acknowledged",
  "integration.retry": "Integration retried",
  "integration.result": "Integration result",
  "action.failed": "Command failed",
};

const DELIVERY_LABELS: Readonly<Record<string, string>> = {
  queued: "Waiting to send",
  sending: "Sending assignment",
  submitted: "Assignment sent",
  claimed: "Assignment claimed",
  uncertain: "Delivery needs review",
};

export function formatDaemonLog(record: unknown): string {
  if (typeof record === "string") return sanitize(record);
  if (!record || typeof record !== "object") return sanitize(String(record));
  const row = record as Fields;
  const text = (value: Fields[string]) => typeof value === "string" ? sanitize(value) : undefined;
  const event = text(row.event) ?? "Log";
  const date = new Date(text(row.time) ?? "");
  const time = Number.isNaN(date.getTime()) ? undefined : `${stamp(date)}:${String(date.getSeconds()).padStart(2, "0")}`;
  const state = text(row.state);
  const deliveryLabel = event === "delivery.changed" && state ? DELIVERY_LABELS[state] : undefined;
  const label = event === "daemon.start" ? (row.action === "reused" ? "Daemon reused" : "Daemon started")
    : deliveryLabel ?? EVENT_LABELS[event] ?? event;
  const serviceEvent = ["daemon.ready", "daemon.stopping", "daemon.stopped"].includes(event);
  const daemonPid = row.daemonPid ?? (serviceEvent ? row.pid : undefined);
  const task = text(row.task);
  const from = text(row.from);
  const to = text(row.to);
  const command = [text(row.command), text(row.operation)].filter(Boolean).join(" ");
  const details = [
    text(row.project) ?? text(row.projectId),
    task ? "#" + task : undefined,
    text(row.feature) && text(row.iteration) ? `${text(row.feature)}@${text(row.iteration)}` : undefined,
    text(row.terminal),
    text(row.inbox),
    text(row.mail),
    text(row.rule),
    text(row.proxyVariables),
    text(row.folder),
    from && to ? from + " → " + to : from ?? text(row.role),
    deliveryLabel ? undefined : state,
    text(row.reason),
    command,
    text(row.errorType),
    typeof daemonPid === "number" ? "PID " + daemonPid : undefined,
    typeof row.projects === "number" ? `${row.projects} active project${row.projects === 1 ? "" : "s"}` : undefined,
    typeof row.count === "number" ? `${row.count} item${row.count === 1 ? "" : "s"}` : undefined,
    typeof row.returned === "number" ? `${row.returned} entr${row.returned === 1 ? "y" : "ies"}` : undefined,
  ].filter(Boolean);
  return [time, label, details.join(" · ")].filter(Boolean).join("  ");
}

/** Keep state and safe diagnostics. Raw adapter errors can include agent input or argv. */
export function deliveryLogReason(reason?: string): string | undefined {
  if (!reason) return;
  reason = deliveryReasonLabel(reason);
  if (/^Agent is (?:working|waiting for input|error|unknown|done(?: \(Core requires idle\))?)$/.test(reason) ||
      /^Waiting for \d{4}(?:, \d{4})*$/.test(reason) ||
      /^Session is processing #\d{4}$/.test(reason) ||
      /^Herdr submission failed \([a-z_]+\); inspect the receiving agent before retrying$/.test(reason) ||
      ["Waiting for agent; run herdr-team up", "Assignment changed; cancel or requeue this delivery",
        "Delivery needs reconciliation; no automatic resend",
        "Claimed agent disappeared or changed session; verify before retrying"].includes(reason)) return reason;
  if (reason.startsWith("Agent startup failed:")) return "Agent startup failed; see inbox for details";
  return "See inbox for details";
}

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { daemonDirectory, type InboxProjectState } from "./daemon-binding.ts";

export const MAIL_ID = /^mail-[a-f0-9]{24}$/;
export type MailState = "conflict" | "pending" | "sending" | "notified" | "uncertain" | "acknowledged" | "trashed";
export type MailTrashReason = Exclude<InboxProjectState, "registered">;

export const mailTrashReasonLabel = (reason?: MailTrashReason | null) => {
  switch (reason) {
    case "unregistered": return "Project not registered";
    case "ambiguous": return "Project ID matches multiple registrations";
    case "missing_team_directory": return "Registered project is missing its .herdr directory";
    default: return "No eligible project at routing";
  }
};

export interface MailItem {
  id: string;
  inbox: string;
  message_id: string;
  project: string | null;
  role: string | null;
  subject: string;
  sender: string;
  received_at: string;
  state: MailState;
  read?: boolean;
  trash_reason?: MailTrashReason | null;
}

export type MailDraft = Omit<MailItem, "id" | "state" | "trash_reason" | "read"> & { body: string };

export function mailId(inbox: string, message: string): string {
  return "mail-" + createHash("sha256").update(inbox + "\0" + message).digest("hex").slice(0, 24);
}

export function withMailInbox<T>(write: boolean, action: (db: Database) => T): T | undefined {
  const dir = join(daemonDirectory(), "agentmail");
  const path = join(dir, "inbox.sqlite");
  if (write) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
  } else if (!existsSync(path)) return;
  const db = new Database(path, write ? { readwrite: true } : { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    if (write) db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS mail (
        id TEXT PRIMARY KEY, inbox TEXT NOT NULL, message_id TEXT NOT NULL, project TEXT, role TEXT,
        subject TEXT NOT NULL, sender TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_project_state ON mail(project, state, received_at, id);
      CREATE TABLE IF NOT EXISTS mail_trash_reasons (mail_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_reads (mail_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS cursors (inbox TEXT PRIMARY KEY, event_id TEXT NOT NULL);
      COMMIT;
    `);
    else if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'mail' AND type = 'table'").get()) return;
    return action(db);
  } finally { db.close(); }
}

export function mailCursor(db: Database, inbox: string): string | undefined {
  return db.query<{ event_id: string }, [string]>("SELECT event_id FROM cursors WHERE inbox = ?").get(inbox)?.event_id;
}

export function saveMailCursor(db: Database, inbox: string, event: string): void {
  db.query("INSERT OR REPLACE INTO cursors VALUES (?, ?)").run(inbox, event);
}

export function storedMailState(db: Database, id: string): MailState | undefined {
  return db.query<{ state: MailState }, [string]>("SELECT state FROM mail WHERE id = ?").get(id)?.state;
}

function hasTrashReasons(db: Database): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name = 'mail_trash_reasons' AND type = 'table'").get());
}

function withReadFlag<T extends MailItem>(row: T & { opened?: number }): T {
  const { opened, ...item } = row;
  return { ...item, read: row.state === "acknowledged" || Boolean(opened) } as T;
}

function readColumn(db: Database) {
  return db.query("SELECT 1 FROM sqlite_master WHERE name = 'mail_reads' AND type = 'table'").get()
    ? ", EXISTS (SELECT 1 FROM mail_reads WHERE mail_id = mail.id) AS opened" : "";
}

export function markMailRead(project: string, id: string): void {
  withMailInbox(true, db => db.query("INSERT OR IGNORE INTO mail_reads SELECT id FROM mail WHERE project = ? AND id = ?").run(project, id));
}

function recordTrashReason(db: Database, id: string, reason: MailTrashReason): void {
  db.query("INSERT OR REPLACE INTO mail_trash_reasons (mail_id, reason) VALUES (?, ?)").run(id, reason);
}

export function storeMail(
  db: Database, draft: MailDraft, state: "pending" | "trashed" | "conflict" = draft.project ? "pending" : "conflict",
  trashReason?: MailTrashReason,
): boolean {
  const { inbox, message_id, project, role, subject, sender, received_at, body } = draft;
  const id = mailId(inbox, message_id);
  return db.transaction(() => {
    const changed = Boolean(db.query(`
      INSERT INTO mail VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project = excluded.project, role = excluded.role, state = excluded.state
      WHERE mail.state = 'conflict' AND excluded.state IN ('pending', 'trashed')
    `).run(id, inbox, message_id, project, role, subject, sender, received_at, body, state).changes);
    if (changed && state === "trashed" && trashReason) recordTrashReason(db, id, trashReason);
    return changed;
  })();
}

export function listMail(project: string, role: string | null, folder: "active" | "all" | "trash" = "active"): MailItem[] {
  return withMailInbox(false, db => {
    const withReasons = folder === "trash" && hasTrashReasons(db);
    return db.query<MailItem & { opened?: number }, [string, string | null, string | null, string]>(`
      SELECT id, inbox, message_id, project, role, subject, sender, received_at, state ${readColumn(db)}
        ${withReasons ? ", mail_trash_reasons.reason AS trash_reason" : ""}
      FROM mail ${withReasons ? "LEFT JOIN mail_trash_reasons ON mail_trash_reasons.mail_id = mail.id" : ""}
      WHERE project = ? AND (? IS NULL OR role = ?)
      AND CASE ? WHEN 'trash' THEN state = 'trashed'
        WHEN 'all' THEN state != 'trashed'
        ELSE state NOT IN ('trashed', 'acknowledged') END ORDER BY received_at, id
    `).all(project, role, role, folder).map(withReadFlag);
  }) ?? [];
}

export function trashUnregisteredPendingMail(projects: ReadonlyMap<string, InboxProjectState>) {
  const pending = withMailInbox(false, db => db.query<{ project: string }, []>(
    "SELECT DISTINCT project FROM mail WHERE state = 'pending' AND project IS NOT NULL").all()) ?? [];
  const unregistered = pending.flatMap(({ project }) => {
    const reason = projects.get(project) ?? "unregistered";
    return reason === "registered" ? [] : [{ project, reason }];
  });
  if (!unregistered.length) return [];
  return withMailInbox(true, db => db.transaction(() => {
    const update = db.query<Pick<MailItem, "id" | "project" | "role" | "inbox">, [string]>(
      "UPDATE mail SET state = 'trashed' WHERE project = ? AND state = 'pending' RETURNING id, project, role, inbox");
    return unregistered.flatMap(({ project, reason }) => update.all(project).map(item => {
      recordTrashReason(db, item.id, reason);
      return { ...item, trash_reason: reason };
    }));
  })()) ?? [];
}

export function readMail(project: string, id: string): (MailItem & { body: string }) | undefined {
  return withMailInbox(false, db => {
    const item = db.query<MailItem & { body: string; opened?: number }, [string, string]>(
      `SELECT * ${readColumn(db)} FROM mail WHERE project = ? AND id = ?`).get(project, id);
    if (!item) return;
    if (item.state === "trashed" && hasTrashReasons(db)) {
      item.trash_reason = db.query<{ reason: MailTrashReason }, [string]>(
        "SELECT reason FROM mail_trash_reasons WHERE mail_id = ?").get(id)?.reason ?? null;
    }
    return withReadFlag(item);
  });
}

export function updateMailState(project: string, id: string, next: MailState, from: MailState): boolean {
  return withMailInbox(true, db => db.transaction(() => {
    const changed = Boolean(db.query("UPDATE mail SET state = ? WHERE project = ? AND id = ? AND state = ?")
      .run(next, project, id, from).changes);
    if (changed && from === "trashed" && next !== "trashed") {
      db.query("DELETE FROM mail_trash_reasons WHERE mail_id = ?").run(id);
    }
    return changed;
  })()) ?? false;
}

export function recoverMailNotifications(project: string): number {
  return withMailInbox(true, db => db.query(
    "UPDATE mail SET state = 'uncertain' WHERE project = ? AND state = 'sending'").run(project).changes) ?? 0;
}

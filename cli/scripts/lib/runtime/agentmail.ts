import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAME_RE } from "../shared/types.ts";
import { daemonDirectory, inboxProjectStates } from "./daemon-binding.ts";
import { logDaemon } from "./daemon-log.ts";
import { mailCursor, mailId, mailTrashReasonLabel, saveMailCursor, storeMail, storedMailState, trashUnregisteredPendingMail, withMailInbox } from "./mail-inbox.ts";
import { withStateLock } from "./state.ts";

interface Route {
  id: string;
  inbox: string;
  project: string;
  role: string;
  subject_contains?: string;
  subject_not_contains?: string;
  label?: string;
}

interface MailEvent { event_id: string; event_type: string; inbox_id: string; message_id: string; label: string }
interface EventPage { events: MailEvent[]; next_page_token?: string }
interface Message {
  inbox_id: string; message_id: string; labels: string[]; subject?: string; from?: string;
  timestamp: string; extracted_text?: string; text?: string; preview?: string;
}

export class AgentMailError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function readRouteText(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new AgentMailError("Cannot read agentmail.toml");
  }
}

function parseRoutes(text: string): Route[] {
  let config: { routes?: unknown[] };
  try { config = Bun.TOML.parse(text) as typeof config; }
  catch { throw new AgentMailError("Invalid TOML in agentmail.toml"); }
  if (Object.keys(config).some(key => key !== "routes") || !Array.isArray(config.routes) || !config.routes.length) {
    throw new AgentMailError("agentmail.toml requires at least one [[routes]] entry");
  }
  const routes: Route[] = [];
  for (const [index, raw] of config.routes.entries()) {
    const route = raw as Partial<Route> | undefined;
    const valid = route && typeof route === "object" && Object.entries(route).every(([key, value]) =>
      ["id", "inbox", "project", "role", "subject_contains", "subject_not_contains", "label"].includes(key) &&
      typeof value === "string" && value.trim() === value && value.length > 0);
    if (!valid || !route.id || !NAME_RE.test(route.id) || !route.inbox || !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(route.inbox) ||
      !route.project || !/^[a-f0-9]{12}$/.test(route.project) || !route.role || !NAME_RE.test(route.role)) {
      throw new AgentMailError(`Invalid AgentMail route at entry ${index + 1}`);
    }
    if (routes.some(other => other.id === route.id)) throw new AgentMailError(`AgentMail route ID ${route.id} already exists`);
    routes.push({ ...route, id: route.id, inbox: route.inbox.toLowerCase(), project: route.project, role: route.role });
  }
  return routes;
}

export function readAgentMailRoutes(): Route[] | undefined {
  const text = readRouteText(join(daemonDirectory(), "agentmail.toml"));
  return text === undefined ? undefined : parseRoutes(text);
}

export function addAgentMailRoute(route: Route): Route {
  const file = join(daemonDirectory(), "agentmail.toml");
  return withStateLock(join(daemonDirectory(), "agentmail-routes.lock"), () => {
    const previous = readRouteText(file);
    const fields = Object.entries(route).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    const separator = previous ? (previous.endsWith("\n") ? "\n" : "\n\n") : "";
    const text = (previous ?? "") + separator + ["[[routes]]", ...fields, ""].join("\n");
    const added = parseRoutes(text).at(-1)!;
    const destination = previous === undefined ? file : realpathSync(file);
    const temporary = destination + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { force: true }); }
    return added;
  });
}

export function readAgentMailConfig() {
  const routes = readAgentMailRoutes();
  if (!routes) return;
  const keyFile = join(daemonDirectory(), "agentmail.key");
  let apiKey: string;
  try {
    const metadata = lstatSync(keyFile);
    if (!metadata.isFile() || metadata.mode & 0o077) throw new AgentMailError("agentmail.key must be a private regular file (chmod 600)");
    apiKey = readFileSync(keyFile, "utf8").trim();
  } catch (error) {
    if (error instanceof AgentMailError) throw error;
    throw new AgentMailError("Cannot read agentmail.key");
  }
  if (!apiKey || /\s/.test(apiKey)) throw new AgentMailError("agentmail.key must contain one API key");
  return { routes, apiKey };
}

export class AgentMailClient {
  constructor(private readonly apiKey: string, private readonly transport: typeof fetch = fetch) {}

  private async get<T>(inbox: string, resource: string, signal: AbortSignal): Promise<T> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    let response: Response;
    try {
      response = await this.transport(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}${resource}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }, signal: deadline, redirect: "error",
      });
    } catch { throw new AgentMailError("Cannot reach AgentMail"); }
    if (!response.ok) throw new AgentMailError(`AgentMail returned HTTP ${response.status}`, response.status);
    try { return await response.json() as T; }
    catch { throw new AgentMailError("AgentMail returned invalid JSON"); }
  }

  inbox(inbox: string, signal: AbortSignal) {
    return this.get<{ inbox_id: string }>(inbox, "", signal);
  }

  async events(inbox: string, signal: AbortSignal, token?: string, limit = 100): Promise<EventPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (token) params.set("page_token", token);
    const page = await this.get<EventPage>(inbox, "/events?" + params, signal);
    if (!Array.isArray(page.events) || page.events.some(event => event.inbox_id !== inbox || !event.event_id || !event.message_id) ||
      page.next_page_token != null && typeof page.next_page_token !== "string") throw new AgentMailError("AgentMail returned invalid inbox events");
    return page;
  }

  async message(inbox: string, id: string, signal: AbortSignal): Promise<Message | undefined> {
    try {
      const message = await this.get<Message>(inbox, "/messages/" + encodeURIComponent(id), signal);
      if (message.inbox_id !== inbox || message.message_id !== id || !Array.isArray(message.labels)) {
        throw new AgentMailError("AgentMail returned a message for a different inbox or ID");
      }
      return message;
    } catch (error) {
      if (error instanceof AgentMailError && error.status === 404) return;
      throw error;
    }
  }
}

/** Use the provider's inbox identity. Text in To, From or the message body does not affect routing. */
export function matchAgentMail(routes: Route[], message: Pick<Message, "inbox_id" | "subject" | "labels">): Route[] {
  const subject = (message.subject ?? "").normalize("NFC").toLowerCase();
  return routes.filter(route => route.inbox === message.inbox_id &&
    (!route.label || message.labels.includes(route.label)) &&
    (!route.subject_not_contains || !subject.includes(route.subject_not_contains.normalize("NFC").toLowerCase())) &&
    (!route.subject_contains || subject.includes(route.subject_contains.normalize("NFC").toLowerCase())));
}

const inboxesFor = (routes: Route[]) => [...new Set(routes.map(route => route.inbox))];

export async function checkAgentMail() {
  const config = readAgentMailConfig();
  if (!config) throw new AgentMailError("Create agentmail.toml in the global herdr-team directory first");
  const { routes, apiKey } = config;
  const client = new AgentMailClient(apiKey);
  const signal = AbortSignal.timeout(12_000);
  const inboxes = inboxesFor(routes);
  await Promise.all(inboxes.map(async inbox => {
    const [identity] = await Promise.all([client.inbox(inbox, signal), client.events(inbox, signal, undefined, 1)]);
    if (identity.inbox_id !== inbox) throw new AgentMailError("AgentMail returned a different inbox identity");
  }));
  logDaemon("agentmail.checked", { count: inboxes.length });
  return { inboxes, routes };
}

export async function syncAgentMailInbox(
  client: AgentMailClient, inbox: string, routes: Route[], wake: (id: string) => void, signal: AbortSignal,
): Promise<void> {
  const previous = withMailInbox(true, db => mailCursor(db, inbox));
  const first = await client.events(inbox, signal, undefined, previous === undefined ? 1 : 100);
  if (previous === undefined) {
    withMailInbox(true, db => saveMailCursor(db, inbox, first.events[0]?.event_id ?? ""));
    logDaemon("agentmail.baseline", { inbox });
    return;
  }
  const head = first.events[0]?.event_id;
  if (!head || head === previous) return;
  const relevant = new Set(["received", ...routes.flatMap(route => route.label ? [route.label] : [])]);
  const candidates = new Set<string>();
  const visitedPages = new Set<string>();
  let page = first;
  let foundCursor = false;
  for (;;) {
    for (const event of page.events) {
      if (event.event_id === previous) { foundCursor = true; break; }
      if (event.event_type === "label.added" && relevant.has(event.label)) candidates.add(event.message_id);
    }
    if (foundCursor || !page.next_page_token) break;
    if (visitedPages.has(page.next_page_token)) throw new AgentMailError("AgentMail returned a repeated event page");
    visitedPages.add(page.next_page_token);
    page = await client.events(inbox, signal, page.next_page_token);
  }
  if (previous && !foundCursor) throw new AgentMailError("Saved AgentMail event cursor is outside the current event feed");
  for (const id of [...candidates].reverse()) {
    signal.throwIfAborted();
    const localId = mailId(inbox, id);
    const existing = withMailInbox(false, db => storedMailState(db, localId));
    if (existing && existing !== "conflict") continue;
    const message = await client.message(inbox, id, signal);
    if (!message || !message.labels.includes("received") ||
      ["spam", "blocked", "trash", "unauthenticated", "agent-armor-held"].some(label => message.labels.includes(label))) continue;
    const matches = matchAgentMail(routes, message);
    if (!matches.length) { logDaemon("agentmail.unmatched", { inbox, mail: localId }); continue; }
    const targets = new Set(matches.map(route => `${route.project}/${route.role}`));
    const target = targets.size === 1 ? matches[0] : undefined;
    const projectState = target ? inboxProjectStates().get(target.project) ?? "unregistered" : undefined;
    const reason = projectState === "registered" ? undefined : projectState;
    const state = !target ? "conflict" : reason ? "trashed" : "pending";
    const changed = withMailInbox(true, db => storeMail(db, {
      inbox, message_id: id, project: target?.project ?? null, role: target?.role ?? null,
      subject: message.subject ?? "", sender: message.from ?? "", received_at: message.timestamp,
      body: message.extracted_text ?? message.text ?? message.preview ?? "",
    }, state, reason));
    if (!changed) continue;
    logDaemon(state === "pending" ? "agentmail.routed" : state === "trashed" ? "agentmail.trashed" : "agentmail.conflict", {
      inbox, mail: localId, projectId: target?.project, role: target?.role, rule: matches.map(route => route.id).join(", "),
      reason: reason ? mailTrashReasonLabel(reason) : undefined,
    });
    if (target && state === "pending") wake(target.project);
  }
  withMailInbox(true, db => saveMailCursor(db, inbox, head));
  logDaemon("agentmail.synced", { inbox, count: candidates.size });
}

export interface AgentMailStatus { state: "checking" | "ready" | "error"; inboxes: number; error?: string }

export function startAgentMail(wake: (project: string) => void) {
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let status: AgentMailStatus | undefined;
  let running: Promise<void>;
  let ready = new Set<string>();
  let reconciled = false;
  const sync = async () => {
    const before = status;
    try {
      const config = readAgentMailConfig();
      if (!config) { status = undefined; ready.clear(); return; }
      if (!reconciled) {
        for (const item of trashUnregisteredPendingMail(inboxProjectStates())) {
          logDaemon("agentmail.trashed", { mail: item.id, projectId: item.project, role: item.role, inbox: item.inbox,
            reason: mailTrashReasonLabel(item.trash_reason) });
        }
        reconciled = true;
      }
      const client = new AgentMailClient(config.apiKey);
      const inboxes = inboxesFor(config.routes);
      if (!status) status = { state: "checking", inboxes: inboxes.length };
      const results = await Promise.allSettled(inboxes.map(async inbox => {
        await syncAgentMailInbox(client, inbox, config.routes.filter(route => route.inbox === inbox), wake, cancellation.signal);
        return inbox;
      }));
      if (cancellation.signal.aborted) return;
      const reachable = new Set<string>();
      let failure: string | undefined;
      for (const [index, result] of results.entries()) {
        const inbox = inboxes[index]!;
        if (result.status === "fulfilled") {
          reachable.add(inbox);
          if (!ready.has(inbox)) logDaemon("agentmail.connected", { inbox });
        } else {
          const reason = result.reason instanceof AgentMailError ? result.reason.message : "Cannot sync AgentMail inbox";
          failure ??= `${inbox}: ${reason}`;
          if (before?.error !== failure || ready.has(inbox)) logDaemon("agentmail.sync_failed", { inbox, reason });
        }
      }
      ready = reachable;
      status = failure ? { state: "error", inboxes: inboxes.length, error: failure } : { state: "ready", inboxes: inboxes.length };
    } catch (error) {
      const reason = error instanceof AgentMailError ? error.message : "Cannot load AgentMail settings";
      status = { state: "error", inboxes: 0, error: reason };
      if (before?.error !== reason) logDaemon("agentmail.config_failed", { reason });
    }
  };
  const run = () => {
    running = sync().finally(() => { if (!cancellation.signal.aborted) timer = setTimeout(run, 30_000); });
  };
  run();
  return {
    status: () => status,
    async stop() { clearTimeout(timer); cancellation.abort(); await running; },
  };
}

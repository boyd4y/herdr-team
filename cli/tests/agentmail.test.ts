import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import { AgentMailClient, matchAgentMail, readAgentMailConfig, syncAgentMailInbox } from "../scripts/lib/runtime/agentmail.ts";
import { inboxProjectStates, registerProjectRoot } from "../scripts/lib/runtime/daemon-binding.ts";
import { readDaemonLog } from "../scripts/lib/runtime/daemon-log.ts";
import { listMail, mailId, readMail, storedMailState, storeMail, trashUnregisteredPendingMail, withMailInbox } from "../scripts/lib/runtime/mail-inbox.ts";
import { notifyMail } from "../scripts/lib/runtime/mail-notifications.ts";
import { assignProjectAlias } from "../scripts/lib/team/project-aliases.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { fakeHerdr, makeProject, roleMeta, writeRole } from "./helpers.ts";

const inbox = "team@agentmail.to";
const clock = "2026-11-19T10:00:00.000Z";
const event = (event_id: string, message_id: string, label = "received") =>
  ({ event_id, message_id, label, inbox_id: inbox, event_type: "label.added" });
const message = (message_id: string, labels = ["received"], subject = "【Bug】登录") =>
  ({ message_id, labels, subject, inbox_id: inbox, from: "test@example.com", timestamp: clock, text: "private mail body" });

async function fixture(run: (root: string, home: string) => Promise<void>) {
  const project = makeProject();
  const home = mkdtempSync(join(tmpdir(), "herdr-mail-test-"));
  const previous = process.env.HERDR_TEAM_HOME;
  process.env.HERDR_TEAM_HOME = home;
  try {
    writeRole(project.root, "lead", roleMeta({ kind: "codex", worktree: false }));
    await run(project.root, home);
  } finally {
    if (previous === undefined) delete process.env.HERDR_TEAM_HOME;
    else process.env.HERDR_TEAM_HOME = previous;
    project.cleanup();
    rmSync(home, { force: true, recursive: true });
  }
}

test("AgentMail CLI adds global routes without a key and preserves existing TOML on errors", async () => {
  await fixture(async (root, home) => {
    const cli = (cwd: string, ...args: string[]) => Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "agentmail", "route", ...args],
      { cwd, env: { ...process.env, HERDR_TEAM_HOME: home } },
    );
    expect(JSON.parse(cli(home, "list", "--json").stdout.toString())).toEqual([]);
    const file = join(home, "agentmail.toml");
    const comment = "# Team routes\n";
    writeFileSync(file, comment);
    const pending = cli(root, "add", "general", "--inbox", "Team@agentmail.to", "--role", "lead",
      "--subject-not-contains", "【缺陷】");
    expect(pending.exitCode).toBe(0);
    expect(pending.stdout.toString()).toContain("Project is unregistered");
    const original = readFileSync(file, "utf8");
    expect(original).toStartWith(comment);

    registerProjectRoot({ root });
    const project = projectKey({ root }).slice(0, 12);
    const rule = { id: "defects", inbox, project, role: "lead", subject_contains: '【缺陷】"登录"', label: "triage" };
    const result = cli(home, "add", rule.id, "--inbox", inbox, "--project", project, "--role", rule.role,
      "--subject-contains", rule.subject_contains, "--label", rule.label, "--json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(rule);
    const saved = readFileSync(file, "utf8");
    expect(saved).toStartWith(original);
    const listed = cli(home, "list", "--json");
    expect(JSON.parse(listed.stdout.toString())).toEqual([
      { id: "general", inbox, project, role: "lead", subject_not_contains: "【缺陷】" }, rule,
    ]);
    expect(cli(root, "add", rule.id, "--inbox", inbox, "--role", "lead").stderr.toString()).toContain("already exists");
    expect(cli(root, "add", "other", "--inbox", inbox, "--role", "missing").stderr.toString()).toContain("Unknown role");
    expect(readFileSync(file, "utf8")).toBe(saved);
    expect(readDaemonLog(10).join("\n")).toContain("agentmail.route_added");
  });
});

test("AgentMail routes one message to the configured project Inbox and notifies its resident role", async () => {
  await fixture(async (root, home) => {
    const key = projectKey({ root }), projectId = key.slice(0, 12);
    registerProjectRoot({ root });
    writeFileSync(join(home, "agentmail.key"), "test-key\n", { mode: 0o600 });
    writeFileSync(join(home, "agentmail.toml"), `[[routes]]
id = "defect-mail"
inbox = "${inbox}"
project = "${projectId}"
role = "lead"
label = "triage"
subject_contains = "【bug】"
`);
    const config = readAgentMailConfig()!;
    const seen: string[] = [];
    let pages = { first: [event("old", "historical")], next: [] as ReturnType<typeof event>[] };
    let labels = ["received"];
    const fetchMock = (async (resource, options) => {
      const url = new URL(String(resource));
      expect(url.pathname).toStartWith("/v0/inboxes/team%40agentmail.to/");
      expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-key");
      if (url.pathname.endsWith("/events")) {
        return url.searchParams.has("page_token") ? Response.json({ events: pages.next }) :
          Response.json({ events: pages.first, ...(pages.next.length ? { next_page_token: "page-2" } : {}) });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      seen.push(id);
      return Response.json(message(id, labels));
    }) as typeof fetch;
    const client = new AgentMailClient(config.apiKey, fetchMock);
    const wake: string[] = [];
    const sync = () => syncAgentMailInbox(client, inbox, config.routes, id => wake.push(id), new AbortController().signal);
    await sync();
    expect(seen).toEqual([]);
    pages = { first: [event("received-new", "new")], next: [event("old", "historical")] };
    await sync();
    expect(listMail(projectId, "lead")).toEqual([]);
    labels = ["received", "triage"];
    pages = { first: [event("triaged", "new", "triage"), ...pages.first], next: pages.next };
    await sync();
    await sync();
    expect(seen).toEqual(["new", "new"]);
    expect(wake).toEqual([projectId]);
    expect(listMail(projectId, "lead")).toMatchObject([{ id: mailId(inbox, "new"), state: "pending" }]);
    expect(listMail(projectId, "developer")).toEqual([]);
    expect(readMail("000000000000", mailId(inbox, "new"))).toBeUndefined();

    const herdr = fakeHerdr();
    const prompts: string[] = [];
    const submit = herdr.agentPrompt;
    herdr.agentPrompt = (target, prompt) => { prompts.push(prompt); submit(target, prompt); };
    herdr.state.agents.push({ agent: "codex", agent_status: "working", workspace_id: "ws", pane_id: "ws:p1",
      tokens: { team_project: key, team_role: "lead", team_session: "resident" } });
    const project = loadProject(root);
    expect(notifyMail(project, herdr, "ws")).toEqual(["ws:p1"]);
    expect(herdr.calls).toEqual([]);
    herdr.state.agents[0]!.agent_status = "idle";
    expect(notifyMail(project, herdr, "other")).toEqual([]);
    notifyMail(project, herdr, "ws");
    notifyMail(project, herdr, "ws");
    expect(herdr.calls).toHaveLength(1);
    expect(prompts[0]).toContain("herdr-team inbox read");
    expect(prompts[0]).not.toContain("private mail body");

    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args], {
      cwd: root, env: { ...process.env, HERDR_TEAM_HOME: home },
    });
    const id = mailId(inbox, "new");
    const summary = cli("inbox", "list", "--role", "lead", "--json");
    expect(summary.exitCode).toBe(0);
    expect(JSON.parse(summary.stdout.toString())).toMatchObject([{ id, state: "notified", source: "agentmail" }]);
    expect(summary.stdout.toString()).not.toContain("private mail body");
    const read = cli("inbox", "read", id);
    expect(read.exitCode).toBe(0);
    expect(read.stdout.toString()).toContain("private mail body");
    expect(cli("inbox", "ack", id).exitCode).toBe(0);
    expect(listMail(projectId, "lead")).toEqual([]);
    writeFileSync(join(home, "projects.toml"), `[projects]\nmy-team = ${JSON.stringify(realpathSync(root))}\n`);
    const current = cli("project", "current", "--json");
    expect(current.exitCode).toBe(0);
    expect(JSON.parse(current.stdout.toString())).toMatchObject({
      id: projectId, aliases: ["my-team"], registered: true, daemonState: "unregistered", enabled: null,
    });
    expect(cli("project", "current").stdout.toString()).toContain("Aliases     my-team");
    const fromOutside = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args], {
      cwd: home, env: { ...process.env, HERDR_TEAM_HOME: home },
    });
    const archived = fromOutside("inbox", "list", "lead@my-team", "--all", "--json");
    expect(archived.exitCode).toBe(0);
    expect(JSON.parse(archived.stdout.toString())).toMatchObject([{ id, state: "acknowledged" }]);
    expect(JSON.parse(fromOutside("inbox", "developer@my-team", "--all", "--json").stdout.toString())).toEqual([]);
    expect(fromOutside("inbox", "missing@missing", "--all").stderr.toString()).toContain("Unknown Inbox project missing");
    expect(cli("inbox", "ack", id, "--all").exitCode).toBe(2);
    const log = readDaemonLog(20).join("\n");
    expect(log).toContain("agentmail.routed");
    expect(log).toContain("agentmail.notification_notified");
    expect(log).not.toContain("private mail body");
    expect(log).not.toContain("test-key");
  });
});

test("Inbox refuses an ambiguous project name and accepts a unique explicit alias", async () => {
  await fixture(async (root, home) => {
    const other = makeProject();
    try {
      writeRole(other.root, "lead", roleMeta({ kind: "codex", worktree: false }));
      writeFileSync(join(home, "projects.toml"), `[projects]\nmyproj = ${JSON.stringify(other.root)}\nmyproj-alt = ${JSON.stringify(other.root)}\n`);
      const run = (selector: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "inbox", selector, "--json"], {
        cwd: root, env: { ...process.env, HERDR_TEAM_HOME: home },
      });
      const ambiguous = run("lead@myproj");
      expect(ambiguous.exitCode).toBe(2);
      expect(ambiguous.stderr.toString()).toContain("Inbox project myproj is ambiguous");
      expect(run("lead@myproj-alt").exitCode).toBe(0);
      expect(run(`lead@${projectKey({ root }).slice(0, 12)}`).exitCode).toBe(0);
      assignProjectAlias("saved-team", root);
      expect(() => assignProjectAlias("saved-team", other.root)).toThrow("already in use");
      expect(run("lead@saved-team").exitCode).toBe(0);
    } finally { other.cleanup(); }
  });
});

test("AgentMail keeps conflicting mail unrouted and retries a failed event page without duplicates", async () => {
  await fixture(async (root) => {
    const project = projectKey({ root }).slice(0, 12);
    registerProjectRoot({ root });
    const routes = [{ id: "lead-route", inbox, project, role: "lead" },
      { id: "dev-route", inbox, project, role: "developer", label: "dev" }];
    const wake: string[] = [];
    let events: ReturnType<typeof event>[] = [];
    let fail = true;
    const client = new AgentMailClient("test", (async resource => {
      const url = new URL(String(resource));
      if (url.pathname.endsWith("/events")) return Response.json({ events });
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (id === "later" && fail) return Response.json({ error: "Do not leak" }, { status: 503 });
      return Response.json(message(id, id === "conflict" ? ["received", "dev"] : ["received"]));
    }) as typeof fetch);
    const sync = () => syncAgentMailInbox(client, inbox, routes, id => wake.push(id), new AbortController().signal);
    await sync();
    events = [event("c", "later"), event("b", "conflict"), event("a", "first")];
    await expect(sync()).rejects.toThrow("AgentMail returned HTTP 503");
    fail = false;
    await sync();
    expect(wake).toEqual([project, project]);
    expect(listMail(project, null).map(row => row.message_id).sort()).toEqual(["first", "later"]);
    expect(withMailInbox(false, db => storedMailState(db, mailId(inbox, "conflict")))).toBe("conflict");
  });
});

test("Unregistered mail goes to trash; lightweight registration enables delivery without launching a runtime", async () => {
  await fixture(async (root, home) => {
    const project = projectKey({ root }).slice(0, 12);
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args], {
      cwd: home, env: { ...process.env, HERDR_TEAM_HOME: home, HERDR_ENV: "0" },
    });
    const json = (...args: string[]) => {
      const result = cli(...args, "--json");
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    assignProjectAlias("mail-team", root);
    expect(json("project", "current", "--root", root)).toMatchObject({ aliases: ["mail-team"], registered: false });
    const routes = [{ id: "lead-route", inbox, project, role: "lead" }];
    const wake: string[] = [];
    let events: ReturnType<typeof event>[] = [];
    const client = new AgentMailClient("test", (async resource => {
      const url = new URL(String(resource));
      return url.pathname.endsWith("/events") ? Response.json({ events }) :
        Response.json(message(decodeURIComponent(url.pathname.split("/").at(-1)!)));
    }) as typeof fetch);
    const sync = () => syncAgentMailInbox(client, inbox, routes, id => wake.push(id), new AbortController().signal);
    await sync();
    events.unshift(event("a", "unregistered"));
    await sync();
    const trashed = mailId(inbox, "unregistered");
    expect(wake).toEqual([]);
    expect(json("inbox", "lead@mail-team", "--all")).toEqual([]);
    expect(json("inbox", "trash", "lead@mail-team")).toMatchObject([{ id: trashed, state: "trashed", trash_reason: "unregistered" }]);
    expect(cli("inbox", "read", trashed, "--root", root).stdout.toString()).toContain("Reason: Project not registered");
    expect(cli("inbox", "restore", trashed, "--root", root).exitCode).toBe(2);

    withMailInbox(true, db => storeMail(db, {
      inbox, project, message_id: "legacy", role: "lead", subject: "Legacy", sender: "test@example.com", received_at: clock, body: "Keep this",
    }));
    expect(trashUnregisteredPendingMail(inboxProjectStates())).toMatchObject([{ id: mailId(inbox, "legacy"), trash_reason: "unregistered" }]);
    expect(listMail(project, null)).toEqual([]);

    expect(json("project", "register", "--root", root, "--name", "mail-team")).toMatchObject({
      registered: true, daemonState: "unregistered", aliases: ["mail-team"],
    });
    expect(json("daemon", "status")).toMatchObject({ state: "stopped", teams: [] });
    expect(json("project", "list")).toMatchObject([{ id: project, enabled: null }]);
    expect(json("inbox", "trash", "lead@mail-team")).toHaveLength(2);
    events.unshift(event("b", "registered"));
    await sync();
    expect(wake).toEqual([project]);
    expect(json("inbox", "list", "--project", project)).toMatchObject([{ id: mailId(inbox, "registered"), state: "pending" }]);
    expect(json("inbox", "restore", trashed, "--project", project)).toMatchObject({ id: trashed, state: "pending" });
    expect(json("inbox", "lead@mail-team")).toHaveLength(2);
    expect(json("inbox", "read", trashed, "--project", project)).not.toHaveProperty("trash_reason");
    expect(json("inbox", "trash", "lead@mail-team")).toMatchObject([{ id: mailId(inbox, "legacy") }]);
    expect(readDaemonLog(30).join("\n")).toContain("agentmail.trashed");
  });
});

test("Inbox preserves routing causes and reads trash created before reasons were recorded", async () => {
  await fixture(async (root, home) => {
    const project = projectKey({ root }).slice(0, 12);
    const draft = { inbox, project, role: "lead", sender: "test@example.com", subject: "Feedback", received_at: clock, body: "" };
    withMailInbox(true, db => {
      storeMail(db, { ...draft, message_id: "old-trash" }, "trashed");
      db.exec("DROP TABLE mail_trash_reasons");
    });
    const old = listMail(project, "lead", "trash");
    expect(old).toHaveLength(1);
    expect(old[0]).not.toHaveProperty("trash_reason");
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "inbox", "trash", "--root", root], {
      cwd: home, env: { ...process.env, HERDR_TEAM_HOME: home },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("No eligible project at routing");
    withMailInbox(true, db => storeMail(db, { ...draft, message_id: "ambiguous" }, "trashed", "ambiguous"));
    expect(readMail(project, mailId(inbox, "ambiguous"))?.trash_reason).toBe("ambiguous");

    registerProjectRoot({ root });
    withMailInbox(true, db => storeMail(db, { ...draft, message_id: "missing-team-directory" }));
    rmSync(join(root, ".herdr"), { recursive: true });
    expect(inboxProjectStates().get(project)).toBe("missing_team_directory");
    expect(trashUnregisteredPendingMail(inboxProjectStates())).toMatchObject([
      { id: mailId(inbox, "missing-team-directory"), trash_reason: "missing_team_directory" },
    ]);
  });
});

test("AgentMail can route test subjects away from a shared mailbox's ordinary route", async () => {
  await fixture(async (_root, home) => {
    writeFileSync(join(home, "agentmail.key"), "test-key", { mode: 0o600 });
    writeFileSync(join(home, "agentmail.toml"), `[[routes]]
id = "feedback"
inbox = "${inbox}"
project = "0123456789ab"
role = "lead"
subject_not_contains = "[Herdr Team Test]"

[[routes]]
id = "test-mail"
inbox = "${inbox}"
project = "0123456789ac"
role = "lead"
subject_contains = "[Herdr Team Test]"
`);
    const { routes } = readAgentMailConfig()!;
    expect(matchAgentMail(routes, message("feedback", ["received"], "Manual feedback")).map(route => route.id)).toEqual(["feedback"]);
    expect(matchAgentMail(routes, message("test", ["received"], "Re: [herdr team test] Receiving mail")).map(route => route.id)).toEqual(["test-mail"]);
  });
});

test("Inbox displays local receive times and sorts mail newest first in both folders", async () => {
  await fixture(async (root, home) => {
    const project = projectKey({ root }).slice(0, 12);
    const older = "2026-11-19T19:59:43+10:00";
    const newer = "2026-11-19T10:01:04.000Z";
    withMailInbox(true, db => {
      for (const [folder, status] of [["active", "pending"], ["trash", "trashed"]] as const) {
        for (const [subject, received_at] of [["Older", older], ["Newer", newer]] as const) {
          storeMail(db, { inbox, project, role: "lead", sender: "test@example.com",
            message_id: `${folder}-${subject}`, subject, received_at, body: "" }, status);
        }
      }
    });
    for (const folder of ["list", "trash"]) {
      const run = (...options: string[]) => Bun.spawnSync([
        process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "inbox", folder, "--root", root, ...options,
      ], { cwd: home, env: { ...process.env, HERDR_TEAM_HOME: home, HERDR_ENV: "0", TZ: "Asia/Shanghai" } });
      const result = run();
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.toString().trim().split("\n");
      expect(lines[0]).toStartWith("2026-11-19 18:01:04  Newer");
      expect(lines[1]).toStartWith("2026-11-19 17:59:43  Older");
      expect(JSON.parse(run("--json").stdout.toString())).toMatchObject([{ received_at: newer }, { received_at: older }]);
    }
  });
});

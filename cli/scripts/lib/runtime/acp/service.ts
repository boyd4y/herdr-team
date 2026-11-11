import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acpEntry, readAcpLaunch } from "./client.ts";
import { AcpcRequestError, openAcpcTui } from "./tui.ts";
import { processAlive, withTeamLock } from "../state.ts";
import { sanitize } from "../../shared/text.ts";
import { agentHarnessLabel } from "../../team/agents.ts";

export async function serveAcp(file: string) {
  const config = readAcpLaunch(file);
  if (process.env.HERDR_ENV !== "1" || process.env.HERDR_PANE_ID !== config.paneId) throw new Error("ACP runner requires its assigned Herdr pane");
  process.chdir(config.cwd);
  const owner = join(config.stateDir, "owner.json");
  withTeamLock({ root: config.root }, `acp-owner-${createHash("sha256").update(config.stateDir).digest("hex").slice(0, 20)}`, () => {
    if (existsSync(owner)) {
      const previous = JSON.parse(readFileSync(owner, "utf8"));
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid ACP owner record; inspect it before retrying");
      if (processAlive(previous.pid)) throw new Error("ACP session already has a live owner; inspect it before retrying");
      if (previous.token === config.token && existsSync(config.socket)) unlinkSync(config.socket);
      unlinkSync(owner);
    }
    writeFileSync(owner, JSON.stringify({ pid: process.pid, token: config.token }), { flag: "wx", mode: 0o600 });
  });
  let state = "starting", error: string | undefined, seq = Date.now(), closing = false;
  let session: Awaited<ReturnType<typeof openAcpcTui>> | undefined;
  let opening: ReturnType<typeof openAcpcTui> | undefined;
  const startup = new AbortController();
  const log = (message: string) => appendFileSync(join(config.stateDir, "client.log"), `${new Date().toISOString()} ${sanitize(message)}\n`, { mode: 0o600 });
  const herdr = (args: string[]) => Bun.spawnSync([process.env.HERDR_BIN_PATH || "herdr", ...args], { stdout: "pipe", stderr: "pipe", timeout: 2000 });
  const report = (next: string, message?: string) => {
    state = next;
    if (next === "ready") error = undefined;
    else if (message) error = message;
    const semantic = next === "ready" ? "idle" : ["failed", "blocked"].includes(next) ? "blocked" : "working";
    const args = ["pane", "report-agent", config.paneId, "--source", "herdr-team:acp", "--agent", "acp", "--state", semantic, "--seq", String(++seq)];
    if (message) args.push("--message", sanitize(message).slice(0, 300));
    const resume = ["bun", acpEntry, "serve", file];
    if (session && resume.every(arg => !/[\x00-\x1f\x7f']/.test(arg))) args.push("--agent-session-id", session.sessionId, "--", ...resume);
    const result = herdr(args);
    if (result.exitCode !== 0) log("Herdr state report failed; ACP execution state is unchanged.");
    if (session) metadata();
  };
  const metadata = () => herdr(["pane", "report-metadata", config.paneId, "--source", "herdr-team-acp", "--display-agent", config.name,
    "--token", `team_preset=${config.preset ?? ""}`, "--token", `team_harness=${agentHarnessLabel("acp", config.preset)}`, "--token", `team_model=${session?.model ?? config.agent.model}`,
    "--token", `team_acp_launch=${config.launchId}`, "--token", `team_acp_session=${session ? createHash("sha256").update(session.sessionId).digest("hex") : ""}`]);
  const submit = async (id: string, text: string) => {
    const receipt = join(config.stateDir, `delivery-${createHash("sha256").update(id).digest("hex")}.json`);
    const hash = createHash("sha256").update(text).digest("hex");
    if (existsSync(receipt)) {
      const previous = JSON.parse(readFileSync(receipt, "utf8"));
      return previous.hash === hash && ["submitted", "finished"].includes(previous.state)
        ? { ok: true } : { ok: false, code: "acp_delivery_uncertain", error: "This delivery already has an uncertain ACP attempt; inspect it before retrying" };
    }
    if (!session || state !== "ready") return { ok: false, code: "agent_not_ready", error: error ?? `ACP agent is ${state}` };
    const save = (value: string) => writeFileSync(receipt, JSON.stringify({ id, hash, state: value }), { mode: 0o600 });
    writeFileSync(receipt, JSON.stringify({ id, hash, state: "sending" }), { flag: "wx", mode: 0o600 });
    report("working");
    let turn: Awaited<ReturnType<typeof session.start>>;
    try { turn = await session.start(text); }
    catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      if (failure instanceof AcpcRequestError) {
        unlinkSync(receipt); report(/already running/.test(error) ? "working" : "blocked", error);
        return { ok: false, code: "agent_not_ready", error };
      }
      report("blocked", error); return { ok: false, code: "acp_submission_uncertain", error };
    }
    // Start consuming immediately; prompt admission and turn completion are separate.
    const finished = turn.done.then(result => {
      if (result.status === "completed") { save("finished"); error = undefined; }
      else { error = result.error?.message ?? "Turn cancelled; verify task state before continuing"; log(error); }
    }).catch(failure => { error = failure instanceof Error ? failure.message : String(failure); report("blocked", error); log(error); });
    void finished;
    if (JSON.parse(readFileSync(receipt, "utf8")).state !== "finished") save("submitted");
    return { ok: true };
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    startup.abort();
    server.stop(true);
    const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
    try { if (opening) await opening.then(value => value.close(), () => {}); }
    finally {
      herdr(["pane", "release-agent", config.paneId, "--source", "herdr-team:acp", "--agent", "acp", "--seq", String(++seq)]);
      if (existsSync(owner) && JSON.parse(readFileSync(owner, "utf8")).token === config.token) unlinkSync(owner);
      if (existsSync(config.socket)) unlinkSync(config.socket);
      clearTimeout(deadline); process.exit(0);
    }
  };
  const server = Bun.serve({ unix: config.socket, maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${config.token}`) return Response.json({ ok: false }, { status: 403 });
      const operation = new URL(request.url).pathname;
      if (operation === "/status") return Response.json({ ok: true, state, error, sessionId: session?.sessionId, resumed: session?.resumed });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (operation === "/prompt") {
        const input = await request.json() as { id?: unknown; text?: unknown };
        if (!input || typeof input !== "object") return Response.json({ ok: false, code: "empty_agent_prompt", error: "Expected delivery ID and prompt text" });
        if (typeof input.id !== "string" || !input.id || input.id.length > 200 || typeof input.text !== "string" || !input.text.trim()) return Response.json({ ok: false, code: "empty_agent_prompt", error: "Expected delivery ID and prompt text" });
        return Response.json(await submit(input.id, input.text));
      }
      if (operation === "/stop") { setTimeout(() => void shutdown(), 0); return Response.json({ ok: true }); }
      return new Response(null, { status: 404 });
    },
  });
  chmodSync(config.socket, 0o600);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown());
  report("starting"); metadata();
  try {
    opening = openAcpcTui({ ...config, fresh: config.fresh && !existsSync(`${file}.started`) }, report, startup.signal);
    session = await opening;
    if (closing) return;
    writeFileSync(`${file}.started`, "confirmed", { mode: 0o600 });
    metadata();
    report(state);
    herdr(["agent", "rename", config.paneId, config.name]);
    void session.exit.then(shutdown);
  } catch (failure) {
    if (closing) return;
    error = failure instanceof Error ? failure.message : String(failure);
    report("failed", error); writeFileSync(`${file}.error`, error, { mode: 0o600 });
    process.stderr.write(`ACP startup failed: ${sanitize(error)}\n`);
    void shutdown();
  }
}

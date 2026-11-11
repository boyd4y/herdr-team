import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "smol-toml";
import { v5 as uuidV5 } from "uuid";
import WebSocket from "ws";
import type { AcpLaunch } from "./client.ts";

export type TuiState = "starting" | "ready" | "working" | "blocked" | "failed";
type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
export class AcpcRequestError extends Error {}

/** A second app-server client of ACPC's own bridge; never a second ACP connection. */
class AcpcConnection {
  private next = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly socket: WebSocket, readonly receive: (message: Message) => void, disconnected: (error: Error) => void) {
    socket.on("message", data => {
      try {
        const message = JSON.parse(String(data)) as Message;
        const pending = message.method === undefined && message.id !== undefined ? this.pending.get(String(message.id)) : undefined;
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(String(message.id));
          if (message.error) pending.reject(new AcpcRequestError(message.error.message)); else pending.resolve(message.result);
        } else receive(message);
      } catch { socket.close(1002, "Invalid app-server message"); }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      const error = new Error("ACPC control connection closed; inspect its pane before retrying");
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear(); disconnected(error);
    });
  }
  send(message: Message) { this.socket.send(JSON.stringify({ jsonrpc: "2.0", ...message })); }
  request(method: string, params: object): Promise<any> {
    const id = `herdr-team-${++this.next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACPC ${method} was not acknowledged; inspect its pane before retrying`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}

export async function openAcpcTui(
  config: Pick<AcpLaunch, "cwd" | "stateDir" | "fresh" | "agent" | "preset"> & { bound?: boolean },
  state: (next: TuiState, message?: string) => void,
  signal?: AbortSignal,
) {
  const executable = Bun.which("acpc", { PATH: process.env.PATH });
  if (!executable) throw new Error("ACPC is required for the ACP terminal UI; install acpc and retry");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const savedFile = join(config.stateDir, "session.json");
  let resume: string | undefined;
  if (!config.fresh && existsSync(savedFile)) {
    const saved = JSON.parse(readFileSync(savedFile, "utf8"));
    if (saved.cwd !== config.cwd || JSON.stringify(saved.agent) !== JSON.stringify(config.agent) || typeof saved.sessionId !== "string" || !saved.sessionId) throw new Error("ACP session scope changed; use an explicit fresh start");
    if (saved.resumable !== false) {
      // ACPC derives its UI thread ID from the original ACP session ID. Keep
      // confirmed sessions from the previous headless runner, without guessing.
      // ACPC's namespace has non-RFC variant bits; pass its exact 16 bytes
      // rather than a string that UUID libraries correctly reject as an ID.
      resume = saved.client === "acpc" ? saved.sessionId : uuidV5(`remote\n${saved.sessionId}`, Buffer.from("616370632d7468726561642d69647331", "hex"));
    }
  }
  // Keep the Unix socket path short on macOS; ACPC owns its terminal lifecycle.
  const home = `/tmp/ht-acpc-${randomUUID()}`;
  mkdirSync(home, { mode: 0o700 });
  const file = join(home, "agents.toml");
  writeFileSync(file, stringify({ agent: "remote", agents: [{ slug: "remote", name: `acp(${config.preset ?? "default"})`, command: config.agent.command, args: config.agent.args }] }), { mode: 0o600 });
  const initial = "This is session initialization only. Reply Ready and wait for explicit instructions. Do not use tools or start project work.";
  const child = spawn(executable, ["-a", "remote", "-C", config.cwd, ...(resume ? ["resume", resume] : [initial])], {
    cwd: config.cwd, env: { ...process.env, ACPC_HOME: home, ACPC_CONFIG: file }, stdio: "inherit",
  });
  let exited = false, closing = false, connection: AcpcConnection | undefined, threadId: string | undefined;
  let active: string | undefined, busy = false, currentModel = config.agent.model;
  const approvals = new Set<string>();
  const turns = new Map<string, { resolve: (value: { status: string; error?: { message: string } }) => void }>();
  const completed = new Map<string, { status: string; error?: { message: string } }>();
  let scopeChanged = false;
  const report = (next: TuiState, message?: string) => state(scopeChanged ? "blocked" : next, message);
  let startupError: Error | undefined;
  const exit = new Promise<void>(resolve => {
    child.once("error", error => { startupError = error; });
    child.once("close", code => {
      exited = true;
      for (const turn of turns.values()) turn.resolve({ status: "failed", error: { message: "ACPC exited; verify task state before retrying" } });
      turns.clear();
      if (!closing) report("failed", `ACPC exited (${code ?? "signal"})`); resolve();
    });
  });
  const stop = () => { child.kill("SIGTERM"); };
  signal?.addEventListener("abort", stop, { once: true });
  const close = async () => {
    if (closing) return;
    closing = true; signal?.removeEventListener("abort", stop);
    connection?.socket.close();
    if (!exited) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exit; } finally {
      clearTimeout(timer);
      const log = join(home, "log", "acpc.log");
      if (existsSync(log)) copyFileSync(log, join(config.stateDir, "acpc.log"));
      rmSync(home, { recursive: true, force: true });
    }
  };
  const receive = (message: Message) => {
    const { method, params } = message;
    if (method === "thread/started" && typeof params?.thread?.id === "string") {
      if (!threadId) threadId = params.thread.id;
      else if (params.thread.id !== threadId) {
        if (config.bound === false) threadId = params.thread.id;
        else { scopeChanged = true; report("blocked", "ACPC opened another session; restart this runner to restore its assigned conversation"); }
      }
    }
    if (params?.threadId && threadId && params.threadId !== threadId) {
      if (["acpc/sessionConfig/updated", "acpc/availableCommands/updated"].includes(method ?? "")) {
        if (config.bound === false) threadId = params.threadId;
        else { scopeChanged = true; report("blocked", "ACPC changed sessions; restart this runner to restore its assigned conversation"); }
      }
      return;
    }
    if (message.id !== undefined && method) {
      approvals.add(String(message.id)); report("blocked");
      if (method.endsWith("requestApproval") && config.agent.permissionMode !== "approve-reads") {
        connection?.send({ id: message.id, result: { decision: config.agent.permissionMode === "approve-all" ? "accept" : "decline" } });
      }
    } else if (method === "serverRequest/resolved") {
      approvals.delete(String(params?.requestId)); if (!approvals.size) report(busy ? "working" : "ready");
    } else if (method === "turn/started") { active = params?.turn?.id; busy = true; report("working"); }
    else if (method === "turn/completed") {
      const turn = params?.turn;
      if (!turn?.id) return;
      const result = { status: turn.status === "completed" ? "completed" : "failed", error: turn.error ?? { message: "Turn interrupted; verify task state before continuing" } };
      completed.set(turn.id, result);
      if (completed.size > 32) completed.delete(completed.keys().next().value!);
      turns.get(turn.id)?.resolve(result);
      turns.delete(turn.id); active = undefined; busy = false; approvals.clear();
      report(turn.status === "completed" ? "ready" : "blocked", turn.error?.message);
    } else if (method === "thread/settings/updated" && params?.threadSettings?.model) {
      currentModel = params.threadSettings.model; report(approvals.size ? "blocked" : busy ? "working" : "ready");
    }
  };
  try {
    const deadline = Date.now() + 30000;
    const path = join(home, "run", `bridge-${child.pid}.sock`);
    while (!existsSync(path)) {
      if (exited || signal?.aborted) throw startupError ?? new Error("ACPC exited before its control socket was ready");
      if (Date.now() > deadline) throw new Error("ACPC startup timed out; inspect its pane before retrying");
      await Bun.sleep(50);
    }
    const socket = new WebSocket(`ws+unix://${path}:/`, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000 });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    connection = new AcpcConnection(socket, receive, error => { if (!closing) report("failed", error.message); });
    await connection.request("initialize", { clientInfo: { name: "herdr-team", version: "1" }, capabilities: { experimentalApi: true } });
    connection.send({ method: "initialized" });
    while (!threadId) {
      if (exited || signal?.aborted) throw new Error("ACPC exited before confirming its session");
      if (Date.now() > deadline) throw new Error("ACPC did not open the assigned session; inspect its pane before retrying");
      const loaded = await connection.request("thread/loaded/list", {});
      if (loaded.data?.length === 1) threadId = loaded.data[0];
      else await Bun.sleep(50);
    }
    if (resume && threadId !== resume) throw new Error("ACPC opened a different session; refusing to replace the saved conversation");
    if (config.agent.model !== "default") {
      await connection.request("thread/settings/update", { threadId, model: config.agent.model });
      const current = await connection.request("thread/read", { threadId, includeTurns: false });
      if (current.thread?.model !== config.agent.model) throw new Error(`ACPC did not select the requested model ${config.agent.model}`);
    }
    const temp = `${savedFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ client: "acpc", cwd: config.cwd, agent: config.agent, sessionId: threadId }), { flag: "wx", mode: 0o600 });
    renameSync(temp, savedFile);
    const current = await connection.request("thread/read", { threadId, includeTurns: false });
    busy = current.thread?.status?.type === "active" || active !== undefined;
    report(busy ? "working" : "ready");
    return {
      sessionId: threadId, resumed: Boolean(resume), exit,
      get model() { return currentModel; },
      async start(text: string) {
        if (scopeChanged) throw new AcpcRequestError("ACPC changed sessions; restore the assigned conversation before retrying");
        const reply = await connection!.request("turn/start", { threadId, input: [{ type: "text", text, textElements: [] }] });
        const id = reply.turn?.id;
        if (typeof id !== "string") throw new Error("ACPC did not confirm the submitted turn");
        const done = completed.has(id) ? Promise.resolve(completed.get(id)!) : new Promise<{ status: string; error?: { message: string } }>(resolve => turns.set(id, { resolve }));
        return { done };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

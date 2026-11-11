import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HerdrError, type AgentInfo, type Herdr } from "../herdr.ts";
import { runtimePath } from "../state.ts";
import { readAgentPresets, resolveAgentPreset } from "../../team/agents.ts";
import type { Project, RoleCard } from "../../shared/types.ts";

export interface AcpLaunch {
  version: 1;
  root: string;
  role: string;
  taskId?: string;
  cwd: string;
  name: string;
  paneId: string;
  socket: string;
  token: string;
  launchId: string;
  stateDir: string;
  fresh: boolean;
  agent: { command: string; args: string[]; model: string; permissionMode: string };
}
export const acpEntry = fileURLToPath(new URL("../../../acp-agent.ts", import.meta.url));
export function acpLaunchFor(root: string, role: RoleCard) {
  if (!role.preset) throw new Error("ACP roles require a preset in root agents.json");
  const launch = resolveAgentPreset(readAgentPresets(root), "acp", role.preset);
  if (!launch.acp) throw new Error("Missing ACP launch settings");
  return launch;
}
export function readAcpLaunch(file: string): AcpLaunch {
  const value = JSON.parse(readFileSync(file, "utf8")) as AcpLaunch;
  if (value.version !== 1 || !value.token || !value.socket || !value.root || !value.agent?.command) throw new Error("Invalid ACP launch record");
  return value;
}
export function acpLaunchPath(project: Pick<Project, "root">, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid ACP launch binding");
  return runtimePath(project, `acp-launches/${id}.json`);
}
export function requestAcp(file: string, operation: string, body?: object, timeout = 10_000): { ok: boolean; state?: string; error?: string; code?: string; sessionId?: string; resumed?: boolean } {
  const result = Bun.spawnSync([process.execPath, acpEntry, "request", file, operation], {
    stdin: Buffer.from(JSON.stringify(body ?? {})), stdout: "pipe", stderr: "pipe", timeout,
  });
  try { return JSON.parse(result.stdout.toString()); }
  catch { throw new Error(`ACP runner did not acknowledge ${operation}; inspect its pane before retrying`); }
}
export function startAcpAgent(project: Project, herdr: Herdr, role: RoleCard, paneId: string, name: string, scope?: { taskId: string; cwd: string }, fresh = false): boolean {
  // New shells can briefly run prompt helpers. Wait only during explicit startup;
  // a pane that stays occupied is never sent a launch command.
  const shellDeadline = Date.now() + 2000;
  while (!herdr.paneIsShell(paneId)) {
    if (Date.now() >= shellDeadline) throw new Error("ACP pane is busy; refusing to replace its process");
    Bun.sleepSync(50);
  }
  const launch = acpLaunchFor(project.root, role);
  const cwd = realpathSync(scope?.cwd ?? resolve(project.root, role.cwd ?? "."));
  const key = createHash("sha256").update(JSON.stringify([role.name, scope?.taskId, cwd, launch.acp, Object.entries(role.env ?? {}).sort(([a], [b]) => a.localeCompare(b))])).digest("hex").slice(0, 24);
  const stateDir = runtimePath(project, `acp/${key}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID(), file = acpLaunchPath(project, nonce);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const config: AcpLaunch = { version: 1, root: realpathSync(project.root), role: role.name, taskId: scope?.taskId,
    cwd, paneId, name, launchId: nonce, socket: `/tmp/ht-acp-${nonce}.sock`, token: randomUUID(), stateDir, fresh, agent: launch.acp! };
  writeFileSync(file, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  herdr.paneRun(paneId, [process.execPath, acpEntry, "serve", file].map(quote).join(" "));
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (existsSync(`${file}.error`)) throw new HerdrError(readFileSync(`${file}.error`, "utf8"), [], "acp_startup_failed");
    try {
      const status = requestAcp(file, "status", undefined, 1000);
      if (status.state === "failed") throw new HerdrError(status.error ?? "ACP startup failed", [], "acp_startup_failed");
      if (status.state === "ready") {
        const registered = herdr.agentList().find(agent => agent.pane_id === paneId && agent.agent === "acp" && agent.tokens?.team_acp_launch === nonce);
        if (!registered) throw new HerdrError("ACP connected but Herdr agent registration was not confirmed; inspect its pane", [], "acp_registration_failed");
        return status.resumed === true;
      }
    } catch (error) { if (error instanceof HerdrError) throw error; }
    Bun.sleepSync(100);
  }
  throw new Error("ACP startup was not confirmed; inspect the existing pane before retrying");
}
export function promptAcpAgent(project: Project, role: RoleCard, agent: AgentInfo, taskId: string | undefined, delivery: string, text: string): void {
  const id = agent.tokens?.team_acp_launch;
  if (!id) throw new HerdrError("ACP runner has no launch binding", [], "agent_not_ready");
  const file = acpLaunchPath(project, id);
  const launch = readAcpLaunch(file);
  if (launch.root !== realpathSync(project.root) || launch.role !== role.name || launch.paneId !== agent.pane_id || launch.taskId !== taskId) {
    throw new HerdrError("ACP runner does not match this assignment", [], "agent_not_ready");
  }
  const response = requestAcp(file, "prompt", { id: delivery, text });
  if (!response.ok) throw new HerdrError(response.error ?? "ACP submission failed", [], response.code ?? "acp_submission_failed");
}
export function agentSessionId(agent: AgentInfo): string | undefined {
  return agent.agent_session?.value ?? (agent.agent === "acp" ? agent.tokens?.team_acp_session : undefined);
}

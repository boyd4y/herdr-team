import { spawn } from "node:child_process";
import { resolveAgentPreset, type listAgentPresets } from "../team/agents.ts";

export type PresetRow = ReturnType<typeof listAgentPresets>[number];
export const agentOutputLimit = 16_384;

export function agentLaunch(row: PresetRow) {
  const settings = resolveAgentPreset({ [row.kind]: { [row.preset]: row.config } }, row.kind, row.preset);
  const env = { ...process.env, ...settings.env };
  const aliases: Record<string, string[]> = { cursor: ["cursor-agent"], kiro: ["kiro-cli"], qoder: ["qoder", "qodercli", "qoderclicn", "qodercn"] };
  const candidates = aliases[row.kind] ?? [row.kind];
  const executable = candidates.map(name => Bun.which(name, { PATH: env.PATH })).find(Boolean);
  return { executable, candidates, env, args: settings.args };
}

/** Bounded native CLI invocation with cancellation and descendant cleanup. */
export async function captureAgentCommand(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal) {
  const child = spawn(executable, args, { cwd, env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stdout = "", stderr = "", timedOut = false, error: Error | undefined;
  const kill = () => {
    try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  child.stdout!.setEncoding("utf8").on("data", (data: string) => { stdout = (stdout + data).slice(-agentOutputLimit); });
  child.stderr!.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(-agentOutputLimit); });
  child.once("error", value => { error = value; });
  child.once("exit", kill);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  let code: number | null;
  try { code = await new Promise<number | null>(resolve => child.once("close", resolve)); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", kill); }
  return { code, stdout, stderr, timedOut, error };
}

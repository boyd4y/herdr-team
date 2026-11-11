import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetRow } from "../agent-command.ts";
import { agentLaunch } from "../agent-command.ts";
import { resolveAgentPreset } from "../../team/agents.ts";
import { openAcpcTui } from "./tui.ts";
import { agentHarnessLabel } from "../../team/agents.ts";
import { realHerdr } from "../herdr.ts";

export async function runAcpInteractive(root: string, row: PresetRow): Promise<number> {
  const settings = resolveAgentPreset({ acp: { [row.preset]: row.config } }, "acp", row.preset);
  const { executable } = agentLaunch(row);
  if (!executable) throw new Error(`Executable not found on PATH: ${settings.acp!.command}`);
  // A separate process applies preset environment overrides without mutating this CLI.
  const { spawn } = await import("node:child_process");
  const { acpEntry } = await import("./client.ts");
  const child = spawn(process.execPath, [acpEntry, "interactive", root, JSON.stringify({ ...settings.acp, command: executable, preset: row.preset })], { cwd: root, env: { ...process.env, ...settings.env }, stdio: "inherit" });
  const cancel = () => child.kill("SIGINT");
  process.on("SIGINT", cancel);
  try { return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); }); }
  finally { process.off("SIGINT", cancel); }
}

export async function interactiveAcp(cwd: string, settings: Parameters<typeof openAcpcTui>[0]["agent"] & { preset?: string }): Promise<number> {
  const { preset, ...agent } = settings;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-team-acp-run-"));
  let session: Awaited<ReturnType<typeof openAcpcTui>> | undefined;
  const startup = new AbortController();
  const close = () => { startup.abort(); void session?.close(); };
  const pane = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;
  let seq = Date.now();
  const report = (state: string) => {
    if (!pane) return;
    Bun.spawnSync([process.env.HERDR_BIN_PATH || "herdr", "pane", "report-agent", pane, "--source", "herdr-team:acp-manual", "--agent", "acp", "--state", state === "ready" ? "idle" : ["blocked", "failed"].includes(state) ? "blocked" : "working", "--seq", String(++seq)], { stdout: "ignore", stderr: "ignore", timeout: 2000 });
    try { realHerdr().reportMetadata(pane, "herdr-team-acp-manual", agentHarnessLabel("acp", preset), { team_harness: agentHarnessLabel("acp", preset), team_preset: preset ?? null, team_model: session?.model ?? agent.model }); } catch { /* Keep the TUI's terminal intact if Herdr reporting fails. */ }
  };
  process.on("SIGINT", close); process.on("SIGTERM", close);
  try {
    report("starting");
    session = await openAcpcTui({ cwd, agent, preset, stateDir, fresh: true, bound: false }, report, startup.signal);
    await session.exit;
    return 0;
  } finally {
    await session?.close();
    if (pane) Bun.spawnSync([process.env.HERDR_BIN_PATH || "herdr", "pane", "release-agent", pane, "--source", "herdr-team:acp-manual", "--agent", "acp", "--seq", String(++seq)], { stdout: "ignore", stderr: "ignore", timeout: 2000 });
    rmSync(stateDir, { recursive: true, force: true }); process.off("SIGINT", close); process.off("SIGTERM", close);
  }
}

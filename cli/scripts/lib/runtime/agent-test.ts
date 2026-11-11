import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLaunch, agentOutputLimit, captureAgentCommand, type PresetRow } from "./agent-command.ts";
import { formatColumns, sanitize, truncate } from "../shared/text.ts";
import { acpEntry } from "./acp/client.ts";
import { resolveAgentPreset } from "../team/agents.ts";

export interface AgentTestResult {
  kind: string;
  preset: string;
  model: string;
  status: "passed" | "failed" | "skipped";
  elapsedMs: number;
  detail: string;
}

const responseToken = "HERDR_TEAM_OK";
const prompt = `Reply with exactly ${responseToken}. Do not use tools, read files or make changes.`;
function launch(row: PresetRow) {
  const result = agentLaunch(row);
  if (!result.executable) throw new Error(`Executable not found on PATH: ${result.candidates.join(" / ")}`);
  return { ...result, executable: result.executable };
}

/** Explicit standalone setup operation; does not create team agents or workspaces. */
export async function runAgentPreset(root: string, row: PresetRow): Promise<number> {
  if (row.kind === "acp") {
    const { runAcpInteractive } = await import("./acp/interactive.ts");
    return runAcpInteractive(root, row);
  }
  const { executable, env, args } = launch(row);
  const child = spawn(executable, args, { cwd: root, env, stdio: "inherit" });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}

function responseCommand(row: PresetRow, args: string[], answer: string): string[] | undefined {
  if (row.kind === "codex") {
    // exec has its own flags; daemon is a global option and approval uses config.
    const command = args.filter(arg => arg === "--no-daemon");
    const exec = args.filter(arg => arg !== "--no-daemon");
    const approval = exec.indexOf("--ask-for-approval");
    if (approval >= 0) exec.splice(approval, 2, "-c", `approval_policy=${JSON.stringify(row.config.approval_policy)}`);
    return [...command, "exec", ...exec, "--ephemeral", "--skip-git-repo-check", "--color", "never", "--output-last-message", answer, prompt];
  }
  if (row.kind === "claude") return ["--print", prompt, ...args, "--output-format", "text", "--no-session-persistence", "--tools", ""];
  if (row.kind === "grok") return [...args, "--single", prompt, "--output-format", "plain", "--max-turns", "1", "--tools", ""];
  if (row.kind === "kimi") return [...args, "--prompt", prompt, "--output-format", "text"];
  if (row.kind === "qoder") return [...args, "--print", prompt, "--output-format", "text", "--no-session-persistence", "--tools", ""];
}

async function responseTest(row: PresetRow, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentTestResult> {
  const started = Date.now();
  const result = (status: AgentTestResult["status"], detail: string): AgentTestResult => ({
    kind: row.kind, preset: row.preset, model: row.config.model ?? "default", status, elapsedMs: Date.now() - started, detail,
  });
  const answer = join(cwd, "answer.txt");
  // Unsupported automation is a visible skip, never a claimed model response.
  if (row.kind !== "acp" && !responseCommand(row, [], answer)) return result("skipped", `No response-test adapter; use agents run ${row.kind}/${row.preset}`);
  try {
    const { executable, env, args } = launch(row);
    const settings = row.kind === "acp" ? resolveAgentPreset({ acp: { [row.preset]: row.config } }, "acp", row.preset).acp : undefined;
    const command = settings ? [acpEntry, "probe", cwd] : responseCommand(row, args, answer)!;
    const { code, stdout, stderr, timedOut, error } = await captureAgentCommand(settings ? process.execPath : executable, command, cwd, env, timeoutMs, signal,
      settings ? JSON.stringify({ agent: { ...settings, command: executable }, prompt }) : undefined);
    if (signal?.aborted) return result("failed", "Cancelled");
    if (timedOut) return result("failed", `Timed out after ${timeoutMs} ms`);
    if (error) return result("failed", error.message);
    if (code !== 0) return result("failed", sanitize((stderr || stdout).trim(), true).slice(-4000) || `Exited with code ${code}`);
    if (row.kind === "codex" && statSync(answer).size > agentOutputLimit) return result("failed", "Response exceeds test output limit");
    const response = row.kind === "codex" ? readFileSync(answer, "utf8").trim() : stdout.trim();
    return response === responseToken ? result("passed", "Model responded") : result("failed", `Unexpected response: ${sanitize(response).slice(0, 400) || "(empty)"}`);
  } catch (error) { return result("failed", error instanceof Error ? error.message : String(error)); }
}

export async function testAgentPresets(rows: readonly PresetRow[], timeoutMs: number, signal?: AbortSignal, onStart?: (row: PresetRow) => void) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-team-agent-test-"));
  const results: AgentTestResult[] = [];
  try {
    for (const [index, row] of rows.entries()) {
      if (signal?.aborted) {
        results.push({ kind: row.kind, preset: row.preset, model: row.config.model ?? "default", status: "skipped", elapsedMs: 0, detail: "Cancelled before start" });
        continue;
      }
      const cwd = join(directory, String(index)); mkdirSync(cwd);
      onStart?.(row);
      results.push(await responseTest(row, cwd, timeoutMs, signal));
    }
    return results;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function formatAgentTests(results: readonly AgentTestResult[]): string {
  if (!results.length) return "(no agent presets)";
  const table = formatColumns([
    ["HARNESS", "PRESET", "MODEL", "RESULT", "TIME", "DETAIL"],
    ...results.map(row => [row.kind, row.preset, row.model, row.status, `${(row.elapsedMs / 1000).toFixed(1)}s`, truncate(sanitize(row.detail), 120)]),
  ]);
  return `${table}\n\n${results.filter(row => row.status === "passed").length} passed, ${results.filter(row => row.status === "failed").length} failed, ${results.filter(row => row.status === "skipped").length} skipped`;
}

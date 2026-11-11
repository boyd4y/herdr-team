import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPreset, type listAgentPresets } from "../team/agents.ts";
import { formatColumns, sanitize, truncate } from "../shared/text.ts";

type PresetRow = ReturnType<typeof listAgentPresets>[number];
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
const outputLimit = 16_384;

function launch(row: PresetRow) {
  const settings = resolveAgentPreset({ [row.kind]: { [row.preset]: row.config } }, row.kind, row.preset);
  const env = { ...process.env, ...settings.env };
  const aliases: Record<string, string[]> = { cursor: ["cursor-agent"], kiro: ["kiro-cli"], qodercli: ["qoder", "qodercli", "qoderclicn", "qodercn"] };
  const candidates = aliases[row.kind] ?? [row.kind];
  const executable = candidates.map(name => Bun.which(name, { PATH: env.PATH })).find(Boolean);
  if (!executable) throw new Error(`Executable not found on PATH: ${candidates.join(" / ")}`);
  return { executable, env, args: settings.args };
}

/** Explicit standalone setup operation; does not create team agents or workspaces. */
export async function runAgentPreset(root: string, row: PresetRow): Promise<number> {
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
  if (row.kind === "qodercli") return [...args, "--print", prompt, "--output-format", "text", "--max-turns", "1"];
}

async function responseTest(row: PresetRow, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentTestResult> {
  const started = Date.now();
  const result = (status: AgentTestResult["status"], detail: string): AgentTestResult => ({
    kind: row.kind, preset: row.preset, model: row.config.model ?? "default", status, elapsedMs: Date.now() - started, detail,
  });
  const answer = join(cwd, "answer.txt");
  // Unsupported automation is a visible skip, never a claimed model response.
  if (!responseCommand(row, [], answer)) return result("skipped", `No response-test adapter; use agents run ${row.kind}/${row.preset}`);
  try {
    const { executable, env, args } = launch(row);
    const command = responseCommand(row, args, answer)!;
    const child = spawn(executable, command, { cwd, env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "", stderr = "", timedOut = false, error: Error | undefined;
    const kill = () => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    child.stdout!.setEncoding("utf8").on("data", (data: string) => { stdout = (stdout + data).slice(-outputLimit); });
    child.stderr!.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(-outputLimit); });
    child.once("error", value => { error = value; });
    child.once("exit", kill); // Reap helpers that would otherwise keep pipes open.
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    let code: number | null;
    try { code = await new Promise<number | null>(resolve => child.once("close", resolve)); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", kill); }
    if (signal?.aborted) return result("failed", "Cancelled");
    if (timedOut) return result("failed", `Timed out after ${timeoutMs} ms`);
    if (error) return result("failed", error.message);
    if (code !== 0) return result("failed", sanitize((stderr || stdout).trim(), true).slice(-4000) || `Exited with code ${code}`);
    if (row.kind === "codex" && statSync(answer).size > outputLimit) return result("failed", "Response exceeds test output limit");
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

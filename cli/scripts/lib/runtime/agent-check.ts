import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatColumns, sanitize, truncate } from "../shared/text.ts";
import { agentLaunch, captureAgentCommand, type PresetRow } from "./agent-command.ts";

export interface AgentCheckResult {
  kind: string;
  preset: string;
  installed: boolean;
  executable: string | null;
  version: string | null;
  auth: "logged-in" | "not-logged-in" | "unknown";
  issues: string[];
}

async function check(row: PresetRow, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Omit<AgentCheckResult, "kind" | "preset">> {
  const { executable, env, candidates } = agentLaunch(row);
  const result: Omit<AgentCheckResult, "kind" | "preset"> = {
    installed: Boolean(executable), executable: executable ?? null, version: null, auth: "unknown", issues: [],
  };
  if (!executable) { result.issues.push(`Executable not found on PATH: ${candidates.join(" / ")}`); return result; }
  const invoke = async (args: string[], label: string) => {
    const output = await captureAgentCommand(executable, args, cwd, env, timeoutMs, signal);
    if (signal?.aborted) result.issues.push("Cancelled");
    else if (output.timedOut) result.issues.push(`${label} timed out after ${timeoutMs} ms`);
    else if (output.error) result.issues.push(`${label} could not start`);
    else return output;
  };
  const version = await invoke(["--version"], "Version check");
  if (version) {
    // Emit only the version, never raw tool output that may contain credentials.
    result.version = version.code === 0 ? /(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$|\))/m.exec(version.stdout + "\n" + version.stderr)?.[1] ?? null : null;
    if (!result.version) result.issues.push("Version unavailable from --version");
  }
  if (signal?.aborted) return result;
  const args = row.kind === "codex" ? ["login", "status"] : row.kind === "claude" ? ["auth", "status", "--json"] : row.kind === "qoder" ? ["status", "--output", "json"] : undefined;
  if (!args) return result;
  const auth = await invoke(args, "Login check");
  if (!auth) return result;
  if (row.kind === "claude" || row.kind === "qoder") {
    try {
      const value: unknown = JSON.parse(auth.stdout);
      const field = row.kind === "claude" ? "loggedIn" : "logged_in";
      if (value && typeof value === "object" && field in value) {
        const loggedIn = (value as Record<string, unknown>)[field];
        if (loggedIn === true && auth.code === 0) result.auth = "logged-in";
        else if (loggedIn === false) result.auth = "not-logged-in";
      }
    } catch { /* An unsupported CLI version is unknown, never a login failure. */ }
  } else {
    const text = auth.stdout + "\n" + auth.stderr;
    if (auth.code === 0 && /^Logged in\b/m.test(text)) result.auth = "logged-in";
    else if (/^Not logged in\b/m.test(text)) result.auth = "not-logged-in";
  }
  if (result.auth === "unknown") result.issues.push("Login status unavailable from native CLI");
  return result;
}

/** Explicit local checks only; does not fetch models, log in, or send prompts. */
export async function checkAgentPresets(rows: readonly PresetRow[], timeoutMs: number, signal?: AbortSignal): Promise<AgentCheckResult[]> {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-team-agent-check-"));
  const cache = new Map<string, Omit<AgentCheckResult, "kind" | "preset">>();
  const results: AgentCheckResult[] = [];
  try {
    for (const row of rows) {
      if (signal?.aborted) {
        results.push({ kind: row.kind, preset: row.preset, installed: false, executable: null, version: null, auth: "unknown", issues: ["Cancelled before check"] });
        continue;
      }
      // Models and launch permissions do not affect local CLI status. Distinct
      // environment overrides may select different binaries or credential stores.
      const key = JSON.stringify([row.kind, Object.entries(row.config.env ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
      let value = cache.get(key);
      if (!value) { value = await check(row, cwd, timeoutMs, signal); cache.set(key, value); }
      results.push({ kind: row.kind, preset: row.preset, ...value });
    }
    return results;
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

export function formatAgentChecks(rows: readonly AgentCheckResult[]): string {
  if (!rows.length) return "(no agent presets)";
  return formatColumns([
    ["HARNESS", "PRESET", "INSTALLED", "VERSION", "LOGIN", "PATH", "DETAIL"],
    ...rows.map(row => [row.kind, row.preset, row.installed ? "yes" : "no", row.version ?? "unknown", row.auth,
      row.executable ?? "-", truncate(sanitize(row.issues.join("; ") || (row.auth === "unknown" ? "No read-only login-status adapter" : "Native CLI login status; response not tested")), 120)]),
  ]);
}

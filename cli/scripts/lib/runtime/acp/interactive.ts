import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { PresetRow } from "../agent-command.ts";
import { agentLaunch } from "../agent-command.ts";
import { resolveAgentPreset } from "../../team/agents.ts";
import { openAcpSession } from "./session.ts";
import { sanitize } from "../../shared/text.ts";

export async function runAcpInteractive(root: string, row: PresetRow): Promise<number> {
  const settings = resolveAgentPreset({ acp: { [row.preset]: row.config } }, "acp", row.preset);
  const { executable } = agentLaunch(row);
  if (!executable) throw new Error(`Executable not found on PATH: ${settings.acp!.command}`);
  // A separate process applies preset environment overrides without mutating this CLI.
  const { spawn } = await import("node:child_process");
  const { acpEntry } = await import("./client.ts");
  const child = spawn(process.execPath, [acpEntry, "interactive", root, JSON.stringify({ ...settings.acp, command: executable })], { cwd: root, env: { ...process.env, ...settings.env }, stdio: "inherit" });
  const cancel = () => child.kill("SIGINT");
  process.on("SIGINT", cancel);
  try { return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); }); }
  finally { process.off("SIGINT", cancel); }
}

export async function interactiveAcp(cwd: string, agent: Parameters<typeof openAcpSession>[0]["agent"]): Promise<number> {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-team-acp-run-"));
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let session: Awaited<ReturnType<typeof openAcpSession>> | undefined;
  const startup = new AbortController();
  const close = () => { startup.abort(); input.close(); void session?.close(); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
  try {
    session = await openAcpSession({ cwd, agent, stateDir, fresh: true }, async (request) => {
      if (agent.permissionMode !== "approve-reads" || ["read", "search"].includes(request.inferredKind ?? "")) return undefined;
      const answer = await input.question(`\n${sanitize(request.raw.toolCall.title ?? "Permission required")}\n${request.raw.options.map((o, i) => `${i + 1}. ${sanitize(o.name)}`).join("\n")}\nChoose: `);
      const option = request.raw.options[Number(answer) - 1];
      return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancel" };
    }, startup.signal);
    process.stdout.write(`ACP connected: ${sanitize(session.sessionId)}. Type /quit to exit.\n`);
    while (true) {
      const text = await input.question("> ");
      if (text.trim() === "/quit") break;
      if (!text.trim()) continue;
      const turn = session.start(text, crypto.randomUUID(), event => {
        if (event.type === "text_delta") process.stdout.write(sanitize(event.text, true));
        else if (event.type === "tool_call") process.stdout.write(`\n[tool] ${sanitize(event.title ?? event.text)}\n`);
      });
      await turn.started;
      const result = await turn.done;
      process.stdout.write(`\n[${result.status}]\n`);
    }
    return 0;
  } finally { input.close(); await session?.close(); rmSync(stateDir, { recursive: true, force: true }); process.off("SIGINT", close); process.off("SIGTERM", close); }
}

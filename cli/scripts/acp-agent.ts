// Internal ACP pane process and bounded IPC client; not a public orchestration command.
import { readAcpLaunch } from "./lib/runtime/acp/client.ts";
import { writeFileSync } from "node:fs";
import { sanitize } from "./lib/shared/text.ts";

try {
  const [mode, file, operation] = process.argv.slice(2);
  if (!file) throw new Error("ACP runner requires a launch record");
  if (mode === "serve") {
    const { serveAcp } = await import("./lib/runtime/acp/service.ts");
    await serveAcp(file);
  } else if (mode === "interactive" && operation) {
    const { interactiveAcp } = await import("./lib/runtime/acp/interactive.ts");
    process.exitCode = await interactiveAcp(file, JSON.parse(operation));
  } else if (mode === "probe") {
    const input = JSON.parse(await Bun.stdin.text());
    const { openAcpSession } = await import("./lib/runtime/acp/session.ts");
    const session = await openAcpSession({ cwd: file, agent: input.agent, stateDir: `${file}/acp-state`, fresh: true });
    try {
      let text = "";
      const turn = session.start(input.prompt, crypto.randomUUID(), event => { if (event.type === "text_delta" && event.stream !== "thought") text = (text + event.text).slice(-16384); });
      await turn.started;
      const result = await turn.done;
      if (result.status !== "completed") throw new Error(result.status === "failed" ? result.error.message : "ACP response cancelled");
      process.stdout.write(text);
    } finally { await session.close(); }
  } else if (mode === "request" && operation) {
    const config = readAcpLaunch(file);
    const response = await fetch(`http://localhost/${operation}`, { unix: config.socket,
      method: operation === "status" ? "GET" : "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: operation === "status" ? undefined : await Bun.stdin.text(), signal: AbortSignal.timeout(8000) });
    process.stdout.write(JSON.stringify(await response.json()));
  } else throw new Error("Unknown ACP runner operation");
} catch (error) {
  if (process.argv[2] === "serve" && process.argv[3]) writeFileSync(`${process.argv[3]}.error`, error instanceof Error ? error.message : String(error), { mode: 0o600 });
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv[2] === "request") process.stdout.write(JSON.stringify({ ok: false, error: message }));
  else process.stderr.write(`${sanitize(message)}\n`);
  process.exitCode = 1;
}

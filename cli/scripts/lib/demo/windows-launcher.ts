import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const agent = fileURLToPath(new URL("task-agent.ts", import.meta.url));
const harnesses = new Set(["codex", "claude", "grok"]);

export function windowsMockArgv(kind: string): string[] {
  if (!harnesses.has(kind)) throw new Error(`Unknown demo harness: ${kind}`);
  return [process.execPath, agent, kind];
}

export function windowsMockProgram(argv: readonly string[]): string | undefined {
  const [exe, script, kind] = argv;
  if (exe && script && kind && harnesses.has(kind) &&
      win32.relative(process.execPath, exe) === "" && win32.relative(agent, script) === "") return kind;
}

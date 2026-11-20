import { spawnSync } from "node:child_process";
import { DesktopError, realDesktop, type DesktopClient, type DesktopTerminal } from "./desktop.ts";

export type ManagedContext = { kind: "desktop"; caller: DesktopTerminal } | { kind: "tui"; pane: string };
export interface ContextProbes {
  core(address: string): DesktopTerminal;
  tui(): string;
}

/** Environment variables identify candidates; a live runtime must verify them. */
export function managedContext(env: NodeJS.ProcessEnv = process.env, probes?: ContextProbes): ManagedContext {
  const clients: ContextProbes = probes ?? {
    core: address => realDesktop().rpc("terminal.get", { terminal: address }),
    tui: () => {
      const result = spawnSync(env["HERDR_BIN_PATH"] ?? "herdr", ["pane", "current", "--current"], { encoding: "utf8", timeout: 10_000 });
      if (result.error || result.status !== 0) throw new Error("Cannot verify TUI caller");
      const value = JSON.parse(result.stdout);
      return value.result?.pane?.pane_id ?? value.result?.pane_id ?? "";
    },
  };
  let core: DesktopTerminal | undefined;
  let pane: string | undefined;
  if (env["HC_TERMINAL_ID"]) {
    try {
      const terminal = clients.core(env["HC_TERMINAL_ID"]);
      if (terminal.address === env["HC_TERMINAL_ID"] && terminal.state === "live") core = terminal;
    } catch { /* An inherited or stale variable is not verified context. */ }
  }
  if (env["HERDR_ENV"] === "1" && env["HERDR_PANE_ID"]) {
    try {
      const actual = clients.tui();
      if (actual === env["HERDR_PANE_ID"]) pane = actual;
    } catch { /* Verification failure must not fall back to a focused pane. */ }
  }
  if (core && pane) throw new DesktopError("Two managed caller contexts are valid; run directly in the intended Herdr terminal");
  if (core) return { kind: "desktop", caller: core };
  if (pane) return { kind: "tui", pane };
  throw new DesktopError("Cannot verify a live Herdr caller. Run this command inside a Herdr terminal; no operation was performed.");
}

export function callerSpace(caller: DesktopTerminal, client: DesktopClient, pendingSpace?: string, previousSpace?: string): string {
  const id = caller.labels["herdr.space"];
  if (!id) throw new DesktopError("Calling terminal has no space binding; open a project terminal in Herdr first");
  const spaces = client.spaces();
  const space = spaces.find(space => space.id === id && space.machine === null);
  if (!space && (id !== pendingSpace || id.includes("/"))) throw new DesktopError("Calling terminal's labeled space does not exist on this machine");
  // Core labels are the explicit opt-in. The window attaches newly launched
  // terminals asynchronously; absence from a tab is not conflicting ownership.
  const attached = spaces.filter(space => space.tabs.some(tab => tab.terminals.some(terminal => terminal.terminal === caller.address)));
  if (attached.some(other => other.machine !== null || other.id !== id && !(pendingSpace === id && other.id === previousSpace))) {
    throw new DesktopError("Calling terminal has conflicting space ownership");
  }
  return id;
}

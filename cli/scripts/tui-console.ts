#!/usr/bin/env bun
// Native TUI plugin entrypoint. Assignment delivery belongs to the shared daemon.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { acquireConsole } from "./lib/runtime/console.ts";
import { createConsoleEvents } from "./lib/runtime/console-events.ts";
import { realHerdr, type Herdr } from "./lib/runtime/herdr.ts";
import { findRoot, loadProject } from "./lib/team/project.ts";
import { formatConsoleFrame, initialState, renderOnce, renderStatusLine } from "./lib/ui/console-model.ts";
import { syncWorkspaceGit } from "./lib/ui/workspace-git.ts";

function projectRoot(herdr: Herdr, explicit: string | undefined, follow: boolean): string | null {
  if (explicit !== undefined) {
    const root = resolve(explicit);
    if (!existsSync(resolve(root, ".herdr"))) throw new Error("No .herdr/ directory under " + root);
    return root;
  }
  if (follow) {
    try {
      const cwd = herdr.paneCurrent().cwd;
      return cwd ? findRoot(cwd) : null;
    } catch { return null; }
  }
  return findRoot(process.cwd());
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string" },
      interval: { type: "string" },
      all: { type: "boolean" },
      once: { type: "boolean" },
      observe: { type: "boolean" },
      line: { type: "boolean" },
      follow: { type: "boolean" },
      "sync-git": { type: "boolean" },
      sample: { type: "boolean" },
    },
  });
  const seconds = Number(values.interval ?? (values.sample ? 2 : 60));
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--interval must be nonnegative");
  if ((values.follow || values["sync-git"]) && !values.line) throw new Error("--follow and --sync-git require --line");
  if (values.line && (values.sample || values.once)) throw new Error("--line cannot be combined with --sample or --once");

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const showAll = Boolean(values.all);
  if (values.sample) {
    if (!interactive || values.once) {
      const { sampleConsole } = await import("./lib/ui/console-sample.ts");
      const { model } = sampleConsole(initialState(showAll));
      process.stdout.write("SAMPLE · simulated data · no project changes\n" + formatConsoleFrame(model));
      return 0;
    }
    const { runConsole } = await import("./lib/ui/console-view.ts");
    return runConsole({ sample: true, intervalMs: seconds * 1000, showAll });
  }

  const herdr = realHerdr();
  const root = projectRoot(herdr, values.root, Boolean(values.follow));
  if (values.line) {
    if (values["sync-git"]) syncWorkspaceGit(herdr);
    if (!root) return 0;
    const line = renderStatusLine(loadProject(root), herdr);
    if (line) process.stdout.write(line + "\n");
    return 0;
  }
  if (!root) throw new Error("No team project found; open the Console from a project workspace");
  const project = loadProject(root);
  if (values.once || !interactive) {
    process.stdout.write(renderOnce(project, herdr, { showAll }));
    if (!values.once) process.stderr.write("console: non-interactive terminal; rendered one read-only frame.\n");
    return 0;
  }

  if (!values.observe && !herdr.envOk()) throw new Error("Open the TUI Console from a Herdr-managed pane");
  const { runConsole } = await import("./lib/ui/console-view.ts");
  const lease = values.observe ? undefined : acquireConsole(project);
  const events = createConsoleEvents(project, seconds > 0 ? seconds * 1000 : 60_000);
  try {
    return await runConsole({
      initial: project, load: events.load, subscribe: events.subscribe, herdr, intervalMs: seconds * 1000, showAll,
      shouldQuit: () => lease?.stopped() ?? false,
    });
  } finally { events.close(); lease?.close(); }
}

try { process.exitCode = await main(); }
catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 2;
}

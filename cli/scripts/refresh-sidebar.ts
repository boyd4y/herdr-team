// Internal plugin hook; independent of the caller's project directory.
import { realHerdr } from "./lib/runtime/herdr.ts";
import { refreshSessionSidebar } from "./lib/ui/sidebar.ts";
import { syncWorkspaceBadges } from "./lib/ui/workspace-badges.ts";
import { syncWorkspaceGit } from "./lib/ui/workspace-git.ts";
import { notifyConsoleHerdr } from "./lib/runtime/console-events.ts";

try {
  const sessionsOnly = process.argv.slice(2).includes("--sessions-only");
  const herdr = realHerdr();
  if (!herdr.envOk()) throw new Error("Sidebar refresh requires a Herdr-managed pane");
  let failed = 0;
  if (process.env.HERDR_PLUGIN_EVENT) {
    try { notifyConsoleHerdr(); } catch { failed++; }
  }
  if (!process.argv.includes("--notify-only")) {
    if (!sessionsOnly) {
      failed += syncWorkspaceBadges(herdr).failed;
      failed += syncWorkspaceGit(herdr).failed;
    }
    failed += refreshSessionSidebar(herdr, sessionsOnly).failed;
  }
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

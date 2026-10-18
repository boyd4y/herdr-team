// Internal plugin hook; independent of the caller's project directory.
import { realHerdr } from "./lib/herdr.ts";
import { refreshSessionSidebar } from "./lib/sidebar.ts";
import { syncWorkspaceBadges } from "./lib/workspace-badges.ts";
import { syncWorkspaceGit } from "./lib/workspace-git.ts";

try {
  const sessionsOnly = process.argv.slice(2).includes("--sessions-only");
  const herdr = realHerdr();
  if (!herdr.envOk()) throw new Error("Sidebar refresh requires a Herdr-managed pane");
  let failed = 0;
  if (!sessionsOnly) {
    failed += syncWorkspaceBadges(herdr).failed;
    failed += syncWorkspaceGit(herdr).failed;
  }
  failed += refreshSessionSidebar(herdr, sessionsOnly).failed;
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

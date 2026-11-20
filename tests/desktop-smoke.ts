#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { callerSpace, managedContext } from "../cli/scripts/lib/runtime/context.ts";
import { realDesktop, savedDesktopBinding } from "../cli/scripts/lib/runtime/desktop.ts";
import { runRelease } from "../cli/scripts/lib/demo/release.ts";
import { command } from "../cli/scripts/lib/demo/shared.ts";

const [version, mode] = process.argv.slice(2);
if (!version || !/^v\d+\.\d+(?:\.\d+)?-smoke\.\d+(?:\.reject)?$/.test(version) ||
    (mode !== undefined && mode !== "--paired" && mode !== "--reject-once") || process.argv.length > 4 ||
    (mode === "--reject-once") !== version.endsWith(".reject")) {
  throw new Error("Use bun tests/desktop-smoke.ts v1.2-smoke.4 [--paired], or add .reject with --reject-once");
}
const root = realpathSync(process.cwd());
const context = managedContext();
if (root.split("/").at(-1) !== "herdr-team-test" || context.kind !== "desktop" ||
    savedDesktopBinding({ root })?.space !== callerSpace(context.caller, realDesktop())) {
  throw new Error("Run from the main Desktop Space of the registered herdr-team-test project");
}
if (command(["git", "branch", "--show-current"], root).stdout !== "main" ||
    command(["git", "status", "--porcelain"], root).stdout) throw new Error("Start from a clean main branch");

const area = join(root, ".herdr", "typescript-smoke");
mkdirSync(area, { recursive: true, mode: 0o700 });
const lock = join(area, "smoke.lock"), fd = openSync(lock, "wx", 0o600);
try {
  const run = (iteration: string, rejectOnce: boolean) => runRelease(root, {
    version: iteration, area, fast: true, verifyGuards: true, testDirtyCheckout: rejectOnce,
    lanes: [{ label: `Verify release contract ${iteration}`, issue: `Validate release ${iteration}`,
      slug: iteration.replace(/[^a-z0-9-]+/g, "-"), rejectOnce }],
  });
  console.log(JSON.stringify(await run(version, mode === "--reject-once"), null, 2));
  if (mode === "--paired") console.log(JSON.stringify(await run(`${version}.reject`, true), null, 2));
} finally {
  closeSync(fd);
  unlinkSync(lock);
}

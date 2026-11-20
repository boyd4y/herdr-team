#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { callerSpace, managedContext } from "../cli/scripts/lib/runtime/context.ts";
import { realDesktop, savedDesktopBinding } from "../cli/scripts/lib/runtime/desktop.ts";
import { runRelease } from "../cli/scripts/lib/demo/release.ts";
import { selectSmokeScenario, smokeChecks, smokeFixtures } from "../cli/scripts/lib/demo/scenario.ts";
import { command } from "../cli/scripts/lib/demo/shared.ts";

const usage = `Usage: bun tests/desktop-smoke.ts VERSION [--paired|--reject-once|--await-merge [--keywords TEXT] [--seed SEED]]
       bun tests/desktop-smoke.ts --plan [--keywords TEXT] [--seed SEED]
Use a VERSION such as v1.2-smoke.4, with .reject only for --reject-once.`;
const { positionals: [version, ...extra], values } = parseArgs({ allowPositionals: true, options: {
  paired: { type: "boolean" }, "reject-once": { type: "boolean" }, "await-merge": { type: "boolean" },
  plan: { type: "boolean" }, keywords: { type: "string" }, seed: { type: "string" }, help: { type: "boolean" },
} });
if (values.help) { console.log(usage); process.exit(0); }
const awaitMerge = values["await-merge"];
const rejectOnce = values["reject-once"] === true;
const modes = [values.paired, rejectOnce, awaitMerge, values.plan].filter(Boolean);
if (modes.length > 1 || extra.length || (values.plan ? version !== undefined :
    (!version || !/^v\d+\.\d+(?:\.\d+)?-smoke\.\d+(?:\.reject)?$/.test(version) || rejectOnce !== version.endsWith(".reject"))) ||
    ((values.keywords !== undefined || values.seed !== undefined) && !awaitMerge && !values.plan)) throw new Error(usage);
const scenario = awaitMerge || values.plan ? selectSmokeScenario(values.keywords, values.seed) : undefined;
const fixture = scenario ? smokeFixtures[scenario.fixture] : undefined;
if (values.plan && scenario && fixture) {
  console.log(JSON.stringify({ ...scenario, title: fixture.title, acceptance: fixture.expectation, example: smokeChecks(scenario)[0] }, null, 2));
  process.exit(0);
}
if (!version) throw new Error(usage);
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
  const run = (iteration: string, reject: boolean) => runRelease(root, {
    version: iteration, area, fast: true, verifyGuards: true, testDirtyCheckout: reject, scenario,
    lanes: [{ label: fixture?.title ?? `Verify release contract ${iteration}`, issue: `Validate release ${iteration}`,
      slug: iteration.replace(/[^a-z0-9-]+/g, "-"), rejectOnce: reject }],
  });
  console.log(JSON.stringify(await run(version, rejectOnce), null, 2));
  if (values.paired) console.log(JSON.stringify(await run(`${version}.reject`, true), null, 2));
} finally {
  closeSync(fd);
  unlinkSync(lock);
}

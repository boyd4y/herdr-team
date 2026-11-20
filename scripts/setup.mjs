import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shared = resolve(process.env.HERDR_TEAM_SOURCE || resolve(root, "../herdr-team-skill"));
const installer = resolve(shared, "bin/setup.js");
if (!existsSync(installer)) {
  console.error("Shared herdr-team-skill source is missing. Place it beside this repository or set HERDR_TEAM_SOURCE.");
  process.exitCode = 1;
} else {
  for (const script of [installer, resolve(root, "scripts/dev.mjs")]) {
    const args = script === installer ? [script] : [script, "--once"];
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    if (result.error || result.status !== 0) {
      if (result.error) console.error(result.error.message);
      process.exitCode = result.status || 1;
      break;
    }
  }
}

// Internal manifest entrypoint; team workflow decisions remain in the skill.
import { realHerdr } from "./lib/runtime/herdr.ts";
import { runPluginAction } from "./lib/runtime/plugin.ts";

try {
  const result = runPluginAction(process.argv[2], realHerdr(), process.env.HERDR_PLUGIN_CONTEXT_JSON);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

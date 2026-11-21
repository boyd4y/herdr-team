import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const name = "herdr-team";

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), "herdr-team-dev-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, "source checkout");
  const home = join(temporary, "app home");
  const desktop = join(root, "desktop");
  for (const path of ["scripts", "layouts", "mods"]) {
    cpSync(join(repository, "desktop", path), join(desktop, path), { recursive: true });
  }
  const options = { cwd: temporary, env: { ...process.env, HERDR_APP_HOME: home }, encoding: "utf8" };
  return { root, desktop, home, options, register: () => spawnSync(process.execPath, [join(desktop, "scripts/dev.mjs"), "--once"], options) };
}

test("registers an isolated dev layout from any cwd and preserves unrelated files", t => {
  const { root, desktop, home, register } = fixture(t);
  mkdirSync(join(home, "layouts"), { recursive: true });
  writeFileSync(join(home, "layouts/main.json"), "personal layout");
  assert.equal(register().status, 0);
  const installed = join(home, "mods", name, "main.js");
  assert.equal(readFileSync(installed, "utf8"), readFileSync(join(desktop, "mods/herdr-team/main.js"), "utf8"));
  const layout = JSON.parse(readFileSync(join(home, "layouts", `${name}.json`), "utf8"));
  const findConsole = node => node.id === "team-console" ? node : node.children?.map(findConsole).find(Boolean);
  assert.equal(findConsole(layout).content.mod, name);
  assert.deepEqual(findConsole(layout).content.props, {});
  const findAgents = node => node.id === "agents" ? node : node.children?.map(findAgents).find(Boolean);
  assert.equal(findAgents(layout).content.mod, `${name}-agents`);
  assert.equal(readFileSync(join(home, "mods", `${name}-agents`, "main.js"), "utf8"), readFileSync(join(desktop, "mods/herdr-team-agents/main.js"), "utf8"));
  assert.equal(JSON.parse(readFileSync(join(home, `.${name}.json`), "utf8")).source, realpathSync(root));
  const modified = statSync(installed).mtimeMs;
  assert.equal(register().status, 0);
  assert.equal(statSync(installed).mtimeMs, modified);
  assert.equal(readFileSync(join(home, "layouts/main.json"), "utf8"), "personal layout");
  assert.equal(existsSync(join(home, "view.json")), false);
});

test("refuses collisions and external edits before modifying installed files", t => {
  const { desktop, home, register } = fixture(t);
  const installed = join(home, "mods", name, "main.js");
  mkdirSync(join(home, "mods", name), { recursive: true });
  writeFileSync(installed, "personal code");
  assert.equal(register().status, 1);
  assert.equal(readFileSync(installed, "utf8"), "personal code");
  rmSync(join(home, "mods", name), { recursive: true });
  assert.equal(register().status, 0);
  const model = join(home, "mods", name, "model.js");
  const original = readFileSync(model, "utf8");
  writeFileSync(installed, "edited installed code");
  writeFileSync(join(desktop, "mods/herdr-team/model.js"), "changed source");
  const result = register();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Preserving externally edited file/);
  assert.equal(readFileSync(model, "utf8"), original);
  assert.equal(readFileSync(installed, "utf8"), "edited installed code");
});

test("watches atomic saves, nested additions and deletions, then stops cleanly", async t => {
  const { desktop, home, options } = fixture(t);
  const child = spawn(process.execPath, [join(desktop, "scripts/dev.mjs")], options);
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `Timed out. ${output}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  await until(() => output.includes("Watching"));
  const source = join(desktop, "mods/herdr-team");
  const target = join(home, "mods", name);
  writeFileSync(join(source, ".save.tmp"), "// atomic editor save\n");
  renameSync(join(source, ".save.tmp"), join(source, "model.js"));
  await until(() => readFileSync(join(target, "model.js"), "utf8") === "// atomic editor save\n");
  mkdirSync(join(source, "assets"));
  writeFileSync(join(source, "assets/icon.svg"), "<svg/>");
  await until(() => existsSync(join(target, "assets/icon.svg")));
  rmSync(join(source, "assets/icon.svg"));
  await until(() => !existsSync(join(target, "assets/icon.svg")));
  writeFileSync(join(source, "herdr.d.ts"), "generated types");
  writeFileSync(join(desktop, "layouts/herdr-team.json"), JSON.stringify({ id: "changed", content: { mod: "herdr-team" } }));
  await until(() => JSON.parse(readFileSync(join(home, "layouts", `${name}.json`), "utf8")).id === "changed");
  assert.equal(existsSync(join(target, "herdr.d.ts")), false);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.equal(existsSync(join(target, "main.js")), true);
});

import { createHash } from "node:crypto";
import { watch, readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep the checkout as the owner so existing registrations survive the move.
const checkout = dirname(desktop);
const home = resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"));
const name = "herdr-desktop-team-dev";
const manifestPath = join(home, `.${name}.json`);
const sourceMods = new Map([["team-console", name], ["team-agents", `${name}-agents`]]);
const modPaths = [...sourceMods.values()].map(mod => `mods/${mod}`);
const layoutPath = `layouts/${name}.json`;
const args = process.argv.slice(2);
const watchers = [];
let timer;

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function ignored(path) {
  return path.split(/[\\/]/).some(part => part.startsWith(".") || part === "node_modules")
    || path.endsWith(".d.ts") || path.endsWith("jsconfig.json");
}

function sources() {
  const files = new Map();
  function collect(folder, prefix) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const target = `${prefix}/${entry.name}`;
      if (ignored(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Source symlinks are unsupported: ${path}`);
      if (entry.isDirectory()) collect(path, target);
      else if (entry.isFile()) files.set(target, readFileSync(path));
    }
  }
  for (const [source, installed] of sourceMods) collect(join(desktop, "mods", source), `mods/${installed}`);
  const layout = JSON.parse(readFileSync(join(desktop, "layouts/team.json"), "utf8"));
  function rewrite(node) {
    if (!node || typeof node !== "object") return;
    if (sourceMods.has(node.mod)) node.mod = sourceMods.get(node.mod);
    Object.values(node).forEach(rewrite);
  }
  rewrite(layout);
  files.set(layoutPath, Buffer.from(`${JSON.stringify(layout, null, 2)}\n`));
  return files;
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${name}-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (stat(temporary)) unlinkSync(temporary);
  }
}

function sync() {
  // Read and validate everything before touching the installed files.
  const files = sources();
  let previous = { source: checkout, files: {} };
  const manifest = stat(manifestPath);
  if (manifest) {
    if (!manifest.isFile()) throw new Error(`Not a regular file: ${manifestPath}`);
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (previous.source !== checkout || !previous.files || typeof previous.files !== "object") {
      throw new Error(`Dev registration belongs to another checkout: ${manifestPath}`);
    }
  } else if (modPaths.some(path => stat(join(home, path))) || stat(join(home, layoutPath))) {
    throw new Error(`Existing personal files found for ${name}; move them aside or choose another HERDR_APP_HOME.`);
  }
  for (const path of new Set([...Object.keys(previous.files), ...files.keys()])) {
    if (path !== layoutPath && (!modPaths.some(mod => path.startsWith(`${mod}/`)) || path.split("/").some(part => part === ".." || part === "."))) {
      throw new Error(`Invalid managed path: ${path}`);
    }
    // Do not follow links, including links introduced in an installed subfolder.
    for (let parent = dirname(join(home, path)); parent !== home; parent = dirname(parent)) {
      const info = stat(parent);
      if (info && !info.isDirectory()) throw new Error(`Not a regular directory: ${parent}`);
    }
    const target = join(home, path);
    const info = stat(target);
    if (info && (!info.isFile() || !previous.files[path] || digest(readFileSync(target)) !== previous.files[path])) {
      throw new Error(`Preserving externally edited file: ${target}. Move it aside before syncing again.`);
    }
  }
  let changed = 0;
  const hashes = {};
  for (const [path, data] of files) {
    hashes[path] = digest(data);
    if (!stat(join(home, path)) || previous.files[path] !== hashes[path]) {
      atomicWrite(join(home, path), data);
      changed++;
    }
  }
  for (const path of Object.keys(previous.files)) {
    if (!files.has(path) && stat(join(home, path))) {
      unlinkSync(join(home, path));
      changed++;
    }
  }
  if (!manifest || changed) atomicWrite(manifestPath, `${JSON.stringify({ source: checkout, files: hashes }, null, 2)}\n`);
  console.log(`[dev] Synced ${changed} file(s) to ${home}`);
}

function stop(code) {
  clearTimeout(timer);
  watchers.forEach(watcher => watcher.close());
  process.exitCode = code;
}

try {
  if (args.some(arg => arg !== "--once")) throw new Error("Usage: npm run dev [-- --once]");
  if (!args.includes("--once")) {
    // Watch directories, so editor atomic saves and new nested files are observed.
    for (const folder of ["mods", "layouts"]) {
      const watcher = watch(join(desktop, folder), { recursive: true }, (_event, filename) => {
        if (filename && (ignored(String(filename)) || (folder === "layouts" && String(filename) !== "team.json"))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { sync(); }
          catch (error) { console.error(`[dev] ${error.message}`); }
        }, 100);
      });
      watcher.on("error", error => { console.error(`[dev] ${error.message}`); stop(1); });
      watchers.push(watcher);
    }
    process.once("SIGINT", () => stop(0));
    process.once("SIGTERM", () => stop(0));
  }
  sync();
  console.log(`[dev] Registered layout: ${name}`);
  console.log(`[dev] Select it when ready: herdr-app do layout.switch --name ${name}`);
  if (watchers.length) console.log(`[dev] Watching ${relative(process.cwd(), desktop) || "."}; save source files to hot reload. Ctrl+C stops watching; registration stays installed.`);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  stop(1);
}

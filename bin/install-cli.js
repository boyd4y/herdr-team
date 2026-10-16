#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { stateDirectory } = require('./install-skill');

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function target(env = process.env, home = os.homedir()) {
  const bin = path.resolve(env.XDG_BIN_HOME || path.join(home, '.local', 'bin'));
  const onPath = (env.PATH || '').split(path.delimiter).some((entry) => path.resolve(entry || '.') === bin);
  if (!onPath) throw new Error(`${bin} is not on PATH; add it to your shell PATH, open a new shell and retry install-cli. No CLI installed.`);
  return path.join(bin, 'herdr-team');
}

function requireBun(env) {
  const result = spawnSync('bun', ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(result.stdout || '');
  if (result.error || result.status !== 0 || !version ||
      (Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 2))) {
    throw new Error('Bun 1.2+ must be installed on PATH before installing the team CLI.');
  }
}

// Freeze only runtime files, never tests, dev dependencies or local settings.
// Build checkouts move after setup; a shim pointing into that checkout breaks.
function runtime(stateDir, source = path.resolve(__dirname, '..', 'cli')) {
  const files = [['package.json', fs.readFileSync(path.join(source, 'package.json'), 'utf8')]];
  function collect(relative) {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile() && name.endsWith('.ts')) files.push([name, fs.readFileSync(path.join(source, name), 'utf8')]);
      else throw new Error(`Unexpected CLI runtime file: ${name}`);
    }
  }
  collect('scripts');
  const directory = path.join(stateDir, 'cli-runtime', hash(JSON.stringify(files)));
  for (const [name, contents] of files) {
    const destination = path.join(directory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!stat(destination)?.isFile() || fs.readFileSync(destination, 'utf8') !== contents) {
        throw new Error(`CLI runtime cache was modified; refusing to overwrite: ${destination}`);
      }
    }
  }
  return path.join(directory, 'scripts', 'cli.ts');
}

function readState(file) {
  if (!stat(file)) return [];
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records) || records.some((r) => !r || typeof r.file !== 'string' ||
      !path.isAbsolute(r.file) || path.basename(r.file) !== 'herdr-team' || !/^[a-f0-9]{64}$/.test(r.hash) ||
      !Number.isInteger(r.dev) || !Number.isInteger(r.ino) || !Number.isInteger(r.mode)) ||
      new Set(records.map((r) => r.file)).size !== records.length) {
    throw new Error(`${file}: invalid CLI ownership records; refusing changes`);
  }
  return records;
}

function owned(record) {
  const info = stat(record.file);
  return info?.isFile() && info.dev === record.dev && info.ino === record.ino &&
    (info.mode & 0o777) === record.mode && hash(fs.readFileSync(record.file)) === record.hash;
}

async function installCLI(uninstall = false, env = process.env) {
  // Removal depends only on the ledger, even when HOME, PATH or Bun changed.
  const file = uninstall ? null : target(env);
  if (!uninstall) requireBun(env);
  const stateDir = stateDirectory(env);
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'cli.lock');
  const deadline = Date.now() + 15000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`CLI installation locked: ${lock}; retry after the other action finishes`);
      await delay(50);
    }
  }
  try {
    const ledger = path.join(stateDir, 'cli-paths.json');
    let records = readState(ledger);
    const save = () => {
      const text = JSON.stringify(records, null, 2) + '\n';
      if (stat(ledger)?.isFile() && fs.readFileSync(ledger, 'utf8') === text) return;
      const temporary = `${ledger}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, ledger);
      } finally { fs.rmSync(temporary, { force: true }); }
    };
    if (uninstall) {
      for (const record of [...records]) {
        if (stat(record.file)) {
          if (!owned(record)) { console.log(`Kept modified CLI: ${record.file}`); continue; }
          fs.unlinkSync(record.file);
          console.log(`Removed CLI: ${record.file}`);
        }
        records = records.filter((r) => r !== record); save();
      }
      return;
    }
    let record = records.find((r) => r.file === file);
    if (stat(file) && (!record || !owned(record))) {
      console.log(`Skipped existing CLI: ${file}`); return;
    }
    const text = `#!/usr/bin/env bun\nawait import(${JSON.stringify(pathToFileURL(runtime(stateDir)).href)});\n`;
    if (!stat(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let created;
      try { created = fs.openSync(file, 'wx', 0o755); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        console.log(`Skipped existing CLI: ${file}`); return;
      }
      fs.closeSync(created);
      const info = stat(file);
      records = records.filter((r) => r.file !== file);
      record = { file, hash: hash(''), dev: info.dev, ino: info.ino, mode: info.mode & 0o777 };
      records.push(record);
      save(); // Record the newly created file before writing executable content.
    }
    if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
    record.hash = hash(text);
    save();
    console.log(`Installed CLI: ${file}`);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--uninstall')) {
    console.error('Usage: node bin/install-cli.js [--uninstall]'); process.exitCode = 1;
  } else installCLI(args.includes('--uninstall')).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}

module.exports = { target, runtime, installCLI };

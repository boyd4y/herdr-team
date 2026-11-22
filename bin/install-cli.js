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
const windows = require('./windows-tools');

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function target(env = process.env, home = os.homedir(), name = 'herdr-team', platform = process.platform) {
  if (platform === 'win32') {
    const { join, resolve } = path.win32;
    const bin = resolve(env.XDG_BIN_HOME || join(env.BUN_INSTALL || join(home, '.bun'), 'bin'));
    const onPath = windows.pathEntries(env).some(entry => resolve(entry).toLowerCase() === bin.toLowerCase());
    if (!onPath) throw new Error(`${bin} is not on PATH; add it to your user PATH, open a new shell and retry install-cli. No CLI installed.`);
    return join(bin, `${name}.cmd`);
  }
  const bin = path.resolve(env.XDG_BIN_HOME || path.join(home, '.local', 'bin'));
  const onPath = (env.PATH || '').split(path.delimiter).some(entry => path.resolve(entry || '.') === bin);
  if (!onPath) throw new Error(`${bin} is not on PATH; add it to your shell PATH, open a new shell and retry install-cli. No CLI installed.`);
  return path.join(bin, name);
}

function requireBun(env) {
  const bun = process.platform === 'win32' ? windows.bunExecutable(env) : 'bun';
  const result = spawnSync(bun, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(result.stdout || '');
  if (result.error || result.status !== 0 || !version ||
      (Number(version[1]) < 1 || (Number(version[1]) === 1 &&
        (Number(version[2]) < 3 || (Number(version[2]) === 3 && Number(version[3]) < 14))))) {
    throw new Error('Bun 1.3.14+ must be installed on PATH before installing the team CLI.');
  }
  return bun;
}

// Freeze runtime source and assets; install the production dependency graph separately.
// Build checkouts move after setup; a shim pointing into that checkout breaks.
function runtime(stateDir, source = path.resolve(__dirname, '..', 'cli'), env = process.env, bun = requireBun(env)) {
  const files = ['package.json', 'bun.lock'].map((name) =>
    [path.join('cli', name), fs.readFileSync(path.join(source, name), 'utf8')]);
  function collect(directory, relative, destination, extensions) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) collect(directory, name, destination, extensions);
      else if (entry.isFile() && extensions.includes(path.extname(name))) {
        files.push([path.join(destination, name), fs.readFileSync(path.join(directory, name), 'utf8')]);
      } else throw new Error(`Unexpected CLI runtime file: ${name}`);
    }
  }
  collect(source, 'scripts', 'cli', ['.ts']);
  collect(path.join(source, '..', 'skill', 'assets'), '', 'skill/assets', ['.md', '.json']);
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
  // Bun resolves the pinned production graph and selects the host native library.
  // Validate it before publishing a new shim; a failed upgrade leaves the old CLI usable.
  for (const args of [
    ['install', '--production', '--frozen-lockfile', '--ignore-scripts'],
    ['-e', 'await import("@opentui/core");'],
  ]) {
    const result = spawnSync(bun, args, { cwd: path.join(directory, 'cli'), env,
      encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0) {
      throw new Error(`CLI dependency setup failed: ${result.error?.message || result.stderr || result.stdout}`);
    }
  }
  return path.join(directory, 'cli', 'scripts', 'cli.ts');
}

const commandNames = ['herdr-team', 'herdr-mock'];
const launcherNames = commandNames.flatMap(name => [name, `${name}.cmd`, `${name}.mjs`]);
const fileIdentity = file => process.platform === 'win32' ? file.toLowerCase() : file;

function readState(file) {
  if (!stat(file)) return [];
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records) || records.some((r) => !r || typeof r.file !== 'string' ||
      !path.isAbsolute(r.file) || !launcherNames.includes(path.basename(r.file)) || !/^[a-f0-9]{64}$/.test(r.hash) ||
      !Number.isInteger(r.dev) || !Number.isInteger(r.ino) || !Number.isInteger(r.mode)) ||
      new Set(records.map(r => fileIdentity(r.file))).size !== records.length) {
    throw new Error(`${file}: invalid CLI ownership records; refusing changes`);
  }
  return records;
}

function owned(record) {
  const info = stat(record.file);
  return info?.isFile() && info.dev === record.dev && info.ino === record.ino &&
    (info.mode & 0o777) === record.mode && hash(fs.readFileSync(record.file)) === record.hash;
}

function launcherFiles(file, entry, mock, platform = process.platform) {
  const cli = pathToFileURL(entry).href;
  const tuiView = pathToFileURL(path.join(path.dirname(entry), 'tui-console.ts')).href;
  const mockEntry = pathToFileURL(path.join(path.dirname(entry), 'mock-agent.ts')).href;
  const script = mock ? `await import(${JSON.stringify(mockEntry)});\n`
    : `await import(process.env.HERDR_TEAM_TUI_VIEW === "1" ? ${JSON.stringify(tuiView)} : ${JSON.stringify(cli)});\n`;
  if (platform !== 'win32') return [[file, '#!/usr/bin/env bun\n' + script]];
  const name = path.win32.basename(file, '.cmd');
  return [
    [file.slice(0, -4) + '.mjs', script],
    [file, [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "NoDefaultCurrentDirectoryInExePath=1"',
      `bun "%~dp0${name}.mjs" %*`,
      '',
    ].join('\r\n')],
  ];
}

async function installCLI(uninstall = false, env = process.env, mock = false) {
  // Removal depends only on the ledger, even when HOME, PATH or Bun changed.
  const name = mock ? 'herdr-mock' : 'herdr-team';
  const file = uninstall ? null : target(env, os.homedir(), name);
  const bun = uninstall ? null : requireBun(env);
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
      const uninstallNames = [name, `${name}.cmd`, `${name}.mjs`];
      const uninstallRecords = records.filter(record => uninstallNames.includes(path.basename(record.file)));
      // Withdraw each command before removing its adjacent module.
      uninstallRecords.sort((a, b) => uninstallNames.indexOf(path.basename(a.file)) - uninstallNames.indexOf(path.basename(b.file)));
      for (const record of uninstallRecords) {
        if (stat(record.file)) {
          if (!owned(record)) { console.log(`Kept modified CLI: ${record.file}`); continue; }
          fs.unlinkSync(record.file);
          console.log(`Removed CLI: ${record.file}`);
        }
        records = records.filter((r) => r !== record); save();
      }
      return;
    }
    const files = process.platform === 'win32' ? [file.slice(0, -4) + '.mjs', file] : [file];
    const recordFor = candidate => records.find(record => fileIdentity(record.file) === fileIdentity(candidate));
    for (const candidate of files) {
      const record = recordFor(candidate);
      if (stat(candidate) && (!record || !owned(record))) {
        console.log(`Skipped existing CLI: ${candidate}`); return;
      }
    }
    const entry = runtime(stateDir, undefined, env, bun);
    for (const [candidate, text] of launcherFiles(file, entry, mock)) {
      let record = recordFor(candidate);
      const exists = stat(candidate);
      if (exists && (!record || !owned(record))) {
        console.log(`Skipped existing CLI: ${candidate}`); return;
      }
      if (!exists) {
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        let created;
        try { created = fs.openSync(candidate, 'wx', 0o755); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          console.log(`Skipped existing CLI: ${candidate}`); return;
        }
        fs.closeSync(created);
        const info = stat(candidate);
        if (record) records = records.filter(item => item !== record);
        record = { file: candidate, hash: hash(''), dev: info.dev, ino: info.ino, mode: info.mode & 0o777 };
        records.push(record);
        save(); // Record the newly created file before writing executable content.
      }
      if (fs.readFileSync(candidate, 'utf8') !== text) fs.writeFileSync(candidate, text);
      record.hash = hash(text);
      save();
    }
    console.log(`Installed CLI: ${file}`);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--uninstall' && arg !== '--mock')) {
    console.error('Usage: node bin/install-cli.js [--mock] [--uninstall]'); process.exitCode = 1;
  } else installCLI(args.includes('--uninstall'), process.env, args.includes('--mock')).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}

module.exports = { target, runtime, launcherFiles, installCLI };

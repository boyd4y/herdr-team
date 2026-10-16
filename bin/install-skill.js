#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const NAME = 'herdr-team';
// Only adapters with a known user-level skills directory. Do not infer a
// skills format from another program's trust/config directory (e.g. grok).
const AGENTS = [
  { kind: 'claude', variable: 'CLAUDE_CONFIG_DIR', home: ['.claude'] },
  { kind: 'codex', variable: 'CODEX_HOME', home: ['.codex'] },
  { kind: 'pi', variable: 'PI_CODING_AGENT_DIR', home: ['.pi', 'agent'] },
];

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function targets(env = process.env, home = os.homedir()) {
  if (env.HERDR_TEAM_SKILL_DIRS !== undefined) {
    // An explicit empty value disables discovery as well as installation.
    return [...new Set(env.HERDR_TEAM_SKILL_DIRS.split(path.delimiter).filter(Boolean)
      .map((dir) => path.resolve(dir, NAME)))];
  }
  return [...new Set(AGENTS.filter(({ kind }) => (env.PATH || '').split(path.delimiter).some((bin) => {
    const executable = path.join(bin, kind);
    try { return fs.statSync(executable).isFile() && (fs.accessSync(executable, fs.constants.X_OK), true); }
    catch { return false; }
  })).map((agent) => path.resolve(env[agent.variable] || path.join(home, ...agent.home), 'skills', NAME)))];
}

function stateDirectory(env = process.env, home = os.homedir()) {
  // Herdr build commands do not receive the action's plugin environment.
  // Match Herdr's Unix state-dir default so build and actions share ownership.
  return path.resolve(env.HERDR_PLUGIN_STATE_DIR || path.join(
    env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'herdr', 'plugins', 'linxai.herdr-team'));
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function atomicWrite(file, text) {
  if (stat(file)?.isFile() && fs.readFileSync(file, 'utf8') === text) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function readState(file) {
  if (!stat(file)) return [];
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records) || records.some((r) => !r || typeof r.dir !== 'string' ||
    !path.isAbsolute(r.dir) || path.basename(r.dir) !== NAME ||
    !(r.hash === null || /^[a-f0-9]{64}$/.test(r.hash)) ||
    !Number.isInteger(r.dev) || !Number.isInteger(r.ino)) ||
    new Set(records.map((r) => r.dir)).size !== records.length) {
    throw new Error(`${file}: invalid skill ownership records; refusing changes`);
  }
  return records;
}

function skillText(stateDir) {
  // The plugin bundles its skill and references for standalone distribution.
  // No npm package, network or installed skill is needed.
  const source = path.resolve(__dirname, '..', 'skill');
  const text = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
  const refs = path.join(source, 'references');
  const documents = fs.readdirSync(refs).sort().map((name) => {
    if (!stat(path.join(refs, name))?.isFile()) throw new Error(`Expected reference file: ${name}`);
    return [name, fs.readFileSync(path.join(refs, name), 'utf8')];
  });
  // Immutable versions keep retained/user-edited skills' old references valid.
  // A build checkout is moved after the hook, so never link to __dirname here.
  const destination = path.join(stateDir, 'skill-references', hash(JSON.stringify(documents)));
  fs.mkdirSync(destination, { recursive: true });
  for (const [name, contents] of documents) atomicWrite(path.join(destination, name), contents);
  return text.replace(/\]\(references\/([^\s)]+)\)/g, (_, name) => {
    if (!documents.some(([file]) => file === name)) throw new Error(`Missing skill reference: ${name}`);
    return `](<${path.join(destination, name).replaceAll('>', '%3E')}>)`;
  });
}

function owned(record) {
  const directory = stat(record.dir);
  if (!directory?.isDirectory() || directory.dev !== record.dev || directory.ino !== record.ino) return false;
  const file = path.join(record.dir, 'SKILL.md');
  const info = stat(file);
  // Symlinks and edited files have a new owner; never write through/remove them.
  return !info || (info.isFile() && hash(fs.readFileSync(file)) === record.hash);
}

async function installSkill(uninstall = false, env = process.env) {
  const stateDir = stateDirectory(env);
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'skill.lock');
  const deadline = Date.now() + 15000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Skill installation locked: ${lock}; retry after the other action finishes`);
      await delay(50);
    }
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    const file = path.join(stateDir, 'skill-paths.json');
    let records = readState(file);
    const save = () => atomicWrite(file, JSON.stringify(records, null, 2) + '\n');
    if (uninstall) {
      // Use recorded paths even after PATH, HOME overrides or agent discovery change.
      for (const record of [...records]) {
        if (!stat(record.dir)) {
          records = records.filter((r) => r !== record); save(); continue;
        }
        if (!owned(record) || fs.readdirSync(record.dir).some((name) => name !== 'SKILL.md')) {
          console.log(`Kept modified skill: ${record.dir}`); continue;
        }
        fs.rmSync(path.join(record.dir, 'SKILL.md'), { force: true });
        fs.rmdirSync(record.dir);
        records = records.filter((r) => r !== record); save();
        console.log(`Removed skill: ${record.dir}`);
      }
      return;
    }
    const directories = targets(env);
    if (!directories.length) { console.log('No supported installed agent programs; no skills installed.'); return; }
    const text = skillText(stateDir);
    for (const dir of directories) {
      let record = records.find((r) => r.dir === dir);
      if (stat(dir)) {
        if (!record || !owned(record)) { console.log(`Skipped existing skill: ${dir}`); continue; }
      } else {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        try { fs.mkdirSync(dir); }
        catch (error) { if (error.code === 'EEXIST') { console.log(`Skipped existing skill: ${dir}`); continue; } throw error; }
        const info = stat(dir);
        records = records.filter((r) => r.dir !== dir);
        record = { dir, hash: null, dev: info.dev, ino: info.ino };
        records.push(record);
        save(); // Record ownership before writing any skill content.
      }
      atomicWrite(path.join(dir, 'SKILL.md'), text);
      record.hash = hash(text);
      save();
      console.log(`Installed skill: ${dir}`);
    }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--uninstall')) {
    console.error('Usage: node bin/install-skill.js [--uninstall]'); process.exitCode = 1;
  } else installSkill(args.includes('--uninstall')).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}

module.exports = { AGENTS, targets, stateDirectory, installSkill };

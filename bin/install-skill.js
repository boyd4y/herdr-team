#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { spawnSync } = require('node:child_process');

const NAME = 'herdr-team';
// The upstream CLI owns skill placement, copies, agent links and removal.
const SKILLS_PACKAGE = 'skills@1.7.2';
const AGENTS = { claude: 'claude-code', codex: 'codex', pi: 'pi', grok: 'grok' };

function installedAgents(env = process.env) {
  return Object.entries(AGENTS).filter(([command]) => (env.PATH || '').split(path.delimiter).some((bin) => {
    const file = path.join(bin, command);
    try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); }
    catch { return false; }
  })).map(([, agent]) => agent);
}

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function stateDirectory(env = process.env, home = os.homedir()) {
  // Herdr build commands do not receive the action's plugin environment.
  // Match Herdr's Unix state-dir default so build and actions share ownership.
  return path.resolve(env.HERDR_PLUGIN_STATE_DIR || path.join(
    env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'herdr', 'plugins', 'herdr-team'));
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
    const source = path.resolve(__dirname, '..', 'skill');
    const agents = uninstall ? [] : installedAgents(env);
    if (!uninstall && !agents.length) throw new Error('No supported agent found on PATH (claude, codex, pi, grok)');
    const args = ['--yes', SKILLS_PACKAGE, ...(uninstall
      ? ['remove', NAME, '--global', '--yes']
      : ['add', source, '--skill', NAME, '--global', '--yes', '--json', '--agent', ...agents])];
    console.log(`Skill ${uninstall ? 'removal' : 'installation'}: npx ${args.join(' ')}`);
    const result = spawnSync('npx', args, {
      env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) throw new Error(
      `Skill ${uninstall ? 'removal' : 'installation'} failed: ${result.error?.message || `npx exited ${result.status}`}`,
    );
    let installedPath;
    if (!uninstall) {
      let installed;
      try { installed = JSON.parse(result.stdout); } catch { throw new Error('skills returned invalid installation JSON'); }
      const skill = Array.isArray(installed) && installed.find((item) => item.name === NAME && item.status === 'installed');
      if (!skill || !Array.isArray(skill.agents) || !skill.agents.length || typeof skill.path !== 'string' ||
          !path.isAbsolute(skill.path) || !stat(path.join(skill.path, 'SKILL.md'))?.isFile() ||
          fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8') !== fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')) {
        throw new Error('skills did not confirm a readable herdr-team installation; old skills retained');
      }
      installedPath = path.resolve(skill.path);
      console.log(`Skill installed: ${skill.path} (${skill.agents.join(', ')})`);
    }
    // One-time migration: only remove untouched copies left by the old installer,
    // after the standard CLI has succeeded. It now owns any replaced agent links.
    for (const record of [...records]) {
      if (path.resolve(record.dir) === installedPath) {
        records = records.filter((r) => r !== record); save(); continue;
      }
      const directory = stat(record.dir);
      if (!directory || !directory.isDirectory() || directory.dev !== record.dev || directory.ino !== record.ino) {
        records = records.filter((r) => r !== record); save(); continue;
      }
      if (!owned(record) || fs.readdirSync(record.dir).some((name) => name !== 'SKILL.md')) {
        console.log(`Kept modified legacy skill: ${record.dir}`); continue;
      }
      fs.rmSync(path.join(record.dir, 'SKILL.md'), { force: true });
      fs.rmdirSync(record.dir);
      records = records.filter((r) => r !== record); save();
      console.log(`Removed legacy skill copy: ${record.dir}`);
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

module.exports = { SKILLS_PACKAGE, installedAgents, stateDirectory, installSkill };

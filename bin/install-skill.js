#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    if (!uninstall) {
      let installed;
      try { installed = JSON.parse(result.stdout); } catch { throw new Error('skills returned invalid installation JSON'); }
      const skill = Array.isArray(installed) && installed.find((item) => item.name === NAME && item.status === 'installed');
      if (!skill || !Array.isArray(skill.agents) || !skill.agents.length || typeof skill.path !== 'string' ||
          !path.isAbsolute(skill.path) || !stat(path.join(skill.path, 'SKILL.md'))?.isFile() ||
          fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8') !== fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')) {
        throw new Error('skills did not confirm a readable herdr-team installation');
      }
      console.log(`Skill installed: ${skill.path} (${skill.agents.join(', ')})`);
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

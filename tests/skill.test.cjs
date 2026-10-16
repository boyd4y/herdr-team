'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { targets, stateDirectory } = require('../bin/install-skill');

const root = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-team-skill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const skills = [path.join(dir, 'agent one'), path.join(dir, 'agent-two')];
  // Every subprocess has explicit temporary targets and state. Even an installed
  // real agent on the developer's PATH can never direct a test to its real home.
  const env = {
    ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'),
    HERDR_PLUGIN_STATE_DIR: path.join(dir, 'plugin-state'),
    HERDR_TEAM_SKILL_DIRS: skills.join(path.delimiter), PATH: bin,
    CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    PI_CODING_AGENT_DIR: path.join(dir, 'pi'),
  };
  function put(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text); return file;
  }
  function run(args = [], overrides = {}, plugin = root) {
    const result = spawnSync(process.execPath, [path.join(plugin, 'bin/install-skill.js'), ...args], {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result;
  }
  const stateFile = path.join(env.HERDR_PLUGIN_STATE_DIR, 'skill-paths.json');
  return { dir, bin, skills, env, put, run, stateFile,
    records: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    directories: skills.map((d) => path.join(d, 'herdr-team')) };
}

test('discovery maps only installed supported executables and honors homes and escape hatch', (t) => {
  const f = fixture(t);
  const env = { ...f.env };
  delete env.HERDR_TEAM_SKILL_DIRS;
  assert.deepEqual(targets(env, f.dir), []);
  for (const kind of ['claude', 'codex', 'pi', 'grok']) {
    fs.chmodSync(f.put(path.join(f.bin, kind), '#!/bin/sh\nexit 99\n'), 0o755);
  }
  assert.deepEqual(targets(env, f.dir), ['claude', 'codex', 'pi'].map((kind) => path.join(f.dir, kind, 'skills', 'herdr-team')));
  fs.chmodSync(path.join(f.bin, 'pi'), 0o644);
  assert.equal(targets(env, f.dir).length, 2);
  delete env.CODEX_HOME; delete env.CLAUDE_CONFIG_DIR;
  assert.deepEqual(targets(env, f.dir), ['.claude', '.codex'].map((kind) => path.join(f.dir, kind, 'skills', 'herdr-team')));
  assert.deepEqual(targets({ ...env, HERDR_TEAM_SKILL_DIRS: '' }, f.dir), []);
  assert.deepEqual(targets(f.env, f.dir), f.directories);
  assert.equal(stateDirectory({ XDG_STATE_HOME: path.join(f.dir, 'xdg') }, f.dir), path.join(f.dir, 'xdg/herdr/plugins/herdr-team'));
  assert.equal(stateDirectory({}, f.dir), path.join(f.dir, '.local/state/herdr/plugins/herdr-team'));
  f.run([], { HERDR_TEAM_SKILL_DIRS: '' });
  assert(!fs.existsSync(f.stateFile));
});

test('unrecorded directories, ordinary files and symlinks are never adopted or overwritten', (t) => {
  const f = fixture(t);
  const [first, second] = f.directories;
  f.put(path.join(first, 'SKILL.md'), 'my own skill');
  f.put(second, 'a file, not a skill directory');
  f.run();
  assert.equal(fs.readFileSync(path.join(first, 'SKILL.md'), 'utf8'), 'my own skill');
  assert.equal(fs.readFileSync(second, 'utf8'), 'a file, not a skill directory');
  f.run(['--uninstall']);
  assert(fs.existsSync(first)); assert(fs.existsSync(second));
  fs.rmSync(first, { recursive: true }); fs.unlinkSync(second);
  const other = path.join(f.dir, 'user-skill');
  f.put(path.join(other, 'SKILL.md'), 'symlink target');
  fs.symlinkSync(other, first);
  fs.symlinkSync(path.join(f.dir, 'absent'), second);
  f.run(); f.run(['--uninstall']);
  assert(fs.lstatSync(first).isSymbolicLink()); assert(fs.lstatSync(second).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(other, 'SKILL.md'), 'utf8'), 'symlink target');
});

test('records every owned directory; repeated install does not rewrite skill, references or state', (t) => {
  const f = fixture(t);
  f.run();
  assert.deepEqual(f.records().map((r) => r.dir), f.directories);
  const generated = fs.readFileSync(path.join(f.directories[0], 'SKILL.md'), 'utf8');
  const original = fs.readFileSync(path.join(root, 'skill/SKILL.md'), 'utf8');
  const links = [...generated.matchAll(/\]\(<([^>]+)>\)/g)].map((m) => m[1]);
  assert.equal(links.length, 2);
  for (const link of links) {
    assert(link.startsWith(f.env.HERDR_PLUGIN_STATE_DIR + path.sep));
    assert.equal(fs.readFileSync(link, 'utf8'), fs.readFileSync(path.join(root, 'skill/references', path.basename(link)), 'utf8'));
  }
  assert.equal(generated.replace(/\]\(<([^>]+)>\)/g, (_, file) => `](references/${path.basename(file)})`), original);
  // The linked how-to's own relative references must also remain reachable.
  const refs = path.dirname(links[0]);
  assert(fs.existsSync(path.join(refs, 'role-presets.md')));
  assert.deepEqual(fs.readdirSync(f.directories[0]), ['SKILL.md']);
  const tracked = [f.stateFile, ...links, ...f.directories.map((d) => path.join(d, 'SKILL.md'))];
  const old = new Date('2001-01-01T00:00:00Z');
  tracked.forEach((file) => fs.utimesSync(file, old, old));
  f.run();
  for (const file of tracked) assert.equal(fs.statSync(file).mtimeMs, old.getTime(), file);
  // Removal uses the ledger, not today's discovery/override directories.
  const unrelated = f.put(path.join(f.skills[0], 'other-skill/SKILL.md'), 'keep me');
  f.run(['--uninstall'], { HERDR_TEAM_SKILL_DIRS: '' });
  for (const dir of f.directories) assert(!fs.existsSync(dir));
  assert.deepEqual(f.records(), []);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me');
  f.run(['--uninstall']);
});

test('uninstall retains directories containing user additions and retains ownership for later removal', (t) => {
  const f = fixture(t);
  f.run();
  const extra = f.put(path.join(f.directories[0], 'notes/custom.md'), 'user addition');
  f.run(['--uninstall']);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'user addition');
  assert(fs.existsSync(path.join(f.directories[0], 'SKILL.md')));
  assert(!fs.existsSync(f.directories[1]));
  assert.deepEqual(f.records().map((r) => r.dir), [f.directories[0]]);
  fs.rmSync(path.dirname(extra), { recursive: true });
  f.run(['--uninstall']);
  assert(!fs.existsSync(f.directories[0]));
});

test('edited skill files and replacement symlinks are preserved on update and uninstall', (t) => {
  const f = fixture(t);
  f.run();
  const first = path.join(f.directories[0], 'SKILL.md');
  const second = path.join(f.directories[1], 'SKILL.md');
  f.put(first, 'user revision');
  const target = f.put(path.join(f.dir, 'personal.md'), 'personal');
  fs.unlinkSync(second); fs.symlinkSync(target, second);
  f.run(); f.run(['--uninstall']);
  assert.equal(fs.readFileSync(first, 'utf8'), 'user revision');
  assert(fs.lstatSync(second).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'personal');
  assert.equal(f.records().length, 2);
});

test('standalone plugin links survive the build checkout being moved or removed', (t) => {
  const f = fixture(t);
  const checkout = path.join(f.dir, 'temporary-checkout');
  const plugin = path.join(checkout, 'herdr-team-plugin');
  fs.cpSync(root, plugin, { recursive: true, filter: (file) => path.basename(file) !== 'tests' });
  for (const name of ['SKILL.md', 'references', 'agents']) assert(!fs.existsSync(path.join(plugin, name)));
  assert(fs.existsSync(path.join(plugin, 'skill/SKILL.md')));
  // Build lacks HERDR_PLUGIN_STATE_DIR; the fallback must equal action state.
  const buildState = stateDirectory({ XDG_STATE_HOME: f.env.XDG_STATE_HOME }, f.dir);
  f.run([], { HERDR_PLUGIN_STATE_DIR: '' }, plugin);
  const installed = f.directories.map((dir) => fs.readFileSync(path.join(dir, 'SKILL.md')));
  const final = path.join(f.dir, 'final-checkout');
  fs.renameSync(checkout, final);
  f.run([], { HERDR_PLUGIN_STATE_DIR: buildState }, path.join(final, 'herdr-team-plugin'));
  for (const [index, dir] of f.directories.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(dir, 'SKILL.md')), installed[index]);
  }
  fs.rmSync(final, { recursive: true });
  const text = fs.readFileSync(path.join(f.directories[0], 'SKILL.md'), 'utf8');
  for (const [, link] of text.matchAll(/\]\(<([^>]+)>\)/g)) {
    assert.deepEqual(fs.readFileSync(link), fs.readFileSync(path.join(root, 'skill/references', path.basename(link))));
  }
  f.run(['--uninstall'], { HERDR_PLUGIN_STATE_DIR: buildState });
  for (const dir of f.directories) assert(!fs.existsSync(dir));
});

test('concurrent actions wait for the write lock and release it on failure', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
  const lock = f.put(path.join(f.env.HERDR_PLUGIN_STATE_DIR, 'skill.lock'), 'another installer');
  const child = spawn(process.execPath, [path.join(root, 'bin/install-skill.js')], { env: f.env });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(!fs.existsSync(f.directories[0]));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another installer');
  fs.unlinkSync(lock);
  assert.equal(await done, 0, stderr);
  assert.equal(f.records().length, 2);
  assert(!fs.existsSync(lock));
  f.put(f.stateFile, '{invalid state');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/install-skill.js')], { env: f.env });
  assert.notEqual(result.status, 0);
  assert(!fs.existsSync(lock));
  assert(fs.existsSync(path.join(f.directories[0], 'SKILL.md')));
});

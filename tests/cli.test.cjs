'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { target } = require('../bin/install-cli');

const root = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-team-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'user bin');
  fs.mkdirSync(bin);
  const env = { ...process.env, HOME: dir, XDG_BIN_HOME: bin,
    XDG_STATE_HOME: path.join(dir, 'state'), HERDR_PLUGIN_STATE_DIR: path.join(dir, 'plugin state # 中文'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const file = path.join(bin, 'herdr-team');
  const ledger = path.join(env.HERDR_PLUGIN_STATE_DIR, 'cli-paths.json');
  function run(args = [], overrides = {}, plugin = root) {
    return spawnSync(process.execPath, [path.join(plugin, 'bin/install-cli.js'), ...args], {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000,
    });
  }
  function ok(args = [], overrides = {}, plugin = root) {
    const result = run(args, overrides, plugin);
    assert.equal(result.status, 0, result.stdout + result.stderr); return result;
  }
  function cli(...args) {
    // A fresh non-interactive shell resolves the installed command from PATH.
    const result = spawnSync('/bin/sh', ['-c', 'exec herdr-team "$@"', 'sh', ...args], {
      env, cwd: dir, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  }
  return { dir, bin, env, file, ledger, run, ok, cli,
    records: () => JSON.parse(fs.readFileSync(ledger, 'utf8')) };
}

test('requires a PATH-visible user bin and Bun 1.3.14+ before installing', (t) => {
  const f = fixture(t);
  const homeBin = path.join(f.dir, '.local/bin');
  assert.equal(target({ PATH: homeBin }, f.dir), path.join(homeBin, 'herdr-team'));
  const missing = f.run([], { PATH: process.env.PATH });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not on PATH/);
  assert(!fs.existsSync(f.file));
  const noBun = f.run([], { PATH: f.bin });
  assert.notEqual(noBun.status, 0);
  assert.match(noBun.stderr, /Bun 1.3.14\+/);
  const bun = path.join(f.bin, 'bun');
  fs.writeFileSync(bun, '#!/bin/sh\necho 1.3.13\n', { mode: 0o755 });
  assert.match(f.run([], { PATH: f.bin }).stderr, /Bun 1.3.14\+/);
  assert(!fs.existsSync(f.ledger));
});

test('standalone CLI works after build checkout moves and disappears; uninstall uses only ledger', (t) => {
  const f = fixture(t);
  const checkout = path.join(f.dir, 'build-checkout');
  fs.cpSync(root, checkout, { recursive: true, filter: (file) => !['tests', 'node_modules'].includes(path.basename(file)) });
  const leadTemplate = path.join(checkout, 'skill/assets/roles/lead/prompt.md');
  fs.appendFileSync(leadTemplate, '\nProject-specific template change.\n');
  const expectedLead = fs.readFileSync(leadTemplate, 'utf8');
  const identityTemplate = path.join(checkout, 'skill/assets/identity.md');
  fs.appendFileSync(identityTemplate, '\nTemplate change for packaging verification.\n');
  const expectedIdentity = fs.readFileSync(identityTemplate, 'utf8');
  const expectedDocs = fs.readFileSync(path.join(checkout, 'skill/assets/roles/docs/prompt.md'), 'utf8');
  const expectedDefault = fs.readFileSync(path.join(checkout, 'skill/assets/roles/default/prompt.md'), 'utf8');
  const buildState = path.join(f.env.XDG_STATE_HOME, 'herdr/plugins/herdr-team');
  f.ok([], { HERDR_PLUGIN_STATE_DIR: '' }, checkout);
  const moved = path.join(f.dir, 'installed-plugin');
  fs.renameSync(checkout, moved);
  f.ok([], { HERDR_PLUGIN_STATE_DIR: buildState }, moved);
  fs.rmSync(moved, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(root, 'cli/package.json'), 'utf8')).version;
  assert.equal(f.cli('--version').trim(), version);
  assert.match(f.cli('--help'), /herdr-team <command>/);
  assert(!f.cli('--help').includes('bunx'));
  for (const command of ['init', 'validate', 'add', 'edit', 'handoff', 'role', 'tasks', 'status', 'console', 'claim', 'queue', 'up', 'dispatch', 'clean', 'down']) {
    assert(f.cli(command, '--help').includes(`Usage: herdr-team ${command}`));
  }
  f.cli('init', '--plan', 'balanced');
  assert.equal(fs.readFileSync(path.join(f.dir, '.herdr/identity.md'), 'utf8'), expectedIdentity);
  assert.equal(fs.readFileSync(path.join(f.dir, '.herdr/roles/lead/prompt.md'), 'utf8'), expectedLead);
  f.cli('role', 'add', 'docs', '--kind', 'codex');
  assert.equal(fs.readFileSync(path.join(f.dir, '.herdr/roles/docs/prompt.md'), 'utf8'), expectedDocs);
  f.cli('role', 'add', 'helper', '--kind', 'codex');
  assert.equal(fs.readFileSync(path.join(f.dir, '.herdr/roles/helper/prompt.md'), 'utf8'), expectedDefault);
  assert.equal(JSON.parse(f.cli('validate', '--json')).ok, true);
  const herdr = path.join(f.bin, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\nprintf \'%s\' \'{"result":{"agents":[],"workspaces":[],"panes":[],"worktrees":[]}}\'\n', { mode: 0o755 });
  assert.equal(typeof JSON.parse(f.cli('status', '--json')), 'object');
  assert.match(f.cli('console', '--once'), /TASKS/);
  // Only production dependencies, source and assets survive removal of the checkout.
  const snapshot = fs.readdirSync(path.join(buildState, 'cli-runtime'))[0];
  assert.deepEqual(fs.readdirSync(path.join(buildState, 'cli-runtime', snapshot)).sort(), ['cli', 'skill']);
  assert.deepEqual(fs.readdirSync(path.join(buildState, 'cli-runtime', snapshot, 'cli')).sort(), ['bun.lock', 'node_modules', 'package.json', 'scripts']);
  assert.deepEqual(fs.readdirSync(path.join(buildState, 'cli-runtime', snapshot, 'skill')), ['assets']);
  const runtimeCli = path.join(buildState, 'cli-runtime', snapshot, 'cli');
  assert(!fs.existsSync(path.join(runtimeCli, 'node_modules/@types/bun')));
  const native = spawnSync('bun', ['-e', `
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { mountConsole } = await import("./scripts/lib/ui/console-view.ts");
    const { loadProject } = await import("./scripts/lib/team/project.ts");
    const screen = await createTestRenderer({ width: 100, height: 28 });
    try {
      const project = loadProject(process.env.TEST_PROJECT);
      mountConsole(screen.renderer, { initial: project, load: () => project,
        herdr: { agentList: () => [] }, intervalMs: 0, showAll: false });
      await screen.renderOnce();
      if (!screen.captureCharFrame().includes("Team Console")) throw new Error("Missing Console frame");
    } finally { await screen.dispose(); }
  `], { cwd: runtimeCli, env: { ...f.env, TEST_PROJECT: f.dir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stdout + native.stderr);
  f.ok(['--uninstall'], { HERDR_PLUGIN_STATE_DIR: buildState, XDG_BIN_HOME: '/unused', PATH: '' });
  assert(!fs.existsSync(f.file));
  assert(fs.existsSync(herdr));
});

test('installation is idempotent and upgrades only its unchanged shim', (t) => {
  const f = fixture(t);
  const plugin = path.join(f.dir, 'plugin');
  fs.cpSync(root, plugin, { recursive: true, filter: (file) => !['tests', 'node_modules'].includes(path.basename(file)) });
  f.ok([], {}, plugin);
  const before = fs.readFileSync(f.file, 'utf8');
  const old = new Date('2001-01-01T00:00:00Z');
  for (const file of [f.file, f.ledger]) fs.utimesSync(file, old, old);
  f.ok([], {}, plugin);
  for (const file of [f.file, f.ledger]) assert.equal(fs.statSync(file).mtimeMs, old.getTime());
  const template = path.join(plugin, 'skill/assets/roles/dev/prompt.md');
  fs.appendFileSync(template, '\nUpdated role responsibilities.\n');
  const failingBun = path.join(f.bin, 'bun');
  fs.writeFileSync(failingBun, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; else echo "Dependency download failed" >&2; exit 1; fi\n', { mode: 0o755 });
  const failed = f.run([], {}, plugin);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /CLI dependency setup failed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.unlinkSync(failingBun);
  f.ok([], {}, plugin);
  assert.notEqual(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.records().length, 1);
  f.ok(['--uninstall']); f.ok(['--uninstall']);
  assert(!fs.existsSync(f.file));
  assert.deepEqual(f.records(), []);
});

test('unrecorded files, directories and symlinks are never adopted', (t) => {
  const f = fixture(t);
  const unrelated = path.join(f.dir, 'personal-command');
  fs.writeFileSync(unrelated, 'keep me');
  for (const kind of ['file', 'directory', 'symlink', 'dangling']) {
    if (kind === 'file') fs.writeFileSync(f.file, 'personal CLI');
    else if (kind === 'directory') fs.mkdirSync(f.file);
    else fs.symlinkSync(kind === 'symlink' ? unrelated : path.join(f.dir, 'absent'), f.file);
    assert.match(f.ok().stdout, /Skipped existing CLI/);
    f.ok(['--uninstall']);
    assert(fs.lstatSync(f.file));
    fs.rmSync(f.file, { recursive: true });
  }
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me');
});

test('edited, chmodded and replaced shims survive updates and removal', (t) => {
  const f = fixture(t);
  f.ok();
  const original = fs.readFileSync(f.file, 'utf8');
  const mode = fs.statSync(f.file).mode & 0o777;
  fs.writeFileSync(f.file, 'my revision');
  assert.match(f.ok().stdout, /Skipped existing CLI/);
  assert.match(f.ok(['--uninstall']).stdout, /Kept modified CLI/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'my revision');
  fs.writeFileSync(f.file, original);
  fs.chmodSync(f.file, 0o644);
  f.ok(); f.ok(['--uninstall']);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
  fs.chmodSync(f.file, mode);
  const personal = path.join(f.dir, 'personal');
  fs.writeFileSync(personal, 'personal');
  fs.unlinkSync(f.file); fs.symlinkSync(personal, f.file);
  f.ok(); f.ok(['--uninstall']);
  assert(fs.lstatSync(f.file).isSymbolicLink());
  assert.equal(fs.readFileSync(personal, 'utf8'), 'personal');
  assert.equal(f.records().length, 1);
});

test('concurrent CLI actions share a lock; invalid ownership records release it without writes', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
  const lock = path.join(f.env.HERDR_PLUGIN_STATE_DIR, 'cli.lock');
  fs.writeFileSync(lock, 'other installer');
  const child = spawn(process.execPath, [path.join(root, 'bin/install-cli.js')], { env: f.env });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(!fs.existsSync(f.file));
  fs.unlinkSync(lock);
  assert.equal(await done, 0, stderr);
  assert(!fs.existsSync(lock));
  const before = fs.readFileSync(f.file);
  fs.writeFileSync(f.ledger, '{broken');
  assert.notEqual(f.run().status, 0);
  assert(!fs.existsSync(lock));
  assert(fs.readFileSync(f.file).equals(before));
});

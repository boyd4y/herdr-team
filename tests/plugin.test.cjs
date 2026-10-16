'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { read, edit } = require('../bin/managed');
const { locations } = require('../bin/paths');
const { cleanupIcons, BASENAME } = require('../bin/cleanup-icons');
const { existingPopup, POPUP } = require('../bin/configure');

const root = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-team-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'xdg');
  const herdrConfig = path.join(config, 'herdr', 'config.toml');
  // A subprocess stub asserts the candidate file/environment and reload call.
  // No test connects to a live session or network.
  const herdr = path.join(dir, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({args, config: process.env.HERDR_CONFIG_PATH}) + '\\n');
if (args.join(' ') === 'config check') {
  if (process.env.HERDR_CONFIG_PATH === process.env.TEST_REAL_CONFIG) throw Error('Must validate a temporary candidate');
  const text = fs.readFileSync(process.env.HERDR_CONFIG_PATH, 'utf8');
  if (text.includes('REJECT_CANDIDATE')) { console.error('config: rejected candidate'); process.exit(1); }
} else if (args.join(' ') !== 'server reload-config') process.exit(2);
`);
  fs.chmodSync(herdr, 0o755);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const env = {
    ...process.env, HOME: dir, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(dir, 'data'),
    HERDR_CONFIG_PATH: herdrConfig, HERDR_BIN_PATH: herdr, HERDR_ENV: '1',
    HERDR_PLUGIN_STATE_DIR: path.join(dir, 'plugin-state'),
    HERDR_TEAM_SKILL_DIRS: path.join(dir, 'agent-skills'),
    XDG_BIN_HOME: bin,
    TEST_LOG: path.join(dir, 'calls.jsonl'), TEST_REAL_CONFIG: herdrConfig,
    PATH: bin + path.delimiter + process.env.PATH,
  };
  function put(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  function run(script, args = [], overrides = {}) {
    return spawnSync(process.execPath, [path.join(root, 'bin', script), ...args], {
      cwd: dir, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
    });
  }
  function ok(script, args = [], overrides = {}) {
    const result = run(script, args, overrides);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  }
  return { dir, config, herdrConfig, env, put, run, ok, paths: locations(env, process.platform, dir) };
}

test('managed fences round-trip exact bytes and preserve outside edits', () => {
  for (const text of ['', 'plain', 'plain\n', 'plain\n\n\n', 'plain\r\n', 'plain\r\n\r\n', '中文 # comment\n']) {
    for (const exists of text ? [true] : [true, false]) {
      const before = { text, exists };
      const once = edit(before, 'config', '[ui.sidebar.agents]\nrows = [["agent"]]');
      assert.equal(once.text.slice(0, text.length), text);
      assert.deepEqual(edit(once, 'config', '[ui.sidebar.agents]\nrows = [["agent"]]'), once);
      const changed = edit(once, 'config', 'replacement\nline');
      assert.deepEqual(edit(changed, 'config', null), before);
      assert.deepEqual(edit(before, 'config', null), before);
      const suffix = '\n# another plugin\n[theme]\nname="nord"\n';
      const external = { ...once, text: once.text + suffix };
      assert.deepEqual(edit(external, 'config', null), { text: text + suffix, exists: true });
    }
  }
});

test('malformed or duplicated fences fail closed', () => {
  const block = edit({ text: '', exists: true }, 'config', 'body').text;
  for (const text of [block + block, '# >>> herdr-team:config\n', '# <<< herdr-team:config\n',
    block.replace('separator=0', 'separator=9'), block.replace('created=0', 'created=2'),
    '# <<< herdr-team:config\n# >>> herdr-team:config separator=0 created=0\n']) {
    assert.throws(() => edit({ text, exists: true }, 'config', null), /fence/);
  }
});

test('paths follow Herdr override, XDG and both macOS Ghostty locations', () => {
  const linux = locations({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', HERDR_CONFIG_PATH: '/custom.toml' }, 'linux', '/h');
  assert.equal(linux.herdr, '/custom.toml');
  assert.equal(linux.fonts, '/d/fonts');
  assert.deepEqual(linux.terminals.map((t) => t.file), ['/c/ghostty/config', '/c/ghostty/config.ghostty', '/c/kitty/kitty.conf']);
  const mac = locations({}, 'darwin', '/h');
  assert.equal(mac.fonts, '/h/Library/Fonts');
  assert.equal(mac.herdr, '/h/.config/herdr/config.toml');
  assert.equal(mac.terminals.length, 5);
  assert(mac.terminals.some((t) => t.file === '/h/Library/Application Support/com.mitchellh.ghostty/config.ghostty'));
  assert.throws(() => locations({}, 'win32', '/h'), /Supported platforms/);
});

test('configure/unconfigure are idempotent, reload and restore exact files', (t) => {
  const f = fixture(t);
  for (const original of [null, '', '# my keys\n\n[ui]\nsidebar_width = 31', '[theme]\r\nname = "nord"\r\n\r\n']) {
    if (original === null) fs.rmSync(f.herdrConfig, { force: true });
    else f.put(f.herdrConfig, original);
    f.ok('configure.js', ['--apply', '--reload']);
    const applied = fs.readFileSync(f.herdrConfig, 'utf8');
    assert(applied.includes('rows = [["state_icon", "$team_workspace", "agent", "$team_harness"]'));
    assert(!applied.includes('$harness_logo'));
    assert(applied.includes('key = "prefix+t"'));
    assert(applied.includes('command = "herdr-team watch"'));
    assert(applied.startsWith(original || ''));
    f.ok('configure.js', ['--apply', '--reload']);
    assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), applied);
    f.ok('configure.js', ['--uninstall', '--reload']);
    f.ok('configure.js', ['--uninstall', '--reload']);
    if (original === null) assert(!fs.existsSync(f.herdrConfig));
    else assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), original);
  }
  const calls = fs.readFileSync(f.env.TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.some((c) => c.args.join(' ') === 'config check'));
  assert.equal(calls.filter((c) => c.args.join(' ') === 'server reload-config').length, 16);
  for (const call of calls.filter((c) => c.args[0] === 'config')) assert(!fs.existsSync(call.config));
});

test('an existing identical popup is reused, stays outside the fence and survives removal', (t) => {
  const f = fixture(t);
  const original = `${POPUP}\n\n[ui]\nsidebar_width=30\n`;
  f.put(f.herdrConfig, original);
  assert(existingPopup(original));
  assert(!existingPopup(original.replace('herdr-team watch', 'other-command')));
  f.ok('configure.js');
  f.ok('configure.js');
  assert.equal(fs.readFileSync(f.herdrConfig, 'utf8').match(/prefix\+t/g).length, 1);
  f.ok('configure.js', ['--uninstall']);
  assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), original);
});

test('configuration validation failure preserves the original and never reloads', (t) => {
  const f = fixture(t);
  const original = '# REJECT_CANDIDATE\n[ui.sidebar.agents]\nrows=[["agent"]]\n';
  f.put(f.herdrConfig, original);
  assert.notEqual(f.run('configure.js', ['--apply', '--reload']).status, 0);
  assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), original);
  assert(!fs.readFileSync(f.env.TEST_LOG, 'utf8').includes('reload-config'));
});

test('upgrade replaces the old sidebar and removes only managed terminal mappings', (t) => {
  const f = fixture(t);
  const original = '# my config\n[ui]\nsidebar_width=30\n';
  f.put(f.herdrConfig, edit({ text: original, exists: true }, 'config',
    `${POPUP}\n\n[ui.sidebar.agents]\nrows=[["state_icon", "$harness_logo", "agent"]]`).text);
  const originals = new Map();
  for (const { file } of f.paths.terminals) {
    const text = '# user font settings\r\nfont-size = 14\r\n\r\n';
    originals.set(file, text);
    f.put(file, edit({ text, exists: true }, 'font', 'old plugin mapping').text);
  }
  // A user-modified font and other installations must survive the migration.
  const modified = f.put(path.join(f.paths.fonts, BASENAME), 'modified font');
  const unrelated = f.put(path.join(f.paths.fonts, 'HerdrAgentIconsMax-Regular.ttf'), 'other font');
  f.ok('configure.js');
  const config = fs.readFileSync(f.herdrConfig, 'utf8');
  assert(config.startsWith(original));
  assert(!config.includes('$harness_logo'));
  assert(config.includes('rows = [["state_icon", "$team_workspace", "agent", "$team_harness"]'));
  for (const [file, text] of originals) assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.readFileSync(modified, 'utf8'), 'modified font');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'other font');
  f.ok('configure.js');
  assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), config);
  f.ok('configure.js', ['--uninstall']);
  assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), original);
});

test('legacy cleanup preserves terminal symlinks and preflights all fences', (t) => {
  const f = fixture(t);
  const terminal = f.paths.terminals[0].file;
  const original = '# user settings';
  const mapped = edit({ text: original, exists: true }, 'font', 'old mapping').text;
  const target = f.put(path.join(f.dir, 'dotfiles', 'terminal'), mapped);
  fs.mkdirSync(path.dirname(terminal), { recursive: true });
  fs.symlinkSync(target, terminal);
  const bad = f.put(f.paths.terminals.at(-1).file, '# >>> herdr-team:font\n');
  assert.throws(() => cleanupIcons(f.paths), /fence/);
  assert.equal(fs.readFileSync(target, 'utf8'), mapped);
  fs.unlinkSync(bad);
  // Never follow a font symlink to delete a user-owned file.
  const fontTarget = f.put(path.join(f.dir, 'user-font'), 'user font');
  const font = path.join(f.paths.fonts, BASENAME);
  fs.mkdirSync(path.dirname(font), { recursive: true });
  fs.symlinkSync(fontTarget, font);
  cleanupIcons(f.paths);
  cleanupIcons(f.paths);
  assert(fs.lstatSync(terminal).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert(fs.lstatSync(font).isSymbolicLink());
  assert.equal(fs.readFileSync(fontTarget, 'utf8'), 'user font');
  for (const { file } of f.paths.terminals.slice(1)) assert(!fs.existsSync(file));
});

test('writes preserve dotfile symlinks and reject non-UTF8 config', (t) => {
  const f = fixture(t);
  const target = f.put(path.join(f.dir, 'dotfiles', 'herdr.toml'), '[ui]\n# dotfile\n');
  fs.mkdirSync(path.dirname(f.herdrConfig), { recursive: true });
  fs.symlinkSync(target, f.herdrConfig);
  f.ok('configure.js');
  assert(fs.lstatSync(f.herdrConfig).isSymbolicLink());
  f.ok('configure.js', ['--uninstall']);
  assert.equal(fs.readFileSync(target, 'utf8'), '[ui]\n# dotfile\n');
  fs.writeFileSync(target, Buffer.from([0xff]));
  assert.throws(() => read(target), /UTF-8/);
  assert.notEqual(f.run('configure.js').status, 0);
  assert.deepEqual(fs.readFileSync(target), Buffer.from([0xff]));
  const dangling = path.join(f.dir, 'dangling');
  const absent = path.join(f.dir, 'absent');
  fs.symlinkSync(absent, dangling);
  assert.throws(() => read(dangling), /dangling symlink/);
  assert(!fs.existsSync(absent));
});

test('standalone plugin build hook and actions install CLI, skill and configuration', (t) => {
  const f = fixture(t);
  const original = '# before setup\n[ui]\n';
  f.put(f.herdrConfig, original);
  const terminal = f.paths.terminals[0].file;
  f.put(terminal, '# ghostty');
  const standalone = path.join(f.dir, 'standalone');
  fs.cpSync(root, standalone, { recursive: true, filter: (file) => !['tests', 'node_modules'].includes(path.basename(file)) });
  const setup = () => {
    const result = spawnSync(process.execPath, ['bin/setup.js'], {
      cwd: standalone, env: f.env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  setup();
  assert(!fs.readFileSync(f.herdrConfig, 'utf8').includes('$harness_logo'));
  assert(!fs.existsSync(path.join(f.paths.fonts, BASENAME)));
  assert.equal(fs.readFileSync(terminal, 'utf8'), '# ghostty');
  const skillFile = path.join(f.env.HERDR_TEAM_SKILL_DIRS, 'herdr-team', 'SKILL.md');
  assert(fs.readFileSync(skillFile, 'utf8').includes('name: herdr-team'));
  setup();
  const manifest = fs.readFileSync(path.join(standalone, 'herdr-plugin.toml'), 'utf8');
  const actions = [...manifest.matchAll(/\[\[actions\]\]\nid = "([^"]+)"\ntitle = "[^"]+"\ncommand = (\[[^\n]+\])/g)];
  assert.deepEqual(actions.map(([, id]) => id), ['install', 'configure', 'unconfigure', 'install-skill', 'uninstall-skill', 'install-cli', 'uninstall-cli']);
  assert(fs.existsSync(path.join(f.env.XDG_BIN_HOME, 'herdr-team')));
  for (const id of ['install', 'configure', 'install-skill', 'install-cli', 'unconfigure', 'uninstall-skill', 'uninstall-cli']) {
    const command = JSON.parse(actions.find((a) => a[1] === id)[2]);
    const result = spawnSync(command[0], command.slice(1), { cwd: standalone, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(fs.readFileSync(f.herdrConfig, 'utf8'), original);
  assert(!fs.existsSync(path.join(f.paths.fonts, BASENAME)));
  assert(!fs.existsSync(skillFile));
  assert(!fs.existsSync(path.join(f.env.XDG_BIN_HOME, 'herdr-team')));
  assert(manifest.includes('[[startup]]'));
  assert(manifest.includes('on = "workspace.created"'));
  assert(manifest.includes('on = "pane.agent_detected"'));
});

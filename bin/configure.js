#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const managed = require('./managed');
const { locations } = require('./paths');

// Eight stable color slots; each token holds the compact badge + name label.
const BADGE_COLORS = ['#89b4fa', '#cba6f7', '#94e2d5', '#fab387', '#f5c2e7', '#a6e3a1', '#74c7ec', '#f9e2af'];
const BADGE_TOKENS = BADGE_COLORS.map((fg, slot) => `{ token = "$team_workspace_c${slot}", fg = "${fg}", bold = true, dim = false }`).join(', ');
// Missing root-only metadata collapses the second row for every linked worktree.
const SIDEBAR = `[ui.sidebar.agents]\nrows = [["state_icon", ${BADGE_TOKENS}, "$team_label", "$team_harness"], ["$team_session", "$team_model", "$team_task"]]\n\n[ui.sidebar.spaces]\nrows = [["state_icon", ${BADGE_TOKENS}, "$team_label"], ["$team_git_summary"]]`;
const POPUP = '[[keys.command]]\nkey = "prefix+t"\ntype = "popup"\ncommand = "herdr-team console --observe"\nwidth = "90%"\nheight = "85%"';

function herdr(args, env = process.env) {
  const result = spawnSync(env.HERDR_BIN_PATH || 'herdr', args, {
    env, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

// Reuse an ordinary, identical pre-existing popup. Complex TOML is left to
// Herdr's parser below; it rejects colliding bindings/tables before any write.
function existingPopup(text) {
  const tables = text.split(/(?=^\s*\[)/m);
  return tables.some((table) => {
    const lines = table.split(/\r?\n/);
    if (!/^\s*\[\[keys\.command\]\]\s*(?:#.*)?$/.test(lines.shift())) return false;
    const values = new Map();
    for (const line of lines) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const match = /^\s*(\w+)\s*=\s*(["'])([^"'\\\r\n]*)\2\s*(?:#.*)?$/.exec(line);
      if (!match || values.has(match[1])) return false;
      values.set(match[1], match[3]);
    }
    return values.get('key') === 'prefix+t' && values.get('type') === 'popup' &&
      values.get('command') === 'herdr-team console --observe';
  });
}

function validate(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-team-config-'));
  try {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, text);
    herdr(['config', 'check'], { ...process.env, HERDR_CONFIG_PATH: file });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function planConfigure(uninstall = false, file = locations().herdr) {
  const before = managed.read(file);
  // Inspect outside our block so an already-managed popup isn't mistaken for
  // user config on subsequent runs.
  const outside = managed.edit(before, 'config', null);
  const reuse = !uninstall && existingPopup(outside.text);
  const body = uninstall ? null : (reuse ? SIDEBAR : `${POPUP}\n\n${SIDEBAR}`);
  const after = managed.edit(before, 'config', body);
  if (after.exists) validate(after.text);
  return { file, before, after, reuse, uninstall };
}

function applyPlan(plan, reload = false) {
  const current = managed.read(plan.file);
  if (current.text !== plan.before.text || current.exists !== plan.before.exists) {
    throw new Error('config.toml changed during validation; run the action again');
  }
  managed.write(plan.file, plan.before, plan.after);
  console.log(`config: ${plan.file}${plan.reuse ? ' (reusing existing prefix+t popup)' : ''}`);
  if (reload) {
    reloadConfig();
    if (!plan.uninstall) refreshSidebar();
  }
}

function refreshSidebar() {
  const result = spawnSync('bun', [path.join(__dirname, '..', 'cli', 'scripts', 'cli.ts'), 'sidebar', '--auto'], { env: process.env, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) console.log('Refresh team sidebar inside Herdr with: herdr-team sidebar --auto');
}

function reloadConfig() {
  if (process.env.HERDR_ENV !== '1') throw new Error('Config saved; reload requires a Herdr-managed pane or plugin action');
  herdr(['server', 'reload-config']);
  console.log('herdr: config reloaded');
}

function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node bin/configure.js [--apply|--uninstall] [--reload]');
    return;
  }
  if (args.some((arg) => !['--apply', '--uninstall', '--reload'].includes(arg)) ||
      (args.includes('--apply') && args.includes('--uninstall'))) throw new Error('Invalid configure arguments; use --help');
  applyPlan(planConfigure(args.includes('--uninstall')), args.includes('--reload'));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { planConfigure, applyPlan, reloadConfig, refreshSidebar, existingPopup, SIDEBAR, POPUP };

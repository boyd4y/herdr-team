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
const ACTION_KEYS = [
  { key: 'prefix+t', action: 'herdr-team.open-console' },
];

function herdr(args, env = process.env) {
  const result = spawnSync(env.HERDR_BIN_PATH || 'herdr', args, {
    env, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

// User-owned bindings take precedence. Herdr validates the complete candidate
// before any write; this only recognizes ordinary literal keys to avoid collisions.
function existingKey(text, key) {
  return text.split(/(?=^\s*\[)/m).some((table) => {
    const lines = table.split(/\r?\n/);
    if (!/^\s*\[\[keys\.command\]\]\s*(?:#.*)?$/.test(lines.shift())) return false;
    return lines.some(line => {
      const match = /^\s*key\s*=\s*(["'])([^"'\\\r\n]*)\1\s*(?:#.*)?$/.exec(line);
      return match?.[2] === key;
    });
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
  // Inspect outside our block so already-managed keys aren't mistaken for
  // user config on subsequent runs.
  const outside = managed.edit(before, 'config', null);
  const reused = ACTION_KEYS.filter(binding => existingKey(outside.text, binding.key)).map(binding => binding.key);
  const keys = ACTION_KEYS.filter(binding => !reused.includes(binding.key)).map(binding =>
    `[[keys.command]]\nkey = "${binding.key}"\ntype = "plugin_action"\ncommand = "${binding.action}"`);
  const body = uninstall ? null : [...keys, SIDEBAR].join('\n\n');
  const after = managed.edit(before, 'config', body);
  if (after.exists) validate(after.text);
  return { file, before, after, reused, uninstall };
}

function applyPlan(plan, reload = false) {
  const current = managed.read(plan.file);
  if (current.text !== plan.before.text || current.exists !== plan.before.exists) {
    throw new Error('config.toml changed during validation; run the action again');
  }
  managed.write(plan.file, plan.before, plan.after);
  console.log(`config: ${plan.file}${plan.reused.length ? ` (keeping user keys: ${plan.reused.join(', ')})` : ''}`);
  if (reload) {
    reloadConfig();
    if (!plan.uninstall) refreshSidebar();
  }
}

function refreshSidebar() {
  const result = spawnSync('bun', [path.join(__dirname, '..', 'cli', 'scripts', 'refresh-sidebar.ts')], { env: process.env, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) console.log('Sidebar refresh failed; run the herdr-team.configure plugin action inside Herdr to retry.');
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
module.exports = { planConfigure, applyPlan, reloadConfig, refreshSidebar, existingKey, SIDEBAR, ACTION_KEYS };

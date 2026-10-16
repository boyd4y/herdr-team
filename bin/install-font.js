#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const managed = require('./managed');
const { locations } = require('./paths');
const { SOURCE, FAMILY, bundledGlyphs, ranges } = require('./font-data');

// A plugin-specific filename avoids taking ownership of a Font Book install or
// another plugin's copy of the same font family.
const BASENAME = 'HerdrTeamAgentIconsMax-Regular.ttf';

function installFont(uninstall = false, paths = locations()) {
  const bytes = fs.readFileSync(SOURCE);
  const spans = ranges(bundledGlyphs());
  const target = path.join(paths.fonts, BASENAME);
  const exists = fs.existsSync(target);
  if (exists && (!fs.lstatSync(target).isFile() || !fs.readFileSync(target).equals(bytes))) {
    throw new Error(`Refusing to overwrite/remove a different font at ${target}`);
  }
  // Preflight every fence before changing any file.
  const plans = [];
  const seen = new Set();
  for (const { file, kind } of paths.terminals) {
    const before = managed.read(file);
    if (!before.exists) continue;
    const real = fs.realpathSync(file);
    if (seen.has(real)) continue;
    seen.add(real);
    const lines = spans.map((span) => kind === 'ghostty' ? `font-codepoint-map = ${span}=${FAMILY}` : `symbol_map ${span} ${FAMILY}`);
    plans.push({ file, before, after: managed.edit(before, 'font', uninstall ? null : lines.join('\n')) });
  }
  if (uninstall) {
    if (exists) fs.unlinkSync(target);
  } else if (!exists) {
    fs.mkdirSync(paths.fonts, { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  for (const { file, before, after } of plans) managed.write(file, before, after);
  if (process.platform === 'linux' && (exists || !uninstall)) {
    const result = spawnSync('fc-cache', ['-f', paths.fonts], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) console.log('font: fc-cache unavailable or failed; refresh the terminal font cache manually');
  }
  console.log(`font: ${uninstall ? 'removed' : 'installed'} ${target}`);
  if (!uninstall) {
    console.log(`terminal: ${plans.length} config(s) mapped: ${spans.join(', ')} -> ${FAMILY}`);
    if (!plans.length) console.log('No existing Ghostty/kitty config found. Map these ranges in your terminal config, then run install-font again.');
    console.log('Open a new terminal window; some terminals need a full restart. Set HERDR_TEAM_LOGOS=font in the shell running herdr-team.');
  }
}

function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node bin/install-font.js [--uninstall]');
    return;
  }
  if (args.some((arg) => arg !== '--uninstall')) throw new Error('Invalid font arguments; use --help');
  installFont(args.includes('--uninstall'));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { installFont, BASENAME };

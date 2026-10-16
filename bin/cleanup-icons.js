'use strict';

// Upgrade cleanup only: no fonts or terminal mappings are installed anymore.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const managed = require('./managed');
const { locations } = require('./paths');

const BASENAME = 'HerdrTeamAgentIconsMax-Regular.ttf';
const LEGACY_FONT_SHA256 = '1b8199496b223d0761fc3a49d5b2510bda38deab82cb3758bf3980495bf05272';

function cleanupIcons(paths = locations()) {
  const plans = [];
  const seen = new Set();
  for (const { file } of paths.terminals) {
    const before = managed.read(file);
    if (!before.exists) continue;
    const real = fs.realpathSync(file);
    if (seen.has(real)) continue;
    seen.add(real);
    plans.push({ file, before, after: managed.edit(before, 'font', null) });
  }

  const font = path.join(paths.fonts, BASENAME);
  let removeFont = false;
  try {
    const stat = fs.lstatSync(font);
    removeFont = stat.isFile() &&
      createHash('sha256').update(fs.readFileSync(font)).digest('hex') === LEGACY_FONT_SHA256;
    if (!removeFont) console.log(`Kept modified or user-owned legacy font: ${font}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Validate every old fence before changing any file.
  for (const { file, before, after } of plans) {
    if (managed.write(file, before, after)) console.log(`Removed legacy icon mapping: ${file}`);
  }
  if (removeFont) {
    fs.unlinkSync(font);
    console.log(`Removed legacy icon font: ${font}`);
  }
}

module.exports = { cleanupIcons, BASENAME };

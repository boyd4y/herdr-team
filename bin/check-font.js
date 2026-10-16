#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { bundledGlyphs, ranges } = require('./font-data');

function checkLogos(source, glyphs = bundledGlyphs()) {
  const table = /const LOGOS = new Map<string, number>\(\[([\s\S]*?)\]\);/.exec(source);
  if (!table) throw new Error('Cannot locate CLI LOGOS table');
  const entries = [...table[1].matchAll(/\["([a-z][a-z0-9_-]*)",\s*(0x[0-9a-f]+)\]/gi)]
    .map(([, name, value]) => [name, Number(value)]);
  const remainder = table[1].replace(/\["([a-z][a-z0-9_-]*)",\s*(0x[0-9a-f]+)\]/gi, '').replace(/[\s,]/g, '');
  if (remainder || !entries.length) throw new Error('Unrecognized CLI LOGOS entries');
  const vendors = new Map([...glyphs].filter(([, name]) => !name.startsWith('state_')));
  if (vendors.size !== entries.length || new Set(entries.map(([name]) => name)).size !== entries.length ||
      new Set(entries.map(([, point]) => point)).size !== entries.length) throw new Error('CLI/font vendor roster differs or contains duplicates');
  for (const [name, point] of entries) {
    if (vendors.get(point) !== name) throw new Error(`CLI/font mismatch: ${name} at U+${point.toString(16).toUpperCase()}`);
  }
  return ranges(glyphs);
}

if (require.main === module) {
  try {
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli', 'scripts', 'lib', 'logos.ts'), 'utf8');
    console.log(`CLI/font: matched; terminal ranges: ${checkLogos(source).join(', ')}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkLogos };

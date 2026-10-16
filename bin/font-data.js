'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'assets', 'HerdrAgentIconsMax-Regular.ttf');
const FAMILY = 'Herdr Agent Icons Max';

// Read the shipped TrueType cmap and post tables without a font library. Glyph
// names let verification catch a swapped vendor, not just a missing codepoint.
function fontGlyphs(bytes) {
  const tables = new Map();
  if (bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Expected a TrueType font');
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    const offset = bytes.readUInt32BE(at + 8);
    const size = bytes.readUInt32BE(at + 12);
    if (offset + size > bytes.length) throw new Error('Truncated font table');
    tables.set(bytes.toString('ascii', at, at + 4), bytes.subarray(offset, offset + size));
  }
  const name = tables.get('name');
  let familyFound = false;
  if (!name) throw new Error('Missing font family');
  for (let i = 0; i < name.readUInt16BE(2); i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at);
    if (name.readUInt16BE(at + 6) !== 1 || ![0, 3].includes(platform)) continue;
    const offset = name.readUInt16BE(4) + name.readUInt16BE(at + 10);
    const size = name.readUInt16BE(at + 8);
    if (offset + size > name.length || size % 2) throw new Error('Invalid font family record');
    const family = Buffer.from(name.subarray(offset, offset + size)).swap16().toString('utf16le');
    if (family !== FAMILY) throw new Error(`Font family mismatch: ${family}`);
    familyFound = true;
  }
  if (!familyFound) throw new Error('Missing Unicode font family');
  const post = tables.get('post');
  if (!post || post.readUInt32BE(0) !== 0x00020000) throw new Error('Expected named post format 2 glyphs');
  const count = post.readUInt16BE(32);
  const custom = [];
  for (let at = 34 + count * 2; at < post.length;) {
    const size = post[at++];
    if (at + size > post.length) throw new Error('Truncated glyph name');
    custom.push(post.toString('ascii', at, at + size));
    at += size;
  }
  const names = Array.from({ length: count }, (_, i) => {
    const index = post.readUInt16BE(34 + i * 2);
    // The shipped font uses only .notdef and pi from the standard Mac names.
    const name = index === 0 ? '.notdef' : index === 155 ? 'pi' : custom[index - 258];
    if (!name) throw new Error(`Unsupported glyph name index ${index}`);
    return name;
  });
  const cmap = tables.get('cmap');
  if (!cmap) throw new Error('Missing cmap');
  const points = new Map();
  function add(point, glyph) {
    if (point === 0xffff || !glyph) return;
    if (!names[glyph]) throw new Error('cmap references an absent glyph');
    if (points.has(point) && points.get(point) !== glyph) throw new Error('Conflicting Unicode cmaps');
    points.set(point, glyph);
  }
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const at = 4 + i * 8;
    const platform = cmap.readUInt16BE(at);
    const encoding = cmap.readUInt16BE(at + 2);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const sub = cmap.subarray(cmap.readUInt32BE(at + 4));
    const format = sub.readUInt16BE(0);
    if (format === 4) {
      const segments = sub.readUInt16BE(6) / 2;
      for (let n = 0; n < segments; n++) {
        const end = sub.readUInt16BE(14 + n * 2);
        const start = sub.readUInt16BE(16 + segments * 2 + n * 2);
        const delta = sub.readInt16BE(16 + segments * 4 + n * 2);
        const rangeAt = 16 + segments * 6 + n * 2;
        const offset = sub.readUInt16BE(rangeAt);
        for (let point = start; point <= end; point++) {
          let glyph = offset ? sub.readUInt16BE(rangeAt + offset + (point - start) * 2) : point;
          if (!offset || glyph) glyph = (glyph + delta) & 0xffff;
          add(point, glyph);
        }
      }
    } else if (format === 12) {
      for (let n = 0; n < sub.readUInt32BE(12); n++) {
        const at = 16 + n * 12;
        const start = sub.readUInt32BE(at);
        const end = sub.readUInt32BE(at + 4);
        if (end > 0x10ffff || end < start) throw new Error('Invalid cmap range');
        for (let point = start; point <= end; point++) add(point, sub.readUInt32BE(at + 8) + point - start);
      }
    } else {
      throw new Error(`Unsupported Unicode cmap format ${format}`);
    }
  }
  const head = tables.get('head');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !loca || !glyf) throw new Error('Missing glyph outlines');
  const location = (id) => head.readInt16BE(50) === 0 ? loca.readUInt16BE(id * 2) * 2 : loca.readUInt32BE(id * 4);
  const result = new Map();
  for (const [point, glyph] of points) {
    if (location(glyph) >= location(glyph + 1) || location(glyph + 1) > glyf.length) {
      throw new Error(`Empty or invalid outline at U+${point.toString(16)}`);
    }
    result.set(point, names[glyph]);
  }
  if (!result.size) throw new Error('No Unicode glyphs');
  return result;
}

function ranges(glyphs) {
  const points = [...glyphs.keys()].sort((a, b) => a - b);
  const spans = [];
  for (const point of points) {
    if (point < 0xe000 || point > 0xf8ff) throw new Error('Icon font must contain only PUA glyphs');
    const last = spans.at(-1);
    if (last && last[1] + 1 === point) last[1] = point;
    else spans.push([point, point]);
  }
  const hex = (point) => point.toString(16).toUpperCase().padStart(4, '0');
  return spans.map(([start, end]) => `U+${hex(start)}-U+${hex(end)}`);
}

function bundledGlyphs() { return fontGlyphs(fs.readFileSync(SOURCE)); }

module.exports = { SOURCE, FAMILY, fontGlyphs, bundledGlyphs, ranges };

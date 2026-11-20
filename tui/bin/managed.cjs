'use strict';

const fs = require('node:fs');
const path = require('node:path');

function read(file) {
  try {
    const bytes = fs.readFileSync(file);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error(`${file}: expected UTF-8`);
    return { text, exists: true };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A dangling dotfile link has an owner even though its target is absent.
      // Refuse it rather than create a target we cannot later remove exactly.
      try {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file}: dangling symlink; create its target first`);
      } catch (linkError) {
        if (linkError.code !== 'ENOENT') throw linkError;
      }
      return { text: '', exists: false };
    }
    throw error;
  }
}

// Separator ownership lives in the fence, so even a file without a final newline
// can be restored exactly. No trimming, newline normalization or backup state.
function edit(snapshot, id, body) {
  const { text, exists } = snapshot;
  const begin = `# >>> herdr-team:${id}`;
  const end = `# <<< herdr-team:${id}`;
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0]);
  const starts = lines.filter((m) => m[0].startsWith(begin));
  const ends = lines.filter((m) => m[0].startsWith(end));
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length) {
    throw new Error(`${id}: duplicate or incomplete managed fence; repair it first`);
  }
  let from = text.length;
  let to = text.length;
  let separator = exists && text.length > 0 && !text.endsWith('\n') ? 1 : 0;
  let created = exists ? 0 : 1;
  let eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (starts.length) {
    const start = starts[0];
    const finish = ends[0];
    const match = /^# >>> herdr-team:[\w-]+ separator=([01]) created=([01])(\r?\n)$/.exec(start[0]);
    if (!match || !/^# <<< herdr-team:[\w-]+(?:\r?\n|$)$/.test(finish[0]) || finish.index <= start.index) {
      throw new Error(`${id}: malformed managed fence; repair it first`);
    }
    separator = Number(match[1]);
    created = Number(match[2]);
    eol = match[3];
    from = start.index;
    to = finish.index + finish[0].length;
    if (separator) {
      if (text.slice(from - eol.length, from) !== eol) throw new Error(`${id}: missing owned separator`);
      from -= eol.length;
    }
  } else if (body === null) {
    return { text, exists };
  }
  const block = body === null ? '' : (separator ? eol : '') +
    `${begin} separator=${separator} created=${created}${eol}` +
    body.replace(/\n/g, eol) + eol + end + eol;
  const next = text.slice(0, from) + block + text.slice(to);
  return { text: next, exists: !(body === null && created && next === '') };
}

function write(file, before, after) {
  if (before.text === after.text && before.exists === after.exists) return false;
  if (after.exists) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write through dotfile symlinks rather than replacing them.
    fs.writeFileSync(file, after.text, 'utf8');
  } else {
    fs.unlinkSync(file);
  }
  return true;
}

module.exports = { read, edit, write };

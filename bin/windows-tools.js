'use strict';

const fs = require('node:fs');
const path = require('node:path').win32;

function pathEntries(env) {
  const value = env.PATH ?? env[Object.keys(env).find(key => key.toUpperCase() === 'PATH')];
  return (value || '').split(';').map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); }
  catch { return false; }
}

function bunExecutable(env) {
  for (const dir of pathEntries(env)) {
    const executable = [path.join(dir, 'bun.exe'), path.join(dir, 'node_modules/bun/bin/bun.exe')].find(isFile);
    if (executable) return executable;
  }
  return 'bun.exe';
}

function npxScript(env) {
  const npm = env.npm_execpath;
  const candidates = [
    ...(npm && path.basename(npm).toLowerCase() === 'npm-cli.js' ? [path.join(path.dirname(npm), 'npx-cli.js')] : []),
    ...[path.dirname(process.execPath), ...pathEntries(env)].map(dir => path.join(dir, 'node_modules/npm/bin/npx-cli.js')),
  ];
  const script = candidates.find(isFile);
  if (!script) throw new Error('Could not find npx-cli.js. Install Node.js with npm to manage the team skill.');
  return script;
}

module.exports = { pathEntries, isFile, bunExecutable, npxScript };

import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const launcher = process.platform === 'win32'
  ? (process.env.PATH || '').split(delimiter).filter(isAbsolute)
    .map(bin => join(bin, 'herdr-team.mjs'))
    .find(file => statSync(file, { throwIfNoEntry: false })?.isFile())
  : Bun.which('herdr-team');
if (!launcher) throw new Error('Install herdr-team on PATH before opening the Console.');

process.env.HERDR_TEAM_TUI_VIEW = '1';
await import(pathToFileURL(launcher).href);

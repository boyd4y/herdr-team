'use strict';

const os = require('node:os');
const path = require('node:path');

function locations(env = process.env, platform = process.platform, home = os.homedir()) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Supported platforms: macOS, Linux and Windows');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const config = env.XDG_CONFIG_HOME || (platform === 'win32'
    ? env.APPDATA || paths.join(home, 'AppData', 'Roaming')
    : paths.join(home, '.config'));
  return {
    herdr: env.HERDR_CONFIG_PATH || paths.join(config, 'herdr', 'config.toml'),
  };
}

module.exports = { locations };

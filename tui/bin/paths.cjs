'use strict';

const os = require('node:os');
const path = require('node:path');

function locations(env = process.env, platform = process.platform, home = os.homedir()) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Supported platforms: macOS and Linux');
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return {
    herdr: env.HERDR_CONFIG_PATH || path.join(config, 'herdr', 'config.toml'),
  };
}

module.exports = { locations };

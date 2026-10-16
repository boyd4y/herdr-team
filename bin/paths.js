'use strict';

const os = require('node:os');
const path = require('node:path');

function locations(env = process.env, platform = process.platform, home = os.homedir()) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Supported platforms: macOS and Linux');
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const ghostty = ['config', 'config.ghostty'].flatMap((name) => [
    path.join(config, 'ghostty', name),
    ...(platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty', name)] : []),
  ]);
  return {
    herdr: env.HERDR_CONFIG_PATH || path.join(config, 'herdr', 'config.toml'),
    fonts: platform === 'darwin' ? path.join(home, 'Library', 'Fonts') :
      path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'fonts'),
    terminals: [...new Set(ghostty)].map((file) => ({ file, kind: 'ghostty' })).concat([
      { file: path.join(config, 'kitty', 'kitty.conf'), kind: 'kitty' },
    ]),
  };
}

module.exports = { locations };

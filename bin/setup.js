#!/usr/bin/env node
'use strict';

const { installCLI } = require('./install-cli');
const { installSkill } = require('./install-skill');

// No UI configuration, project initialization or runtime startup during installation.
(async () => {
  await installCLI();
  await installSkill();
})().catch(error => { console.error(error.message); process.exitCode = 1; });

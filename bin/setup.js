#!/usr/bin/env node
'use strict';

const { planConfigure, applyPlan, reloadConfig } = require('./configure');
const { installSkill } = require('./install-skill');
const { installCLI } = require('./install-cli');

// One-shot install hook: no daemon, no agent orchestration, no downloads.
async function setup() {
  const plan = planConfigure();
  await installCLI();
  await installSkill();
  applyPlan(plan);
  // GitHub builds need not have a running server or runtime socket context.
  if (process.env.HERDR_ENV === '1') {
    try { reloadConfig(); }
    catch (error) { console.log(`Setup saved. Reload with the configure action: ${error.message}`); }
  } else console.log('Setup saved. Invoke herdr-team.configure in a running Herdr session to reload.');
}

setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

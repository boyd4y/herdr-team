#!/usr/bin/env node
'use strict';

const { planConfigure, applyPlan, reloadConfig, refreshSidebar } = require('./configure');
const { installSkill } = require('./install-skill');
const { installCLI } = require('./install-cli');

// One-shot install hook: npx installs the bundled local skill; no daemon or agent startup.
async function setup() {
  const plan = planConfigure();
  await installCLI();
  await installSkill();
  applyPlan(plan);
  // GitHub builds need not have a running server or runtime socket context.
  if (process.env.HERDR_ENV === '1') {
    try { reloadConfig(); refreshSidebar(); }
    catch (error) { console.log(`Setup saved. Reload with the configure action: ${error.message}`); }
  } else console.log('Setup saved. Invoke herdr-team.configure in a running Herdr session to reload.');
}

setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

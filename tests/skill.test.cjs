'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SKILLS_PACKAGE, installedAgents, stateDirectory } = require('../bin/install-skill');
const { installNpxStub } = require('./skills-fixture.cjs');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-team-npx-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const bin = path.join(dir,'bin');fs.mkdirSync(bin);installNpxStub(bin);
  const env={...process.env,HOME:dir,HERDR_PLUGIN_STATE_DIR:path.join(dir,'state'),PATH:bin,TEST_NPX_LOG:path.join(dir,'npx.jsonl')};
  const destination=path.join(dir,'.agents/skills/herdr-team');
  function run(args=[],overrides={},plugin=root){return spawnSync(process.execPath,[path.join(plugin,'bin/install-skill.js'),...args],{env:{...env,...overrides},encoding:'utf8',timeout:20000});}
  function ok(args=[],overrides={},plugin=root){const r=run(args,overrides,plugin);assert.equal(r.status,0,r.stdout+r.stderr);return r;}
  return {dir,bin,env,destination,run,ok,calls:()=>fs.readFileSync(env.TEST_NPX_LOG,'utf8').trim().split('\n').map(JSON.parse)};
}
test('npx installs the bundled local skill globally and reports its real destination',(t)=>{
 const f=fixture(t),r=f.ok();
 assert.deepEqual(f.calls(),[['--yes',SKILLS_PACKAGE,'add',path.join(root,'skill'),'--skill','herdr-team','--global','--yes','--json','--agent','codex']]);
 for(const file of ['SKILL.md','references/setup.md','references/workflow.md','references/handoff.md','references/models.md','agents/openai.yaml','assets/plans.json','assets/identity.md', ...fs.readdirSync(path.join(root,'skill/assets/roles')).map(role=>`assets/roles/${role}/prompt.md`)])assert.deepEqual(fs.readFileSync(path.join(f.destination,file)),fs.readFileSync(path.join(root,'skill',file)));
 assert(r.stdout.includes(`Skill installed: ${f.destination}`));
 assert.equal(stateDirectory({},f.dir),path.join(f.dir,'.local/state/herdr/plugins/herdr-team'));
});
test('only PATH-visible supported agents are selected, never the upstream project-only defaults',(t)=>{
 const f=fixture(t);assert.deepEqual(installedAgents(f.env),['codex']);
 for(const name of ['claude','pi','grok'])fs.writeFileSync(path.join(f.bin,name),'#!/bin/sh\nexit 99\n',{mode:0o755});
 assert.deepEqual(installedAgents(f.env),['claude-code','codex','pi','grok']);
 fs.chmodSync(path.join(f.bin,'pi'),0o644);assert.deepEqual(installedAgents(f.env),['claude-code','codex','grok']);
 assert.notEqual(f.run([],{PATH:''}).status,0);
});
test('uninstall delegates exactly herdr-team to the standard CLI',(t)=>{
 const f=fixture(t);f.ok();f.ok(['--uninstall']);
 assert.deepEqual(f.calls()[1],['--yes',SKILLS_PACKAGE,'remove','herdr-team','--global','--yes']);assert(!fs.existsSync(f.destination));
});
test('failed, invalid or unreadable installation results fail and release the lock',(t)=>{
 const f=fixture(t);
 for(const override of [{TEST_NPX_FAIL:'1'},{TEST_NPX_INVALID:'1'},{TEST_NPX_STATUS:'failed'},{TEST_NPX_UNREADABLE:'1'}]){
   fs.rmSync(f.destination,{recursive:true,force:true});
   assert.notEqual(f.run([],override).status,0);
   assert(!fs.existsSync(path.join(f.env.HERDR_PLUGIN_STATE_DIR,'skill.lock')));
 }
});
test('installation and removal ignore old ownership ledgers and unmanaged skill copies',(t)=>{
 const f=fixture(t),ledger=path.join(f.env.HERDR_PLUGIN_STATE_DIR,'skill-paths.json');
 const old=path.join(f.dir,'old-agent/skills/herdr-team/SKILL.md');
 fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,'old skill');
 fs.mkdirSync(f.env.HERDR_PLUGIN_STATE_DIR,{recursive:true});fs.writeFileSync(ledger,'invalid old ledger');
 f.ok();f.ok(['--uninstall']);
 assert.equal(fs.readFileSync(ledger,'utf8'),'invalid old ledger');assert.equal(fs.readFileSync(old,'utf8'),'old skill');
});
test('installed skill and relative references survive checkout move and removal',(t)=>{
 const f=fixture(t),checkout=path.join(f.dir,'checkout');fs.cpSync(root,checkout,{recursive:true,filter:file=>!['tests','node_modules','.git','.herdr'].includes(path.basename(file))});
 f.ok([],{},checkout);fs.renameSync(checkout,path.join(f.dir,'moved'));f.ok([],{},path.join(f.dir,'moved'));fs.rmSync(path.join(f.dir,'moved'),{recursive:true});
 const text=fs.readFileSync(path.join(f.destination,'SKILL.md'),'utf8');for(const [,link]of text.matchAll(/\]\((references\/[^)]+)\)/g))assert(fs.existsSync(path.join(f.destination,link)));assert(!text.includes(checkout));
});
test('concurrent actions wait for the lock and failures release it',async(t)=>{
 const f=fixture(t);fs.mkdirSync(f.env.HERDR_PLUGIN_STATE_DIR,{recursive:true});const lock=path.join(f.env.HERDR_PLUGIN_STATE_DIR,'skill.lock');fs.writeFileSync(lock,'busy');
 const child=spawn(process.execPath,[path.join(root,'bin/install-skill.js')],{env:f.env});let stderr='';child.stderr.on('data',data=>{stderr+=data;});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});await new Promise(resolve=>setTimeout(resolve,200));assert(!fs.existsSync(f.env.TEST_NPX_LOG));fs.unlinkSync(lock);assert.equal(await done,0,stderr);assert(!fs.existsSync(lock));
});

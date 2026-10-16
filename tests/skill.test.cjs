'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
  const ledger=path.join(env.HERDR_PLUGIN_STATE_DIR,'skill-paths.json');
  function run(args=[],overrides={},plugin=root){return spawnSync(process.execPath,[path.join(plugin,'bin/install-skill.js'),...args],{env:{...env,...overrides},encoding:'utf8',timeout:20000});}
  function ok(args=[],overrides={},plugin=root){const r=run(args,overrides,plugin);assert.equal(r.status,0,r.stdout+r.stderr);return r;}
  function legacy(){
    const old=path.join(dir,'old-agent/skills/herdr-team');fs.mkdirSync(old,{recursive:true});
    fs.writeFileSync(path.join(old,'SKILL.md'),'legacy');const info=fs.statSync(old);
    fs.mkdirSync(env.HERDR_PLUGIN_STATE_DIR,{recursive:true});
    fs.writeFileSync(ledger,JSON.stringify([{dir:old,hash:createHash('sha256').update('legacy').digest('hex'),dev:info.dev,ino:info.ino}]));return old;
  }
  return {dir,bin,env,destination,ledger,run,ok,legacy,calls:()=>fs.readFileSync(env.TEST_NPX_LOG,'utf8').trim().split('\n').map(JSON.parse)};
}
test('npx installs the bundled local skill globally and reports its real destination',(t)=>{
 const f=fixture(t),r=f.ok();
 assert.deepEqual(f.calls(),[['--yes',SKILLS_PACKAGE,'add',path.join(root,'skill'),'--skill','herdr-team','--global','--yes','--json','--agent','codex']]);
 for(const file of ['SKILL.md','references/team-setup.md','references/role-presets.md','agents/openai.yaml'])assert.deepEqual(fs.readFileSync(path.join(f.destination,file)),fs.readFileSync(path.join(root,'skill',file)));
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
test('migration never deletes the newly installed canonical skill',(t)=>{
 const f=fixture(t);f.ok();const info=fs.statSync(f.destination),text=fs.readFileSync(path.join(f.destination,'SKILL.md'));
 fs.writeFileSync(f.ledger,JSON.stringify([{dir:f.destination,hash:createHash('sha256').update(text).digest('hex'),dev:info.dev,ino:info.ino}]));
 f.ok();assert(fs.existsSync(path.join(f.destination,'SKILL.md')));
});
test('uninstall delegates exactly herdr-team to the standard CLI',(t)=>{
 const f=fixture(t);f.ok();f.ok(['--uninstall']);
 assert.deepEqual(f.calls()[1],['--yes',SKILLS_PACKAGE,'remove','herdr-team','--global','--yes']);assert(!fs.existsSync(f.destination));
});
test('migration removes old copies only after npx succeeds',(t)=>{
 const f=fixture(t),old=f.legacy();assert.notEqual(f.run([],{TEST_NPX_FAIL:'1'}).status,0);assert(fs.existsSync(old));
 f.ok();assert(!fs.existsSync(old));assert.deepEqual(JSON.parse(fs.readFileSync(f.ledger,'utf8')),[]);assert(fs.existsSync(path.join(f.destination,'SKILL.md')));
});
test('migration preserves user edits, additions and replacement symlinks',(t)=>{
 const f=fixture(t),old=f.legacy(),skill=path.join(old,'SKILL.md');fs.writeFileSync(skill,'user edit');
 f.ok();assert.equal(fs.readFileSync(skill,'utf8'),'user edit');fs.writeFileSync(skill,'legacy');fs.writeFileSync(path.join(old,'notes.md'),'user notes');
 f.ok();assert(fs.existsSync(path.join(old,'notes.md')));fs.rmSync(old,{recursive:true});fs.symlinkSync(f.destination,old);f.ok();assert(fs.lstatSync(old).isSymbolicLink());assert(fs.existsSync(path.join(f.destination,'SKILL.md')));
});
test('invalid, failed or unreadable success results retain legacy copies',(t)=>{
 const f=fixture(t),old=f.legacy();
 for(const override of [{TEST_NPX_INVALID:'1'},{TEST_NPX_STATUS:'failed'}]){assert.notEqual(f.run([],override).status,0);assert(fs.existsSync(old));}
 fs.rmSync(f.destination,{recursive:true});assert.notEqual(f.run([],{TEST_NPX_UNREADABLE:'1'}).status,0);assert(fs.existsSync(old));
 fs.writeFileSync(f.ledger,'invalid');assert.notEqual(f.run().status,0);assert(fs.existsSync(old));assert(!fs.existsSync(path.join(f.env.HERDR_PLUGIN_STATE_DIR,'skill.lock')));
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

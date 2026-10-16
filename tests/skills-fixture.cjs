'use strict';
const fs = require('node:fs');
const path = require('node:path');
function installNpxStub(bin) {
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const file = path.join(bin, 'npx');
  fs.writeFileSync(file, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(process.env.TEST_NPX_LOG)fs.appendFileSync(process.env.TEST_NPX_LOG,JSON.stringify(args)+'\\n');
if(process.env.TEST_NPX_FAIL){console.error('test npm unavailable');process.exit(1);}
const destination=path.join(process.env.HOME,'.agents/skills/herdr-team');
if(args[2]==='remove'){fs.rmSync(destination,{recursive:true,force:true});process.exit(0);}
if(args[2]!=='add'||!path.isAbsolute(args[3]))throw Error('Expected absolute local skill');
if(!process.env.TEST_NPX_UNREADABLE){fs.mkdirSync(path.dirname(destination),{recursive:true});fs.cpSync(args[3],destination,{recursive:true});}
if(process.env.TEST_NPX_INVALID){console.log('invalid JSON');process.exit(0);}
console.log(JSON.stringify([{name:'herdr-team',status:process.env.TEST_NPX_STATUS||'installed',path:destination,agents:['codex','claude-code','pi']}]));
`);
  fs.chmodSync(file, 0o755);
}
module.exports = { installNpxStub };

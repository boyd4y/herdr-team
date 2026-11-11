import { chmodSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ACPC app-server double; the real TUI is exercised separately in a Herdr pane. */
export function fakeAcpc(root: string) {
  const bin = join(root, "acpc-bin"), log = join(root, "acpc-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "acpc"), `#!${process.execPath}
import {mkdirSync,appendFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {createInterface} from "node:readline";
const record=(method,params)=>appendFileSync(${JSON.stringify(log)},JSON.stringify({method,params,pid:process.pid,cwd:process.cwd()})+"\\n");
const args=process.argv.slice(2), resumed=args.indexOf("resume");
let threadId=resumed>=0?args[resumed+1]:crypto.randomUUID(),model="default",active,pending;
record("launch",{args,home:process.env.ACPC_HOME,config:Bun.TOML.parse(await Bun.file(process.env.ACPC_CONFIG).text())});
if(resumed>=0&&existsSync(${JSON.stringify(join(root, "reject-tui-resume"))}))process.exit(4);
const home=process.env.ACPC_HOME;mkdirSync(join(home,"run"),{recursive:true});
const clients=new Set();
const notify=(method,params)=>{for(const ws of clients)ws.send(JSON.stringify({method,params}));};
const finish=()=>{const turn={id:active,status:"completed"};active=undefined;notify("turn/completed",{threadId,turn});};
const resolvePermission=decision=>{record("permission",decision);pending=undefined;notify("serverRequest/resolved",{requestId:10});setTimeout(finish,20);};
const server=Bun.serve({unix:join(home,"run",\`bridge-\${process.pid}.sock\`),fetch(req,s){if(s.upgrade(req))return;return new Response("no",{status:400});},websocket:{
 open(ws){clients.add(ws);},close(ws){clients.delete(ws);},message(ws,raw){
  const m=JSON.parse(String(raw)),p=m.params??{};
  const reply=result=>ws.send(JSON.stringify({id:m.id,result}));
  const fail=message=>ws.send(JSON.stringify({id:m.id,error:{code:-32600,message}}));
  if(m.method==="initialize")reply({userAgent:"acpc/test"});
  else if(m.method==="thread/loaded/list")reply({data:[threadId]});
  else if(m.method==="thread/read")reply({thread:{id:threadId,model,status:{type:active?"active":"idle"},turns:p.includeTurns&&active?[{id:active,status:"inProgress"}]:[]}});
  else if(m.method==="thread/settings/update"){if(p.model==="invalid")return fail("Unsupported model");model=p.model;reply({});notify("thread/settings/updated",{threadId,threadSettings:{model}});}
  else if(m.method==="turn/start"){
   if(active)return fail("a turn is already running");
   record("prompt",{prompt:[{text:p.input[0].text}]});
   active=crypto.randomUUID();reply({turn:{id:active,status:"inProgress"}});notify("turn/started",{threadId,turn:{id:active}});
   if(p.input[0].text==="permission"){pending=true;for(const client of clients)client.send(JSON.stringify({id:10,method:"item/commandExecution/requestApproval",params:{threadId,turnId:active}}));}
   else if(p.input[0].text==="immediate")finish();else setTimeout(finish,100);
  }else if(m.method==="turn/interrupt"){reply({});finish();}
  else if(m.id===10&&m.result)resolvePermission(m.result);
 }}
});
createInterface({input:process.stdin}).on("line",line=>{if(pending)resolvePermission({option:line.trim()});else if(line==="new-session")notify("thread/started",{thread:{id:crypto.randomUUID()}});});
process.on("SIGTERM",()=>{server.stop(true);process.exit(0);});
`);
  chmodSync(join(bin, "acpc"), 0o755);
  return {
    env: { PATH: `${bin}:${process.env.PATH}` },
    rows: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
  };
}

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProject, fakeHerdr } from "./helpers.ts";
import { init } from "../scripts/lib/team/init.ts";
import { addRole } from "../scripts/lib/team/roles.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { readAgentPresets } from "../scripts/lib/team/agents.ts";
import { openAcpSession } from "../scripts/lib/runtime/acp/session.ts";
import { acpLaunchPath, promptAcpAgent, requestAcp, startAcpAgent } from "../scripts/lib/runtime/acp/client.ts";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import { processAlive } from "../scripts/lib/runtime/state.ts";
import { createTask } from "../scripts/lib/tasks/cards.ts";
import { enqueueTasks, pumpQueue } from "../scripts/lib/dispatch/queue.ts";

function fixture(root: string) {
  const log = join(root, "acp-calls.jsonl"), command = join(root, "fake-acp");
  const sdk = Bun.resolveSync("@agentclientprotocol/sdk", import.meta.dir);
  writeFileSync(command, `#!${process.execPath}
import {AgentSideConnection,ndJsonStream,PROTOCOL_VERSION} from ${JSON.stringify(sdk)};
import {Readable,Writable} from "node:stream";
import {appendFileSync,existsSync} from "node:fs";
const log=${JSON.stringify(log)};
const record=(method,params)=>appendFileSync(log,JSON.stringify({method,params,pid:process.pid,cwd:process.cwd()})+"\\n");
if(process.argv[2]==="--version") {console.log("fake-acp 1.0.0");process.exit(0);}
new AgentSideConnection(connection=>({
 async initialize(params) {record("initialize",params);if(existsSync(${JSON.stringify(join(root, "slow-start"))}))await new Promise(r=>setTimeout(r,20000));return {protocolVersion:PROTOCOL_VERSION,agentCapabilities:{loadSession:!existsSync(${JSON.stringify(join(root, "no-resume"))})},authMethods:[]};},
 async newSession(params) {record("new",params);return {sessionId:crypto.randomUUID()};},
 async loadSession(params) {record("load",params);if(existsSync(${JSON.stringify(join(root, "reject-resume"))}))throw new Error("Exact session unavailable");return {};},
 async prompt(params) {
  record("prompt",params);
  if(params.prompt[0].text==="permission") {
   const answer=await connection.requestPermission({sessionId:params.sessionId,toolCall:{toolCallId:"edit-1",title:"Edit fixture",kind:"edit",status:"pending"},options:[{optionId:"allow",name:"Allow once",kind:"allow_once"},{optionId:"deny",name:"Reject",kind:"reject_once"}]});record("permission",answer);
  }
  await new Promise(r=>setTimeout(r,150));
  await connection.sessionUpdate({sessionId:params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"HERDR_TEAM_OK"}}});
  return {stopReason:"end_turn"};
 },async cancel(params){record("cancel",params);}
}),ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
`);
  chmodSync(command, 0o755);
  const agent = { command, args: ["literal argument with spaces"], model: "default", permissionMode: "approve-reads" };
  const rows = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { agent, rows, log };
}

test("ACP roles validate structured presets and native response tests use actual ACP messages", () => {
  const f = makeProject();
  try {
    const server = fixture(f.root), file = join(f.root, "agents.json");
    writeFileSync(file, JSON.stringify({ acp: { remote: server.agent } }).replace('"permissionMode"', '"permission_mode"'));
    init(loadProject(f.root), []);
    expect(() => addRole(loadProject(f.root), { name: "invalid", kind: "acp" })).toThrow("require a preset");
    addRole(loadProject(f.root), { name: "story", kind: "acp", preset: "remote", worktree: true });
    expect(loadProject(f.root).roles.find(r => r.name === "story")?.kind).toBe("acp");
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "agents", "test", "acp/remote", "--root", f.root, "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())[0].status).toBe("passed");
    expect(server.rows().map(r => r.method)).toEqual(["initialize", "new", "prompt"]);
    expect(server.rows()[1].params.cwd).not.toBe(realpathSync(f.root));
    writeFileSync(join(f.root,"slow-start"),"yes");
    const timed = Bun.spawnSync([process.execPath,join(import.meta.dir,"../scripts/cli.ts"),"agents","test","acp/remote","--root",f.root,"--timeout-ms","1500","--json"],{stdout:"pipe",stderr:"pipe"});
    expect(JSON.parse(timed.stdout.toString())[0].detail).toContain("Timed out");
    const pid=server.rows().at(-1).pid;
    expect(processAlive(pid)).toBe(false);
    writeFileSync(file, JSON.stringify({ acp: { bad: { command: server.agent.command, args: "--bad" } } }));
    expect(() => readAgentPresets(f.root)).toThrow("list of strings");
  } finally { f.cleanup(); }
});

test("ACP sessions resume the exact confirmed ID and preserve a good reference on failed resume", async () => {
  const f = makeProject();
  try {
    const server = fixture(f.root), config = { cwd: realpathSync(f.root), stateDir: join(f.root, "state"), fresh: false, agent: server.agent };
    const first = await openAcpSession(config);
    const id = first.sessionId;
    await first.close();
    const saved = readFileSync(join(config.stateDir, "session.json"), "utf8");
    const second = await openAcpSession(config);
    expect(second.resumed).toBe(true); expect(second.sessionId).toBe(id);
    await second.close();
    expect(server.rows().filter(r => r.method === "load")[0].params.sessionId).toBe(id);
    writeFileSync(join(f.root, "reject-resume"), "yes");
    await expect(openAcpSession(config)).rejects.toThrow();
    expect(readFileSync(join(config.stateDir, "session.json"), "utf8")).toBe(saved);
    expect(server.rows().filter(r => r.method === "new")).toHaveLength(1);
    writeFileSync(join(f.root, "no-resume"), "yes");
    const fresh = await openAcpSession({ ...config, fresh: true });
    expect(fresh.resumable).toBe(false);
    await fresh.close();
    const unsupported = await openAcpSession(config);
    expect(unsupported.resumed).toBe(false);
    expect(unsupported.sessionId).not.toBe(fresh.sessionId);
    await unsupported.close();
    const savedBeforeAbort=readFileSync(join(config.stateDir,"session.json"),"utf8");
    writeFileSync(join(f.root,"slow-start"),"yes");
    const controller=new AbortController(),opening=openAcpSession({...config,fresh:true},undefined,controller.signal);
    void opening.catch(()=>{});
    const before=server.rows().length;
    for(let i=0;i<50&&server.rows().length===before;i++)await Bun.sleep(20);
    const pid=server.rows().at(-1).pid;
    controller.abort();
    await expect(opening).rejects.toThrow();
    expect(processAlive(pid)).toBe(false);
    expect(readFileSync(join(config.stateDir,"session.json"),"utf8")).toBe(savedBeforeAbort);
  } finally { f.cleanup(); }
});

test("ACP task delivery registers a visible Herdr agent, deduplicates requests and handles permission state", async () => {
  const f = makeProject(), previousState = process.env.HERDR_PLUGIN_STATE_DIR;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    process.env.HERDR_PLUGIN_STATE_DIR = join(f.root, "runtime");
    const server = fixture(f.root), native = join(f.root, "fake-herdr"), live = join(f.root, "live.json");
    writeFileSync(live, "[]");
    writeFileSync(native, `#!${process.execPath}
import {readFileSync,writeFileSync} from "node:fs";
const file=${JSON.stringify(live)},args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
let rows=JSON.parse(readFileSync(file,"utf8")),agent=rows.find(a=>a.pane_id===args[2]);
if(args[0]==="pane"&&args[1]==="report-agent") {
 if(!agent){agent={pane_id:args[2],workspace_id:"w101",tab_id:"w101:t1",cwd:process.cwd(),tokens:{}};rows.push(agent);}
 agent.agent=value("--agent");agent.agent_status=value("--state");
} else if(args[1]==="report-metadata"&&agent) {
 agent.display_agent=value("--display-agent");for(let i=0;i<args.length;i++)if(args[i]==="--token"){const t=args[++i],n=t.indexOf("=");agent.tokens[t.slice(0,n)]=t.slice(n+1);}
} else if(args[0]==="agent"&&args[1]==="rename"&&agent)agent.name=args[3];
else if(args[1]==="release-agent")rows=rows.filter(a=>a.pane_id!==args[2]);
writeFileSync(file,JSON.stringify(rows));console.log(JSON.stringify({result:{}}));
`);
    chmodSync(native, 0o755);
    writeFileSync(join(f.root, "agents.json"), JSON.stringify({ acp: { remote: { command: server.agent.command, args: server.agent.args } } }));
    init(loadProject(f.root), [{ name: "story", kind: "acp", preset: "remote", worktree: true }]);
    let project = loadProject(f.root);
    const task = createTask(project, { title: "ACP task", role: "story", handoff: [], priority: "P2", body: "Check ACP delivery" });
    const h = fakeHerdr();
    h.agentList = () => JSON.parse(readFileSync(live, "utf8"));
    const checkout = join(f.root, "checkout"); mkdirSync(checkout);
    h.worktreeList = () => h.branches.size ? [...h.branches].map(([id, branch]) => ({ branch, path: checkout, open_workspace_id: id })) : [];
    h.paneRun = (pane, command) => {
      children.push(Bun.spawn(["/bin/sh", "-c", `exec ${command}`], { cwd: f.root,
        env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: pane, HERDR_BIN_PATH: native }, stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    };
    h.reportMetadata = (pane, _source, label, tokens = {}) => {
      const rows = h.agentList(), agent = rows.find(a => a.pane_id === pane);
      if (agent) { agent.display_agent = label; agent.tokens = { ...agent.tokens, ...Object.fromEntries(Object.entries(tokens).filter(([, v]) => v !== null)) } as Record<string,string>; }
      writeFileSync(live, JSON.stringify(rows));
    };
    enqueueTasks(loadProject(f.root), task.id);
    const outcomes = pumpQueue(loadProject(f.root), h);
    expect(outcomes[0]?.state).toBe("submitted");
    project = loadProject(f.root);
    const agent = h.agentList()[0]!, launch = acpLaunchPath(project, agent.tokens!.team_acp_launch!);
    expect(agent.agent).toBe("acp"); expect(agent.display_agent).toBe(`story-${task.id}`);
    expect(agent.tokens!.team_project).toBe(projectKey(project));
    expect(agent.tokens!.team_acp_session).toBeTruthy();
    expect(h.calls.some(call => call.startsWith("agent start"))).toBe(false);
    const delivery = project.tasks[0]!.meta.delivery as { id: string };
    const promptsBefore = server.rows().filter(r => r.method === "prompt").length;
    // A repeated accepted delivery acknowledges the same request, never resubmits it.
    expect(requestAcp(launch, "prompt", { id: delivery.id, text: "different prompt" }).code).toBe("acp_delivery_uncertain");
    const ready = async () => { for (let i=0;i<40;i++) { if (requestAcp(launch,"status").state==="ready") return; await Bun.sleep(50); } throw new Error("ACP did not become ready"); };
    await ready();
    expect(() => startAcpAgent(project,h,project.roles[0]!,"w101:p2","duplicate",{taskId:task.id,cwd:checkout})).toThrow("live owner");
    expect(() => promptAcpAgent(project,project.roles[0]!,h.agentList()[0]!,"9999","wrong-scope","wrong task")).toThrow("does not match");
    expect(server.rows().filter(r => r.method === "prompt")).toHaveLength(promptsBefore);
    promptAcpAgent(project, project.roles[0]!, h.agentList()[0]!, task.id, "permission-test", "permission");
    for(let i=0;i<40&&requestAcp(launch,"status").state!=="blocked";i++)await Bun.sleep(25);
    expect(h.agentList()[0]!.agent_status).toBe("blocked");
    children[0]!.stdin!.write("1\n");
    await ready();
    expect(server.rows().find(r => r.method === "permission").params.outcome.optionId).toBe("allow");
    expect(requestAcp(launch,"prompt",{id:"permission-test",text:"permission"}).ok).toBe(true);
    expect(server.rows().filter(r => r.method === "prompt")).toHaveLength(promptsBefore+1);
    requestAcp(launch,"stop");
    await children[0]!.exited;
    expect(h.agentList()).toHaveLength(0);
  } finally {
    for(const child of children) if(child.exitCode===null) { child.kill("SIGTERM"); await child.exited; }
    if(previousState===undefined)delete process.env.HERDR_PLUGIN_STATE_DIR;else process.env.HERDR_PLUGIN_STATE_DIR=previousState;
    f.cleanup();
  }
}, 20000);

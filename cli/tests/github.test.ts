import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { realGitHub, type PullRequest } from "../scripts/lib/pull-request.ts";
import { makeProject } from "./helpers.ts";

function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup(); try { run(f); } finally { f.cleanup(); }
}
function setup() {
  const p = makeProject(), bin = join(p.root, "bin"), file = join(p.root, "github.json"); mkdirSync(bin);
  const sha = "a".repeat(40);
  const pr: PullRequest = { repository: "owner/repo", number: 12, url: "https://github.com/owner/repo/pull/12", head: "feat/0001-change", base: "main", commit: sha };
  const state = { login: "owner", calls: [] as string[][], posts: [] as any[], failAfterPost: false,
    pr: { number: 12, url: pr.url, state: "OPEN", isDraft: false, headRefName: pr.head, baseRefName: pr.base, headRefOid: sha, author: { login: "owner" }, reviewDecision: "", mergeCommit: null as any } };
  writeFileSync(file, JSON.stringify(state));
  const executable = join(bin, "gh");
  writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'), file=process.env.HERDR_TEAM_GITHUB_TEST_STATE;
const state=JSON.parse(fs.readFileSync(file,'utf8')), args=process.argv.slice(2);
state.calls.push(args); let output;
if(args[0]==='pr'&&args[1]==='view') output=state.pr;
else if(args[0]==='repo') output={nameWithOwner:'owner/repo',defaultBranchRef:{name:'main'}};
else if(args[0]==='pr'&&args[1]==='list') output=[state.pr];
else if(args[0]==='api'&&args[1]==='user') output=state.login;
else if(args[0]==='api'&&args.includes('--paginate')) output=[state.posts.filter(p=>p.endpoint===args[1])];
else if(args[0]==='api'&&args.includes('POST')) {
 const fields=args.filter((a,i)=>args[i-1]==='-F'||args[i-1]==='-f');
 const body=fs.readFileSync(fields.find(a=>a.startsWith('body=@')).slice(6),'utf8');
 state.posts.push({endpoint:args[1],body,user:{login:state.login},commit_id:state.pr.headRefOid,state:fields.includes('event=APPROVE')?'APPROVED':'CHANGES_REQUESTED'});
 if(state.failAfterPost) {state.failAfterPost=false;fs.writeFileSync(file,JSON.stringify(state));process.stderr.write('response lost');process.exit(1);}
 output={id:state.posts.length};
} else if(args[0]==='api'&&args[1].endsWith('/merge')&&args.includes('PUT')) {state.pr.state='MERGED';state.pr.mergeCommit={oid:state.pr.headRefOid};output={merged:true};}
else {process.stderr.write('Unexpected gh command');process.exit(1);}
fs.writeFileSync(file,JSON.stringify(state));process.stdout.write(typeof output==='string'?output:JSON.stringify(output));
`); chmodSync(executable, 0o755);
  const originalPath = process.env.PATH, originalState = process.env.HERDR_TEAM_GITHUB_TEST_STATE;
  process.env.PATH = `${bin}${delimiter}${originalPath}`; process.env.HERDR_TEAM_GITHUB_TEST_STATE = file;
  return { pr, github: realGitHub(), load: () => JSON.parse(readFileSync(file, "utf8")) as typeof state,
    set: (value: typeof state) => writeFileSync(file, JSON.stringify(value)),
    cleanup() { process.env.PATH = originalPath; if(originalState === undefined) delete process.env.HERDR_TEAM_GITHUB_TEST_STATE; else process.env.HERDR_TEAM_GITHUB_TEST_STATE = originalState; p.cleanup(); } };
}

test("shared-account PR decisions are explicit comments, idempotent after lost responses", () => fixture((f) => {
  const state = f.load(); state.failAfterPost = true; f.set(state);
  expect(() => f.github.decide(f.pr, "approved", "Checked all requirements", "delivery-1")).toThrow(/response lost/);
  expect(f.github.decide(f.pr, "approved", "Checked all requirements", "delivery-1")).toBe("comment");
  const after = f.load(); expect(after.posts).toHaveLength(1);
  expect(after.posts[0].body).toContain("not an independent GitHub approval");
  expect(after.posts[0].body).toContain(f.pr.commit);
  expect(after.calls.some((args) => args.includes("event=APPROVE"))).toBe(false);
}));

test("independent accounts submit formal reviews pinned to the tested commit", () => fixture((f) => {
  const state = f.load(); state.login = "reviewer"; f.set(state);
  expect(f.github.decide(f.pr, "changes_requested", "Missing validation", "delivery-2")).toBe("review");
  const after = f.load();
  expect(after.calls.some((args) => args.includes(`commit_id=${f.pr.commit}`) && args.includes("event=REQUEST_CHANGES"))).toBe(true);
  expect(after.posts[0].body).toContain("changes_requested");
}));

test("GitHub merge requires the approved head and never bypasses branch protection", () => fixture((f) => {
  expect(f.github.merge(f.pr).state).toBe("MERGED");
  const args = f.load().calls.find((args) => args[0] === "api" && args[1]!.endsWith("/merge"))!;
  expect(args).toContain("PUT"); expect(args).toContain(`sha=${f.pr.commit}`); expect(args).not.toContain("bypass_rules=true");
  // Reconciliation sees an already-merged PR without submitting a second merge.
  f.github.merge(f.pr);
  expect(f.load().calls.filter((args) => args[0] === "api" && args[1]!.endsWith("/merge"))).toHaveLength(1);
}));

test("a changed remote head blocks review and merge before any remote mutation", () => fixture((f) => {
  const state = f.load(); state.pr.headRefOid = "b".repeat(40); f.set(state);
  expect(() => f.github.decide(f.pr, "approved", "Checked", "delivery-3")).toThrow(/head changed/);
  expect(() => f.github.merge(f.pr)).toThrow(/head changed/);
  expect(f.load().posts).toHaveLength(0);
  expect(f.load().calls.some((args) => args[0] === "api" && args[1]!.endsWith("/merge"))).toBe(false);
}));

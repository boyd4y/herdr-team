import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { claimCurrent, fakeHerdr, makeProject, taskMeta, twoResidentRoles, writeTask } from "./helpers.ts";

function fixture(run: (root: string, herdr: ReturnType<typeof fakeHerdr>) => void): void {
  const { root, cleanup } = makeProject();
  try {
    twoResidentRoles(root);
    writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] }), "原始任务描述，必须保留。");
    const herdr = fakeHerdr();
    herdr.live("docs");
    run(root, herdr);
  } finally { cleanup(); }
}

test("交付摘要在通知下游前落入 task.md，保留原描述，并提示读文件", () => fixture((root, herdr) => {
  const summary = "完成：鉴权文档已修正。\n\n产物：[报告](report.md)，提交 abc123。\n验证：类型检查通过。\n风险：未运行真实 Sandbox。";
  const file = join(root, ".herdr/tasks/0001-a/task.md");
  let prompted = false;
  herdr.agentPrompt = (_target, text) => {
    expect(readFileSync(file, "utf8")).toContain(summary);
    expect(text).toContain(file);
    expect(text).toContain("Read it and its referenced");
    expect(text).toContain("only for troubleshooting");
    prompted = true;
  };
  const result = handoff(loadProject(root), herdr, "0001", new Date(2026, 9, 16, 23, 30), { summary });
  expect(result).toMatchObject({ summarySaved: true, taskPath: file, prompted: true, status: "review" });
  expect(prompted).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("原始任务描述，必须保留。");
  expect(readFileSync(file, "utf8")).toContain("### Delivery 2026-10-16 23:30 · dev → docs");
  const done = handoff(loadProject(root), herdr, "0001", new Date(), { summary: "复核通过，无遗留问题。", delivery: claimCurrent(root) });
  expect(done.summarySaved).toBe(true);
  const body = readFileSync(file, "utf8");
  expect(body).toContain(summary);
  expect(body).toContain("复核通过，无遗留问题。");
  expect(body.match(/### Delivery /g)).toHaveLength(2);
}));

test("下游不可用或发送失败也保留摘要，不靠终端恢复交付", () => fixture((root, herdr) => {
  herdr.agentPrompt = () => { throw new Error("agent unavailable"); };
  expect(handoff(loadProject(root), herdr, "0001", new Date(), { summary: "可恢复交付：报告 report.md" })).toMatchObject({ prompted: false, queueState: "uncertain" });
  expect(loadProject(root).tasks[0]!.body).toContain("可恢复交付：报告 report.md");
}));

test("摘要保持可选；显式空摘要拒绝且不改变任务", () => fixture((root, herdr) => {
  const before = loadProject(root);
  expect(() => handoff(before, herdr, "0001", new Date(), { summary: " \n " })).toThrow("summary cannot be empty");
  expect(loadProject(root).tasks).toEqual(before.tasks);
  expect(herdr.calls).toEqual([]);
  let prompt = "";
  herdr.agentPrompt = (_target, text) => { prompt = text; };
  const result = handoff(before, herdr, "0001");
  expect(result.summarySaved).toBe(false);
  expect(result.note).toContain("No delivery summary supplied");
  expect(prompt).toContain("ask the previous owner for missing details");
}));

test("摘要无法落盘时恢复原元数据，不通知下游", () => fixture((root, herdr) => {
  const project = loadProject(root);
  const file = join(root, ".herdr/tasks/0001-a/task.md");
  const meta = join(root, ".herdr/tasks/0001-a/.task.yaml");
  const before = readFileSync(meta);
  rmSync(file);
  mkdirSync(file);
  expect(() => handoff(project, herdr, "0001", new Date(), { summary: "必须保存的交付" })).toThrow();
  expect(readFileSync(meta)).toEqual(before);
  expect(herdr.calls.some((call) => call.startsWith("agent prompt"))).toBe(false);
}));

test("真实 CLI 支持 summary / summary-file，校验输入后才流转，并可通过 tasks 读取", () => fixture((root) => {
  const executable = join(root, "offline-herdr");
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({result:{agents:[],workspaces:[],panes:[],worktrees:[]}}));\n`);
  chmodSync(executable, 0o755);
  const cli = (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args, "--root", root, "--json"], {
      cwd: root, env: { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: executable }, stdout: "pipe", stderr: "pipe",
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  };
  const before = loadProject(root).tasks;
  expect(cli("handoff", "0001", "--summary", "x", "--summary-file", "missing.md").code).not.toBe(0);
  expect(cli("handoff", "0001", "--summary-file", "missing.md").code).not.toBe(0);
  expect(cli("handoff", "0001", "--summary", " ").code).not.toBe(0);
  expect(loadProject(root).tasks).toEqual(before);
  const first = cli("handoff", "0001", "--summary", "完成实现；文件 src/a.ts；验证通过。");
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ summarySaved: true, prompted: false });
  writeFileSync(join(root, "summary.md"), "复核通过。\n\n风险：无。\n");
  herdrForSummary(root);
  expect(cli("queue", "drain").code).toBe(0);
  const delivery = loadProject(root).tasks[0]!.meta.delivery as { id: string };
  expect(cli("claim", "0001", "--delivery", delivery.id).code).toBe(0);
  expect(cli("handoff", "0001", "--delivery", delivery.id, "--summary-file", "summary.md").code).toBe(0);
  const task = JSON.parse(cli("tasks", "0001").stdout);
  expect(task.status).toBe("done");
  expect(task.body).toContain("完成实现；文件 src/a.ts；验证通过。");
  expect(task.body).toContain("复核通过。\n\n风险：无。");
}));

function herdrForSummary(root: string): void {
  const executable = join(root, "offline-herdr");
  writeFileSync(executable, `#!${process.execPath}
const result = {agents:[{name:"docs-0001",pane_id:"w1:p1",agent_status:"idle"}],workspaces:[],panes:[{pane_id:"w1:p1",workspace_id:"w1",cwd:${JSON.stringify(root)}}],worktrees:[]};
process.stdout.write(JSON.stringify({result}));
`);
}

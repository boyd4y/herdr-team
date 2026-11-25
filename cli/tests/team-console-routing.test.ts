import { expect, mock, test } from "bun:test";

const machines: (string | null)[] = [];
const requests: string[][] = [];
const respond: ((value: object) => void)[] = [];
const unused = () => { throw new Error("Unexpected host operation"); };

mock.module("gpui-kit", () => ({ View: class {}, div: unused, image: unused, svg: unused }));
mock.module("gpui-base", () => ({ Button: {}, Link: {}, Popover: {}, TextView: {}, h_flex: unused, v_flex: unused }));
mock.module("herdr", () => ({
  checking: unused, closeOverlay: unused, focused: unused, knownAgents: unused, layout: unused, nextCommand: unused,
  openOverlay: unused, panes: unused, props: unused, run: unused, settings: unused, spaces: unused, terminals: unused,
  theme: unused, watchFolder: unused, window: () => ({ platform: "macos" }),
  exec(_program: string, args: string[], { on }: { on: string | null }) {
    machines.push(on);
    requests.push(args);
    return new Promise(resolve => respond.push(rows => resolve({ code: 0, stdout: JSON.stringify(rows), stderr: "" })));
  },
}));

const { default: TeamConsole } = await import("../../desktop/mods/herdr-team/main.js");

test("leaving a remote Space discards its pending Inbox response", async () => {
  const jobs: Promise<void>[] = [];
  const cx = { spawn(job: (context: typeof cx) => Promise<void>) { jobs.push(job(cx)); }, notify() {} };
  const panel = new TeamConsole();
  panel.section = "inbox";
  panel.inboxFolder = "active";
  panel.inboxRequest = 0;
  panel.bodies = new Map();
  panel.watchInbox = () => {};
  panel.binding = { root: "/same/path", space: "remote/sp", machine: "remote" };
  panel.loadInbox(cx);
  panel.clearBinding();
  panel.binding = { root: "/same/path", space: "sp", machine: null };
  panel.loadInbox(cx);

  expect(machines).toEqual(["remote", null]);
  respond[1]!([{ title: "Local Inbox" }]);
  await jobs[1];
  respond[0]!([{ title: "Remote Inbox" }]);
  await jobs[0];
  expect(panel.inboxRows).toEqual([{ title: "Local Inbox" }]);
});

test("switching Feature Spaces discards the previous service list and uses the current workspace ports", async () => {
  const index = respond.length;
  const jobs: Promise<void>[] = [];
  const cx = { spawn(job: (context: typeof cx) => Promise<void>) { jobs.push(job(cx)); }, notify() {} };
  const panel = new TeamConsole();
  panel.binding = { root: "/same/path", space: "team", machine: null };
  panel.followServices({ view_space: "search" }, cx);
  panel.followServices({ view_space: "metrics" }, cx);

  expect(machines.slice(index)).toEqual([null, null]);
  expect(requests.slice(index).map(args => args.slice(args.indexOf("service"), args.indexOf("service") + 4)))
    .toEqual([["service", "list", "--space", "search"], ["service", "list", "--space", "metrics"]]);
  const rows = [{ name: "web", port: 6101, reserved: true }];
  respond[index + 1]!({ services: rows });
  await jobs[1];
  respond[index]!({ services: [{ name: "web", port: 6100, reserved: true }] });
  await jobs[0];
  expect(panel.servicePanel?.space).toBe("metrics");
  expect(panel.servicePanel?.rows).toEqual(rows);
});

test("Team panel archives tasks and issues through their own CLI operations", async () => {
  const index = respond.length;
  const jobs: Promise<void>[] = [];
  const cx = { spawn(job: (context: typeof cx) => Promise<void>) { jobs.push(job(cx)); }, notify() {} };
  const panel = new TeamConsole();
  panel.binding = { root: "/same/path", space: "team", machine: null };
  panel.load = () => {};
  const task = { id: "0001", status: "doing", meta: { requirement: "R0001" } };
  const issue = { id: "R0001", status: "open" };
  panel.tasks = [task];
  panel.requirements = [issue];
  panel.changeTask(task, "archive", cx);
  panel.changeIssue(issue, "archive", cx);

  const [taskArgs, issueArgs] = requests.slice(index);
  expect(taskArgs?.slice(taskArgs.indexOf("task"))).toEqual(["task", "archive", "0001", "--root", "/same/path", "--json", "--force"]);
  expect(issueArgs?.slice(issueArgs.indexOf("issue"))).toEqual(["issue", "archive", "R0001", "--root", "/same/path", "--json"]);
  respond[index]!({ ...task, meta: { ...task.meta, disposition: "archived" } });
  await jobs[0];
  expect(panel.requirements).toEqual([issue]);
  respond[index + 1]!({ ...issue, disposition: "archived" });
  await jobs[1];
  expect(panel.tasks[0].meta).toMatchObject({ requirement: "R0001", disposition: "archived" });
  expect(panel.requirements[0]).toMatchObject({ id: "R0001", disposition: "archived" });
});

import { expect, mock, test } from "bun:test";

const machines: (string | null)[] = [];
const respond: ((rows: object[]) => void)[] = [];
const unused = () => { throw new Error("Unexpected host operation"); };

mock.module("gpui-kit", () => ({ View: class {}, div: unused, image: unused, svg: unused }));
mock.module("gpui-base", () => ({ Button: {}, Popover: {}, TextView: {}, h_flex: unused, v_flex: unused }));
mock.module("herdr", () => ({
  checking: unused, closeOverlay: unused, focused: unused, knownAgents: unused, layout: unused, nextCommand: unused,
  openOverlay: unused, panes: unused, props: unused, run: unused, settings: unused, spaces: unused, terminals: unused,
  theme: unused, watchFolder: unused,
  exec(_program: string, _args: string[], { on }: { on: string | null }) {
    machines.push(on);
    return new Promise(resolve => respond.push(rows => resolve({ code: 0, stdout: JSON.stringify(rows), stderr: "" })));
  },
}));

const { default: TeamConsole } = await import("../../desktop/mods/team-console/main.js");

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

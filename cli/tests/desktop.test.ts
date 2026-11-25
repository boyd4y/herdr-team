import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopAgentProgram, desktopUp, bindDesktop, projectDesktopBinding, registeredDesktopBinding, showDesktopBinding, unbindDesktop, type DesktopClient, type DesktopTerminal } from "../scripts/lib/runtime/desktop.ts";
import { callerSpace, managedContext } from "../scripts/lib/runtime/context.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { makeProject, writeRole } from "./helpers.ts";

test("the Desktop adapter recognizes Grok lifecycle operations for labeled demo sessions", () => {
  const terminal: DesktopTerminal = { address: "t1", state: "live", argv: ["/demo/mock-bin/grok"], cwd: "/demo", labels: {} };
  expect(desktopAgentProgram(terminal)).toBeUndefined();
  expect(desktopAgentProgram({ ...terminal, labels: { "team.mock": "1" } })).toBe("grok");
});

function fixture() {
  const project = makeProject();
  writeRole(project.root, "lead", { kind: "codex" });
  writeRole(project.root, "developer", { kind: "codex", worktree: true });
  let document: any = null, version = 0;
  const terminals: DesktopTerminal[] = [];
  const calls: { method: string; params: Record<string, any> }[] = [];
  const space = { id: "space-one", machine: null, tabs: [{ terminals: [{ terminal: "caller" }] }] };
  const client: DesktopClient = {
    spaces: () => [space],
    executable: kind => `/bin/${kind}`,
    park() { throw new Error("Unexpected native detach"); },
    closeEmptyTaskSpace() { throw new Error("Unexpected native space close"); },
    rpc<T>(method: string, params: Record<string, any>): T {
      calls.push({ method, params });
      if (method === "doc.get") return structuredClone({ value: document, version }) as T;
      if (method === "doc.set") {
        if (params.version !== version) throw new Error("conflict");
        document = structuredClone(params.value); version++;
        return { version } as T;
      }
      if (method === "terminal.list") return { terminals } as T;
      if (method === "terminal.run") {
        const terminal = { address: `t${terminals.length + 1}`, state: "live", argv: params.argv,
          cwd: params.cwd, labels: params.labels, status: null };
        terminals.push(terminal);
        return terminal as T;
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  return { ...project, client, terminals, calls, space };
}

describe("verified runtime context", () => {
  const terminal: DesktopTerminal = { address: "caller", state: "live", argv: ["codex"], cwd: "/project", labels: { "herdr.space": "space-one" } };
  test("uses live runtime evidence and rejects stale, missing or ambiguous contexts", () => {
    const probes = { core: () => terminal, tui: () => "w1:p1" };
    expect(managedContext({ HC_TERMINAL_ID: "caller" }, probes).kind).toBe("desktop");
    expect(managedContext({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, probes).kind).toBe("tui");
    expect(() => managedContext({}, probes)).toThrow("Cannot verify");
    expect(() => managedContext({ HC_TERMINAL_ID: "stale" }, probes)).toThrow("Cannot verify");
    expect(() => managedContext({ HERDR_ENV: "1", HERDR_PANE_ID: "wrong" }, probes)).toThrow("Cannot verify");
    expect(() => managedContext({ HC_TERMINAL_ID: "caller", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, probes)).toThrow("Two managed");
    expect(() => managedContext({ HC_TERMINAL_ID: "caller" }, { ...probes, core: () => ({ ...terminal, state: "finished" }) })).toThrow("Cannot verify");
  });
  test("uses explicit Core opt-in before UI attachment and rejects conflicting ownership", () => {
    const f = fixture();
    try {
      expect(callerSpace(terminal, f.client)).toBe("space-one");
      expect(callerSpace({ ...terminal, address: "newly-created" }, f.client)).toBe("space-one");
      expect(() => callerSpace({ ...terminal, labels: {} }, f.client)).toThrow("no space binding");
      const list = f.client.spaces;
      f.client.spaces = () => [...list(), { ...f.space, id: "other-space" }];
      expect(() => callerSpace(terminal, f.client)).toThrow("conflicting space ownership");
    } finally { f.cleanup(); }
  });
});

test("up binds persistently, reuses one resident, defers isolated roles and leaves task files alone", () => {
  const f = fixture();
  try {
    const project = loadProject(f.root);
    const initial = desktopUp(project, f.client, { space: "space-one" });
    expect(initial.roles.map(role => [role.role, role.action])).toEqual([["developer", "deferred"], ["lead", "started"]]);
    const saved = initial.binding;
    expect(showDesktopBinding(f.client, "space-one")).toEqual(saved);
    expect(projectDesktopBinding(project, f.client)).toEqual(saved);
    expect(existsSync(join(f.root, ".herdr/desktop.json"))).toBe(false);
    expect(f.terminals[0]!.argv).toContain("--no-daemon");
    const trust = f.terminals[0]!.argv.find(arg => arg.startsWith("projects="))!;
    expect(Bun.TOML.parse(trust)).toEqual({ projects: { [saved.root]: { trust_level: "trusted" } } });
    expect(f.terminals[0]!.labels["team.project"]).toBe(saved.root);
    expect(f.terminals[0]!.labels["herdr.space"]).toBe("space-one");
    expect(f.calls.find(call => call.method === "terminal.run")!.params.no_parent).toBe(true);
    expect(f.calls.find(call => call.method === "terminal.run")!.params.env.PATH).toBe(process.env["PATH"]);
    expect(desktopUp(project, f.client).roles.find(role => role.role === "lead")!.action).toBe("reused");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(1);
    expect(loadProject(f.root).tasks).toEqual([]);
    expect(() => unbindDesktop(project, f.client)).toThrow("still live");
    f.terminals[0]!.argv = ["/bin/zsh"];
    expect(desktopUp(project, f.client).roles.find(role => role.role === "lead")!.action).toBe("failed");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(1);
    f.terminals[0]!.state = "finished";
    unbindDesktop(project, f.client);
    expect(showDesktopBinding(f.client, "space-one")).toBeNull();
  } finally { f.cleanup(); }
});

test("different Cores bind clones independently even with a copied Desktop binding file", () => {
  const f = fixture(), other = fixture();
  try {
    other.space.id = "space-two";
    const first = bindDesktop(f, f.client, f.space.id);
    const legacy = join(other.root, ".herdr/desktop.json");
    const original = JSON.stringify(first);
    writeFileSync(legacy, original);

    expect(projectDesktopBinding(other, other.client)).toBeNull();
    const second = bindDesktop(other, other.client, other.space.id);
    expect(projectDesktopBinding(other, other.client)).toEqual(second);
    expect(projectDesktopBinding(f, f.client)).toEqual(first);
    expect(second.root).not.toBe(first.root);
    expect(second.space).not.toBe(first.space);
    unbindDesktop(other, other.client);
    expect(projectDesktopBinding(other, other.client)).toBeNull();
    expect(projectDesktopBinding(f, f.client)).toEqual(first);
    expect(readFileSync(legacy, "utf8")).toBe(original);
  } finally { f.cleanup(); other.cleanup(); }
});

test("Desktop up binds an initialized project with no roles and launches no agents", () => {
  const runtime = fixture(), project = makeProject("without-roles");
  try {
    const result = desktopUp(loadProject(project.root), runtime.client, { space: runtime.space.id });
    expect(result.binding.space).toBe(runtime.space.id);
    expect(result.roles).toEqual([]);
    expect(runtime.calls.some(call => call.method === "terminal.run")).toBe(false);
  } finally { runtime.cleanup(); project.cleanup(); }
});

test("Desktop up leaves Codex's default trust checks when a role starts outside the bound project", () => {
  const f = fixture(), other = makeProject("outside");
  try {
    symlinkSync(other.root, join(f.root, "outside"));
    writeRole(f.root, "lead", { kind: "codex", cwd: "outside" });
    desktopUp(loadProject(f.root), f.client, { space: "space-one" });
    expect(f.terminals[0]!.argv).toContain("--no-daemon");
    expect(f.terminals[0]!.argv.some(arg => arg.startsWith("projects="))).toBe(false);
  } finally { f.cleanup(); other.cleanup(); }
});

test("another project cannot take over a bound space and absent spaces are never guessed", () => {
  const f = fixture(), other = makeProject("other");
  try {
    bindDesktop({ root: f.root }, f.client, "space-one");
    expect(() => bindDesktop({ root: other.root }, f.client, "space-one")).toThrow("already bound");
    expect(() => bindDesktop({ root: other.root }, f.client, "display-name")).toThrow("No local Desktop space");
    expect(f.calls.filter(call => call.method === "terminal.run")).toHaveLength(0);
  } finally { f.cleanup(); other.cleanup(); }
});

test("an explicit Core-only binding uses the verified terminal's Space without a window", () => {
  const f = fixture();
  const caller: DesktopTerminal = { address: "caller", state: "live", argv: ["sh"], cwd: f.root, labels: { "herdr.space": "space-one" } };
  f.client.spaces = () => { throw new Error("No window on this host"); };
  try {
    expect(() => bindDesktop(f, f.client, "other-space", caller)).toThrow("intended Space");
    expect(() => bindDesktop(f, f.client, undefined, { ...caller, address: "other/caller" })).toThrow("intended Space");
    expect(() => bindDesktop(f, f.client, undefined, { ...caller, labels: {} })).toThrow("No space binding");
    const binding = bindDesktop(f, f.client, undefined, caller);
    expect(registeredDesktopBinding(f.client, "space-one")).toEqual(binding);
    expect(registeredDesktopBinding(f.client, "other-space")).toBeNull();
    expect(f.calls.filter(call => call.method === "doc.set")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("concurrent binding conflict stops before any resident launch", () => {
  const f = fixture();
  try {
    const rpc = f.client.rpc;
    f.client.rpc = (method, params) => { if (method === "doc.set") throw new Error("conflict"); return rpc(method, params); };
    expect(() => desktopUp(loadProject(f.root), f.client, { space: "space-one" })).toThrow("conflict");
    expect(f.terminals).toEqual([]);
  } finally { f.cleanup(); }
});

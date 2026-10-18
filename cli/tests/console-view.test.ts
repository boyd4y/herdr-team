import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { CliRenderEvents, getTimelineEngine, type SelectRenderable, type TextRenderable } from "@opentui/core";
import { deliveryState, newDelivery } from "../scripts/lib/dispatch/delivery.ts";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import type { Project, RoleCard, TaskCard } from "../scripts/lib/shared/types.ts";
import { buildModel, formatStatusLine, fuzzyScore, filterTasks, renderOnce, resolveSelection, taskFlow, type ConsoleState, type TaskFlow } from "../scripts/lib/ui/console-model.ts";
import { sampleConsole } from "../scripts/lib/ui/console-sample.ts";
import { createFlowView } from "../scripts/lib/ui/console-flow.ts";
import { mountConsole } from "../scripts/lib/ui/console-view.ts";
import { fakeHerdr, type FakeHerdr } from "./helpers.ts";

function role(name: string, worktree = false): RoleCard {
  // meta 要带上 kind —— 校验是按 meta 里有没有这个键判的，空 meta 会一直报
  // 「缺少必填字段 kind」，把每个测试的横幅区都塞满。
  return { dir: `roles/${name}`, name, meta: { kind: "codex" }, kind: "codex", worktree, body: "" };
}

function task(
  id: string,
  slug: string,
  title: string,
  priority: string,
  status: string,
  owner: string,
  body = "任务描述",
): TaskCard {
  return {
    dir: `tasks/${id}-${slug}`,
    id,
    slug,
    // meta 要写全：校验是按 meta 里有没有这个键判「缺字段」的，
    // 给个空对象会让每张卡报四条「缺少必填字段」，横幅区全被塞满。
    meta: { title, priority, status, role: owner, handoff: [], depends_on: [], repo: "." },
    title,
    priority,
    status,
    role: owner,
    handoff: [],
    dependsOn: [],
    repo: ".",
    body,
  };
}

function deliveryTask(id: string, state?: string): TaskCard {
  const card = task(id, "flow", `Title ${id}`, "P1", "todo", "dev");
  if (state !== undefined) {
    card.meta["delivery"] = state === "invalid" ? "malformed" : {
      ...newDelivery("dev", "dispatch", new Date("2026-10-17T00:00:00Z")),
      id: "4f2abcde-1234-4000-8000-123456789abc", state, reason: "Waiting for capacity",
    };
  }
  return card;
}

const DEV = role("dev", true);
const TEST = role("test");

function projectOf(tasks: TaskCard[], roles: RoleCard[] = [DEV, TEST]): Project {
  return {
    root: "/tmp/myproj",
    herdrDir: "/tmp/myproj/.herdr",
    hasIdentity: true,
    roles,
    tasks,
    retiredIds: [],
    problems: [],
  };
}

const freshState = (over: Partial<ConsoleState> = {}): ConsoleState => ({
  showAll: false,
  query: "",
  selectedId: null,
  selectedIndex: 0,
  loadError: null,
  ...over,
});

const DOING = task("0015", "add-tui", "加只读看板", "P1", "doing", "dev");
const TODO = task("0016", "watch-tests", "补 watch 的测试", "P2", "todo", "test");
const DONE = task("0012", "split-up", "拆分 up 与 dispatch", "P2", "done", "test");

describe("fuzzy search", () => {
  test("子序列不要求连续，但不能乱序或复用码点", () => {
    expect(fuzzyScore("watch tests", "wtt")).not.toBeNull();
    expect(fuzzyScore("watch tests", "tw")).toBeNull();
    expect(fuzzyScore("console", "ww")).toBeNull();
    expect(fuzzyScore("", "w")).toBeNull();
  });

  test("ASCII 大小写不敏感，中文和非 BMP 字符按码点逐个匹配", () => {
    expect(fuzzyScore("WATCH Tests", "WtT")).toBe(fuzzyScore("watch tests", "wtt"));
    expect(fuzzyScore("加只读看板", "加读")).not.toBeNull();
    expect(fuzzyScore("加只读看板", "读加")).toBeNull();
    expect(fuzzyScore("𠮷野家的看板", "𠮷板")).not.toBeNull();
    expect(fuzzyScore("𠮷", "\ud842")).toBeNull(); // 不能拿半个代理对当命中
  });

  test("matches rank by score, ties and unfiltered tasks use newest ID regardless of priority", () => {
    const cards = [
      task("0003", "a", "ab", "P2", "todo", "dev"),
      task("0004", "b", "a___b", "P0", "todo", "dev"),
      task("0002", "c", "ab", "P1", "todo", "dev"),
      task("0001", "d", "ab", "P1", "todo", "dev"),
    ];
    expect(filterTasks(cards, "ab").map((t) => t.id)).toEqual(["0003", "0002", "0001", "0004"]);
    expect(filterTasks(cards, "").map((t) => t.id)).toEqual(["0004", "0003", "0002", "0001"]);
    expect(cards.map((t) => t.id)).toEqual(["0003", "0004", "0002", "0001"]);
  });

  test("只搜索 id、标题、role，字段不能拼在一起命中", () => {
    expect(filterTasks([DOING, TODO], "015")).toEqual([DOING]);
    expect(filterTasks([DOING, TODO], "加读")).toEqual([DOING]);
    expect(filterTasks([DOING, TODO], "TeSt")).toEqual([TODO]);
    expect(filterTasks([TODO], "任务描述")).toEqual([]);
    expect(filterTasks([DOING], "5加")).toEqual([]);
  });
});

describe("resolveSelection", () => {
  test("按 id 黏住：列表重排后光标还在同一张卡上", () => {
    const reordered = [TODO, DOING, DONE];
    expect(resolveSelection({ id: "0015", index: 0 }, reordered)).toBe(1);
  });

  test("id 不在了回落到下标，而不是跳回顶部", () => {
    expect(resolveSelection({ id: "9999", index: 2 }, [DOING, TODO, DONE])).toBe(2);
  });
});

// ---------------------------------------------------------------- 模型

describe("buildModel", () => {
  test("搜索沿用 showAll 范围，保持全局计数和健康检查，空结果取消选中", () => {
    const project = projectOf([DOING, TODO, DONE]);
    const build = (over: Partial<ConsoleState>) =>
      buildModel(project, fakeHerdr(), freshState(over), "");
    const filtered = build({ query: "test", selectedId: DOING.id, selectedIndex: 0 });
    expect(filtered.tasks).toEqual([TODO]);
    expect(filtered.selectedIndex).toBe(0);
    expect(filtered.candidateCount).toBe(2);
    expect(filtered.roles).toHaveLength(2);
    expect(filtered.inconsistencies.map((i) => i.id)).toContain(DOING.id);
    const all = build({ query: "test", showAll: true });
    expect(all.tasks.map((t) => t.id)).toEqual([TODO.id, DONE.id]);
    expect(all.candidateCount).toBe(3);
    expect(build({ query: "查无此卡" }).selectedIndex).toBe(-1);
  });

  /**
   * `findInconsistencies` 完全从 agent 列表推导。`agent list` 一失败就会返回空
   * 列表，照算的话**每张 doing 卡**都会被伪造成「没有存活 agent」—— 一次性
   * `status` 里这只是小噪音，2 秒轮询就是满屏假警报。
   */
  test("herdr 挂了：不伪造不一致，而是标记连不上", () => {
    const dead = fakeHerdr();
    dead.agentList = () => {
      throw new Error("herdr 没了");
    };
    const m = buildModel(projectOf([DOING]), dead, freshState(), "00:00:00");

    expect(m.herdrOk).toBe(false);
    expect(m.inconsistencies).toEqual([]);
  });

  test("herdr 活着但没有 agent 时，照常报 agent-missing", () => {
    // 和上一条对照：证明上面那个闸门确实在做事情，而不是把报告全关了。
    const m = buildModel(projectOf([DOING]), fakeHerdr(), freshState(), "00:00:00");

    expect(m.herdrOk).toBe(true);
    expect(m.inconsistencies.map((i) => i.kind)).toContain("agent-missing");
  });
});

describe("formatStatusLine", () => {
  /** 常驻角色（非隔离）—— agent 名就是角色名，造 fixture 简单。 */
  const RESIDENT = [role("dev"), role("test")];

  const line = (tasks: TaskCard[], herdr: FakeHerdr = fakeHerdr(), roles = RESIDENT): string =>
    formatStatusLine(
      buildModel(projectOf(tasks, roles), herdr, freshState(), ""),
    );

  /** 一个"正在干活"的常驻 agent —— 让 doing 卡不再产出不一致。 */
  const working = (name = "dev"): FakeHerdr => {
    const herdr = fakeHerdr();
    herdr.live(name);
    herdr.state.agents.at(-1)!.tokens = { team_project: projectKey(projectOf([])) };
    const agent = herdr.state.agents.at(-1);
    if (agent !== undefined) agent.agent_status = "working";
    return herdr;
  };

  test("只列非零的状态，顺序固定", () => {
    expect(
      line([
        task("0001", "a", "A", "P2", "todo", "dev"),
        task("0002", "b", "B", "P2", "doing", "dev"),
        task("0003", "c", "C", "P2", "doing", "dev"),
      ], working()),
    ).toBe("team: 2 doing 1 todo");
  });

  /**
   * `blocked` **不在**前半段 —— 它归后面那个「卡住」计数器管。
   * 两处都列会打出 `1 doing 1 blocked · 2 blocked`：同一个词两个意思。
   */
  test("blocked 不计入前半段，只在尾部出现一次", () => {
    expect(
      line([
        task("0001", "a", "A", "P2", "todo", "dev"),
        task("0002", "b", "B", "P2", "blocked", "dev"),
      ]),
    ).toBe("team: 1 todo · 1 blocked");
  });

  test("agent 掉了算卡住", () => {
    // 没有 agent（fakeHerdr 空的）→ agent-missing
    expect(line([task("0001", "a", "A", "P2", "doing", "dev")])).toBe(
      "team: 1 doing · 1 blocked",
    );
  });

  test("agent 在跑就不算卡住", () => {
    expect(line([task("0001", "a", "A", "P2", "doing", "dev")], working())).toBe(
      "team: 1 doing",
    );
  });

  test("干完了没交棒也算卡住", () => {
    // live() 默认 idle
    const idle = fakeHerdr();
    idle.live("dev");
    idle.state.agents.at(-1)!.tokens = { team_project: projectKey(projectOf([])) };
    expect(line([task("0001", "a", "A", "P2", "doing", "dev")], idle)).toBe(
      "team: 1 doing · 1 blocked",
    );
  });

  test("校验问题要露出来 —— 坏卡会被静默跳过，不报就只剩数字变小", () => {
    const broken = task("0009", "bad", "坏卡", "P2", "todo", "dev");
    delete broken.meta["title"]; // 只缺一个字段，正好一条问题
    expect(line([task("0001", "a", "A", "P2", "todo", "dev"), broken])).toBe(
      "team: 2 todo · 1 ✗",
    );
  });

  test("同一张卡只会被数一次（卡片状态和 agent 两侧都指向它）", () => {
    // 防御性的：今天 findInconsistencies 对一张 doing 卡最多产出一条，
    // 但按 id 去重的写法不该依赖这个巧合。
    const blocked = task("0001", "a", "A", "P2", "blocked", "dev");
    expect(line([blocked, task("0002", "b", "B", "P2", "todo", "dev")])).toBe(
      "team: 1 todo · 1 blocked",
    );
  });

  test("herdr 连不上时明说，而不是假装一切正常", () => {
    const dead = fakeHerdr();
    dead.agentList = () => {
      throw new Error("broke");
    };
    expect(line([task("0001", "a", "A", "P2", "todo", "dev")], dead)).toBe(
      "team: 1 todo · herdr ✗",
    );
  });

  test("queued deliveries appear between task counts and attention, without counting other flows", () => {
    const queued = deliveryTask("0001", "queued");
    const sending = deliveryTask("0002", "sending");
    const submitted = deliveryTask("0003", "submitted");
    const uncertain = deliveryTask("0004", "uncertain");
    expect(line([queued, sending, submitted, uncertain])).toBe("team: 4 todo · 1 queued · 1 blocked");
    expect(line([sending, submitted])).toBe("team: 2 todo");
    const blocked = task("0005", "blocked", "Blocked", "P1", "blocked", "dev");
    const broken = task("0006", "bad", "Bad", "P1", "todo", "dev");
    delete broken.meta["title"];
    expect(line([queued, blocked, broken])).toBe("team: 2 todo · 1 queued · 1 blocked · 1 ✗");
    const finished = { ...queued, status: "done" };
    const cancelled = { ...sending, status: "cancelled" };
    expect(line([finished, cancelled])).toBe("");
  });

  test("全静默时什么都不输出 —— 和 needs-you --line 一个规矩", () => {
    expect(line([])).toBe("");
    expect(
      line([task("0001", "a", "A", "P2", "done", "dev")]), // 终态不进单行
    ).toBe("");
  });
});


describe("OpenTUI Console", () => {
  async function setup(project = projectOf([DOING, TODO, DONE])) {
    const screen = await createTestRenderer({ width: 110, height: 32 });
    let polls = 0;
    const h = fakeHerdr(); h.agentList = () => { polls++; return h.state.agents; };
    const app = mountConsole(screen.renderer, { initial: project, load: () => project, herdr: h,
      intervalMs: 0, showAll: false });
    return { ...screen, app, project, polls: () => polls };
  }

  test("renders task details, native selection, responsive layout and scrolling", async () => {
    const long = task("0099", "long", "Long task", "P0", "todo", "dev",
      Array.from({ length: 100 }, (_, i) => `Body line ${i} 中文𠮷`).join("\n"));
    const ui = await setup(projectOf([long, TODO]));
    try {
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("Team Console");
      expect(ui.captureCharFrame()).toContain("Body line 0");
      ui.mockInput.pressKey("\x1b[6~");
      await ui.renderOnce();
      expect(ui.captureCharFrame()).not.toContain("Body line 0");
      ui.mockInput.pressArrow("down");
      await ui.renderOnce();
      ui.app.refresh(false);
      expect(ui.app.model.tasks[ui.app.model.selectedIndex]?.id).toBe(TODO.id);
      ui.resize(62, 26);
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("DETAIL");
      expect(ui.captureCharFrame()).toContain(TODO.id);
    } finally { await ui.dispose(); }
  });

  test("native search accepts Unicode, keeps command keys as text, and clears empty results", async () => {
    const card = task("0001", "unicode", "中文𠮷qj", "P1", "todo", "dev");
    const ui = await setup(projectOf([card, TODO]));
    try {
      const polls = ui.polls();
      ui.mockInput.pressKey("/");
      await ui.mockInput.pasteBracketedText("中文𠮷qj");
      await ui.renderOnce();
      expect(ui.renderer.isDestroyed).toBe(false);
      expect(ui.app.model.query).toBe("中文𠮷qj");
      expect(ui.app.model.tasks.map((t) => t.id)).toEqual([card.id]);
      expect(ui.polls()).toBe(polls);
      expect(ui.captureCharFrame()).toContain("team: 2 todo");
      ui.mockInput.pressEnter();
      await ui.renderOnce();
      const search = ui.renderer.root.findDescendantById("search")!;
      await ui.mockMouse.click(search.x + 1, search.y);
      ui.mockInput.pressKey("END");
      ui.mockInput.pressKey("q");
      expect(ui.renderer.isDestroyed).toBe(false);
      expect(ui.app.model.query).toBe("中文𠮷qjq");
      await ui.mockInput.typeText("z");
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("No matching tasks");
      expect(ui.app.model.selectedIndex).toBe(-1);
      ui.mockInput.pressEscape();
      await Bun.sleep(50); // Bare ESC waits for the native parser to rule out an escape sequence.
      await ui.waitFor(() => ui.app.model.query === "");
      expect(ui.app.model.query).toBe("");
      expect(ui.app.model.tasks).toHaveLength(2);
      ui.mockInput.pressKey("q");
      await ui.renderer.closed;
      expect(ui.renderer.isDestroyed).toBe(true);
    } finally { await ui.dispose(); }
  });

  test("all toggle and refresh keep selection by task ID", async () => {
    const ui = await setup();
    try {
      ui.mockInput.pressArrow("down");
      ui.mockInput.pressKey("a");
      expect(ui.app.model.showAll).toBe(true);
      expect(ui.app.model.tasks[ui.app.model.selectedIndex]?.id).toBe(DOING.id);
      ui.project.tasks.push(task("0099", "new", "Newer task", "P3", "todo", "dev"));
      ui.app.refresh();
      expect(ui.app.model.selectedIndex).toBe(2);
      expect(ui.app.model.tasks[ui.app.model.selectedIndex]?.id).toBe(DOING.id);
    } finally { await ui.dispose(); }
  });

  test("refresh failure preserves data, reports error, recovers, and stop closes the renderer", async () => {
    const screen = await createTestRenderer({ width: 110, height: 32 });
    let fail = false, stop = false, ticks = 0, tickFail = false;
    let project = projectOf([TODO]);
    const app = mountConsole(screen.renderer, { initial: project, herdr: fakeHerdr(),
      load: () => { if (fail) throw new Error("Could not read project"); return project; },
      tick: () => { ticks++; if (tickFail) throw new Error("Queue paused"); }, shouldQuit: () => stop,
      intervalMs: 0, showAll: false });
    try {
      expect(ticks).toBe(1);
      fail = true; app.refresh();
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Could not read project");
      expect(app.model.tasks).toEqual([TODO]);
      fail = false; app.refresh();
      expect(app.model.loadError).toBeNull();
      tickFail = true; project = projectOf([DOING, TODO]); app.refresh();
      expect(app.model.tasks).toEqual([TODO, DOING]);
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Queue paused");
      tickFail = false; app.refresh();
      expect(app.model.loadError).toBeNull();
      const before = ticks;
      stop = true; app.refresh();
      await screen.renderer.closed;
      app.refresh();
      expect(ticks).toBe(before);
    } finally { await screen.dispose(); }
  });

  test("malformed task records and ambiguous agents stay visible and recover without exiting", async () => {
    const screen = await createTestRenderer({ width: 110, height: 32 });
    const broken = deliveryTask("0099", "invalid");
    const project = projectOf([broken, TODO], [role("dev"), TEST]);
    broken.meta.integration = "corrupt";
    const h = fakeHerdr();
    h.live("dev"); h.live("dev");
    for (const agent of h.state.agents) agent.tokens = { team_project: projectKey(project), team_role: "dev" };
    try {
      const app = mountConsole(screen.renderer, { initial: project, load: () => project, herdr: h,
        intervalMs: 0, showAll: false });
      await screen.renderOnce();
      expect(screen.renderer.isDestroyed).toBe(false);
      expect(screen.captureCharFrame()).toContain("NEEDS YOU");
      expect(renderOnce(project, h, { showAll: false })).toContain("integration: invalid");
      expect(renderOnce(project, h, { showAll: false })).toContain("ambiguous");
      delete broken.meta.integration; delete broken.meta.delivery;
      h.state.agents.pop(); app.refresh();
      expect(app.model.problems).toEqual([]);
      expect(app.model.taskAgents.get(broken.id)?.name).toBe("dev");
    } finally { await screen.dispose(); }
  });

  test("plain output remains read-only, complete and free of terminal controls", () => {
    const project = projectOf([{ ...TODO, body: "Safe body\x1b[31m" }, DONE]);
    const h = fakeHerdr();
    expect(renderOnce(project, h, { showAll: false })).not.toContain(DONE.title);
    const all = renderOnce(project, h, { showAll: true });
    expect(all).toContain(DONE.title);
    expect(all).toContain("TASKS");
    expect(all).not.toContain("\x1b");
    expect(h.calls.some((call) => call.startsWith("agent prompt"))).toBe(false);
  });

  test("flow follows recorded custom roles and serial integration", () => {
    const card = task("0099", "custom", "Custom assignment", "P1", "review", "audit");
    card.handoff = ["publish"];
    card.meta.review = { commit: "a".repeat(40), developer: "builder", reviewer: "audit", reviewers: ["audit"] };
    const project = projectOf([card], [role("builder"), role("audit"), role("publish"), role("unused")]);
    const model = buildModel(project, fakeHerdr(), freshState(), "");
    const flow = taskFlow(card, project, model);
    expect(flow.nodes.map(node => node.role)).toEqual(["builder", "audit", "publish"]);
    expect(flow.current).toBe(1);
    expect(flow.nodes[0]?.state).toBe("done");
    card.status = "blocked";
    expect(taskFlow(card, project, model).nodes[1]?.state).toBe("blocked");
    card.status = "review"; card.handoff = [];
    card.meta.integration = { state: "queued", commit: "a".repeat(40) };
    const merge = taskFlow(card, project, model);
    expect(merge.nodes.at(-1)?.role).toBe("merge");
    expect(merge.nodes.at(-1)?.state).toBe("waiting");
    card.status = "done";
    expect(taskFlow(card, project, model).nodes.every(node => node.state === "done")).toBe(true);
    // Historical role removal must not invent a merge or a pending assignment.
    delete card.meta.integration;
    card.handoff = ["publish"];
    project.roles = [];
    const archived = taskFlow(card, project, model);
    expect(archived.nodes.map(node => node.role)).toEqual(["builder", "audit"]);
    expect(archived.nodes.every(node => node.kind === "role" && node.model === "unconfigured role")).toBe(true);
  });

  test("integration failures expose their reason and remain distinct from a real merge role", async () => {
    const card = task("0099", "merge", "Merge failure", "P1", "review", "merge");
    card.meta.integration = { state: "blocked", commit: "b".repeat(40), reason: "Required CI check failed" };
    const ui = await setup(projectOf([card], [role("merge")]));
    try {
      await ui.renderOnce();
      const flow = taskFlow(card, ui.project, ui.app.model);
      expect(flow.nodes.map(node => node.kind)).toEqual(["role", "integration"]);
      expect(flow.nodes[0]?.model).toContain("codex");
      expect(flow.nodes[1]?.model).toBe("serial integration");
      expect(ui.captureCharFrame()).toContain("Required CI check failed");
      expect(ui.captureCharFrame()).toContain("MERGE QUEUE");
    } finally { await ui.dispose(); }
  });

  test("handoff particles and running pulses use OpenTUI frames without polling; static selection releases animations", async () => {
    const frame = sampleConsole(freshState({ showAll: true }), 5000);
    // Use the sample model's recorded participants with a fake live service for poll accounting.
    const h = fakeHerdr();
    h.state.agents = [...frame.model.taskAgents.values()];
    for (const agent of h.state.agents) agent.tokens = { team_project: projectKey(frame.project) };
    let polls = 0;
    h.agentList = () => { polls++; return h.state.agents; };
    const screen = await createTestRenderer({ width: 130, height: 36 });
    const app = mountConsole(screen.renderer, { initial: frame.project, load: () => frame.project, herdr: h, intervalMs: 0, showAll: true });
    try {
      await screen.renderOnce();
      const signal = screen.renderer.root.findDescendantById("flow-signal-1") as TextRenderable;
      expect(signal).toBeDefined();
      const before = JSON.stringify(signal.chunks);
      const count = polls;
      getTimelineEngine(screen.renderer).update(500);
      await screen.renderOnce();
      expect(JSON.stringify(signal.chunks)).not.toBe(before);
      expect(signal.chunks.length).toBeGreaterThan(1);
      expect(polls).toBe(count);
      screen.mockInput.pressArrow("down"); // Blocked task has no continuously animated elements.
      await screen.renderOnce();
      expect(signal.isDestroyed).toBe(true);
      const after = polls;
      getTimelineEngine(screen.renderer).update(500);
      expect(polls).toBe(after);
      app.dispose();
      const state = app.model;
      app.refresh();
      expect(app.model).toBe(state);
    } finally { await screen.dispose(); }
  });

  test("flow and details share the right side equally while compact role rows fit the full team", async () => {
    const names = ["dev", "dev-blog", "docs", "lead", "research", "review", "test-final"];
    const ui = await setup(projectOf([task("0099", "layout", "Layout", "P1", "todo", "dev")], names.map(name => role(name))));
    try {
      ui.resize(150, 42); await ui.renderOnce();
      const flow = ui.renderer.root.findDescendantById("flow")!;
      const details = ui.renderer.root.findDescendantById("details")!;
      const roles = ui.renderer.root.findDescendantById("roles")!;
      expect(ui.renderer.root.findDescendantById("activity")).toBeUndefined();
      expect(Math.abs(flow.height - details.height)).toBeLessThanOrEqual(1);
      expect(flow.width).toBe(details.width);
      expect(details.y).toBe(flow.y + flow.height);
      for (const name of names) {
        const row = ui.renderer.root.findDescendantById(`role-${name}`)!;
        expect(row.height).toBe(1);
        expect(row.y).toBeGreaterThan(roles.y);
        expect(row.y).toBeLessThan(roles.y + roles.height - 1);
      }
      ui.resize(130, 26); await ui.renderOnce();
      expect(Math.abs(flow.height - details.height)).toBeLessThanOrEqual(1);
      expect(ui.captureCharFrame()).toContain("test-final");
      ui.resize(62, 26); await ui.renderOnce();
      expect(roles.visible).toBe(true);
      expect(Math.abs(flow.height - details.height)).toBeLessThanOrEqual(1);
      ui.mockInput.pressKey("\t");
      expect(roles.focused).toBe(true);
      ui.mockInput.pressKey("\x1b[6~"); await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("test-final");
      ui.resize(34, 12); await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("Resize the terminal");
      expect(ui.captureCharFrame()).toContain("q quit");
      ui.resize(62, 26); await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("DETAIL");
      expect(ui.app.model.tasks[ui.app.model.selectedIndex]?.id).toBe("0099");
      ui.resize(34, 12); ui.mockInput.pressKey("q"); await ui.renderer.closed;
    } finally { await ui.dispose(); }
  });

  test("role rows survive assignment changes and reordering, and removed roles release their widgets", async () => {
    const ui = await setup(projectOf([task("0099", "roles", "Assignment", "P1", "todo", "dev")]));
    try {
      await ui.renderOnce();
      const roles = ui.renderer.root.findDescendantById("roles")!;
      const dev = ui.renderer.root.findDescendantById("role-dev")!;
      const tester = ui.renderer.root.findDescendantById("role-test")!;
      ui.project.tasks[0]!.status = "doing";
      ui.project.tasks[0]!.meta.status = "doing";
      ui.project.roles.reverse();
      ui.app.refresh(); await ui.renderOnce();
      expect(ui.renderer.root.findDescendantById("role-dev")).toBe(dev);
      expect(ui.renderer.root.findDescendantById("role-test")).toBe(tester);
      expect(roles.getChildren().map(row => row.id)).toEqual(["roles-heading", "role-test", "role-dev"]);
      expect(dev.getChildren().map(cell => (cell as TextRenderable).plainText).join(" ")).toContain("#0099");
      ui.project.roles = ui.project.roles.filter(role => role.name !== "test");
      ui.app.refresh(); await ui.renderOnce();
      expect(tester.isDestroyed).toBe(true);
      expect(roles.getChildren().map(row => row.id)).toEqual(["roles-heading", "role-dev"]);
      expect(ui.renderer.root.findDescendantById("role-dev")).toBe(dev);
    } finally { await ui.dispose(); }
  });

  test("long flow reveals its active node after native layout and remains manually scrollable", async () => {
    const screen = await createTestRenderer({ width: 62, height: 20 });
    const flow = createFlowView(screen.renderer);
    screen.renderer.root.add(flow.view);
    try {
      flow.update("long", { current: 7, nodes: Array.from({ length: 8 }, (_, i) => ({
        kind: "role", role: `stage-${i}`, label: i === 7 ? "Running" : "Done", state: i === 7 ? "running" : "done", model: "codex · default",
      })) });
      await screen.waitForFrame(frame => frame.includes("STAGE-7"));
      expect(flow.view.scrollLeft).toBeGreaterThan(0);
      flow.view.scrollTo({ x: 0, y: 0 }); await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("STAGE-0");
      flow.view.scrollTo({ x: 9999, y: 0 }); await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("STAGE-7");
    } finally { flow.dispose(); await screen.dispose(); }
  });

  test("repeat visits and the merge queue animate the recorded transition without mistaking a role name", async () => {
    const screen = await createTestRenderer({ width: 140, height: 24 });
    const flow = createFlowView(screen.renderer); screen.renderer.root.add(flow.view);
    const path = (roles: string[], current: number): TaskFlow => ({ current, nodes: roles.map((role, index) => ({
      kind: "role", role, label: index === current ? "Running" : index < current ? "Done" : "Next",
      state: index === current ? "running" : index < current ? "done" : "waiting", model: "codex · default",
    })) });
    try {
      flow.update("repeat", path(["dev", "test", "doc", "test"], 1)); await screen.renderOnce();
      // A refresh may skip intermediate owners; this is the second test visit, not the first.
      flow.update("repeat", path(["dev", "test", "doc", "test"], 3));
      getTimelineEngine(screen.renderer).update(500);
      await screen.renderOnce();
      const forward = screen.renderer.root.findDescendantById("flow-signal-3") as TextRenderable;
      expect(forward.chunks.length).toBeGreaterThan(1);
      expect(forward.chunks.map(chunk => chunk.text).join("")).toContain("▶");
      expect((screen.renderer.root.findDescendantById("flow-signal-1") as TextRenderable).chunks.map(chunk => chunk.text).join("")).toContain("▶");
      flow.update("repeat", path(["dev", "test", "doc", "test"], 1));
      await screen.renderOnce();
      expect((screen.renderer.root.findDescendantById("flow-signal-3") as TextRenderable).chunks.map(chunk => chunk.text).join("")).toContain("◀");
      expect((screen.renderer.root.findDescendantById("flow-signal-1") as TextRenderable).chunks.map(chunk => chunk.text).join("")).toContain("▶");
      flow.update("merge", path(["merge"], 0)); await screen.renderOnce();
      const integrated = path(["merge", "merge"], 1);
      integrated.nodes[1]!.kind = "integration";
      flow.update("merge", integrated);
      getTimelineEngine(screen.renderer).update(500); await screen.renderOnce();
      expect((screen.renderer.root.findDescendantById("flow-signal-1") as TextRenderable).chunks.length).toBeGreaterThan(1);
      flow.dispose();
      const count = screen.renderer.listenerCount(CliRenderEvents.FRAME);
      flow.update("after-dispose", path(["dev", "test"], 1));
      screen.resize(120, 26); await screen.renderOnce();
      expect(screen.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(count);
    } finally { flow.dispose(); await screen.dispose(); }
  });

  test("hidden flow stops live animation, resumes on resize and cannot restart after disposal", async () => {
    const screen = await createTestRenderer({ width: 120, height: 36 });
    const app = mountConsole(screen.renderer, { sample: true, intervalMs: 0, showAll: true });
    try {
      await screen.renderOnce();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(true);
      screen.renderer.emit(CliRenderEvents.BLUR); await screen.flush();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      screen.resize(130, 38); app.refresh(); await screen.flush();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      screen.renderer.emit(CliRenderEvents.FOCUS); await screen.renderOnce();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(true);
      screen.resize(34, 12); await screen.flush();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      screen.resize(120, 36); await screen.renderOnce();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(true);
      app.dispose(); await screen.flush();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      const before = app.model;
      screen.mockInput.pressArrow("down"); screen.resize(130, 38); await screen.flush();
      expect(app.model).toBe(before);
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
    } finally { await screen.dispose(); }
  });

  test("unchanged polls reuse task options and body; steady running and delivery animations finish", async () => {
    const screen = await createTestRenderer({ width: 120, height: 36 });
    const frame = sampleConsole(freshState({ showAll: true }));
    const h = fakeHerdr();
    h.state.agents = [{ name: "dev-0083", agent_status: "working", tokens: { team_project: projectKey(frame.project) } }];
    const app = mountConsole(screen.renderer, { initial: frame.project, load: () => frame.project, herdr: h,
      intervalMs: 0, showAll: true });
    try {
      await screen.renderOnce();
      const tasks = screen.renderer.root.findDescendantById("tasks") as SelectRenderable;
      const body = screen.renderer.root.findDescendantById("detail-body") as TextRenderable;
      const options = tasks.options, content = body.content;
      expect(screen.renderer.getSchedulerState().isRunning).toBe(true);
      getTimelineEngine(screen.renderer).update(3000); await screen.flush();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      app.refresh(); await screen.flush();
      expect(tasks.options).toBe(options);
      expect(body.content).toBe(content);
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      const selected = frame.project.tasks[0]!;
      selected.body = "Updated task body";
      app.refresh(); await screen.renderOnce();
      expect(body.plainText).toContain("Updated task body");
      const delivery = selected.meta.delivery as Record<string, unknown>;
      delivery.state = "submitted";
      selected.meta.review = { commit: "a".repeat(40), developer: "test", reviewer: "dev" };
      app.refresh(); await screen.renderOnce();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(true);
      getTimelineEngine(screen.renderer).update(3000); await screen.flush();
      expect(screen.renderer.getSchedulerState().isRunning).toBe(false);
      selected.title = "Changed title";
      app.refresh(); await screen.renderOnce();
      expect(tasks.options).not.toBe(options);
      expect(tasks.options[0]?.name).toContain("Changed title");
    } finally { app.dispose(); await screen.dispose(); }
  });

  test("empty projects can preview samples without scheduling, then recover the real project even on a failed reload", async () => {
    const screen = await createTestRenderer({ width: 120, height: 36 });
    const project = projectOf([]);
    let ticks = 0, loads = 0, fail = false;
    const app = mountConsole(screen.renderer, { initial: project, load: () => { loads++; if (fail) throw new Error("Reload failed"); return project; },
      herdr: fakeHerdr(), tick: () => { ticks++; }, intervalMs: 0, showAll: false });
    try {
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("No tasks yet");
      const counts = [ticks, loads];
      screen.mockInput.pressKey("s");
      app.refresh();
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("SAMPLE");
      expect(app.model.tasks).toHaveLength(3);
      expect([ticks, loads]).toEqual(counts);
      expect(project.tasks).toEqual([]);
      screen.resize(62, 26); await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("DEV");
      expect(screen.captureCharFrame()).toContain("TEST");
      expect(screen.captureCharFrame()).toContain("DOC");
      expect(screen.captureCharFrame()).toContain("q quit");
      fail = true;
      screen.mockInput.pressKey("s"); await screen.renderOnce();
      expect(screen.captureCharFrame()).not.toContain("SAMPLE");
      expect(app.model.projectName).toBe("myproj");
      expect(app.model.tasks).toEqual([]);
      expect(app.model.loadError).toContain("Reload failed");
    } finally { await screen.dispose(); }
  });

  test("standalone sample cycles through handoff, return, completion and restart entirely in memory", async () => {
    const state = freshState({ showAll: true });
    const frames = [0, 5000, 10000, 15000, 35000, 45000, 50000].map(ms => sampleConsole(state, ms));
    expect(frames.map(frame => frame.model.tasks[0]?.role)).toEqual(["dev", "test", "test", "dev", "doc", "doc", "dev"]);
    expect(deliveryState(frames[1]!.model.tasks[0]!)).toBe("submitted");
    expect(frames[5]!.model.tasks[0]?.status).toBe("done");
    expect(frames.every(frame => frame.model.problems.length === 0)).toBe(true);
    const screen = await createTestRenderer({ width: 120, height: 36 });
    try {
      mountConsole(screen.renderer, { sample: true, intervalMs: 0, showAll: false, tick: () => { throw new Error("Sample must never schedule"); } });
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("SAMPLE");
      const active = screen.renderer.root.findDescendantById("flow-node-0")!;
      getTimelineEngine(screen.renderer).update(1200);
      expect(active.opacity).toBe(1); // Breathing the border must not dim task text.
      screen.mockInput.pressKey("q"); await screen.renderer.closed;
      expect(screen.renderer.isDestroyed).toBe(true);
    } finally { await screen.dispose(); }
  });
});

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { newDelivery } from "../scripts/lib/dispatch/delivery.ts";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import type { Project, RoleCard, TaskCard } from "../scripts/lib/shared/types.ts";
import { buildModel, formatStatusLine, fuzzyScore, filterTasks, renderOnce, resolveSelection, type ConsoleState } from "../scripts/lib/ui/console-model.ts";
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
  searching: false,
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

  test("按分数排序，同分再按 priority、id，空查询恢复原顺序且不修改输入", () => {
    const cards = [
      task("0003", "a", "ab", "P2", "todo", "dev"),
      task("0004", "b", "a___b", "P0", "todo", "dev"),
      task("0002", "c", "ab", "P1", "todo", "dev"),
      task("0001", "d", "ab", "P1", "todo", "dev"),
    ];
    expect(filterTasks(cards, "ab").map((t) => t.id)).toEqual(["0001", "0002", "0003", "0004"]);
    expect(filterTasks(cards, "").map((t) => t.id)).toEqual(["0004", "0001", "0002", "0003"]);
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
      buildModel(project, fakeHerdr(), freshState(over), "", 2);
    const filtered = build({ query: "test", selectedId: DOING.id, selectedIndex: 0 });
    expect(filtered.tasks).toEqual([TODO]);
    expect(filtered.selectedIndex).toBe(0);
    expect(filtered.candidateCount).toBe(2);
    expect(filtered.openCount).toBe(2);
    expect(filtered.totalCount).toBe(3);
    expect(filtered.roles).toHaveLength(2);
    expect(filtered.inconsistencies.map((i) => i.id)).toContain(DOING.id);
    const all = build({ query: "test", showAll: true });
    expect(all.tasks.map((t) => t.id)).toEqual([DONE.id, TODO.id]);
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
    const m = buildModel(projectOf([DOING]), dead, freshState(), "00:00:00", 2);

    expect(m.herdrOk).toBe(false);
    expect(m.inconsistencies).toEqual([]);
  });

  test("herdr 活着但没有 agent 时，照常报 agent-missing", () => {
    // 和上一条对照：证明上面那个闸门确实在做事情，而不是把报告全关了。
    const m = buildModel(projectOf([DOING]), fakeHerdr(), freshState(), "00:00:00", 2);

    expect(m.herdrOk).toBe(true);
    expect(m.inconsistencies.map((i) => i.kind)).toContain("agent-missing");
  });
});

describe("formatStatusLine", () => {
  /** 常驻角色（非隔离）—— agent 名就是角色名，造 fixture 简单。 */
  const RESIDENT = [role("dev"), role("test")];

  const line = (tasks: TaskCard[], herdr: FakeHerdr = fakeHerdr(), roles = RESIDENT): string =>
    formatStatusLine(
      buildModel(projectOf(tasks, roles), herdr, freshState(), "", 0),
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
    const app = mountConsole(screen.renderer, { initial: project, load: () => project, herdr: fakeHerdr(),
      intervalMs: 0, intervalSeconds: 2, showAll: false });
    return { ...screen, app, project };
  }

  test("renders task details, native selection, responsive layout and scrolling", async () => {
    const long = task("0001", "long", "Long task", "P0", "todo", "dev",
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
      ui.mockInput.pressKey("/");
      await ui.mockInput.pasteBracketedText("中文𠮷qj");
      await ui.renderOnce();
      expect(ui.renderer.isDestroyed).toBe(false);
      expect(ui.app.model.query).toBe("中文𠮷qj");
      expect(ui.app.model.tasks.map((t) => t.id)).toEqual([card.id]);
      await ui.mockInput.typeText("z");
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("No matching tasks");
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
      expect(ui.app.model.tasks[ui.app.model.selectedIndex]?.id).toBe(TODO.id);
      TODO.priority = "P0";
      ui.app.refresh();
      expect(ui.app.model.selectedIndex).toBe(0);
      expect(ui.app.model.tasks[0]?.id).toBe(TODO.id);
    } finally { TODO.priority = "P2"; await ui.dispose(); }
  });

  test("refresh failure preserves data, reports error, recovers, and stop closes the renderer", async () => {
    const screen = await createTestRenderer({ width: 110, height: 32 });
    let fail = false, stop = false, ticks = 0;
    const project = projectOf([TODO]);
    const app = mountConsole(screen.renderer, { initial: project, herdr: fakeHerdr(),
      load: () => { if (fail) throw new Error("Could not read project"); return project; },
      tick: () => { ticks++; }, shouldQuit: () => stop,
      intervalMs: 0, intervalSeconds: 2, showAll: false });
    try {
      expect(ticks).toBe(1);
      fail = true; app.refresh();
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Could not read project");
      expect(app.model.tasks).toEqual([TODO]);
      fail = false; app.refresh();
      expect(app.model.loadError).toBeNull();
      const before = ticks;
      stop = true; app.refresh();
      await screen.renderer.closed;
      app.refresh();
      expect(ticks).toBe(before);
    } finally { await screen.dispose(); }
  });

  test("plain output remains read-only, complete and free of terminal controls", () => {
    const project = projectOf([{ ...TODO, body: "Safe body\x1b[31m" }, DONE]);
    const h = fakeHerdr();
    expect(renderOnce(project, h, { showAll: false, intervalSeconds: 2 })).not.toContain(DONE.title);
    const all = renderOnce(project, h, { showAll: true, intervalSeconds: 2 });
    expect(all).toContain(DONE.title);
    expect(all).toContain("TASKS");
    expect(all).not.toContain("\x1b");
    expect(h.calls.some((call) => call.startsWith("agent prompt"))).toBe(false);
  });
});

import { newDelivery } from "../scripts/lib/delivery.ts";
import { projectKey } from "../scripts/lib/team-scope.ts";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { displayWidth } from "../scripts/lib/text.ts";
import type { Project, RoleCard, TaskCard } from "../scripts/lib/types.ts";
import { buildModel, computeLayout, flushCarry, formatStatusLine, fuzzyScore, filterTasks, parseKeys, realTerminal, resolveSize, renderFrame, resolveSelection, runWatch, type Key, type Terminal, type WatchDeps, type WatchState } from "../scripts/lib/watch.ts";
import { fakeHerdr, makeProject, taskMeta, twoRoles, writeTask, type FakeHerdr } from "./helpers.ts";

/** 把着色剥掉 —— 宽度不变量要在「终端实际占几列」上验，不能把 ANSI 码算进去。 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

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

const freshState = (over: Partial<WatchState> = {}): WatchState => ({
  showAll: false,
  query: "",
  searching: false,
  selectedId: null,
  selectedIndex: 0,
  detailScroll: 0,
  loadError: null,
  ...over,
});

const DOING = task("0015", "add-tui", "加只读看板", "P1", "doing", "dev");
const TODO = task("0016", "watch-tests", "补 watch 的测试", "P2", "todo", "test");
const DONE = task("0012", "split-up", "拆分 up 与 dispatch", "P2", "done", "test");

// ---------------------------------------------------------------- 纯解析

describe("parseKeys", () => {
  test("方向键两种编码都认", () => {
    // `\x1bO…` 是 DECCKM 应用光标模式，tmux 会发这种。
    expect(parseKeys("\x1b[A").keys).toEqual([{ kind: "up" }]);
    expect(parseKeys("\x1bOA").keys).toEqual([{ kind: "up" }]);
    expect(parseKeys("\x1b[B").keys).toEqual([{ kind: "down" }]);
    expect(parseKeys("\x1bOB").keys).toEqual([{ kind: "down" }]);
  });

  /**
   * 这条是最要紧的：终端把一个方向键拆到两次 read 是常态，不靠 carry 拼回来
   * 就会把前半截 `\x1b` 当成裸 Esc —— **按一下方向键就把看板关了**。
   */
  test("序列被拆到两次 read：靠 carry 拼回来，不能当成 Esc", () => {
    const first = parseKeys("\x1b");
    expect(first.keys).toEqual([]);
    expect(first.carry).toBe("\x1b");

    const second = parseKeys("[A", first.carry);
    expect(second.keys).toEqual([{ kind: "up" }]);
    expect(second.carry).toBe("");
  });

  test("flushCarry：等超时后，孤立的 ESC 才算 Esc", () => {
    expect(flushCarry("\x1b")).toEqual([{ kind: "escape" }]);
    expect(flushCarry("\x1b[")).toEqual([]);
  });
});

// ---------------------------------------------------------------- 选中

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
    const build = (over: Partial<WatchState>) =>
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

// ---------------------------------------------------------------- 渲染

describe("renderFrame", () => {
  const model = (over: Partial<WatchState> = {}, herdr: FakeHerdr = fakeHerdr()) =>
    buildModel(projectOf([DOING, TODO, DONE]), herdr, freshState(over), "15:04:22", 2);

  test("TASKS 右侧显示查询及命中数，搜索输入占一行预算", () => {
    const kept = model({ query: "加读" });
    const editing = { ...kept, searching: true };
    const opts = { width: 80, height: 30, color: false };
    const frame = renderFrame(editing, opts);
    expect(frame.find((l) => l.includes("TASKS"))).toContain("/加读  (1/2)");
    expect(frame.some((l) => l.includes("/ 加读▏"))).toBe(true);
    expect(computeLayout(editing, opts).minHeight).toBe(computeLayout(kept, opts).minHeight + 1);
    expect(renderFrame(kept, opts).some((l) => l.includes("▏"))).toBe(false);
  });

  test("任务超出可视区时在标题行给上下溢出标记", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      task(`00${10 + i}`, `t${i}`, `第 ${i} 个任务`, "P2", "todo", "dev"),
    );
    const m = buildModel(projectOf(many), fakeHerdr(), freshState(), "00:00:00", 2);

    const top = renderFrame(m, { width: 80, height: 20, color: false });
    const titleRow = top.find((l) => l.includes("TASKS")) ?? "";
    expect(titleRow).toContain("↓5"); // 8 张卡，只放得下 3 行
    expect(titleRow).not.toContain("↑");

    // 选中往下走，窗口跟着滚。
    const scrolled = renderFrame(
      { ...m, selectedIndex: 5 },
      { width: 80, height: 20, color: false },
    );
    const scrolledTitle = scrolled.find((l) => l.includes("TASKS")) ?? "";
    expect(scrolledTitle).toContain("↑3");
    expect(scrolledTitle).toContain("↓2");
  });

  test("herdr 连不上时表头标记，且不冒出假的 ⚠", () => {
    const dead = fakeHerdr();
    dead.agentList = () => {
      throw new Error("broke");
    };
    const frame = renderFrame(model({}, dead), { width: 80, height: 24, color: false });
    expect(frame[0]).toContain("herdr ✗");
    expect(frame.some((l) => l.includes("⚠"))).toBe(true); // 就是「连不上」那一条
    expect(frame.some((l) => l.includes("agent-missing"))).toBe(false);
  });

  test("正文保留段落空行", () => {
    const withBody = task("0001", "body", "带正文", "P2", "todo", "dev", "第一段\n\n第二段");
    const m = buildModel(projectOf([withBody]), fakeHerdr(), freshState(), "00:00:00", 2);
    const frame = renderFrame(m, { width: 80, height: 30, color: false });
    const start = frame.findIndex((l) => l.includes("task.md"));
    expect(frame[start + 1]).toContain("第一段");
    expect((frame[start + 2] ?? "").trim()).toBe("");
    expect(frame[start + 3]).toContain("第二段");
  });

  test("卡片里的转义序列是惰性的", () => {
    const evil = task("0001", "evil", "标题\x1b[31m红", "P2", "todo", "dev", "正文\x1b[2J清屏");
    const m = buildModel(projectOf([evil]), fakeHerdr(), freshState(), "00:00:00", 2);
    const frame = renderFrame(m, { width: 80, height: 30, color: false });
    // 卡片自带的 ESC 必须已经被剥掉 —— 剩下的 \x1b 只可能是渲染自己加的。
    expect(frame.join("\n")).not.toContain("\x1b[31m");
    expect(frame.join("\n")).not.toContain("\x1b[2J");
  });
});

describe("Team Console delivery layout", () => {
  const cards = () => [undefined, "queued", "sending", "submitted", "claimed", "uncertain", "invalid"]
    .map((state, index) => deliveryTask(`000${index + 1}`, state));
  const makeModel = (tasks = cards(), state: Partial<WatchState> = {}) =>
    buildModel(projectOf(tasks), fakeHerdr(), freshState(state), "09:41:12", 2);
  const frame = (m = makeModel(), width = 100, color = false) =>
    renderFrame(m, { width, height: 80, color });

  test("PENDING is a project-wide nonzero legend with compact responsive counts", () => {
    const m = makeModel();
    expect(frame(m).find((line) => line.includes("PENDING"))?.trim()).toBe(
      "PENDING   ◷ 1 waiting   → 2 delivering   ● 1 claimed   ! 2 needs you",
    );
    expect(frame(m, 70).find((line) => line.includes("PENDING"))?.trim()).toBe(
      "PENDING   ◷ 1 waiting  → 2 delivering  ● 1 claimed  ! 2 needs you",
    );
    for (const width of [40, 49, 50, 69]) {
      expect(frame(m, width).find((line) => line.includes("PENDING"))?.trim()).toBe(
        "PENDING   ◷ 1  → 2  ● 1  ! 2",
      );
    }
    const queued = makeModel([deliveryTask("0001", "queued")]);
    expect(frame(queued).find((line) => line.includes("PENDING"))?.trim()).toBe("PENDING   ◷ 1 waiting");
    const filtered = makeModel(cards(), { query: "no match", searching: true });
    expect(filtered.tasks).toHaveLength(0);
    expect(frame(filtered).find((line) => line.includes("PENDING"))).toBe(
      frame(m).find((line) => line.includes("PENDING")),
    );
    const clean = makeModel([deliveryTask("0001")]);
    const without = frame(clean);
    expect(without.join("\n")).not.toContain("PENDING");
    expect(without[2]).toContain("TASKS");
    const withPending = frame(queued);
    expect(withPending[2]).toContain("PENDING");
    expect(withPending[3]?.trim()).toBe("");
    expect(withPending[4]).toContain("TASKS");
    expect(computeLayout(queued, { width: 100, height: 80, color: false }).minHeight).toBe(
      computeLayout(clean, { width: 100, height: 80, color: false }).minHeight + 2,
    );
  });

  test("NEEDS YOU consolidates all four warning categories and disappears when clean", () => {
    const m = makeModel([]);
    m.loadError = "disk error";
    m.herdrOk = false;
    m.inconsistencies = [
      { kind: "delivery-uncertain", id: "0001", message: "0001 needs reconciliation" },
      { kind: "agent-missing", id: "0002", message: "0002 is absent" },
    ];
    m.problems = ["tasks/0003 [rule 3] invalid role", "tasks/0004 [rule 3] invalid role"];
    const lines = frame(m, 180);
    const start = lines.findIndex((line) => line.includes("NEEDS YOU"));
    expect(start).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes("NEEDS YOU"))).toHaveLength(1);
    expect(lines[start]).toContain("Failed to load .herdr/: disk error");
    expect(lines[start + 1]).toContain("Herdr is unavailable");
    expect(lines[start + 2]).toContain("[delivery-uncertain] 0001 needs reconciliation (2 total)");
    expect(lines[start + 3]).toContain("tasks/0003 [rule 3] invalid role (run validate) (2 total)");
    for (const line of lines.slice(start + 1, start + 4)) expect(line.startsWith("             ")).toBe(true);
    const narrow = frame(m, 40);
    const narrowStart = narrow.findIndex((line) => line.includes("NEEDS YOU"));
    expect(narrow[narrowStart + 2]?.trimEnd()).toEndWith("(2 total)");
    expect(narrow[narrowStart + 3]?.trimEnd()).toEndWith("(2 total)");
    expect(frame(makeModel([])).join("\n")).not.toContain("NEEDS YOU");
    expect(frame(makeModel([deliveryTask("0001", "uncertain")]), 180).join("\n")).toContain("(1 total)");
  });

  test("detail shows human flow, short delivery ID, reason, and the selected live agent/pane", () => {
    const herdr = fakeHerdr();
    herdr.live("dev-0001", "w1M:p6");
    herdr.live("dev-0002", "w1M:p7");
    herdr.state.agents.forEach((agent) => {
      agent.tokens = { team_project: projectKey(projectOf([])) };
      agent.agent_status = "working";
    });
    const tasks = [deliveryTask("0001", "submitted"), deliveryTask("0002", "claimed")];
    const m = buildModel(projectOf(tasks), herdr, freshState(), "09:41:12", 2);
    const text = frame(m, 120).join("\n");
    expect(text).toContain("flow → delivering · delivery 4f2abcde… · Waiting for capacity");
    expect(text).toContain("agent dev-0001 · working · w1M:p6");
    expect(text).toContain("priority P1   status todo   role dev   repo .");
    expect(text).toContain("handoff  —        depends_on —");
    expect(text).toContain("branch   feat/0001-flow");
    expect(text).toContain("任务描述");
    const second = frame({ ...m, selectedIndex: 1 }, 120).join("\n");
    expect(second).toContain("flow ● claimed");
    expect(second).toContain("agent dev-0002 · working · w1M:p7");
    expect(frame(makeModel([deliveryTask("0001", "invalid")]), 120).join("\n")).toContain("flow ! invalid");
    expect(frame(makeModel([deliveryTask("0001")]), 120).join("\n")).toContain("flow · none");
    expect(frame({ ...m, herdrOk: false }, 120).join("\n")).toContain("agent dev-0001 · unavailable · w1M:p6");
  });

  test("all responsive tiers fit width and height with pending, warnings, search, and empty lists", () => {
    const full = makeModel(cards(), { searching: true, loadError: "load failure" });
    full.herdrOk = false;
    full.problems = ["validation problem", "another problem"];
    const emptyRoles = { ...full, roles: [] };
    const emptyTasks = makeModel(cards(), { query: "no matches", searching: true });
    const empty = makeModel([]);
    for (const m of [full, emptyRoles, emptyTasks, empty]) {
      for (const width of [39, 40, 49, 50, 69, 70, 99, 100]) {
        for (let height = 5; height <= 40; height++) {
          for (const color of [false, true]) {
            const opts = { width, height, color };
            const lines = renderFrame(m, opts);
            expect(lines.length).toBeLessThanOrEqual(height);
            for (const line of lines) expect(displayWidth(stripAnsi(line))).toBe(width);
            const layout = computeLayout(m, opts);
            if (height === layout.minHeight && width >= 40) expect(layout.tooSmall).toBe(false);
          }
        }
      }
    }
  });

  test("new detail and warning fields sanitize control characters and preserve Unicode", () => {
    const card = deliveryTask("0001", "claimed");
    (card.meta["delivery"] as { reason: string }).reason = "等待\x1b[2J\ncapacity";
    const m = makeModel([card]);
    m.loadError = "读取\x1b[31m\nfailed";
    m.taskAgents.set("0001", { name: "开发\x1b[2J", agent_status: "idle", pane_id: "w1:p1\n" });
    const text = frame(m, 120).join("\n");
    expect(text).toContain("等待[2Jcapacity");
    expect(text).toContain("agent 开发[2J · idle · w1:p1");
    expect(text).not.toContain("\x1b");
  });
});

// ---------------------------------------------------------------- 驱动

type Step = Key | null;

class FakeTerminal implements Terminal {
  readonly log: string[] = [];
  readonly writes: string[] = [];
  sizeValue = { width: 80, height: 24 };
  private readonly script: Step[];

  constructor(script: Step[]) {
    this.script = [...script];
  }

  size(): { width: number; height: number } {
    return this.sizeValue;
  }

  write(text: string): void {
    this.writes.push(text);
  }

  enter(): void {
    this.log.push("enter");
  }

  leave(): void {
    this.log.push("leave");
  }

  setRawMode(on: boolean): void {
    this.log.push(on ? "raw:on" : "raw:off");
  }

  nextEvent(): Promise<Key | null> {
    // 脚本耗尽就收工 —— 顺便保证驱动 bug 不会把测试挂死。
    // 注意用 `undefined` 判而不是 `??`：`null` 在这里是有意义的值（定时器到点），
    // 用 `??` 会把每一个 `null` 步骤都悄悄换成 quit。
    const next = this.script.shift();
    return Promise.resolve(next === undefined ? { kind: "quit" } : next);
  }

  /** 最后一帧的画面（剥掉 ANSI）。 */
  get screen(): string {
    const paints = this.writes.filter((w) => w.startsWith("\x1b[H"));
    return stripAnsi(paints.at(-1) ?? "");
  }
}

async function drive(
  steps: Step[],
  over: Partial<WatchDeps> = {},
): Promise<{ io: FakeTerminal; calls: number }> {
  const io = new FakeTerminal(steps);
  let calls = 0;
  await runWatch({
    io,
    initial: projectOf([DOING, TODO, DONE]),
    load: () => {
      calls += 1;
      return projectOf([DOING, TODO, DONE]);
    },
    herdr: fakeHerdr(),
    intervalMs: 1,
    intervalSeconds: 2,
    showAll: false,
    color: false,
    ...over,
  });
  return { io, calls };
}

describe("runWatch", () => {
  test("一批输入里 / 进入搜索，中文逐键过滤，Enter 保留，再恢复字母命令", async () => {
    const { io } = await drive(parseKeys("/加读\rj").keys);
    const screens = io.writes.filter((s) => s.startsWith("\x1b[H")).map(stripAnsi);
    expect(screens.some((s) => s.includes("/ 加▏"))).toBe(true);
    expect(screens.some((s) => s.includes("/ 加读▏"))).toBe(true);
    expect(io.screen).toContain("/加读  (1/2)");
    expect(io.screen).not.toContain("0016");
    expect(io.screen).not.toContain("▏");
    expect(io.screen).toContain("0015 ·");
  });

  test("输入中的 q/j/k/r/a 和 / 都是文本，不退出或触发命令", async () => {
    const { io, calls } = await drive([...parseKeys("/qjkra/").keys, { kind: "quit" }]);
    expect(io.screen).toContain("/qjkra/  (0/2)");
    expect(io.screen).toContain("no matching tasks");
    expect(calls).toBe(0);
    expect(io.log).toEqual(["raw:on", "enter", "leave", "raw:off"]);
  });

  test("两种 Backspace 都能删完整码点，空串删除无事发生", async () => {
    const { io } = await drive(parseKeys("/加𠮷\x7f只\x08\x08\x08读").keys);
    expect(io.screen).toContain("/读  (1/2)");
    expect(io.screen).toContain("0015 ·");
    expect(io.screen).not.toContain("𠮷");
  });

  test.each([false, true])("Esc 清空过滤并恢复全部（已 Enter：%s），再次 Esc 才退出", async (enter) => {
    const { io } = await drive([
      ...parseKeys(`/加读${enter ? "\r" : ""}`).keys,
      ...flushCarry("\x1b"),
      ...parseKeys("j").keys,
      ...flushCarry("\x1b"),
    ]);
    expect(io.screen).toContain("0016 ·");
    expect(io.screen).toContain("0015");
    expect(io.screen).not.toContain("/加读");
    expect(io.screen).toContain("2 open / 3 total");
  });

  test("输入中 Ctrl-C 始终退出并还原终端", async () => {
    const { io } = await drive(parseKeys("/中文\x03").keys);
    expect(io.screen).toContain("/ 中文▏");
    expect(io.log).toEqual(["raw:on", "enter", "leave", "raw:off"]);
  });

  test("刷新和 a 切换保留过滤，重新进入搜索可继续输入", async () => {
    const { io, calls } = await drive([
      ...parseKeys("/test\ra").keys, null, ...parseKeys("r/s\x7f\r").keys,
    ]);
    expect(calls).toBe(2);
    expect(io.screen).toContain("/test  (2/3)");
    expect(io.screen).toContain("0012");
    expect(io.screen).toContain("0016");
  });

  test("输入外旧快捷键继续有效，包括同一批里的 a/j/k/r/q", async () => {
    const { io, calls } = await drive(parseKeys("ajkrq").keys);
    expect(io.screen).toContain("0012");
    expect(io.screen).toContain("0015 ·");
    expect(calls).toBe(1);
  });

  test("每次重绘擦掉上一帧尾部，空结果不会留下旧任务和详情", async () => {
    const { io } = await drive(parseKeys("/不存在").keys);
    const paints = io.writes.filter((s) => s.startsWith("\x1b[H"));
    expect(paints.every((s) => s.endsWith("\x1b[J"))).toBe(true);
    expect(io.screen).not.toContain("task.md");
  });

  /** 渲染中途炸掉也必须还原终端 —— 否则用户的 shell 就留在 raw mode + 备屏里了。 */
  test("循环里抛错也要还原终端：清理只在 finally 里", async () => {
    const io = new FakeTerminal([{ kind: "quit" }]);
    io.size = () => {
      throw new Error("boom");
    };

    await expect(
      runWatch({
        io,
        initial: projectOf([DOING]),
        load: () => projectOf([DOING]),
        herdr: fakeHerdr(),
        intervalMs: 1,
        intervalSeconds: 2,
        showAll: false,
        color: false,
      }),
    ).rejects.toThrow("boom");

    expect(io.log).toEqual(["raw:on", "enter", "leave", "raw:off"]);
  });

  test("j / k 移动选中，详情跟着换", async () => {
    const { io } = await drive([{ kind: "down" }, { kind: "quit" }]);
    expect(io.screen).toContain("0016 ·");
  });

  test("定时器到点也会重新读取", async () => {
    const { calls } = await drive([null, { kind: "quit" }]);
    expect(calls).toBe(1);
  });

  test("resize 整屏重绘 —— 逐行擦不掉缩小后露出来的旧帧", async () => {
    const { io } = await drive([{ kind: "resize" }, { kind: "quit" }]);
    expect(io.writes).toContain("\x1b[2J");
  });

  test("刷新时读盘失败不崩：保住上一份数据并在横幅里报出来", async () => {
    const io = new FakeTerminal([null, { kind: "quit" }]);
    await runWatch({
      io,
      initial: projectOf([DOING]),
      load: () => {
        throw new Error("磁盘炸了");
      },
      herdr: fakeHerdr(),
      intervalMs: 1,
      intervalSeconds: 2,
      showAll: false,
      color: false,
    });

    expect(io.screen).toContain("Failed to load .herdr/");
    expect(io.screen).toContain("加只读看板"); // 上一份数据还在画
  });

  test("PgUp/PgDn 滚动正文", async () => {
    const long = task("0001", "long", "长正文", "P2", "todo", "dev",
      Array.from({ length: 40 }, (_, i) => `第 ${i} 行`).join("\n"));
    const io = new FakeTerminal([{ kind: "page-down" }, { kind: "quit" }]);
    await runWatch({
      io,
      initial: projectOf([long]),
      load: () => projectOf([long]),
      herdr: fakeHerdr(),
      intervalMs: 1,
      intervalSeconds: 2,
      showAll: false,
      color: false,
    });

    const first = stripAnsi(io.writes.find((w) => w.startsWith("\x1b[H")) ?? "");
    expect(first).toContain("第 0 行");
    expect(io.screen).not.toContain("第 0 行"); // 已经翻过去了
  });
});

/**
 * `--once` 走**真实进程**：这是唯一能端到端验证整条渲染路径、又不需要真终端的
 * 办法（照 `.herdr/identity.md`「文档里写的命令要实际跑通再写进去」）。
 * 用的是 `dispatch.test.ts` 那套：临时项目 + 桩 herdr 可执行文件。
 */
describe("watch --once（真实进程，无需真终端）", () => {
  interface Run {
    (cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string };
  }

  function withCLI(
    run: (
      cli: (...args: string[]) => { code: number; stdout: string; stderr: string },
      from: Run,
    ) => void,
  ): void {
    const { root, cleanup } = makeProject();
    try {
      twoRoles(root);
      writeTask(root, "0001-a", taskMeta({ priority: "P1" }));
      writeTask(root, "0002-b", taskMeta({ status: "done" }));

      const bin = join(root, "bin");
      mkdirSync(bin);
      symlinkSync(join(import.meta.dir, "../scripts/cli.ts"), join(bin, "herdr-team"));
      const executable = join(bin, "herdr");
      writeFileSync(executable, `#!/usr/bin/env bun
const args = process.argv.slice(2);
let result = { agents: [] };
if (args[0] === "pane" && args[1] === "current") {
  result = { pane: { pane_id: "w1:p1", cwd: process.env.HERDR_TEST_CWD ?? null } };
}
process.stdout.write(JSON.stringify({ result }));
`);
      chmodSync(executable, 0o755);

      const spawn = (cwd: string, args: string[]) => {
        const proc = Bun.spawnSync([join(bin, "herdr-team"), ...args], {
          cwd,
          env: {
            ...process.env,
            HERDR_ENV: "1",
            HERDR_BIN_PATH: executable,
            HERDR_TEST_CWD: root,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          code: proc.exitCode,
          stdout: proc.stdout.toString(),
          stderr: proc.stderr.toString(),
        };
      };

      run(
        (...args: string[]) => spawn(root, args),
        (cwd: string, ...args: string[]) => spawn(cwd, args),
      );
    } finally {
      cleanup();
    }
  }

  test("打一帧就退出，而且绝不碰备屏和光标", () => {
    withCLI((cli) => {
      const r = cli("console", "--once");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("TASKS");
      expect(r.stdout).toContain("1 open / 2 total");
      expect(r.stdout).toContain("0001");
      expect(r.stdout).not.toContain("0002"); // 已结束的默认不显示
      expect(r.stdout).not.toContain("Terminal too small");
      // 关键：非交互路径一个终端控制序列都不能发。
      expect(r.stdout).not.toContain("\x1b[?1049");
      expect(r.stdout).not.toContain("\x1b[?25l");
      expect(r.stdout).not.toContain("\x1b[H");
    });
  });

  test("非 TTY 又没给 --once：照样打一帧，并在 stderr 说清楚", () => {
    withCLI((cli) => {
      const r = cli("console");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("TASKS");
      expect(r.stderr).toContain("non-interactive terminal");
    });
  });

  test("--json 明确拒绝，而不是默默忽略", () => {
    withCLI((cli) => {
      const r = cli("console", "--json");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("status --json");
    });
  });

  test("--line 打一行给标签栏，不碰终端", () => {
    withCLI((cli) => {
      const r = cli("console", "--line");
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("team: 1 todo");
      expect(r.stdout).not.toContain("\x1b");
    });
  });

  test("--line 显式给了错的 --root 就照常报错（那是你写错了，该说）", () => {
    withCLI((_cli, from) => {
      const r = from(tmpdir(), "console", "--line", "--root", join(tmpdir(), "definitely-not-a-project"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("No .herdr/");
    });
  });

  /**
   * 标签栏命令跑在 Herdr **服务器进程**里（cwd = 服务器启动目录，实测是 `$HOME`），
   * 不跟焦点 pane 走的话这行永远是空的 —— 所以这条模拟的是「cwd 不在项目里」。
   */
  test("--follow 跟着焦点 pane 找项目", () => {
    withCLI((_cli, from) => {
      const r = from(tmpdir(), "console", "--line", "--follow");
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("team: 1 todo");
    });
  });

  test("--line 和 --once 互斥", () => {
    withCLI((cli) => {
      const r = cli("console", "--line", "--once");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--line");
    });
  });
});

// ---------------------------------------------------------------- 标签栏单行

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

describe("resolveSize", () => {

  /**
   * 回归：pty 没有尺寸时 `columns` 是 **0** 而不是 undefined（`script(1)` 就会这样）。
   * 用 `??` 兜不住 0，整帧宽度归零、画出一屏空白 —— 伪终端冒烟就是这么发现的。
   */
  test("0 和负数都算「拿不到」，不能当成有效宽度", () => {
    expect(resolveSize(0, 0, {})).toEqual({ width: 80, height: 24 });
    expect(resolveSize(-1, -1, {})).toEqual({ width: 80, height: 24 });
  });

  test("退而求其次用 COLUMNS / LINES", () => {
    expect(resolveSize(undefined, undefined, { COLUMNS: "100", LINES: "30" })).toEqual({
      width: 100,
      height: 30,
    });
    // 垃圾值也要忽略，别把画面算崩。
    expect(resolveSize(0, undefined, { COLUMNS: "abc", LINES: "" })).toEqual({
      width: 80,
      height: 24,
    });
  });
});

describe("realTerminal", () => {
  test("UTF-8 每字节拆包仍保留完整中文和非 BMP 码点", async () => {
    const io = realTerminal();
    const original = process.stdout.write;
    try {
      process.stdout.write = (() => true) as typeof original;
      io.enter();
      for (const byte of Buffer.from("/中文𠮷")) process.stdin.emit("data", Buffer.from([byte]));
      for (const text of Array.from("/中文𠮷")) {
        expect(await io.nextEvent(100)).toEqual({ kind: "text", text });
      }
    } finally {
      io.leave();
      process.stdout.write = original;
      io.setRawMode(false);
    }
  });

  /** 备屏序列是 `realTerminal` 写的，不是驱动写的 —— 所以断言落在这一层。 */
  test("进备屏并藏光标，退出时两样都还原", () => {
    const written: string[] = [];
    const spy = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;

    const io = realTerminal();
    const original = process.stdout.write;
    try {
      process.stdout.write = spy;
      io.enter();
      io.leave();
    } finally {
      process.stdout.write = original;
      io.setRawMode(false); // 顺手解开 enter() 里 resume 的 stdin
    }

    const all = written.join("");
    expect(all).toContain("\x1b[?1049h");
    expect(all).toContain("\x1b[?25l");
    expect(all).toContain("\x1b[?25h");
    expect(all).toContain("\x1b[?1049l");
  });
});

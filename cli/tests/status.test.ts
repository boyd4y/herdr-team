import { describe, expect, test } from "bun:test";
import {
  formatReport,
  formatTasks,
  type RoleStatus,
  type StatusReport,
} from "../scripts/lib/status.ts";
import type { RoleCard, TaskCard } from "../scripts/lib/types.ts";
import { displayWidth } from "../scripts/lib/text.ts";

function role(name: string, worktree: boolean): RoleCard {
  return { dir: `roles/${name}`, name, meta: {}, kind: "codex", worktree, body: "" };
}

function task(
  id: string,
  slug: string,
  title: string,
  priority: string,
  status: string,
  owner: string,
): TaskCard {
  return {
    dir: `tasks/${id}-${slug}`,
    id,
    slug,
    meta: {},
    title,
    priority,
    status,
    role: owner,
    handoff: [],
    dependsOn: [],
    repo: ".",
    body: "",
  };
}

const roles = [role("dev", true), role("docs", false)];
const tasks = [
  task("0001", "fix-login", "修登录", "P1", "todo", "dev"),
  task("0002", "add-docs", "Add docs", "P2", "doing", "docs"),
];
const roleStatuses: RoleStatus[] = [
  { role: "dev", agent: "dev-0001", herdrStatus: "working", paneId: "w1:p1", worktree: true },
  { role: "docs", agent: null, herdrStatus: "absent", paneId: null, worktree: false },
];

/**
 * 这些 golden 是**逐字节快照**。
 *
 * 未超宽的单元格保持原样；超宽单元格的截断行为单独断言。
 */
describe("status 文本输出（逐字节快照）", () => {
  test("formatTasks", () => {
    expect(formatTasks(tasks, roles)).toBe(
      [
        "  id    title                         priority  status    role            branch",
        "  0001  修登录                        P1        todo      dev             feat/0001-fix-login",
        "  0002  Add docs                      P2        doing     docs            —",
      ].join("\n"),
    );
  });

  test("formatReport", () => {
    const report: StatusReport = { tasks, roles: roleStatuses, inconsistencies: [] };
    expect(formatReport(report)).toBe(
      [
        "tasks",
        "  id    title                       priority  status    role",
        "  0001  修登录                      P1        todo      dev",
        "  0002  Add docs                    P2        doing     docs",
        "",
        "roles",
        "  role            agent           herdrStatus   paneId",
        "  dev             dev-0001        working       w1:p1",
        "  docs            —               absent        —",
        "",
        "inconsistencies",
        "  （无）",
      ].join("\n"),
    );
  });

  test("formatReport 带不一致", () => {
    const report: StatusReport = {
      tasks,
      roles: roleStatuses,
      inconsistencies: [
        { kind: "maybe-finished", message: "0002 是 doing，但 docs 空闲 —— 可能干完了没交棒" },
      ],
    };
    expect(formatReport(report).split("\n").at(-1)).toBe(
      "  ⚠ [maybe-finished] 0002 是 doing，但 docs 空闲 —— 可能干完了没交棒",
    );
  });

  test("空列表", () => {
    expect(formatTasks([], roles)).toBe("（没有未结束的任务。加 --all 看全部）");
    expect(formatReport({ tasks: [], roles: [], inconsistencies: [] })).toBe(
      [
        "tasks",
        "  （没有未完成的任务）",
        "",
        "roles",
        "  （没有角色）",
        "",
        "inconsistencies",
        "  （无）",
      ].join("\n"),
    );
  });

  // 原先这条测试记录标题顶穿 28 列的 bug；现在钉住截断结果。
  test("超长 CJK 标题截断后不顶穿列宽", () => {
    const long = [task("0003", "long", "一个特别长的中文标题用来量宽度", "P0", "review", "docs")];
    expect(formatReport({ tasks: long, roles: roleStatuses, inconsistencies: [] })).toContain(
      "  0003  一个特别长的中文标题用来量 …P0        review    docs",
    );
  });

  for (const [name, width, format] of [
    ["formatTasks", 30, (items: TaskCard[]) => formatTasks(items, roles)],
    ["formatReport", 28, (items: TaskCard[]) => formatReport({ tasks: items, roles: [], inconsistencies: [] })],
  ] as const) {
    test(`${name} 标题按显示宽度截断，后续列与表头对齐`, () => {
      for (const title of [
        "A".repeat(width),
        "中".repeat(width / 2),
        "A".repeat(width + 1),
        "中".repeat(width / 2 + 1),
        "CLI 中文".repeat(8),
      ]) {
        const output = format([task("0003", "long", title, "P0", "review", "docs")]);
        const lines = output.split("\n");
        const header = lines.find((line) => line.startsWith("  id"))!;
        const row = lines.find((line) => line.startsWith("  0003"))!;
        for (const [heading, value] of [["priority", "P0"], ["status", "review"], ["role", "docs"]] as const) {
          expect(displayWidth(row.slice(0, row.indexOf(value)))).toBe(header.indexOf(heading));
        }
        expect(row.includes("…")).toBe(displayWidth(title) > width);
        if (displayWidth(title) <= width) expect(row).toContain(title);
      }
    });
  }

  test("长角色名和 agent 名不会挤走后续列", () => {
    const owner = "developer-with-a-long-name";
    const items = [task("0003", "long", "Short title", "P0", "review", owner)];
    expect(formatTasks(items, [role(owner, true)]).split("\n")[1]).toBe(
      "  0003  Short title                   P0        review    developer-with-…feat/0003-long",
    );
    expect(formatReport({
      tasks: [],
      roles: [{ role: owner, agent: `${owner}-0003`, herdrStatus: "working", paneId: "w1:p1", worktree: false }],
      inconsistencies: [],
    })).toContain("  developer-with-…developer-with-…working       w1:p1");
  });
});

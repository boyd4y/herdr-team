import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { makeProject, roleMeta, taskMeta, writeRole, writeTask } from "./helpers.ts";

type CLI = (...args: string[]) => { code: number; stdout: string; stderr: string };

function withCLI(run: (cli: CLI, root: string) => void): void {
  const { root, cleanup } = makeProject();
  try {
    writeRole(root, "dev", roleMeta({ env: { body: "metadata value" } }), "角色正文\n\n".repeat(400));
    writeTask(root, "0001-a", taskMeta({ priority: "P1" }), "正文详情标记\n\n任务说明。\n".repeat(400));
    writeTask(root, "0002-b", taskMeta({ status: "done" }), "已完成正文\n".repeat(400));
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(join(import.meta.dir, "../scripts/cli.ts"), join(bin, "herdr-team"));
    const herdr = join(bin, "herdr");
    writeFileSync(herdr, '#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ result: { agents: [] } }));\n');
    chmodSync(herdr, 0o755);
    const cli: CLI = (...args) => {
      const proc = Bun.spawnSync([join(bin, "herdr-team"), ...args], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, COLUMNS: "100", LINES: "40", NO_COLOR: "1" },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    run(cli, root);
  } finally {
    cleanup();
  }
}

function json(cli: CLI, ...args: string[]) {
  const result = cli(...args);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return { value: JSON.parse(result.stdout), stdout: result.stdout };
}

describe("CLI JSON card bodies", () => {
  for (const command of [["tasks", "--all"], ["status", "--all"], ["role", "list"]]) {
    test(`${command.join(" ")} omits only card bodies and reduces output size`, () => {
      withCLI((cli, root) => {
        const project = loadProject(root);
        const before = command[0] === "role" ? project.roles : project.tasks;
        const compact = json(cli, ...command, "--json");
        const compactCards = command[0] === "status" ? compact.value.tasks : compact.value;
        expect(compactCards).toEqual(before.map(({ body, ...rest }) => rest));
        for (const card of compactCards) expect(card).not.toHaveProperty("body");
        const full = command[0] === "status" ? { ...compact.value, tasks: before } : before;
        expect(Buffer.byteLength(compact.stdout)).toBeLessThan(Buffer.byteLength(JSON.stringify(full, null, 2)) / 2);
        if (command[0] === "status") {
          expect(compact.value.roles).toEqual([
            { role: "dev", agent: null, herdrStatus: "absent", paneId: null, worktree: false },
          ]);
          expect(compact.value.inconsistencies).toEqual([]);
        }
        // Serialization does not remove prose from disk or from internal card types.
        expect(loadProject(root).tasks).toEqual(project.tasks);
        expect(loadProject(root).roles).toEqual(project.roles);
      });
    });
  }

  test("JSON task filtering and ordering are preserved", () => {
    withCLI((cli) => {
      expect(json(cli, "tasks", "--json").value.map((t: { id: string }) => t.id)).toEqual(["0001"]);
      expect(json(cli, "status", "--json").value.tasks.map((t: { id: string }) => t.id)).toEqual(["0001"]);
      expect(json(cli, "tasks", "--all", "--role", "dev", "--status", "done", "--json").value.map((t: { id: string }) => t.id)).toEqual(["0002"]);
      expect(json(cli, "tasks", "--role", "missing", "--json").value).toEqual([]);
    });
  });

  test("tasks <id> returns one complete card, including terminal tasks and exact body text", () => {
    withCLI((cli, root) => {
      for (const card of loadProject(root).tasks) {
        expect(json(cli, "tasks", card.id, "--json").value).toEqual(card);
        const human = cli("tasks", card.id);
        expect(human.code).toBe(0);
        expect(human.stderr).toBe("");
        expect(human.stdout).toContain(`id: ${card.id}\n`);
        expect(human.stdout).toContain(`title: ${card.title}\n`);
        expect(human.stdout).toContain(`status: ${card.status}\n`);
        expect(human.stdout).toContain(`role: ${card.role}\n`);
        expect(human.stdout.endsWith(`\n\n${card.body}\n`)).toBe(true);
      }
    });
  });

  test("tasks <id> rejects unknown ids and multiple ids with no partial output", () => {
    withCLI((cli) => {
      for (const flags of [[], ["--json"]]) {
        const missing = cli("tasks", "9999", ...flags);
        expect(missing.code).toBe(2);
        expect(missing.stdout).toBe("");
        expect(missing.stderr).toContain("Task 9999 not found");
        const multiple = cli("tasks", "0001", "0002", ...flags);
        expect(multiple.code).toBe(2);
        expect(multiple.stdout).toBe("");
        expect(multiple.stderr).toContain("accepts at most one task ID");
      }
    });
  });

  test("add / edit keep their body-free receipts; tasks <id> reads their saved bodies", () => {
    withCLI((cli, root) => {
      const compact = json(cli, "add", "Compact task", "--role", "dev", "--body", "调用方正文", "--json").value;
      expect(Object.keys(compact).sort()).toEqual(["dir", "id", "path"]);
      expect(readFileSync(join(compact.path, "task.md"), "utf8")).toBe("调用方正文\n");
      const edited = json(cli, "edit", compact.id, "--body", "修改后的正文", "--json").value;
      expect(edited).toEqual({ dir: compact.dir });
      const detail = json(cli, "tasks", compact.id, "--json").value;
      expect(detail.body).toBe("修改后的正文\n");
      expect(detail.body).toBe(readFileSync(join(root, ".herdr", compact.dir, "task.md"), "utf8"));
      const empty = json(cli, "add", "Empty task", "--role", "dev", "--json").value;
      expect(json(cli, "tasks", empty.id, "--json").value.body).toBe("");
    });
  });

  test("empty role lists still return JSON arrays", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), "role", "list", "--root", root, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("console details, --once and --line keep their behavior", () => {
    withCLI((cli) => {
      expect(cli("console", "--line")).toEqual({ code: 0, stdout: "team: 1 todo\n", stderr: "" });
      const once = cli("console", "--once");
      expect(once.code).toBe(0);
      expect(once.stderr).toBe("");
      expect(once.stdout).toContain("正文详情标记");
      expect(once.stdout).not.toContain("\x1b");
      const watch = cli("console");
      expect(watch.code).toBe(0);
      const withoutClock = (text: string) => text.replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<time>");
      expect(withoutClock(watch.stdout)).toBe(withoutClock(once.stdout));
      expect(watch.stderr).toContain("non-interactive terminal");
    });
  });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/config.ts";
import { createTask, editTask } from "../scripts/lib/task.ts";
import { TASK_BODY, TASK_META } from "../scripts/lib/types.ts";
import { validateProject } from "../scripts/lib/validate.ts";
import { makeProject, taskMeta, twoRoles, writeTask } from "./helpers.ts";

const cliPath = join(import.meta.dir, "../scripts/cli.ts");

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: "utf8" });
}

function withTasks(run: (root: string) => void): void {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    writeTask(root, "0001-first", taskMeta());
    writeTask(root, "0002-second", taskMeta({ depends_on: ["0001"] }));
    writeTask(root, "0003-third", taskMeta({ depends_on: ["0002"] }));
    run(root);
  } finally {
    cleanup();
  }
}

describe("dependsOn 写盘前校验", () => {
  test("createTask 保存依赖、handoff 和带前导零的 id", () => {
    withTasks((root) => {
      createTask(loadProject(root), {
        title: "Implement feature", role: "dev", handoff: ["docs"],
        dependsOn: ["0001", "0002"], priority: "P2", body: "描述",
      });
      const project = loadProject(root);
      const card = project.tasks.find((t) => t.id === "0004")!;
      expect(card.dependsOn).toEqual(["0001", "0002"]);
      expect(card.handoff).toEqual(["docs"]);
      expect(validateProject(project)).toEqual([]);
    });
  });

  for (const dep of ["0099", "1", "0004"]) {
    test(`createTask 拒绝 ${dep}，不留下目录`, () => {
      withTasks((root) => {
        expect(() => createTask(loadProject(root), {
          title: "Implement feature", role: "dev", handoff: [],
          dependsOn: [dep], priority: "P2", body: "描述",
        })).toThrow(dep === "0004" ? /cycle includes 0004/ : new RegExp(`${dep}.*does not resolve to a task`));
        expect(existsSync(join(root, ".herdr/tasks/0004-implement-feature"))).toBe(false);
        expect(loadProject(root).tasks).toHaveLength(3);
      });
    });
  }

  for (const dep of ["0099", "0001", "0003"]) {
    test(`editTask 拒绝 ${dep}，元数据和正文都不写`, () => {
      withTasks((root) => {
        const project = loadProject(root);
        const dir = join(project.herdrDir, "tasks/0001-first");
        const beforeMeta = readFileSync(join(dir, TASK_META), "utf8");
        const beforeBody = readFileSync(join(dir, TASK_BODY), "utf8");
        let message = "";
        try {
          editTask(project, "0001", { dependsOn: [dep], title: "New title", body: "新正文" }, false);
        } catch (error) {
          message = (error as Error).message;
        }
        if (dep === "0099") expect(message).toMatch(/0099.*does not resolve to a task/);
        else {
          expect(message).toContain("cycle");
          for (const id of dep === "0003" ? ["0001", "0002", "0003"] : ["0001"]) {
            expect(message).toContain(`includes ${id}`);
          }
        }
        expect(readFileSync(join(dir, TASK_META), "utf8")).toBe(beforeMeta);
        expect(readFileSync(join(dir, TASK_BODY), "utf8")).toBe(beforeBody);
      });
    });
  }

  test("依赖修改保留 --force 和终态限制", () => {
    withTasks((root) => {
      writeTask(root, "0003-third", taskMeta({ status: "doing" }));
      expect(() => editTask(loadProject(root), "0003", { dependsOn: ["0001"] }, false)).toThrow(/--force/);
      expect(loadProject(root).tasks[2]?.dependsOn).toEqual([]);
      editTask(loadProject(root), "0003", { dependsOn: ["0001"] }, true);
      expect(loadProject(root).tasks[2]?.dependsOn).toEqual(["0001"]);
      writeTask(root, "0003-third", taskMeta({ status: "done" }));
      expect(() => editTask(loadProject(root), "0003", { dependsOn: [] }, true)).toThrow(/terminal/);
    });
  });
});

describe("--depends-on CLI", () => {
  test("add、edit、空串清空；省略依赖或 handoff 时互不干扰", () => {
    withTasks((root) => {
      const run = (...args: string[]) => {
        const result = cli(root, ...args);
        expect(result.status, result.stdout + result.stderr).toBe(0);
      };
      const card = () => loadProject(root).tasks.find((t) => t.id === "0004")!;
      run("add", "Implement feature", "--role", "dev", "--handoff", "docs", "--depends-on", "0001,0002");
      expect(card().dependsOn).toEqual(["0001", "0002"]);
      expect(card().handoff).toEqual(["docs"]);
      const body = readFileSync(join(root, ".herdr", card().dir, TASK_BODY), "utf8");

      run("edit", "0004", "--depends-on", "0003");
      expect(card().dependsOn).toEqual(["0003"]);
      expect(card().handoff).toEqual(["docs"]);
      run("edit", "0004", "--handoff", "");
      expect(card().dependsOn).toEqual(["0003"]);
      expect(card().handoff).toEqual([]);
      run("edit", "0004", "--depends-on", "0001,0002", "--handoff", " docs, dev ");
      expect(card().dependsOn).toEqual(["0001", "0002"]);
      expect(card().handoff).toEqual(["docs", "dev"]);
      run("edit", "0004", "--depends-on", "");
      expect(card().dependsOn).toEqual([]);
      expect(card().handoff).toEqual(["docs", "dev"]);
      run("edit", "0004", "--depends-on= 0002, ,0003, ");
      expect(card().dependsOn).toEqual(["0002", "0003"]);
      expect(readFileSync(join(root, ".herdr", card().dir, TASK_BODY), "utf8")).toBe(body);

      run("add", "Empty dependencies", "--role", "dev", "--depends-on", "");
      expect(loadProject(root).tasks.find((t) => t.id === "0005")?.dependsOn).toEqual([]);
      run("add", "Default dependencies", "--role", "dev");
      expect(loadProject(root).tasks.find((t) => t.id === "0006")?.dependsOn).toEqual([]);
      expect(validateProject(loadProject(root))).toEqual([]);
    });
  });

  test("CLI 对悬空引用、自依赖和多卡环报错且不落盘", () => {
    withTasks((root) => {
      for (const dep of ["0099", "0004"]) {
        const result = cli(root, "add", "Invalid dependency", "--role", "dev", "--depends-on", dep);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(dep);
        expect(readdirSync(join(root, ".herdr/tasks"))).toHaveLength(3);
      }
      const path = join(root, ".herdr/tasks/0001-first", TASK_META);
      const before = readFileSync(path, "utf8");
      for (const dep of ["0099", "0001", "0003"]) {
        const result = cli(root, "edit", "0001", "--depends-on", dep);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(dep);
        if (dep === "0003") {
          for (const id of ["0001", "0002", "0003"]) expect(result.stderr).toContain(`includes ${id}`);
        }
        expect(readFileSync(path, "utf8")).toBe(before);
      }
    });
  });

  test("全局和两个子命令帮助均列出 --depends-on", () => {
    for (const args of [["--help"], ["add", "--help"], ["edit", "--help"]]) {
      const result = cli(import.meta.dir, ...args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--depends-on");
    }
  });
});

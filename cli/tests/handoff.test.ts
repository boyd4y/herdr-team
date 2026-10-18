import { describe, expect, test } from "bun:test";
import { loadProject } from "../scripts/lib/config.ts";
import { handoff } from "../scripts/lib/handoff.ts";
import { type Project } from "../scripts/lib/types.ts";
import { fakeHerdr, makeProject, taskMeta, twoRoles, writeTask } from "./helpers.ts";

function withProject(build: (root: string) => void, run: (p: Project) => void): void {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    build(root);
    run(loadProject(root));
  } finally {
    cleanup();
  }
}

describe("handoff —— 守卫", () => {
  test("终态拒绝", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "done" })), (p) => {
      expect(() => handoff(p, fakeHerdr(), "0001")).toThrow(/terminal/);
    });
  });

  test("cancelled 也拒绝", () => {
    withProject((root) => writeTask(root, "0001-a", taskMeta({ status: "cancelled" })), (p) => {
      expect(() => handoff(p, fakeHerdr(), "0001")).toThrow(/terminal/);
    });
  });

  test("找不到的 id 报错", () => {
    withProject(() => {}, (p) => {
      expect(() => handoff(p, fakeHerdr(), "0099")).toThrow(/not found/);
    });
  });
});

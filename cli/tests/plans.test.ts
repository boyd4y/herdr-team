import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../scripts/lib/team/init.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { makeProject } from "./helpers.ts";
import { PLAN_NAMES, planRoles } from "../scripts/lib/team/plans.ts";

describe("各家的启动参数都带上了各自的坑位开关", () => {
  test("grok 带 --trust（否则启动时弹信任提示卡住 agent）", () => {
    for (const plan of PLAN_NAMES) {
      const grok = planRoles(plan).find((s) => s.kind === "grok");
      expect(grok?.args).toContain("--trust");
    }
  });

  test("codex 带 --no-daemon（否则被共享 daemon 的 feature 冲突卡住）", () => {
    for (const plan of PLAN_NAMES) {
      for (const spec of planRoles(plan).filter((s) => s.kind === "codex")) {
        expect(spec.args).toContain("--no-daemon");
      }
    }
  });
});

test("harness defaults add no model override and reject unknown selections", () => {
  const f = makeProject();
  try {
    init(loadProject(f.root), []);
    const file = join(f.root, ".herdr/models.json");
    const catalog = JSON.parse(readFileSync(file, "utf8"));
    catalog.harnesses.codex.preferred = "default";
    catalog.harnesses.claude.preferred = "default";
    writeFileSync(file, JSON.stringify(catalog));
    const roles = planRoles("balanced", f.root);
    const codex = roles.find(role => role.kind === "codex")!;
    expect(codex.model).toBe("default");
    expect(codex.args).toContain("--no-daemon");
    expect(codex.args).not.toContain("-m");
    expect(codex.args).not.toContain("default");
    const claude = roles.find(role => role.kind === "claude")!;
    expect(claude.model).toBe("default");
    expect(claude.args).toEqual([]);
    catalog.harnesses.claude.preferred = "unknown-model";
    writeFileSync(file, JSON.stringify(catalog));
    expect(() => planRoles("balanced", f.root)).toThrow(/Unknown model/);
    delete catalog.harnesses.claude;
    writeFileSync(file, JSON.stringify(catalog));
    expect(() => planRoles("balanced", f.root)).toThrow(/Unknown model.*harness claude/);
  } finally { f.cleanup(); }
});

test("project model catalogs take precedence, refresh on read, and survive forced initialization", () => {
  const f = makeProject();
  try {
    init(loadProject(f.root), []);
    const file = join(f.root, ".herdr/models.json");
    const catalog = JSON.parse(readFileSync(file, "utf8"));
    catalog.harnesses.codex.models["project-model"] = ["-m", "project-model"];
    catalog.harnesses.codex.preferred = "project-model";
    writeFileSync(file, JSON.stringify(catalog));
    expect(planRoles("balanced", f.root).find(role => role.name === "dev")?.args).toContain("project-model");
    expect(planRoles("balanced", f.root).find(role => role.name === "dev")?.model).toBe("project-model");
    const before = readFileSync(file, "utf8");
    init(loadProject(f.root), [], true);
    expect(readFileSync(file, "utf8")).toBe(before);
    catalog.harnesses.codex.preferred = "default";
    writeFileSync(file, JSON.stringify(catalog));
    const refreshed = planRoles("balanced", f.root).find(role => role.name === "dev")!;
    expect(refreshed.model).toBe("default");
    expect(refreshed.args).not.toContain("-m");
    writeFileSync(file, "{broken");
    expect(() => planRoles("balanced", f.root)).toThrow(/Invalid model catalog/);
  } finally { f.cleanup(); }
});

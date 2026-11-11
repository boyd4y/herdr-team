import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../scripts/lib/team/init.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { validateProject } from "../scripts/lib/team/validate.ts";
import { makeProject } from "./helpers.ts";
import { PLAN_NAMES, planRoles } from "../scripts/lib/team/plans.ts";

test("role plans keep preset references and resolve launch settings from project data", () => {
  for (const plan of PLAN_NAMES) {
    const f = makeProject();
    try {
      const specs = planRoles(plan, f.root);
      expect(specs.every(role => role.preset && role.args === undefined && role.model === undefined)).toBe(true);
      init(loadProject(f.root), specs);
      const project = loadProject(f.root);
      expect(validateProject(project)).toEqual([]);
      expect(project.roles.find(role => role.kind === "grok")?.args).toContain("--trust");
      for (const role of project.roles.filter(role => role.kind === "codex")) expect(role.args).toContain("--no-daemon");
      const file = join(f.root, "agents.json");
      const presets = JSON.parse(readFileSync(file, "utf8"));
      const dev = project.roles.find(role => role.name === "dev")!;
      presets[dev.kind][dev.preset!] = { model: "default" };
      writeFileSync(file, JSON.stringify(presets));
      const before = readFileSync(file, "utf8");
      init(loadProject(f.root), [], true);
      expect(readFileSync(file, "utf8")).toBe(before);
      const refreshed = loadProject(f.root).roles.find(role => role.name === "dev")!;
      expect(refreshed.model).toBe("default");
      expect(refreshed.args).toEqual([]);
    } finally { f.cleanup(); }
  }
});

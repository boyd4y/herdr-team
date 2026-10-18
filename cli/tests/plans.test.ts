import { describe, expect, test } from "bun:test";
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

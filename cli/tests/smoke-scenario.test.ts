import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectSmokeScenario, smokeChecks, smokeFixtures, smokeSource } from "../scripts/lib/demo/scenario.ts";
import { checkArtifact } from "../scripts/lib/demo/shared.ts";

test("Chinese and English keywords select a fixture and combine workflow steps", () => {
  expect(selectSmokeScenario("查依赖，退回，阻塞", "repeat")).toMatchObject({
    seed: "repeat", fixture: "dependencies", rejectOnce: true, hold: "blocked",
    matches: { fixture: "依赖", flow: ["退回", "阻塞"] },
  });
  expect(selectSmokeScenario("ＰＲＩＯＲＩＴＹ direct", "repeat")).toMatchObject({
    fixture: "priority", rejectOnce: false, hold: null,
  });
  expect(selectSmokeScenario("recovery awaiting handoff", "repeat")).toMatchObject({
    fixture: "recovery", rejectOnce: false, hold: "done",
  });
});

test("seeds reproduce the same choices and sample all configured variations", () => {
  expect(selectSmokeScenario("去重 恢复 阻塞 待交接", "same")).toEqual(selectSmokeScenario("去重 恢复 阻塞 待交接", "same"));
  const plans = Array.from({ length: 64 }, (_, i) => selectSmokeScenario("", String(i)));
  expect(new Set(plans.map(plan => plan.fixture)).size).toBe(Object.keys(smokeFixtures).length);
  expect(new Set(plans.map(plan => `${plan.rejectOnce}:${plan.hold}`)).size).toBe(6);
  const limited = plans.map(plan => selectSmokeScenario("dedup recovery", plan.seed).fixture);
  expect(new Set(limited)).toEqual(new Set(["deduplication", "recovery"]));
  const examples = plans.map(plan => smokeChecks(selectSmokeScenario("优先级 直通", plan.seed))[0]);
  expect(new Set(examples)).toEqual(new Set(smokeFixtures.priority.checks));
});

test.each(Object.keys(smokeFixtures) as (keyof typeof smokeFixtures)[])("%s assertions reject the flawed fixture and pass the fix", fixture => {
  const root = mkdtempSync(join(tmpdir(), "herdr-smoke-fixture-"));
  try {
    const task = { id: "0001", ordinal: 1, artifact: "demo/fixture.ts" };
    const scenario = { ...selectSmokeScenario("", "checks"), fixture, exampleIndex: 0 };
    const run = { root, fast: true, tasks: [task], scenario };
    mkdirSync(join(root, "demo"));
    writeFileSync(join(root, task.artifact), smokeSource(scenario, false));
    expect(checkArtifact(run, task, root)).toBe(false);
    writeFileSync(join(root, task.artifact), smokeSource(scenario, true));
    expect(checkArtifact(run, task, root)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

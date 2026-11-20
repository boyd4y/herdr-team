import { createHash, randomBytes } from "node:crypto";

interface Fixture {
  keywords: RegExp;
  title: string;
  name: string;
  parameters: string;
  solution: string;
  defect: string;
  expectation: string;
  failure: string;
  checks: { args: unknown[]; expected: unknown }[];
}

export const smokeFixtures = {
  deduplication: {
    keywords: /去重|重复投递|\b(?:dedup\w*|duplicates?)\b/iu,
    title: "Deduplicate deliveries in first-seen order",
    name: "deduplicate", parameters: "ids: string[]",
    solution: "[...new Set(ids)]", defect: "[...ids]",
    expectation: "Keep the first occurrence of each ID and preserve its order.",
    failure: "Duplicate IDs appeared in the result.",
    checks: [
      { args: [["a", "b", "a", "c", "b"]], expected: ["a", "b", "c"] },
      { args: [["b", "b", "a"]], expected: ["b", "a"] },
      { args: [[]], expected: [] },
    ],
  },
  priority: {
    keywords: /优先级|排序|\b(?:priorit\w*|fifo|sorting)\b/iu,
    title: "Select the highest-priority task and keep FIFO ties",
    name: "nextTask", parameters: "tasks: { id: string; priority: number }[]",
    solution: "[...tasks].sort((left, right) => left.priority - right.priority)[0]?.id ?? null",
    defect: "tasks[0]?.id ?? null",
    expectation: "Lower priority numbers run first. Ties retain arrival order, and an empty queue returns null.",
    failure: "An older, lower-priority task was selected before an urgent one.",
    checks: [
      { args: [[{ id: "older", priority: 2 }, { id: "urgent", priority: 0 }]], expected: "urgent" },
      { args: [[{ id: "first", priority: 1 }, { id: "second", priority: 1 }]], expected: "first" },
      { args: [[]], expected: null },
    ],
  },
  dependencies: {
    keywords: /依赖|前置|\b(?:dependenc\w*|prerequisites?)\b/iu,
    title: "Wait until every task dependency is complete",
    name: "canDispatch", parameters: "dependencies: string[], done: string[]",
    solution: "dependencies.every(id => done.includes(id))",
    defect: "dependencies.some(id => done.includes(id))",
    expectation: "Dispatch only after all dependencies are complete. An independent task can start immediately.",
    failure: "One completed dependency incorrectly unlocked the task.",
    checks: [
      { args: [["a", "b"], ["a"]], expected: false },
      { args: [["a", "b"], ["b", "a"]], expected: true },
      { args: [[], []], expected: true },
    ],
  },
  recovery: {
    keywords: /恢复|重连|断点|\b(?:recover\w*|reconnect\w*|checkpoint\w*|resume)\b/iu,
    title: "Resume event replay after the saved checkpoint",
    name: "resumeEvents", parameters: "sequences: number[], checkpoint: number",
    solution: "sequences.filter(sequence => sequence > checkpoint)",
    defect: "sequences.filter(sequence => sequence >= checkpoint)",
    expectation: "Replay events after the checkpoint in order, skipping the last acknowledged event.",
    failure: "The acknowledged checkpoint event was replayed.",
    checks: [
      { args: [[2, 4, 7, 8], 4], expected: [7, 8] },
      { args: [[2, 4], 4], expected: [] },
      { args: [[2, 4], 0], expected: [2, 4] },
    ],
  },
  filtering: {
    keywords: /筛选|过滤|看板|\b(?:filter\w*|board|open tasks?)\b/iu,
    title: "Show actionable tasks in the Open filter",
    name: "openTasks", parameters: "statuses: string[]",
    solution: 'statuses.filter(status => !["done", "cancelled"].includes(status))',
    defect: 'statuses.filter(status => status !== "done")',
    expectation: "Keep queued, in-progress, review and blocked tasks visible. Hide done and cancelled tasks.",
    failure: "A cancelled task was still visible in the Open filter.",
    checks: [
      { args: [["todo", "doing", "done", "review", "cancelled", "blocked"]], expected: ["todo", "doing", "review", "blocked"] },
      { args: [["done", "cancelled"]], expected: [] },
    ],
  },
} satisfies Record<string, Fixture>;

type FixtureId = keyof typeof smokeFixtures;
type Hold = "done" | "blocked" | null;
interface Flow { rejectOnce: boolean; hold: Hold }

export interface SmokeScenario extends Flow {
  seed: string;
  fixture: FixtureId;
  exampleIndex: number;
  matches: { fixture: string | null; flow: string[] };
}

const fixtureIds = Object.keys(smokeFixtures) as FixtureId[];
const holds = [null, "done", "blocked"] as const;
const flows = [false, true].flatMap(rejectOnce => holds.map(hold => ({ rejectOnce, hold })));
const holdKeywords = {
  done: /交接等待|待交接|提前完成|交接|交棒|\b(?:awaiting handoff|done before handoff|handoff wait|handoff|done)\b/iu,
  blocked: /等待确认|待人确认|人工确认|阻塞|\b(?:blocked|needs you|needs confirmation)\b/iu,
};

function sample<T>(choices: readonly T[], seed: string, stream: string): T {
  const hash = createHash("sha256").update(stream).update("\0").update(seed).digest();
  return choices[hash.readUInt32BE(0) % choices.length]!;
}

export function selectSmokeScenario(keywords = "", seed = randomBytes(8).toString("hex")): SmokeScenario {
  const text = keywords.normalize("NFKC");
  const matchedFixtures = fixtureIds.filter(id => smokeFixtures[id].keywords.test(text));
  const fixture = sample(matchedFixtures.length ? matchedFixtures : fixtureIds, seed, "fixture");
  const direct = text.match(/直通|一次通过|\b(?:direct|straight through|happy path)\b/iu)?.[0];
  const reject = text.match(/退回|返工|拒绝|\b(?:rework|reject\w*)\b/iu)?.[0];
  const matchedHolds = (Object.keys(holdKeywords) as (keyof typeof holdKeywords)[])
    .flatMap(hold => {
      const match = text.match(holdKeywords[hold])?.[0];
      return match ? [{ hold, match }] : [];
    });
  const selectedHold = matchedHolds.length ? sample(matchedHolds, seed, "hold") : null;
  const flow = direct || reject || selectedHold
    ? { rejectOnce: Boolean(reject), hold: selectedHold?.hold ?? null }
    : sample(flows, seed, "flow");
  return {
    seed, fixture, ...flow,
    exampleIndex: sample(smokeFixtures[fixture].checks.map((_, index) => index), seed, "example"),
    matches: { fixture: text.match(smokeFixtures[fixture].keywords)?.[0] ?? null,
      flow: [direct, reject, selectedHold?.match].filter((match): match is string => Boolean(match)) },
  };
}

export function smokeChecks(scenario: SmokeScenario): Fixture["checks"] {
  const checks = smokeFixtures[scenario.fixture].checks;
  return [...checks.slice(scenario.exampleIndex), ...checks.slice(0, scenario.exampleIndex)];
}

export function smokeSource(scenario: SmokeScenario, corrected: boolean): string {
  const fixture = smokeFixtures[scenario.fixture];
  return `export function ${fixture.name}(${fixture.parameters}) {\n  return ${corrected ? fixture.solution : fixture.defect};\n}\n`;
}

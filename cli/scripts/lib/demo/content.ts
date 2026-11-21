import { selectSmokeScenario, smokeFixtures, type SmokeScenario } from "./scenario.ts";

// Each card provides presenter-readable context and an executable contract.
const contracts: Record<string, [string, string, string]> = {
  reconnect: ["recovery", "Operators lose their place when a relay connection drops during the night shift.", "Persist the last acknowledged sequence and restore only newer events after reconnecting."],
  traces: ["filtering", "The trace panel mixes resolved signals with items that still need attention.", "Build the actionable trace projection while preserving arrival order and blocked signals."],
  delivery: ["deduplication", "Retries currently produce duplicate signal deliveries and duplicate operator actions.", "Deduplicate delivery IDs in first-seen order, including non-adjacent retries and empty batches."],
  health: ["dependencies", "A relay can appear healthy before all of its probes have responded.", "Mark a node ready only when every required probe has completed; cover partial probe results."],
  checkpoints: ["recovery", "Restart recovery replays the checkpoint itself, repeating an acknowledged action.", "Use an exclusive checkpoint boundary and preserve the sequence of unseen events."],
  keyboard: ["priority", "Keyboard focus can land on low-priority work while an urgent action is waiting.", "Choose the most urgent eligible action and keep focus order stable for equal priorities."],
  pressure: ["priority", "The pressure panel needs a deterministic next-item projection under heavy queue load.", "Select the lowest priority number without mutating the input; cover ties and an empty queue."],
  receipts: ["filtering", "Receipt search results include closed entries that obscure pending investigations.", "Return actionable receipts, preserving blocked and review entries and excluding cancelled entries."],
  isolation: ["dependencies", "A checkout must not be dispatched until all isolation checks have passed.", "Require every isolation prerequisite before dispatch; exercise zero, partial and complete prerequisites."],
  alerts: ["deduplication", "Repeated relay alerts crowd out distinct incidents on the release board.", "Collapse duplicate alert IDs while keeping the first observed incident order."],
  replay: ["recovery", "After reconnect support lands, session replay must continue from its saved cursor.", "Replay only events newer than the cursor; verify an exhausted stream returns no events."],
  audit: ["deduplication", "Audit exports must explain retries without counting the same delivery twice.", "Build a unique ordered delivery list using the same first-seen contract as dispatch."],
  "checkpoint-age": ["recovery", "The activity feed must distinguish acknowledged history from new checkpoint activity.", "Project only activity beyond the acknowledged boundary; cover equal and older sequences."],
  "queue-recovery": ["dependencies", "Restarted queues must not unlock downstream jobs after only one prerequisite recovers.", "Check every prerequisite against the recovered completion set, independent of completion order."],
  reclaim: ["filtering", "The session list keeps expired and cancelled work visible during cleanup.", "Keep only actionable session states while retaining blocked sessions for investigation."],
  lag: ["priority", "Operators need the most urgent relay lag incident first, with stable ordering for ties.", "Select an incident by priority without reordering the source snapshot."],
  verification: ["dependencies", "A release receipt can be published before every verification lane completes.", "Gate the aggregate receipt on all required checks; verify partial completion cannot pass."],
  "release-notes": ["deduplication", "Repeated handoffs can duplicate a change in the nightly release notes.", "Publish one entry per change ID in first-accepted order."],
};

export function demoContent(lane: { slug: string; label: string; issue: string; dependsOn?: string }, version: string) {
  const contract = contracts[lane.slug];
  if (!contract) throw new Error(`Missing demo content for ${lane.slug}`);
  const [fixture, background, scope] = contract;
  const scenario: SmokeScenario = { ...selectSmokeScenario(fixture, `${version}:${lane.slug}`), rejectOnce: false, hold: null };
  const checks = smokeFixtures[scenario.fixture];
  const acceptance = `${scope}\n${checks.expectation}\nExamples: ${checks.checks.map(check => `${JSON.stringify(check.args)} → ${JSON.stringify(check.expected)}`).join("; ")}`;
  const body = `## Background\n\n${background}\n\n## Implementation\n\n${scope}\nKeep the patch isolated to this task's module and submit a pinned commit for verification.\n\n## Acceptance criteria\n\n${acceptance}\n\n## Handoff\n\nDevelopment → verification → review → integration. Verification must execute the examples against the pinned commit and return a reproducible finding on failure.${lane.dependsOn ? `\nStart after ${lane.dependsOn} has integrated.` : ""}\n\nDemo fixture: this task simulates ${lane.issue} for ${version}; it does not implement a production console.\n`;
  return { scenario, background, scope, acceptance, body };
}

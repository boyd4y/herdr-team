import { reviewFor } from "./execution.ts";
import { join } from "node:path";
import { TASK_BODY, type TaskCard } from "./types.ts";

export function assignmentPrompt(identity: string, roleBody: string, card: TaskCard, root?: string, deliveryId?: string): string {
  return [
    identity.trim(),
    "",
    roleBody.trim(),
    "",
    ...(card.meta.execution === "task" ? [
      card.role === "lead"
        ? "Use the project's single resident lead session. Lead assignments are serial; do not create a task-specific lead agent. Inspect the task's existing feature worktree without switching the primary checkout."
        : "This task owns its workspace and role sessions; other tasks using this role may run concurrently. Use only real interface/data dependencies, never plan order.",
      "Before review, commit all changes and hand off with --commit SHA. By default dev and test reuse this task worktree. Stop writing while the reviewer owns it.",
      "Test with isolated services: use HERDR_TEAM_TEST_DATABASE, HERDR_TEAM_REDIS_PREFIX and HERDR_TEAM_PORT/PORT from this session. Create/configure task-specific test resources; do not run against shared application databases or unprefixed Redis. If isolation cannot be configured, report that blocker.",
      "Accept only the assigned commit using --accept SHA and a validation summary; reject using --reject with defects, which returns directly to the original developer. Accepted tasks enter the merge queue; never merge or run shared local migrations from an execution session.",
      ...(reviewFor(card) ? [`Assigned review commit: ${reviewFor(card)!.commit}. Verify the task worktree's HEAD matches this SHA. The acceptance summary must state the SHA and results.`] : []),
    ] : []),
    `You now own task ${card.id}: ${card.title}`,
    `Directory: ${root === undefined ? `.herdr/${card.dir}` : join(root, ".herdr", card.dir)} (.task.yaml contains metadata; ${TASK_BODY} contains the description and history)`,
    "",
    `When done, run \`herdr-team handoff ${card.id}${deliveryId ? ` --delivery ${deliveryId}` : ""} --summary "results, artifact paths, validation, risks and next steps"\`; use --summary-file F for long summaries. The CLI appends it to task.md. Do not edit task cards yourself.`,
  ].join("\n");
}

import { assignedReviewFor } from "./execution.ts";
import { join } from "node:path";
import { TASK_BODY, type TaskCard } from "./types.ts";
import { stepRole, taskWorkflow } from "./legacy-workflow.ts";
import { pullRequestFor, usesPullRequest } from "./pull-request.ts";

export function assignmentPrompt(identity: string, roleBody: string, card: TaskCard, root?: string): string {
  const workflow = taskWorkflow(card), pr = pullRequestFor(card), prFlow = usesPullRequest(card);
  return [
    "Use the installed herdr-team skill for this assignment. Read its SKILL.md and follow its reference routing before claiming or working; role instructions describe responsibilities, not a separate collaboration procedure.",
    "",
    identity.trim(),
    "",
    roleBody.trim(),
    ...(workflow ? [
      `Task workflow: ${workflow.name}; ${workflow.steps.map((step) => `${step.kind}=${step.role}`).join(" → ")}; ${workflow.delivery}; merge=${workflow.merge}. This saved task workflow takes priority over role-prompt examples or current project defaults.`,
      ...(prFlow ? [card.role === stepRole(card, "test")
        ? "You are testing locally. Accepting the exact tested SHA publishes/updates its PR and queues PR review; it does not permit merging."
        : card.role === stepRole(card, "review")
          ? `Review the PR and its test evidence. Approve with --accept SHA or return defects with --reject. Approval uses the selected ${workflow.merge} merge policy; rejection must repeat development and testing.`
          : "Develop in this task worktree, then submit a clean commit to testing with --commit SHA."] : []),
    ] : []),
    ...(pr ? [`Pull request: ${pr.url}; tested head: ${pr.commit}`] : []),
    "",
    ...(card.meta.execution === "task" ? [
      card.role === "lead"
        ? "Execution scope: the project's single resident lead session; this task may have a separate feature checkout."
        : "Execution scope: a task-owned workspace and checkout shared by this task's role sessions; other tasks use separate sessions.",
      ...(workflow ? [
        "Before review, commit all changes and hand off with --commit SHA. By default dev and test reuse this task worktree. Stop writing while the reviewer owns it.",
        "Test with isolated services: use HERDR_TEAM_TEST_DATABASE, HERDR_TEAM_REDIS_PREFIX and HERDR_TEAM_PORT/PORT from this session. Create/configure task-specific test resources; do not run against shared application databases or unprefixed Redis. If isolation cannot be configured, report that blocker.",
        "Accept only the assigned commit using --accept SHA and a validation summary; reject using --reject with defects, which returns directly to the original developer. Follow the task's selected test/review/merge stages; never bypass them or run shared local migrations from an execution session.",
      ] : []),
      ...(assignedReviewFor(card) ? [`Assigned review commit: ${assignedReviewFor(card)!.commit}`] : []),
    ] : []),
    `You now own task ${card.id}: ${card.title}`,
    `Current role: ${card.role}; remaining owners: ${card.handoff.join(" → ") || "none"}`,
    `Directory: ${root === undefined ? `.herdr/${card.dir}` : join(root, ".herdr", card.dir)} (.task.yaml contains metadata; ${TASK_BODY} contains the description and history)`,
  ].join("\n");
}

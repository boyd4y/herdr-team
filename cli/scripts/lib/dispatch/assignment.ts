import { reviewFor } from "../tasks/verification.ts";
import { join } from "node:path";
import { TASK_BODY, type TaskCard } from "../shared/types.ts";
import { pullRequestFor } from "../integration/pull-request.ts";

export function assignmentPrompt(identity: string, roleBody: string, card: TaskCard, root?: string): string {
  const pr = pullRequestFor(card);
  return [
    "Use the installed herdr-team skill for this assignment. Read its SKILL.md and follow its reference routing before claiming or working; role instructions describe responsibilities, not a separate collaboration procedure.",
    "",
    identity.trim(),
    "",
    roleBody.trim(),
    ...(pr ? [`Pull request: ${pr.url}; tested head: ${pr.commit}`] : []),
    "",
    ...(card.meta.execution === "task" ? [
      card.role === "lead"
        ? "Execution scope: the project's single resident lead session; this task may have a separate feature checkout."
        : "Execution scope: a task-owned workspace and checkout shared by this task's role sessions; other tasks use separate sessions.",
      ...(reviewFor(card) ? [`Assigned review commit: ${reviewFor(card)!.commit}`] : []),
    ] : []),
    `You now own task ${card.id}: ${card.title}`,
    `Current role: ${card.role}; remaining owners: ${card.handoff.join(" → ") || "none"}`,
    `Directory: ${root === undefined ? `.herdr/${card.dir}` : join(root, ".herdr", card.dir)} (.task.yaml contains metadata; ${TASK_BODY} contains the description and history)`,
  ].join("\n");
}

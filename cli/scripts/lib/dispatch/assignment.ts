import { reviewFor } from "../tasks/verification.ts";
import { join } from "node:path";
import { TASK_BODY, type TaskCard } from "../shared/types.ts";
import { pullRequestFor } from "../integration/pull-request.ts";

export function assignmentPrompt(team: string, roleBody: string, card: TaskCard, root?: string): string {
  const pr = pullRequestFor(card);
  const review = reviewFor(card);
  return [
    "Use the installed herdr-team skill for this assignment. Read its SKILL.md and follow its reference routing before claiming or working; role instructions describe responsibilities, not a separate collaboration procedure.",
    "",
    `Team agreement: ${root === undefined ? "TEAM.md" : join(root, "TEAM.md")}`,
    team.trim(),
    "",
    roleBody.trim(),
    ...(pr ? [`Pull request: ${pr.url}; tested head: ${pr.commit}`] : []),
    "",
    ...(card.meta.execution === "task" ? [
      card.role === "lead"
        ? "Execution scope: the project's single resident lead session; this task may have a separate feature checkout."
        : "Execution scope: a task-owned workspace and checkout shared by this task's role sessions; other tasks use separate sessions.",
      ...(review ? [`Assigned review commit: ${review.commit}`] : []),
    ] : []),
    `You now own task ${card.id}: ${card.title}`,
    `Current role: ${card.role}; remaining owners: ${card.handoff.join(" → ") || "none"}`,
    ...(!card.handoff.length && !review && !pr ? [
      "This is the final role for the recorded task. For ordinary delivery, use handoff with --summary to finish. If the task requires review of a commit, ask lead to assign a reviewer first.",
    ] : []),
    `Directory: ${root === undefined ? `.herdr/${card.dir}` : join(root, ".herdr", card.dir)} (.task.yaml contains metadata; ${TASK_BODY} contains the description and history)`,
  ].join("\n");
}

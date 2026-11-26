import { createHash } from "node:crypto";
import { join } from "node:path";
import { pullRequestFor } from "../integration/pull-request.ts";
import type { TaskCard } from "../shared/types.ts";
import { reviewFor } from "../tasks/verification.ts";

export function assignmentPrompt(team: string, roleBody: string, card: TaskCard, root?: string): string {
  const pr = pullRequestFor(card);
  const review = reviewFor(card);
  const agreement = root === undefined ? "TEAM.md" : join(root, "TEAM.md");
  const revision = createHash("sha256").update(team).digest("hex").slice(0, 12);
  return [
    "Reuse the herdr-team skill and project instructions already in this conversation. Load missing or updated instructions only. If your loaded skill requires a reread on every assignment, refresh it once. Consult only relevant reference sections.",
    `Team agreement: ${agreement} (revision ${revision}). Read it if this revision is new to the conversation.`,
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
  ].join("\n");
}

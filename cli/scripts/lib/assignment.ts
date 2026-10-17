import { join } from "node:path";
import { TASK_BODY, type TaskCard } from "./types.ts";

export function assignmentPrompt(identity: string, roleBody: string, card: TaskCard, root?: string, deliveryId?: string): string {
  return [
    identity.trim(),
    "",
    roleBody.trim(),
    "",
    `You now own task ${card.id}: ${card.title}`,
    `Directory: ${root === undefined ? `.herdr/${card.dir}` : join(root, ".herdr", card.dir)} (.task.yaml contains metadata; ${TASK_BODY} contains the description and history)`,
    "",
    `When done, run \`herdr-team handoff ${card.id}${deliveryId ? ` --delivery ${deliveryId}` : ""} --summary "results, artifact paths, validation, risks and next steps"\`; use --summary-file F for long summaries. The CLI appends it to task.md. Do not edit task cards yourself.`,
  ].join("\n");
}

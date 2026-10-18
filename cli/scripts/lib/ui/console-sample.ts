import type { AgentInfo } from "../runtime/herdr.ts";
import type { Project, RoleCard, TaskCard } from "../shared/types.ts";
import { modelFromAgents, type ConsoleState } from "./console-model.ts";

const commit = "a81e6b4".padEnd(40, "0");

/** An isolated, deterministic preview. No project files, leases, queue pumps or Herdr calls. */
export function sampleConsole(state: ConsoleState, elapsedMs = 0) {
  const phase = Math.floor(elapsedMs / 5000) % 10;
  const owner = phase === 0 || phase === 3 || phase === 4 ? "dev" : [1, 2, 5, 6].includes(phase) ? "test" : "doc";
  const role = (name: string, kind: string, model: string): RoleCard => ({
    name, dir: `roles/${name}`, kind, model, worktree: true, body: "",
    meta: { kind, model, worktree: true },
  });
  const card = (id: string, title: string, role: string, status: string, handoff: string[]): TaskCard => ({
    id, slug: "sample", dir: `tasks/${id}-sample`, title, priority: "P1", status, role, handoff,
    dependsOn: [], repo: ".", body: "", meta: { title, role, status, priority: "P1", handoff, repo: ".", execution: "task" },
  });
  const main = card("0083", "Share project model preferences", owner, phase === 9 ? "done" : owner === "dev" ? "doing" : "review",
    owner === "dev" ? ["test", "doc"] : owner === "test" ? ["doc"] : []);
  const now = new Date(Date.UTC(2026, 9, 18, 10, 32) + elapsedMs);
  const queued = new Date(now.getTime() - (elapsedMs % 5000) - 2000).toISOString();
  const sending = [1, 5, 7].includes(phase);
  if (phase !== 9) main.meta.delivery = { id: "sample-delivery-0083", role: owner, phase: owner === "dev" ? "dispatch" : "handoff",
    state: sending ? "submitted" : "claimed", queued_at: queued, sent_at: queued };
  if (owner !== "dev") main.meta.review = { commit, developer: "dev", reviewer: owner,
    reviewers: owner === "test" ? ["test"] : ["test", "doc"] };
  main.body = "Persist each project's model catalog and preferred selections.\n\nAcceptance\n"
    + "• Preserve customer changes during initialization.\n• Follow the harness configuration for default.\n• Verify the packaged CLI without a source checkout.\n\n## History\n"
    + "- 10:32  dev started implementation\n"
    + (phase > 0 ? "- 10:33  dev → test · submitted a81e6b4\n" : "")
    + (phase > 2 ? "- 10:34  test → dev · fix keyboard example\n" : "")
    + (phase > 4 ? "- 10:35  dev → test · submitted corrections\n" : "")
    + (phase > 6 ? "- 10:36  test → doc · validation passed\n" : "")
    + (phase === 9 ? "- 10:36  doc completed the task\n" : "");
  const waiting = card("0081", "Write the contributor quickstart", "doc", "todo", []);
  waiting.meta.delivery = { id: "sample-delivery-0081", role: "doc", phase: "dispatch", state: "queued", queued_at: queued,
    reason: "Waiting for the assigned session" };
  waiting.body = "Document installation, the first task, and how to contribute.";
  const blocked = card("0082", "Check narrow terminal navigation", "test", "blocked", ["doc"]);
  blocked.meta.review = { commit, developer: "dev", reviewer: "test", reviewers: ["test"] };
  blocked.meta.delivery = { id: "sample-delivery-0082", role: "test", phase: "handoff", state: "claimed", queued_at: queued,
    reason: "Choose the expected keyboard behavior before continuing" };
  blocked.body = "Confirm navigation at 62 columns.\n\n## History\n- 10:31  dev → test\n- 10:32  test requested clarification\n";
  const project: Project = { root: "/sample/herdr-team", herdrDir: "/sample/herdr-team/.herdr", hasIdentity: true,
    roles: [role("dev", "codex", "gpt-6.1-sol"), role("test", "claude", "default"), role("doc", "codex", "gpt-6-luna")],
    tasks: [main, waiting, blocked], problems: [], retiredIds: [] };
  const agents: AgentInfo[] = [
    ...(phase === 9 ? [] : [{ name: `${owner}-0083`, agent_status: sending ? "idle" : "working", pane_id: "sample:1" }]),
    { name: "test-0082", agent_status: "blocked", pane_id: "sample:3" },
  ];
  return { project, model: modelFromAgents(project, agents, state, now.toLocaleTimeString("en-GB"), true, now.getTime()) };
}

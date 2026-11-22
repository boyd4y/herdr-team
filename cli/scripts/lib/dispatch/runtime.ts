import type { Project, RoleCard, TaskCard } from "../shared/types.ts";
import type { AgentInfo, Herdr, WorktreeInfo } from "../runtime/herdr.ts";
import type { Delivery } from "./delivery.ts";
import { taskAgent } from "./task-agent.ts";
import { refreshSidebar } from "../ui/sidebar.ts";
import { cleanupIfDone, type CleanupResult } from "./cleanup.ts";
import { featureWorkspace, worktreeBranch } from "../shared/types.ts";
import { projectKey, roleAgentLabel } from "./team-scope.ts";

/** Addresses retain their runtime identity. A Core terminal is never a pane ID. */
export type DeliveryTarget = Pick<Delivery, "runtime" | "space" | "pane_id" | "terminal" | "session_id" | "process_id">;
export class DeliveryRejected extends Error {}
export interface Receiver {
  target: DeliveryTarget;
  /** Runtime-reported terminal status, present only if a session reported one. */
  status?: string;
  canSubmit: boolean;
  submit(prompt: string): DeliveryTarget;
}
export interface TaskRuntime {
  scope: DeliveryTarget;
  envOk(): boolean;
  workspaceBusy?(project: Project, task: TaskCard): boolean;
  assertDelivery(delivery: Delivery): void;
  receiver(project: Project, role: RoleCard, task: TaskCard, delivery: Delivery): Receiver | undefined;
  residentReceiver?(role: RoleCard): Receiver | undefined;
  alive(delivery: Delivery): boolean;
  refresh(project: Project): void;
  worktreeList(repo: string): WorktreeInfo[];
  cleanup(project: Project, task: TaskCard): CleanupResult;
  authorize?(task: TaskCard, delivery: Delivery | undefined): void;
}

export function taskRuntime(runtime: Herdr | TaskRuntime): TaskRuntime {
  if ("receiver" in runtime) return runtime;
  let snapshot: AgentInfo[] | undefined;
  return {
    scope: {},
    envOk: () => runtime.envOk(),
    workspaceBusy(project, task) {
      const feature = featureWorkspace(task);
      if (!feature) return false;
      const owner = projectKey(project);
      return runtime.agentList().some(agent => agent.tokens?.team_project === owner && agent.tokens.team_session === "task" &&
        agent.tokens.team_feature === feature.feature && agent.tokens.team_iteration === feature.iteration &&
        agent.tokens.team_task_id !== task.id && !["done", "idle"].includes(agent.agent_status ?? ""));
    },
    assertDelivery(delivery) {
      if (delivery.runtime === "desktop" || delivery.terminal) throw new Error("Delivery belongs to Desktop; refusing TUI execution");
    },
    receiver(project, role, task, delivery) {
      const agent = taskAgent(project, runtime, role, task);
      if (!agent?.pane_id) return;
      const target = { pane_id: agent.pane_id, ...(agent.agent_session?.value ? { session_id: agent.agent_session.value } : {}) };
      const status = agent.agent_status;
      return { target, status, canSubmit: status === "idle" || status === "done", submit(prompt) {
        if (agent.tokens?.team_feature && agent.tokens.team_session === "task") {
          runtime.reportMetadata(agent.pane_id!, "herdr-team", roleAgentLabel(role.name, task.id), { team_delivery: delivery.id });
        }
        runtime.agentPrompt(agent.pane_id!, prompt);
        return target;
      } };
    },
    alive(delivery) {
      snapshot ??= runtime.agentList();
      const agent = snapshot.find(agent => agent.pane_id === delivery.pane_id);
      return Boolean(agent && (!delivery.session_id || agent.agent_session?.value === delivery.session_id));
    },
    refresh: project => refreshSidebar(project, runtime),
    worktreeList: repo => runtime.worktreeList(repo),
    cleanup: (project, task) => task.meta.feature ? {
      id: task.id, branch: worktreeBranch(task), action: "retained", note: "Task checkout retained for feature delivery.",
    } : cleanupIfDone(project, runtime, task),
  };
}

export function sameReceiver(a: DeliveryTarget, b: DeliveryTarget): boolean {
  return a.terminal !== undefined ? a.runtime === b.runtime && a.space === b.space && a.terminal === b.terminal
    : a.pane_id !== undefined && a.pane_id === b.pane_id && b.runtime !== "desktop";
}

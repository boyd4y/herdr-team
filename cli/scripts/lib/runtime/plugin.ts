import { findRoot, loadProject } from "../team/project.ts";
import { assertProjectWorkspace, resolveProjectWorkspace } from "../dispatch/team-scope.ts";
import { ensureConsole } from "./console.ts";
import type { Herdr } from "./herdr.ts";
import { isAbsolute } from "node:path";

/** Actions use their invocation snapshot, never the plugin cwd or a later UI focus. */
export function runPluginAction(action: string | undefined, herdr: Herdr, contextJson: string | undefined) {
  if (!herdr.envOk()) throw new Error("Team actions require a Herdr-managed context");
  if (action !== "open-console") throw new Error("Unknown team plugin action");
  const context = JSON.parse(contextJson ?? "null") as {
    workspace_id?: string; focused_pane_id?: string; focused_pane_cwd?: string; workspace_cwd?: string;
  } | null;
  if (!context || typeof context.workspace_id !== "string" || !context.workspace_id) throw new Error("Team action is missing its workspace context");
  const panes = herdr.paneList(context.workspace_id);
  const pane = panes.find(pane => pane.pane_id === context.focused_pane_id);
  if (context.focused_pane_id && !pane) throw new Error("The invoking pane has moved or closed; invoke the action again");
  const cwd = context.focused_pane_cwd ?? pane?.cwd ?? context.workspace_cwd;
  const root = typeof cwd === "string" && isAbsolute(cwd) && findRoot(cwd);
  if (!root) throw new Error("No team project found in the invoking workspace; initialize it with the herdr-team skill");
  const project = loadProject(root);
  assertProjectWorkspace(project, herdr, context.workspace_id);
  const workspaceId = resolveProjectWorkspace(project, herdr);
  if (!workspaceId) throw new Error("No main project workspace found; run herdr-team up before opening Console");
  const outcome = ensureConsole(project, herdr, workspaceId, true);
  if (outcome.action === "failed") throw new Error(outcome.failure);
  return { ...outcome, root };
}

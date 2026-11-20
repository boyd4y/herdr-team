import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeHerdr, makeProject, roleMeta, taskMeta, writeRole, writeTask } from "./helpers.ts";
import { loadProject } from "../scripts/lib/team/project.ts";
import { confirmedFeatures, finishFeature } from "../scripts/lib/team/features.ts";
import { projectKey } from "../scripts/lib/dispatch/team-scope.ts";
import { closeDeliveredTuiAgents } from "../scripts/lib/runtime/tui-feature-sessions.ts";
import { writeTaskMeta } from "../scripts/lib/tasks/cards.ts";

test("CLI confirms a feature iteration once and only after all work is recorded", () => {
  const f = makeProject();
  try {
    writeRole(f.root, "dev", roleMeta());
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/cli.ts"), ...args, "--json"],
      { cwd: f.root, env: { ...process.env, HERDR_ENV: "0" } });
    const json = (...args: string[]) => {
      const result = run(...args);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return JSON.parse(result.stdout.toString());
    };
    json("role", "add", "dev", "--force", "--lifecycle", "temporary");
    expect(json("role", "list")[0].lifecycle).toBe("temporary");
    const issue = json("backlog", "add", "Issue", "--iteration", "v1.2");
    const a = json("add", "Implement feature", "--role", "dev", "--requirement", issue.id, "--feature", "search");
    const b = json("add", "Verify feature", "--role", "dev", "--feature", "search", "--iteration", "v1.2");
    const finish = ["feature", "finish", "search", "--iteration", "v1.2"];
    expect(run(...finish).stderr.toString()).toContain(`first: ${a.id}, ${b.id}`);
    expect(run("feature", "clean", "search", "--iteration", "v1.2").stderr.toString()).toContain("Confirm delivery of search@v1.2");
    json("iteration", "archive", "v1.2");
    expect(confirmedFeatures(loadProject(f.root)).size).toBe(0);
    json("edit", a.id, "--status", "done");
    json("edit", b.id, "--status", "cancelled");
    const confirmation = json(...finish);
    expect(confirmation).toMatchObject({ feature: "search", iteration: "v1.2", tasks: [a.id, b.id] });
    expect(json(...finish)).toEqual(confirmation);
  } finally { f.cleanup(); }
});

test("TUI watches the confirmed task pane until it settles and closes only that pane", () => {
  const f = makeProject();
  try {
    writeRole(f.root, "dev", roleMeta());
    writeTask(f.root, "0001-search", taskMeta({ status: "done", feature: "search", iteration: "v1.2", completed_deliveries: ["d1"] }));
    const load = () => loadProject(f.root);
    const key = projectKey(load());
    const labels = { team_project: key, team_session: "task", team_task_id: "0001", team_role: "dev",
      team_feature: "search", team_iteration: "v1.2", team_delivery: "d1" };
    const pane = (id: string, tokens = labels) => ({ pane_id: id, workspace_id: "w2", name: id, agent: "codex", agent_status: "working", tokens });
    const temporary = pane("w2:p1");
    const herdr = fakeHerdr({ workspaces: [{ workspace_id: "w2", label: "task",
      tokens: { team_project: key, team_root: "0" }, worktree: { repo_key: "repo", is_linked_worktree: true } }],
      agents: [temporary, pane("w2:p2", { ...labels, team_session: "resident" }),
        pane("w2:p3", { ...labels, team_iteration: "v1.3" })] });
    expect(closeDeliveredTuiAgents(load(), herdr)).toEqual([]);
    finishFeature(load(), "search", "v1.2");
    expect(closeDeliveredTuiAgents(load(), herdr)).toEqual(["w2:p1"]);
    temporary.agent_status = "done";
    const before = load();
    writeTask(f.root, "0002-other", taskMeta());
    const current = load(), other = current.tasks[1]!;
    writeTaskMeta(current, other, { status: "doing", delivery: {
      id: "d2", state: "claimed", role: "dev", phase: "dispatch", queued_at: new Date().toISOString(), pane_id: "w2:p1",
    } });
    expect(closeDeliveredTuiAgents(load(), herdr)).toEqual([]);
    expect(herdr.calls).toEqual([]);
    writeTaskMeta(load(), other, { status: "cancelled", delivery: null });
    expect(closeDeliveredTuiAgents(load(), herdr)).toEqual([]);
    expect(herdr.calls).toEqual(["pane close w2:p1"]);
    expect(herdr.state.agents.map(agent => agent.pane_id)).toEqual(["w2:p2", "w2:p3"]);
    expect(load().tasks[0]).toEqual(before.tasks[0]);
  } finally { f.cleanup(); }
});

// Demo facts only. No worktrees, processes or task records are created.
export function sample() {
  const binding = { root: "/sample/project", space: "sample-space", machine: null };
  const roles = [
    { name: "dev", kind: "codex", model: "default", worktree: true },
    { name: "test", kind: "claude", model: "default", worktree: true },
    { name: "doc", kind: "codex", model: "default", worktree: true },
  ];
  const tasks = [
    { id: "0042", title: "Add desktop team console", status: "doing", priority: "P1", role: "dev", handoff: ["test"], dependsOn: [] },
    { id: "0041", title: "Write the contributor guide", status: "doing", priority: "P2", role: "doc", handoff: [], dependsOn: [] },
    { id: "0040", title: "Verify project and space isolation", status: "todo", priority: "P1", role: "test", handoff: [], dependsOn: [] },
  ];
  const terminals = [
    { address: "sample-dev", state: "live", status: "working", labels: { "team.project": binding.root, "herdr.space": binding.space, "team.role": "dev", "team.task": "0042", "team.session": "task" } },
    { address: "sample-doc", state: "live", status: "blocked", labels: { "team.project": binding.root, "herdr.space": binding.space, "team.role": "doc", "team.task": "0041", "team.session": "task" } },
  ];
  return { binding, roles, tasks, terminals };
}

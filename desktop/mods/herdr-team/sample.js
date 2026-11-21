// Demo facts only. No worktrees, processes or task records are created.
export function sample() {
  const binding = { root: "/sample/project", space: "sample-space", machine: null };
  const roles = [
    { name: "dev", kind: "codex", model: "gpt-5", worktree: true },
    { name: "test", kind: "claude", model: "default", worktree: true },
    { name: "doc", kind: "codex", model: "default", worktree: true },
  ];
  const tasks = [
    { id: "0050", title: "Reproduce missing delivery notices after reconnect", status: "todo", priority: "P1", role: "test", handoff: ["dev"], dependsOn: [], meta: { iteration: "v1.1" } },
    { id: "0049", title: "Restore the sidebar selection after reconnect", status: "done", priority: "P2", role: "dev", handoff: [], dependsOn: [] },
    { id: "0048", title: "Try the layout at minimum sidebar width", status: "archived", priority: "P3", role: "test", handoff: [], dependsOn: [], meta: { iteration: "v1.3" } },
    { id: "0047", title: "Keep task titles readable in compact mode", status: "review", priority: "P2", role: "dev", handoff: ["test"], dependsOn: [] },
    { id: "0046", title: "Regression pass on the board view", status: "todo", priority: "P2", role: "test", handoff: [], dependsOn: ["0045"] },
    { id: "0045", title: "Add a board view to the team console", status: "doing", priority: "P1", role: "dev", handoff: ["test", "doc"], dependsOn: [], meta: { feature: "team-board" } },
    { id: "0044", title: "Live binding picker for root and space", status: "todo", priority: "P1", role: "dev", handoff: ["test"], dependsOn: [] },
    { id: "0042", title: "Verify project and space isolation", status: "review", priority: "P1", role: "test", handoff: [], dependsOn: [], meta: { integration: { state: "queued" } } },
    { id: "0041", title: "Write the contributor guide", status: "blocked", priority: "P2", role: "doc", handoff: [], dependsOn: [] },
    { id: "0040", title: "Scaffold the desktop layout", status: "done", priority: "P1", role: "doc", handoff: [], dependsOn: [] },
    { id: "0039", title: "Research the Core terminal API", status: "done", priority: "P2", role: "dev", handoff: [], dependsOn: [] },
  ];
  const bodies = {
    "0045": [
      "## Goal",
      "Show each task in its recorded status column, with the current assignee on its card.",
      "",
      "## Scope",
      "- Todo, In progress, Review, Blocked and Done columns",
      "- One card per task, including its current assignee",
      "- Columns wrap in narrow panels and empty statuses appear as counts",
      "",
      "## Acceptance",
      "1. Recorded status changes move cards without a manual refresh",
      "2. Done tasks stay visible in the Done column",
      "",
      "> Display only: the board never edits task records.",
      "",
      "## History",
      "- 2026-01-10 14:30 · Assigned to dev",
      "- 2026-01-10 14:42 · Developer claimed the task",
    ].join("\n"),
    "0042": "Check that a team in another space or on another machine never lends its agents' status to this one.\n\n```sh\nherdr-team tasks --json\n```",
    "0041": "Document the project binding, the supported local runtimes and where to find the daemon log. Waiting for the install instructions to be finalized.",
    "0049": "Restore the selected task after a connection returns. Keep the selection local to its original space.",
  };
  const requirements = [
    {
      id: "R0008", type: "defect", title: "Delivery notices disappear after reconnect", priority: "P1", iteration: "v1.2",
      body: "A delivery can stay unread when the agent reconnects.", acceptance: "Reconnect with an unread delivery and verify the notice appears once.",
      taskIds: ["0050"],
    },
    {
      id: "R0007", type: "requirement", title: "Project onboarding guide", priority: "P2", iteration: "v1.2",
      body: "Explain how to register a project, start the team and trace a delivery.", acceptance: "Follow the steps from a new project through the first delivered task.",
      taskIds: ["0041"],
    },
    {
      id: "R0006", type: "requirement", title: "Status-based team board", priority: "P1", iteration: "v1.1",
      body: "Show the team's recorded work in one sidebar.", acceptance: "- Keep task status visible.\n- Open a task from its requirement.",
      taskIds: ["0040", "0045", "0046"],
    },
    {
      id: "R0005", type: "defect", title: "Prevent data leaking between spaces", priority: "P1", iteration: "v1.1",
      body: "Switching to an unrelated space must not show the previous team's data.", acceptance: "Verify against two separate local projects.",
      taskIds: ["0042"],
    },
    {
      id: "R0004", type: "defect", title: "Sidebar selection resets on reconnect", priority: "P2", iteration: "v1.0",
      body: "Reconnect restores terminal access but loses the selected task.", acceptance: "After reconnecting, open the same task in the same space.",
      taskIds: ["0049"],
    },
    {
      id: "R0003", type: "requirement", title: "Inspect the Core terminal API", priority: "P2", iteration: "v1.0",
      body: "Verify which terminal and agent fields the host exposes.", acceptance: "Record stable identifiers and supported status events.",
      taskIds: ["0039"], acceptedAt: "2026-01-08T09:00:00Z",
    },
    {
      id: "R0002", type: "defect", title: "Long task names hide the assignee", priority: "P2", iteration: "",
      body: "Long names can crowd out the role on a narrow panel.", acceptance: "Keep the role visible and reveal the full title on hover.",
      taskIds: ["0047"],
    },
    {
      id: "R0001", type: "requirement", title: "Export a weekly delivery summary", priority: "P3", iteration: "",
      body: "Summarize completed and blocked work for a selected week.", acceptance: "", taskIds: [],
    },
  ];
  for (const task of tasks) task.body = bodies[task.id] ?? "";
  for (const card of requirements) {
    card.tasks = tasks.filter(task => card.taskIds.includes(task.id));
    for (const task of card.tasks) task.meta = { ...task.meta, requirement: card.id };
    const total = card.tasks.length;
    const done = card.tasks.filter(task => task.status === "done").length;
    const blocked = card.tasks.filter(task => task.status === "blocked").length;
    card.progress = { total, done, blocked };
    card.status = card.acceptedAt ? "accepted" : total > 0 && done === total ? "ready"
      : card.tasks.some(task => task.status !== "todo") ? "in-progress" : card.iteration ? "planned" : "backlog";
  }
  const terminal = (role, task, status) => ({ address: `sample-${role}`, state: "live", status, program: { agent: true },
    labels: { "team.project": binding.root, "herdr.space": binding.space, "team.role": role, "team.task": task, "team.session": "task",
      "team.runtime": "desktop", "team.delivery": `sample-${task}` } });
  const terminals = [terminal("dev", "0045", "working"), terminal("test", "0042", "blocked"), terminal("doc", "0041", "idle")];
  for (const id of ["0045", "0041"]) {
    const task = tasks.find(task => task.id === id);
    task.meta = { ...task.meta, delivery: { id: `sample-${id}`, role: task.role, state: "claimed", runtime: "desktop", space: binding.space } };
  }
  const inbox = {
    active: [
      { id: "0045", title: tasks.find(task => task.id === "0045").title, role: "dev", state: "claimed", label: "In progress" },
      { id: "0046", title: tasks.find(task => task.id === "0046").title, role: "test", state: "queued",
        label: "Waiting to send", reason: "Waiting for 0045" },
      { id: "sample-mail-1", source: "agentmail", role: "test", state: "pending", label: "Waiting to notify",
        subject: "Reconnect test results", sender: "qa@example.test", received_at: "2026-01-10T07:18:00Z",
        body: "After reconnecting, the task list refreshes and the current selection returns. The delivery notice still needs a regression test." },
    ],
    trash: [
      { id: "sample-mail-2", source: "agentmail", role: "dev", state: "trashed", label: "Project not registered",
        subject: "Task board feedback", sender: "feedback@example.test", received_at: "2026-01-09T08:00:00Z",
        body: "Could the task board show the current assignee on every card?" },
    ],
  };
  return { binding, roles, tasks, terminals, requirements, inbox };
}

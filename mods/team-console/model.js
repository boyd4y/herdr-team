/** Presentation only. These functions never mutate task/delivery records. */
export const sortTasks = tasks => [...tasks].sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));

export function scopedTerminals(terminals, binding) {
  if (!binding?.root || !binding?.space) return [];
  const machine = binding.machine ?? null;
  const prefix = machine ? `${machine}/` : "";
  const space = prefix && binding.space.startsWith(prefix) ? binding.space.slice(prefix.length) : binding.space;
  return terminals.filter(terminal => {
    const address = terminal.address ?? "";
    const local = !address.includes("/");
    return (machine ? address.startsWith(prefix) : local) &&
      terminal.state === "live" && terminal.labels?.["team.project"] === binding.root &&
      (terminal.labels?.["team.owner_space"] ?? terminal.labels?.["herdr.space"]) === space;
  });
}

const rank = { error: 5, blocked: 4, working: 3, done: 2, idle: 1 };
export function roleRows(roles, terminals) {
  return roles.map(role => {
    const instances = terminals.filter(terminal => terminal.labels?.["team.role"] === role.name);
    const status = reportedStatus(instances);
    const harness = role.kind === "acp" && role.preset ? `acp(${role.preset})` : role.kind;
    return { ...role, harness, status, instances };
  });
}

function reportedStatus(instances) {
  return instances.map(terminal => typeof terminal.status === "string" ? terminal.status : terminal.status?.state)
    .filter(value => rank[value]).sort((a, b) => rank[b] - rank[a])[0] ?? "unknown";
}

/** Show recorded current/remaining assignees; never invent previous approvals. */
export function flowNodes(task, roles) {
  if (!task) return [];
  return [task.role, ...(task.handoff ?? [])].map((name, index) => {
    const role = roles.find(role => role.name === name);
    const report = reportedStatus(role?.instances?.filter(terminal => terminal.labels?.["team.task"] === task.id) ?? []);
    const status = index ? "next" : task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : task.status === "todo" ? "ready" : report === "unknown" ? "assigned" : report === "done" ? "awaiting handoff" : report;
    return { name, status, harness: role?.harness ?? "—", model: role?.model ?? "default" };
  });
}

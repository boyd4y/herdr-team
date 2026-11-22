/** Presentation only. These functions never mutate task/delivery records. */
export const sortTasks = tasks => [...tasks].sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));

const iterationPattern = /^v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function iterationVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  return iterationPattern.test(version) ? version : "";
}

export function iterationOptions(cards) {
  const versions = new Set(cards.map(card => iterationVersion(card.iteration)).filter(Boolean));
  return [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function iterationGroups(iterations, cards) {
  const rows = iterations ?? iterationOptions(cards).map(version => ({ version, state: "active" }));
  return ["active", "archived"].map(state => ({
    state,
    versions: rows.filter(row => row.state === state).map(row => row.version)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
  })).filter(group => group.versions.length);
}

export function tasksWithIterations(tasks, issues) {
  const issueVersions = new Map(issues.map(issue => [issue.id, issue.iteration]));
  return tasks.map(task => ({ ...task,
    iteration: iterationVersion(task.iteration ?? (iterationVersion(task.meta?.iteration) || issueVersions.get(task.meta?.requirement))) }));
}

export function tasksForIteration(tasks, iteration) {
  return iteration === null ? tasks : tasks.filter(task => task.iteration === iteration);
}

const ISSUE_STATUSES = {
  ready: "Ready", "in-progress": "In progress", planned: "Planned",
  backlog: "Backlog", accepted: "Accepted",
};

export const issueStatusLabel = status => ISSUE_STATUSES[status] ?? status;

export function requirementsForIteration(requirements, iteration, type = null) {
  return requirements.filter(card => card.disposition !== "deleted" &&
    (iteration === null || iterationVersion(card.iteration) === iteration) && (type === null || card.type === type));
}

export function groupIssues(requirements, iteration, type) {
  const groups = new Map(Object.keys(ISSUE_STATUSES).map(status => [status, []]));
  const archived = [];
  for (const card of requirementsForIteration(requirements, iteration, type)) {
    if (card.disposition === "archived") { archived.push(card); continue; }
    const { status } = card;
    if (!groups.has(status)) groups.set(status, []);
    groups.get(status).push(card);
  }
  return { groups: [...groups].filter(([, cards]) => cards.length).map(([status, cards]) => ({ status, cards })), archived };
}

/** The shown space is a lookup key, never evidence of project ownership. */
export function teamSpace(spaces, terminals) {
  const space = spaces.find(space => space.active);
  if (!space) return null;
  const prefix = space.machine ? `${space.machine}/` : "";
  const id = prefix && space.id.startsWith(prefix) ? space.id.slice(prefix.length) : space.id;
  // Labels only invalidate a lookup after up creates/reuses a resident. The CLI
  // registry remains authoritative; neither cwd nor display names supply roots.
  const bindings = terminals.filter(terminal => (prefix ? terminal.address.startsWith(prefix) : !terminal.address.includes("/"))
    && terminal.state === "live" && (terminal.labels?.["team.owner_space"] === id || terminal.labels?.["herdr.space"] === id))
    .map(terminal => [terminal.address, terminal.labels?.["team.project"], terminal.labels?.["team.owner_space"], terminal.labels?.["herdr.space"]]).sort();
  return { space, localId: id, key: JSON.stringify([space.id, space.machine ?? null, bindings]) };
}

export function consoleBinding(binding, space) {
  if (!binding) return null;
  const prefix = space.machine ? `${space.machine}/` : "";
  const id = space.id.slice(prefix.length);
  if (!space.id.startsWith(prefix) || !id || id.includes("/") || (binding.view_space ?? binding.space) !== id ||
      binding.machine !== null || typeof binding.root !== "string" || !binding.root.startsWith("/") ||
      typeof binding.space !== "string" || !binding.space || binding.space.includes("/") ||
      binding.view_space && (!/^\d{4}$/.test(binding.task ?? "") && !/^[a-z0-9]+(?:-[a-z0-9]+)*@v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(binding.feature ?? "") ||
        typeof binding.checkout !== "string" || !binding.checkout.startsWith("/"))) {
    throw new Error("Invalid project space binding returned by the CLI");
  }
  return { root: binding.root, space: `${prefix}${binding.space}`, machine: space.machine ?? null };
}

export function sameTeam(a, b) {
  return Boolean(a && b && a.root === b.root && a.space === b.space && (a.machine ?? null) === (b.machine ?? null));
}

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
    return { ...role, harness: role.kind, status, instances };
  });
}

function explicitModel(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return /^[^-\s\x00-\x1f\x7f][^\s\x00-\x1f\x7f]*$/u.test(name) &&
    !["default", "auto", "unknown"].includes(name.toLowerCase()) ? name : null;
}

function modelArgument(argv, kind) {
  const flags = kind === "codex" ? ["--model", "-m"] : ["--model"];
  let model = null;
  for (let index = 0; index < argv.length && argv[index] !== "--"; index++) {
    const flag = flags.find(flag => argv[index] === flag || argv[index].startsWith(`${flag}=`));
    if (flag) model = explicitModel(argv[index] === flag ? argv[++index] : argv[index].slice(flag.length + 1));
  }
  return model;
}

function sentDelivery(task) {
  const delivery = task.meta?.delivery;
  return delivery?.role === task.role && ["sending", "submitted", "claimed", "uncertain"].includes(delivery?.state) ? delivery : null;
}

function taskTerminal(task, role, delivery) {
  if (delivery?.runtime !== "desktop" || typeof delivery.id !== "string" || !delivery.id || !delivery.space) return null;
  const instances = role?.instances?.filter(terminal => {
    const labels = terminal.labels;
    return labels?.["team.runtime"] === "desktop" && labels["team.role"] === task.role && labels["team.task"] === task.id &&
      labels["team.delivery"] === delivery.id && (labels["team.owner_space"] ?? labels["herdr.space"]) === delivery.space &&
      (!delivery.terminal || terminal.address?.split("/").at(-1) === delivery.terminal) &&
      (!delivery.process_id || terminal.pid === delivery.process_id) && terminal.program?.agent === true;
  });
  return instances?.length === 1 ? instances[0] : null;
}

/** Roles and instances have already been scoped to the visible project and space. */
export function taskAssignee(task, roles, programs) {
  const name = task.role || "Unassigned";
  const role = roles.find(role => role.name === task.role);
  const delivery = sentDelivery(task);
  const completed = task.meta?.completed_deliveries;
  const historical = !task.meta?.delivery && Array.isArray(completed) && completed.some(id => typeof id === "string" && id.length > 0);
  if (!role || (!delivery && !historical)) return { name, program: null, model: null, live: false, modelSource: null };
  const terminal = taskTerminal(task, role, delivery);
  const launched = terminal ? modelArgument(terminal.argv?.slice(1) ?? [], terminal.program.key) : null;
  const configured = modelArgument(role.args ?? [], role.kind) ?? explicitModel(role.model);
  const program = terminal?.program ?? programs.get(role.kind) ?? null;
  return { name, program, model: launched ?? configured, live: Boolean(terminal), modelSource: launched ? "launch" : configured ? "role" : null };
}

function terminalStatus(terminal) {
  return typeof terminal?.status === "string" ? terminal.status : terminal?.status?.state;
}

function reportedStatus(instances) {
  return instances.map(terminalStatus).filter(value => rank[value]).sort((a, b) => rank[b] - rank[a])[0] ?? "unknown";
}

/** Show recorded current/remaining assignees; never invent previous approvals. */
export function flowNodes(task, roles) {
  if (!task) return [];
  const folder = taskFolder(task);
  const delivery = task.meta?.integration ? null : sentDelivery(task);
  return [task.role, ...(folder === "current" ? task.handoff ?? [] : [])].map((name, index) => {
    const role = roles.find(role => role.name === name);
    const report = index === 0 ? terminalStatus(taskTerminal(task, role, delivery)) : undefined;
    const status = index ? "next" : folder !== "current" ? folder : task.status === "done" ? "done" : task.status === "blocked" ? "blocked"
      : task.status === "todo" ? "ready" : !rank[report] ? "assigned" : report === "done" ? "awaiting handoff" : report === "blocked" ? "needs input" : report;
    return { name, status, harness: role?.harness ?? "—", model: role?.model ?? "default" };
  });
}

export function taskFolder(task) {
  if (task.status === "deleted" || task.meta?.disposition === "deleted") return "trash";
  if (task.status === "archived" || task.status === "cancelled" || task.meta?.disposition === "archived") return "archive";
  return "current";
}

const finished = task => task.status === "done" || taskFolder(task) !== "current";

/** Review remains the recorded Task status until the integration succeeds. */
export function taskReviewPhase(task) {
  if (task.status !== "review") return null;
  switch (task.meta?.integration?.state) {
    case "queued": return "Awaiting merge";
    case "running": return "Merging";
    case "blocked": return "Merge blocked";
    default: return "Awaiting review";
  }
}

const attentionOrder = { blocked: 0, review: 1, doing: 2, todo: 3, done: 5 };

/** Sidebar list: recorded blockers/reviews first, newest first within each status. */
export function listTasks(tasks, filter = "all") {
  const current = sortTasks(tasks.filter(task => taskFolder(task) === "current"));
  if (filter === "all") return current;
  return current
    .filter(task => filter === "open" ? !finished(task) : task.status === filter)
    .sort((a, b) => (attentionOrder[a.status] ?? 4) - (attentionOrder[b.status] ?? 4));
}

export function listFilters(tasks) {
  return [
    { status: "all", title: "All", count: tasks.filter(task => taskFolder(task) === "current").length },
    { status: "open", title: "Open", count: tasks.filter(task => !finished(task)).length },
    ...boardColumns(tasks)
      .sort((a, b) => (attentionOrder[a.status] ?? 4) - (attentionOrder[b.status] ?? 4))
      .map(column => ({ status: column.status, title: column.title, count: column.tasks.length })),
  ];
}

export function taskDocument(body) {
  const heading = /^##[ \t]*(?:History|流转记录)[ \t]*\r?$/m.exec(body);
  if (!heading) return { description: body.trim(), history: "" };
  return {
    description: body.slice(0, heading.index).trim(),
    history: body.slice(heading.index + heading[0].length).replace(/^<!-- team-operation:[^\r\n]* -->[ \t]*(?:\r?\n|$)/gm, "").trim(),
  };
}

/** List view sections: in flight, not started, finished. Each keeps newest first. */
export function groupTasks(tasks) {
  const sorted = sortTasks(tasks.filter(task => taskFolder(task) === "current"));
  return {
    active: sorted.filter(task => !finished(task) && task.status !== "todo"),
    todo: sorted.filter(task => task.status === "todo"),
    done: sorted.filter(finished),
  };
}

/** Dependencies not yet finished, as recorded; unknown IDs count as unfinished. */
export function waitingOn(task, tasks) {
  return (task.dependsOn ?? []).filter(id => tasks.find(other => other.id === id)?.status !== "done");
}

/** Recorded task status alone chooses the column; handoffs and agent reports do not. */
export function boardColumns(tasks) {
  const sorted = sortTasks(tasks.filter(task => taskFolder(task) === "current"));
  const columns = [
    { status: "todo", title: "Todo" },
    { status: "doing", title: "In progress" },
    { status: "review", title: "Review" },
    { status: "blocked", title: "Blocked" },
    { status: "done", title: "Done" },
  ];
  // Retain future workflow statuses in the current view.
  const known = new Set(columns.map(column => column.status));
  for (const task of sorted) {
    if (!known.has(task.status)) {
      columns.push({ status: task.status, title: task.status || "Unknown" });
      known.add(task.status);
    }
  }
  return columns.map(column => ({ ...column, tasks: sorted.filter(task => task.status === column.status) }));
}

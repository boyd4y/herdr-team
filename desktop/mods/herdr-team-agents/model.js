import { absolutePath } from "./platform.js";

// Match the installed Spaces mod's avatar colors, indexed by actual space ID.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export function spaceColor(id, colors, theme) {
  const key = colors?.[id] ?? "ansi6";
  return key.startsWith("#") ? key : MARK[key] ?? theme[key] ?? theme.dim;
}

/** Validate explicit terminal scope; a display name never supplies ownership. */
export function agentTeam(agent, terminal) {
  const labels = terminal?.labels;
  if (terminal?.address !== agent.address || terminal.state !== "live" || !absolutePath(labels?.["team.project"]) || !labels["team.role"]) return null;
  const machine = agent.address.includes("/") ? agent.address.slice(0, agent.address.indexOf("/")) : null;
  const prefix = machine ? `${machine}/` : "";
  if (prefix && !agent.space.startsWith(prefix) || !prefix && agent.space.includes("/")) return null;
  const actualSpace = prefix ? agent.space.slice(prefix.length) : agent.space;
  if (labels["herdr.space"] !== actualSpace) return null;
  const owner = labels["team.owner_space"] ?? actualSpace;
  if (!owner || owner.includes("/")) return null;
  const root = labels["team.project"];
  return { root, machine, owner, role: labels["team.role"], task: labels["team.task"] ?? null,
    session: labels["team.session"] ?? null, key: JSON.stringify([machine, owner, root]) };
}

/** Presentation grouping only. Parent ownership must have passed the CLI registry check. */
export function agentGroup(agent, terminal, spaces, teams) {
  const fallback = { id: `sp-${agent.space}`, label: agent.space_name || "", space: agent.space };
  const team = agentTeam(agent, terminal);
  const state = team && teams.get(team.key);
  if (!state?.verified || state.root !== team.root || state.owner !== team.owner || (state.machine ?? null) !== team.machine) return fallback;
  const parentId = `${team.machine ? `${team.machine}/` : ""}${team.owner}`;
  const parent = spaces.find(space => space.id === parentId && (space.machine ?? null) === team.machine);
  return parent ? { id: `sp-${parentId}`, label: parent.name, space: parentId } : fallback;
}

/** Gather nonadjacent members once; flattening these groups also supplies keyboard order. */
export function groupAgents(agents, terminals, spaces, teams) {
  const byAddress = new Map(terminals.map(terminal => [terminal.address, terminal]));
  const groups = new Map();
  for (const agent of agents) {
    const group = agentGroup(agent, byAddress.get(agent.address), spaces, teams);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, status: null, members: [] });
    groups.get(group.id).members.push(agent);
  }
  return [...groups.values()];
}

/** Brief responsibilities, preserving custom prose without inventing a role map. */
export function roleDescription(role) {
  const explicit = role?.meta?.description;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const body = String(role?.body ?? "").replace(/\r/g, "").replace(/^\s*#+\s+.*$/gm, "");
  const sentences = body.split(/\n+|(?<=[.!?。！？])\s+/u).map(line => line.replace(/^\s*(?:#+|[-*]|\d+[.)、])\s*/, "").trim()).filter(Boolean);
  return sentences.find(line => !/^(?:read\b|you are\b)/i.test(line))
    ?? sentences.find(line => !/^read\b/i.test(line)) ?? "";
}

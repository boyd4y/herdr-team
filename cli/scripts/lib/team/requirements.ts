import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withTeamLock } from "../runtime/state.ts";
import { replaceFile } from "../shared/atomic-file.ts";
import { PRIORITIES, type CardDisposition, type Project, type TaskCard } from "../shared/types.ts";
import { createIssue, eraseDeletedIssueText, issueIds, listIssueMetadata, migrateIssueStore, readIssue, RequirementError, requireIssueMetadata, saveIssue, saveIssueMetadata,
  type Requirement, type RequirementMetadata, type RequirementType } from "./issue-store.ts";
import { loadProject } from "./project.ts";

type RequirementFields = Omit<Requirement, "id" | "acceptedAt" | "disposition">;
export const REQUIREMENT_STATUSES = ["backlog", "planned", "in-progress", "ready", "accepted"] as const;
const versionPattern = /^v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const iterationFilename = (project: Project) => join(project.herdrDir, "iterations.json");
type HiddenIterationState = "archived" | "deleted";
type IterationState = "active" | HiddenIterationState;

export function matchesIteration(version: string, selected: string | undefined, hidden: ReadonlyMap<string, HiddenIterationState>): boolean {
  if (selected !== undefined && version !== selected) return false;
  const state = hidden.get(version);
  return state === undefined || state === "archived" && selected === version;
}

export function iterationVersion(value: string): string {
  const version = value.trim();
  return versionPattern.test(version) ? version : "";
}

export function validateIteration(value: string): string {
  if (value.trim() && !iterationVersion(value)) {
    throw new RequirementError("Use a version number such as v1.1 for --iteration");
  }
  return iterationVersion(value);
}

export function taskIteration(task: TaskCard, issueIterations: ReadonlyMap<string, string>): string {
  const { iteration, requirement } = task.meta;
  const own = typeof iteration === "string" ? iterationVersion(iteration) : "";
  return own || (typeof requirement === "string" ? issueIterations.get(requirement) ?? "" : "");
}

function projectIterations(project: Project): Set<string> {
  const versions = listIssueMetadata(project).map(card => iterationVersion(card.iteration));
  for (const task of project.tasks) {
    if (typeof task.meta.iteration === "string") versions.push(iterationVersion(task.meta.iteration));
  }
  return new Set(versions.filter(Boolean));
}

export function readHiddenIterations(project: Project): Map<string, HiddenIterationState> {
  let text: string;
  try { text = readFileSync(iterationFilename(project), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const states = new Map<string, HiddenIterationState>();
    for (const [version, state] of Object.entries(raw)) {
      if (!versionPattern.test(version) || state !== "archived" && state !== "deleted") throw new Error();
      states.set(version, state);
    }
    return states;
  } catch { throw new RequirementError("Invalid .herdr/iterations.json"); }
}

export function iterationRows(project: Project, all: boolean) {
  const hidden = readHiddenIterations(project);
  const versions = projectIterations(project);
  if (all) for (const version of hidden.keys()) versions.add(version);
  return [...versions].filter(version => all || !hidden.has(version))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(version => ({ version, state: hidden.get(version) ?? "active" }));
}

export function setIterationState(project: Project, version: string, state: IterationState) {
  if (!versionPattern.test(version)) throw new RequirementError("Use an iteration version number such as v1.1");
  return withTeamLock(project, "queue", () => {
    const hidden = readHiddenIterations(project);
    if (!hidden.has(version) && !projectIterations(loadProject(project.root, { taskBodies: false, roleBodies: false })).has(version)) {
      throw new RequirementError(`Iteration ${version} not found`);
    }
    if ((hidden.get(version) ?? "active") !== state) {
      if (state === "active") hidden.delete(version);
      else hidden.set(version, state);
      replaceFile(iterationFilename(project), JSON.stringify(Object.fromEntries(hidden), null, 2) + "\n", 0o600);
    }
    return { version, state };
  });
}

export function requirementType(value: string): RequirementType {
  if (value === "requirement" || value === "defect") return value;
  throw new RequirementError("Use requirement or defect for --type");
}

function fields(input: RequirementFields): RequirementFields {
  const title = input.title.trim();
  if (!title || /[\r\n]/.test(title)) throw new RequirementError("A single-line title is required");
  if (!(PRIORITIES as readonly string[]).includes(input.priority)) throw new RequirementError(`Use one of ${PRIORITIES.join(", ")} for --priority`);
  return { ...input, title };
}

export function addRequirement(project: Project, input: RequirementFields): Requirement {
  const validated = { ...fields(input), iteration: validateIteration(input.iteration) };
  return withTeamLock(project, "queue", () => {
    migrateIssueStore(project);
    const last = issueIds(project).at(-1);
    const number = (last ? Number(last.slice(1)) : 0) + 1;
    if (number > 9999) throw new RequirementError("Requirement IDs exhausted");
    const card = { id: "R" + String(number).padStart(4, "0"), ...validated, acceptedAt: null };
    createIssue(project, card);
    return card;
  });
}

export function editRequirements(project: Project, ids: string[], patch: Partial<RequirementFields>): Requirement[] {
  const iteration = patch.iteration === undefined ? undefined : validateIteration(patch.iteration);
  return withTeamLock(project, "queue", () => {
    migrateIssueStore(project);
    const edits = [...new Set(ids)].map(id => {
      const card = readIssue(project, id);
      if (card.acceptedAt && (patch.acceptance !== undefined || patch.body !== undefined)) {
        throw new RequirementError(`${id} has been accepted; its description and acceptance criteria are recorded`);
      }
      return { previous: card, next: { ...card, ...fields({ ...card, ...patch, iteration: iteration ?? card.iteration }) } };
    });
    for (const { previous, next } of edits) saveIssue(project, next, previous);
    return edits.map(({ next }) => next);
  });
}

export function indexRequirementTasks(project: Project): Map<string, TaskCard[]> {
  const byIssue = new Map<string, TaskCard[]>();
  for (const task of project.tasks) {
    const id = task.meta.requirement;
    if (typeof id !== "string") continue;
    const linked = byIssue.get(id);
    if (linked) linked.push(task);
    else byIssue.set(id, [task]);
  }
  return byIssue;
}

export function requirementSummary(card: RequirementMetadata, tasks: readonly Pick<TaskCard, "status">[]) {
  const total = tasks.length, done = tasks.filter(task => task.status === "done").length;
  const blocked = tasks.filter(task => task.status === "blocked").length;
  const iteration = iterationVersion(card.iteration);
  const status = card.acceptedAt ? "accepted" : total > 0 && done === total ? "ready"
    : tasks.some(task => task.status !== "todo") ? "in-progress" : iteration ? "planned" : "backlog";
  return { ...card, iteration, status, progress: { total, done, blocked } };
}

export function requirementDetail(project: Project, card: Requirement) {
  const tasks = project.tasks.filter(task => task.meta.requirement === card.id)
    .map(({ id, title, status, role }) => ({ id, title, status, role }));
  const { body, acceptance, ...meta } = card;
  return { ...requirementSummary(meta, tasks), body, acceptance, tasks };
}

export function acceptRequirement(project: Project, id: string): Requirement {
  return withTeamLock(project, "queue", () => {
    migrateIssueStore(project);
    const card = readIssue(project, id);
    if (card.acceptedAt) return card;
    if (card.disposition) throw new RequirementError(`Restore ${id} before accepting it`);
    const fresh = loadProject(project.root, { taskBodies: false, roleBodies: false });
    const unfinished = fresh.tasks.filter(task => task.meta.requirement === id && task.status !== "done");
    if (unfinished.length) throw new RequirementError(`Finish the linked tasks before accepting ${id}: ${unfinished.map(task => task.id).join(", ")}`);
    const accepted = { ...card, acceptedAt: new Date().toISOString() };
    saveIssue(project, accepted, card);
    return accepted;
  });
}

export function setRequirementDisposition(project: Project, id: string, disposition?: CardDisposition): RequirementMetadata {
  return withTeamLock(project, "queue", () => {
    const card = requireIssueMetadata(project, id);
    if (card.disposition === "deleted" && disposition !== "deleted") throw new RequirementError(`Issue ${id} was permanently deleted`);
    if (card.disposition === disposition && disposition !== "deleted") return card;
    migrateIssueStore(project);
    const { disposition: _previous, ...metadata } = card;
    const updated = disposition === undefined ? metadata : { ...metadata, disposition };
    saveIssueMetadata(project, updated, card);
    if (disposition === "deleted") eraseDeletedIssueText(project, id);
    return updated;
  });
}

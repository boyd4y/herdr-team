import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTeamLock } from "../runtime/state.ts";
import { PRIORITIES, type Project, type TaskCard } from "../shared/types.ts";
import { loadProject } from "./project.ts";

export const REQUIREMENT_TYPES = ["requirement", "defect"] as const;
export type RequirementType = typeof REQUIREMENT_TYPES[number];
export class RequirementError extends Error {}

interface RequirementFields {
  title: string;
  type: RequirementType;
  priority: string;
  iteration: string;
  body: string;
  acceptance: string;
}

export interface Requirement extends RequirementFields {
  id: string;
  acceptedAt: string | null;
}

const filename = (project: Project) => join(project.herdrDir, "requirements.json");
const idPattern = /^R\d{4}$/;
const versionPattern = /^v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const iterationFilename = (project: Project) => join(project.herdrDir, "iterations.json");
type HiddenIterationState = "archived" | "deleted";
type IterationState = "active" | HiddenIterationState;

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
  const versions = readRequirements(project).map(card => iterationVersion(card.iteration));
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
    if (!hidden.has(version) && !projectIterations(loadProject(project.root)).has(version)) {
      throw new RequirementError(`Iteration ${version} not found`);
    }
    if ((hidden.get(version) ?? "active") !== state) {
      if (state === "active") hidden.delete(version);
      else hidden.set(version, state);
      writeJson(iterationFilename(project), Object.fromEntries(hidden));
    }
    return { version, state };
  });
}

export function requirementType(value: string): RequirementType {
  if (value === "requirement" || value === "defect") return value;
  throw new RequirementError("Use requirement or defect for --type");
}

export function readRequirements(project: Project): Requirement[] {
  let text: string;
  try { text = readFileSync(filename(project), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error();
    const ids = new Set<string>();
    for (const card of raw) {
      if (!card || typeof card.id !== "string" || !idPattern.test(card.id) || ids.has(card.id) ||
          typeof card.title !== "string" || !card.title.trim() || !REQUIREMENT_TYPES.includes(card.type) ||
          !(PRIORITIES as readonly string[]).includes(card.priority) || typeof card.iteration !== "string" ||
          typeof card.body !== "string" || typeof card.acceptance !== "string" ||
          card.acceptedAt !== null && (typeof card.acceptedAt !== "string" || !Number.isFinite(Date.parse(card.acceptedAt)))) throw new Error();
      ids.add(card.id);
    }
    return raw as Requirement[];
  } catch { throw new RequirementError("Invalid .herdr/requirements.json"); }
}

function writeJson(destination: string, value: unknown): void {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { force: true }); }
}

export function findRequirement(cards: Requirement[], id: string): Requirement {
  const card = cards.find(candidate => candidate.id === id);
  if (!card) throw new RequirementError(`Requirement ${id} not found`);
  return card;
}

function fields(input: RequirementFields): RequirementFields {
  const title = input.title.trim();
  if (!title || /[\r\n]/.test(title)) throw new RequirementError("A single-line title is required");
  if (!(PRIORITIES as readonly string[]).includes(input.priority)) throw new RequirementError(`Use one of ${PRIORITIES.join(", ")} for --priority`);
  return { ...input, title };
}

export function addRequirement(project: Project, input: RequirementFields): Requirement {
  return withTeamLock(project, "queue", () => {
    const cards = readRequirements(project);
    const number = cards.reduce((max, card) => Math.max(max, Number(card.id.slice(1))), 0) + 1;
    if (number > 9999) throw new RequirementError("Requirement IDs exhausted");
    const card = { id: "R" + String(number).padStart(4, "0"), ...fields(input), iteration: validateIteration(input.iteration), acceptedAt: null };
    writeJson(filename(project), [...cards, card]);
    return card;
  });
}

export function editRequirements(project: Project, ids: string[], patch: Partial<RequirementFields>): Requirement[] {
  return withTeamLock(project, "queue", () => {
    const cards = readRequirements(project);
    const iteration = patch.iteration === undefined ? undefined : validateIteration(patch.iteration);
    const edited = new Map([...new Set(ids)].map(id => {
      const card = findRequirement(cards, id);
      if (card.acceptedAt && (patch.acceptance !== undefined || patch.body !== undefined)) {
        throw new RequirementError(`${id} has been accepted; its description and acceptance criteria are recorded`);
      }
      return [id, { ...card, ...fields({ ...card, ...patch, iteration: iteration ?? card.iteration }) }] as const;
    }));
    writeJson(filename(project), cards.map(card => edited.get(card.id) ?? card));
    return [...edited.values()];
  });
}

export function requirementDetail(project: Project, card: Requirement) {
  const tasks = project.tasks.filter(task => task.meta["requirement"] === card.id)
    .map(({ id, title, status, role }) => ({ id, title, status, role }));
  const total = tasks.length, done = tasks.filter(task => task.status === "done").length;
  const blocked = tasks.filter(task => task.status === "blocked").length;
  const iteration = iterationVersion(card.iteration);
  const status = card.acceptedAt ? "accepted" : total > 0 && done === total ? "ready"
    : tasks.some(task => task.status !== "todo") ? "in-progress" : iteration ? "planned" : "backlog";
  return { ...card, iteration, status, progress: { total, done, blocked }, tasks };
}

export function requirementSummary(project: Project, card: Requirement) {
  const { body: _body, acceptance: _acceptance, tasks: _tasks, ...summary } = requirementDetail(project, card);
  return summary;
}

export function acceptRequirement(project: Project, id: string): Requirement {
  return withTeamLock(project, "queue", () => {
    const cards = readRequirements(project);
    const card = findRequirement(cards, id);
    if (card.acceptedAt) return card;
    const unfinished = requirementDetail(loadProject(project.root), card).tasks.filter(task => task.status !== "done");
    if (unfinished.length) throw new RequirementError(`Finish the linked tasks before accepting ${id}: ${unfinished.map(task => task.id).join(", ")}`);
    const accepted = { ...card, acceptedAt: new Date().toISOString() };
    writeJson(filename(project), cards.map(candidate => candidate.id === id ? accepted : candidate));
    return accepted;
  });
}

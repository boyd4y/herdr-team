import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFile } from "../shared/atomic-file.ts";
import { PRIORITIES, type Project } from "../shared/types.ts";
import { emitYaml, parseYaml } from "../shared/yaml.ts";

export type RequirementType = "requirement" | "defect";
export class RequirementError extends Error {}

export interface RequirementMetadata {
  id: string;
  title: string;
  type: RequirementType;
  priority: string;
  iteration: string;
  acceptedAt: string | null;
}

export interface Requirement extends RequirementMetadata {
  body: string;
  acceptance: string;
}

export const ISSUE_DIRECTORY = "issues";
export const LEGACY_ISSUES = "requirements.json";
export const ISSUE_BACKUP = ".legacy-requirements.json";
const metadataName = ".issue.yaml";
const bodyName = "issue.md";
const acceptanceName = "acceptance.md";
const metadataOrder = ["title", "type", "priority", "iteration", "acceptedAt"];
const idPattern = /^R\d{4}$/;
type IssueProject = Pick<Project, "herdrDir">;

function exists(path: string, kind: "file" | "directory"): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!(kind === "file" ? stat.isFile() : stat.isDirectory())) {
    throw new RequirementError(`Expected an issue ${kind} at ${path}`);
  }
  return true;
}

function metadata(raw: unknown, id: string): RequirementMetadata | undefined {
  if (!raw || typeof raw !== "object") return;
  const { title, type, priority, iteration, acceptedAt } = raw as Record<string, unknown>;
  if (!idPattern.test(id) || typeof title !== "string" || !title.trim() ||
      type !== "requirement" && type !== "defect" || typeof priority !== "string" ||
      !(PRIORITIES as readonly string[]).includes(priority) || typeof iteration !== "string" ||
      acceptedAt !== null && (typeof acceptedAt !== "string" || !Number.isFinite(Date.parse(acceptedAt)))) return;
  return { id, title, type, priority, iteration, acceptedAt };
}

function readLegacy(project: IssueProject): { text: string; cards: Requirement[] } | undefined {
  const path = join(project.herdrDir, LEGACY_ISSUES);
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error();
    const ids = new Set<string>();
    const cards = parsed.map(raw => {
      const fields = typeof raw?.id === "string" ? metadata(raw, raw.id) : undefined;
      if (!fields || ids.has(fields.id) || typeof raw.body !== "string" || typeof raw.acceptance !== "string") throw new Error();
      ids.add(fields.id);
      return { ...fields, body: raw.body, acceptance: raw.acceptance };
    });
    return { text, cards };
  } catch { throw new RequirementError(`Invalid .herdr/${LEGACY_ISSUES}`); }
}

function issueRoot(project: IssueProject): string {
  return join(project.herdrDir, ISSUE_DIRECTORY);
}

export function issueIds(project: IssueProject): string[] {
  const root = issueRoot(project);
  if (!exists(root, "directory")) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!idPattern.test(entry.name)) return [];
    if (!entry.isDirectory()) throw new RequirementError(`Expected an issue directory at ${join(root, entry.name)}`);
    return [entry.name];
  }).sort();
}

function readMetadata(directory: string, id: string): RequirementMetadata {
  const path = join(directory, metadataName);
  if (exists(path, "file")) {
    const fields = metadata(parseYaml(readFileSync(path, "utf8")), id);
    if (fields) return fields;
  }
  throw new RequirementError(`Invalid issue metadata at ${path}`);
}

/** A crash after publication can leave the original where older clients expect it. */
function duplicateLegacyPath(project: IssueProject, root: string): string | undefined {
  const path = join(project.herdrDir, LEGACY_ISSUES);
  if (!exists(path, "file")) return;
  const backup = join(root, ISSUE_BACKUP);
  try {
    if (readFileSync(path).equals(readFileSync(backup))) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!exists(path, "file")) return;
  }
  throw new RequirementError(`Conflicting issue records in .herdr/${LEGACY_ISSUES} and .herdr/${ISSUE_DIRECTORY}; inspect both before continuing`);
}

function issueCollection(project: IssueProject): { root: string } | { legacy: Requirement[] } {
  const root = issueRoot(project);
  if (exists(root, "directory")) {
    duplicateLegacyPath(project, root);
    return { root };
  }
  const legacy = readLegacy(project);
  // A migration may publish the directory between these two reads.
  if (exists(root, "directory")) {
    duplicateLegacyPath(project, root);
    return { root };
  }
  return { legacy: legacy?.cards ?? [] };
}

export function listIssueMetadata(project: IssueProject, ids?: ReadonlySet<string>): RequirementMetadata[] {
  if (ids?.size === 0) return [];
  const store = issueCollection(project);
  if ("legacy" in store) return store.legacy
    .filter(card => !ids || ids.has(card.id))
    .map(({ body: _body, acceptance: _acceptance, ...fields }) => fields);
  if (ids) return [...ids].flatMap(id => {
    const card = findStoredIssueMetadata(store.root, id);
    return card ? [card] : [];
  });
  return issueIds(project).map(id => readMetadata(join(store.root, id), id));
}

function findStoredIssueMetadata(root: string, id: string): RequirementMetadata | undefined {
  if (!idPattern.test(id)) return;
  const directory = join(root, id);
  if (exists(directory, "directory")) return readMetadata(directory, id);
}

export function findIssueMetadata(project: IssueProject, id: string): RequirementMetadata | undefined {
  if (!idPattern.test(id)) return;
  const store = issueCollection(project);
  if ("legacy" in store) {
    const found = store.legacy.find(card => card.id === id);
    return metadata(found, id);
  }
  return findStoredIssueMetadata(store.root, id);
}

export function requireIssueMetadata(project: IssueProject, id: string): RequirementMetadata {
  const card = findIssueMetadata(project, id);
  if (!card) throw new RequirementError(`Requirement ${id} not found`);
  return card;
}

export function readIssue(project: IssueProject, id: string): Requirement {
  if (idPattern.test(id)) {
    const store = issueCollection(project);
    if ("legacy" in store) {
      const found = store.legacy.find(card => card.id === id);
      if (found) return found;
    } else {
      const directory = join(store.root, id);
      if (exists(directory, "directory")) return {
        ...readMetadata(directory, id),
        body: readFileSync(join(directory, bodyName), "utf8"),
        acceptance: readFileSync(join(directory, acceptanceName), "utf8"),
      };
    }
  }
  throw new RequirementError(`Requirement ${id} not found`);
}

function populateIssue(directory: string, card: Requirement): void {
  const { id: _id, body, acceptance, ...fields } = card;
  writeFileSync(join(directory, metadataName), emitYaml(fields, metadataOrder), { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, bodyName), body, { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, acceptanceName), acceptance, { flag: "wx", mode: 0o600 });
}

/** Caller holds the project queue lock. The directory rename publishes the entire migration. */
export function migrateIssueStore(project: IssueProject): number {
  const root = issueRoot(project);
  if (exists(root, "directory")) {
    const duplicate = duplicateLegacyPath(project, root);
    if (duplicate) rmSync(duplicate, { force: true });
    return 0;
  }
  const legacy = readLegacy(project);
  if (!legacy) return 0;
  const stage = mkdtempSync(join(project.herdrDir, ".issues-migrating-"));
  try {
    for (const card of legacy.cards) {
      const directory = join(stage, card.id);
      mkdirSync(directory);
      populateIssue(directory, card);
    }
    // Keep the exact pre-migration input outside all normal reads.
    writeFileSync(join(stage, ISSUE_BACKUP), legacy.text, { flag: "wx", mode: 0o600 });
    renameSync(stage, root);
    rmSync(join(project.herdrDir, LEGACY_ISSUES), { force: true });
    return legacy.cards.length;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/** Publish only a complete directory; readers ignore the temporary sibling. */
export function createIssue(project: IssueProject, card: Requirement): void {
  const root = issueRoot(project);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(root, ".creating-"));
  try {
    populateIssue(stage, card);
    renameSync(stage, join(root, card.id));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function saveIssue(project: IssueProject, card: Requirement, previous: Requirement): void {
  const directory = join(issueRoot(project), card.id);
  const { id: _id, body, acceptance, ...fields } = card;
  const { id: _oldId, body: oldBody, acceptance: oldAcceptance, ...oldFields } = previous;
  if (body !== oldBody) replaceFile(join(directory, bodyName), body, 0o600);
  if (acceptance !== oldAcceptance) replaceFile(join(directory, acceptanceName), acceptance, 0o600);
  const yaml = emitYaml(fields, metadataOrder);
  if (yaml !== emitYaml(oldFields, metadataOrder)) replaceFile(join(directory, metadataName), yaml, 0o600);
}

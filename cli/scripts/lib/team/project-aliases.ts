import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { projectKey } from "../dispatch/team-scope.ts";
import { daemonDirectory, listRegisteredProjects } from "../runtime/daemon-binding.ts";
import { withStateLock } from "../runtime/state.ts";
import { findTeamRoots } from "./project.ts";

export class ProjectAliasError extends Error {}
const aliasName = /^(?![a-f0-9]{12}$)[a-z0-9][a-z0-9._-]{0,63}$/;
const assignedDirectory = () => join(daemonDirectory(), "project-aliases");

function configuredProjects(): Record<string, string> {
  let text: string;
  try { text = readFileSync(join(daemonDirectory(), "projects.toml"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try { parsed = Bun.TOML.parse(text); }
  catch { throw new ProjectAliasError("Invalid projects.toml; use a [projects] table mapping unique names to absolute paths"); }
  const projects = (parsed as { projects?: Record<string, unknown> }).projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects) || Object.entries(projects).some(([name, root]) =>
    !aliasName.test(name) || typeof root !== "string" || !isAbsolute(root))) {
    throw new ProjectAliasError("Invalid [projects] table; give each project a unique name and an absolute path");
  }
  return projects as Record<string, string>;
}

function savedAliases(): [string, string][] {
  const aliases: [string, string][] = [];
  const directory = assignedDirectory();
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return aliases;
    throw error;
  }
  for (const file of files) {
    const name = file.slice(0, -5);
    if (!file.endsWith(".json") || !aliasName.test(name)) continue;
    const root: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (typeof root !== "string" || !isAbsolute(root)) throw new ProjectAliasError(`Invalid saved project alias ${name}`);
    aliases.push([name, root]);
  }
  return aliases;
}

function projectAliases(): [string, string][] {
  return [...Object.entries(configuredProjects()), ...savedAliases()];
}

export function aliasesForProject(root: string): string[] {
  const key = projectKey({ root });
  return [...new Set(projectAliases().filter(([, path]) => projectKey({ root: path }) === key).map(([name]) => name))].sort();
}

function removeSavedAliases(root: string, except?: string): void {
  const key = projectKey({ root });
  for (const [name, assigned] of savedAliases()) {
    if (name !== except && projectKey({ root: assigned }) === key) rmSync(join(assignedDirectory(), name + ".json"), { force: true });
  }
}

export function removeProjectAliases(root: string): void {
  withStateLock(join(daemonDirectory(), "project-aliases.lock"), () => removeSavedAliases(root));
}

export function assignProjectAlias(name: string, root: string, replace = false): void {
  if (!aliasName.test(name)) {
    throw new ProjectAliasError("Invalid project name; use up to 64 lowercase letters, digits, dots, underscores or hyphens and avoid project IDs");
  }
  withStateLock(join(daemonDirectory(), "project-aliases.lock"), () => {
    const canonical = realpathSync(root);
    const aliases = projectAliases().filter(([alias]) => alias === name);
    const roots = [...aliases.map(([, path]) => path),
      ...listRegisteredProjects().filter(project => basename(project.root) === name).map(project => project.root)];
    if (roots.some(path => {
      try { return realpathSync(path) !== canonical; }
      catch { return path !== canonical; }
    })) throw new ProjectAliasError(`Project name ${name} is already in use; choose a unique --name`);
    if (!aliases.length) {
      mkdirSync(assignedDirectory(), { recursive: true, mode: 0o700 });
      const target = join(assignedDirectory(), name + ".json");
      const temp = target + "." + randomUUID();
      try {
        writeFileSync(temp, JSON.stringify(canonical), { flag: "wx", mode: 0o600 });
        renameSync(temp, target);
      } finally { rmSync(temp, { force: true }); }
    }
    if (replace) removeSavedAliases(canonical, name);
  });
}

/** Names select canonical project roots. They do not establish Herdr runtime ownership. */
export function rootForInboxProject(selector: string): string {
  const configured = projectAliases();
  const exactAlias = configured.find(([name]) => name === selector);
  if (exactAlias && !statSync(join(exactAlias[1], ".herdr"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new ProjectAliasError(`Inbox project alias ${selector} does not point to a team project: ${exactAlias[1]}`);
  }
  const candidates = [
    ...configured,
    ...[...findTeamRoots(process.cwd()), ...listRegisteredProjects().map(project => project.root)]
      .map(root => [basename(root), root] as const),
  ];
  const roots = new Set<string>();
  for (const [name, root] of candidates) {
    if (name !== selector && (!/^[a-f0-9]{12}$/.test(selector) || projectKey({ root }).slice(0, 12) !== selector)) continue;
    if (statSync(join(root, ".herdr"), { throwIfNoEntry: false })?.isDirectory()) roots.add(realpathSync(root));
  }
  if (roots.size === 1) return [...roots][0]!;
  if (roots.size > 1) {
    throw new ProjectAliasError(`Inbox project ${selector} is ambiguous; use a unique alias, a project ID, or --root DIR with --role ROLE\n  ${[...roots].join("\n  ")}`);
  }
  throw new ProjectAliasError(`Unknown Inbox project ${selector}; use up --name, add an alias in projects.toml, or use --root DIR with --role ROLE`);
}

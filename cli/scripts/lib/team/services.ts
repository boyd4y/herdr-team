import { readFileSync } from "node:fs";
import { join } from "node:path";

export const serviceName = /^[a-z][a-z0-9-]{0,47}$/;

export interface ServiceSpec { name: string; cwd: string; argv: string[] }
export interface ServiceCatalog {
  ports?: { start: number; end: number };
  services: ServiceSpec[];
  workspace?: { requiredServices: string[]; features: Map<string, string[]> };
}

export function requiredFeatureServices(catalog: ServiceCatalog, feature: string): string[] {
  return catalog.workspace?.features.get(feature) ?? catalog.workspace?.requiredServices ?? [];
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readServiceCatalog(root: string): ServiceCatalog {
  const file = "herdr-services.json";
  let raw: string;
  try { raw = readFileSync(join(root, file), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { services: [] };
    throw error;
  }
  const invalid = (message: string): never => { throw new Error(`${file}: ${message}`); };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid("Invalid JSON"); }
  if (!object(value) || Object.keys(value).some(key => !["ports", "services", "workspace"].includes(key)) || !object(value.services)) {
    return invalid("Expected a services object, optional ports range and workspace requirements");
  }
  let ports: ServiceCatalog["ports"];
  if (value.ports !== undefined) {
    const range = value.ports;
    if (!object(range) || Object.keys(range).length !== 2 ||
        typeof range.start !== "number" || typeof range.end !== "number" ||
        !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 1024 || range.end > 65535 || range.start > range.end) {
      return invalid("Expected ports.start and ports.end between 1024 and 65535, in ascending order");
    }
    ports = { start: range.start, end: range.end };
  }
  const services = Object.entries(value.services).map(([name, spec]): ServiceSpec => {
    if (!serviceName.test(name) || !object(spec) || Object.keys(spec).some(key => key !== "cwd" && key !== "argv")) {
      return invalid(`Invalid service ${name}`);
    }
    const cwd = spec.cwd === undefined ? "." : spec.cwd;
    if (typeof cwd !== "string" || !cwd || cwd.includes(":") || cwd.includes("\\") ||
        cwd.includes("\0") || cwd.startsWith("/") || cwd.split("/").includes("..")) {
      return invalid(`${name}.cwd must be a relative path using forward slashes`);
    }
    if (!Array.isArray(spec.argv) || typeof spec.argv[0] !== "string" || !spec.argv[0].trim() ||
        spec.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
      return invalid(`${name}.argv must be a command and its arguments`);
    }
    return { name, cwd, argv: spec.argv };
  });
  if (value.workspace === undefined) return { ports, services };
  const workspace = value.workspace;
  if (!object(workspace) || Object.keys(workspace).some(key => key !== "requiredServices" && key !== "features") ||
      workspace.features !== undefined && !object(workspace.features)) {
    return invalid("Expected workspace.requiredServices and optional workspace.features");
  }
  const known = new Set(services.map(service => service.name));
  const required = (names: unknown, field: string): string[] => {
    if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !known.has(name)) ||
        new Set(names).size !== names.length) return invalid(`${field} must list distinct declared services`);
    return names;
  };
  const requiredServices = workspace.requiredServices === undefined ? [] : required(workspace.requiredServices, "workspace.requiredServices");
  const features = new Map(Object.entries(workspace.features ?? {}).map(([name, names]) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return invalid(`Invalid Feature name ${name} in workspace.features`);
    return [name, required(names, `workspace.features.${name}`)];
  }));
  return { ports, services, workspace: { requiredServices, features } };
}

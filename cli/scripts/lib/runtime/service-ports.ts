import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { requiredFeatureServices, serviceName, type ServiceCatalog } from "../team/services.ts";
import type { Project } from "../shared/types.ts";
import type { DesktopBinding, DesktopClient, DesktopTerminal } from "./desktop.ts";
import { runtimeDirectory, runtimePath, withStateLock } from "./state.ts";

export type FeaturePorts = Record<string, number>;

export function featurePortsFrom(record: { ports?: unknown }): FeaturePorts {
  const { ports } = record;
  if (ports === undefined) return {};
  if (!ports || typeof ports !== "object" || Array.isArray(ports)) throw new Error("Invalid Feature service port reservations");
  const entries = Object.entries(ports);
  if (entries.some(([name, port]) => !serviceName.test(name) || !Number.isInteger(port) || port < 1024 || port > 65535) ||
      new Set(entries.map(([, port]) => port)).size !== entries.length) {
    throw new Error("Invalid Feature service port reservations");
  }
  return ports as FeaturePorts;
}

function featureRecord(file: string): { root: string; space: string; ports?: unknown } | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

export function featurePorts(project: Pick<Project, "root">, binding: DesktopBinding, key: string): FeaturePorts {
  const record = featureRecord(runtimePath(project, `desktop/features/${key}.json`));
  if (!record) return {};
  if (record.root !== binding.root || record.space !== binding.space) throw new Error("Feature service port ownership changed");
  return featurePortsFrom(record);
}

export function withServicePortLock<T>(action: () => T): T {
  return withStateLock(join(runtimeDirectory(), "service-ports.lock"), action);
}

function entries(directory: string) {
  try { return readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

// Feature ports live in the existing ownership records and follow their cleanup.
export function claimedFeaturePorts(): Set<number> {
  const root = join(runtimeDirectory(), "teams");
  const reserved = new Set<number>();
  for (const project of entries(root)) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name, "desktop", "features");
    for (const entry of entries(directory)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = featureRecord(join(directory, entry.name));
      if (record) for (const port of Object.values(featurePortsFrom(record))) reserved.add(port);
    }
  }
  return reserved;
}

export function liveServicePorts(candidates: readonly DesktopTerminal[]): number[] {
  return candidates.filter(terminal => terminal.state === "live" && !terminal.address.includes("/") &&
    terminal.labels["team.session"] === "service").map(item => Number(item.labels["team.service_port"]));
}

export function availablePort(port: number, reserved = new Set<number>()): number | undefined {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    const selected = probe.port;
    probe.stop(true);
    if (selected >= 1024 && !reserved.has(selected)) return selected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
}

export function choosePort(range: ServiceCatalog["ports"], reserved: Set<number>, previous?: number): number {
  if (previous && (!range || previous >= range.start && previous <= range.end) &&
      !reserved.has(previous) && availablePort(previous, reserved)) return previous;
  if (range) {
    for (let port = range.start; port <= range.end; port++) {
      if (!reserved.has(port) && availablePort(port, reserved)) return port;
    }
    throw new Error(`No service port is available in ${range.start}–${range.end}`);
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = availablePort(0, reserved);
    if (port) return port;
  }
  throw new Error("No service port is available");
}

/** Called with the machine port lock held, before writing any workspace ownership. */
export function allocateFeaturePorts(catalog: ServiceCatalog, feature: string, client?: DesktopClient): FeaturePorts {
  const required = requiredFeatureServices(catalog, feature);
  if (!required.length) return {};
  if (!client) throw new Error("Feature service ports require a local Desktop workspace");
  const reserved = claimedFeaturePorts();
  const { terminals } = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { labels: { "team.session": "service" } });
  for (const port of liveServicePorts(terminals)) reserved.add(port);
  return Object.fromEntries(required.map(name => {
    try {
      const port = choosePort(catalog.ports, reserved);
      reserved.add(port);
      return [name, port];
    } catch (error) {
      throw new Error(`Could not reserve a port for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

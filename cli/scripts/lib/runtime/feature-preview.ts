import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { replaceFile } from "../shared/atomic-file.ts";
import { featureWorkspace, workspaceKey, type Project } from "../shared/types.ts";
import { confirmedFeatures, featureKey, FeatureError, validFeature, type FeatureScope } from "../team/features.ts";
import { loadProject } from "../team/project.ts";
import { iterationVersion } from "../team/requirements.ts";
import { desktopTaskSpaces, type DesktopBinding, type DesktopClient, type DesktopTerminal } from "./desktop.ts";
import { inspectDesktopCheckout } from "./desktop-worktrees.ts";
import { runtimePath, withTeamLock } from "./state.ts";

interface Preview extends FeatureScope {
  argv: string[];
  kind: "web" | "desktop";
  tauriBeforeDev?: string;
  port: number;
  state: "queued" | "starting" | "running" | "failed";
  terminal?: string;
  error?: string;
}

const directory = (project: Project) => runtimePath(project, "desktop/previews");
const filename = (project: Project, scope: FeatureScope) => join(directory(project), featureKey(scope) + ".json");
const records = (project: Project): Preview[] => {
  const dir = directory(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".json")).map(name => {
    const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as Preview;
    if (!record || !validFeature(record.feature) || !iterationVersion(record.iteration ?? "") ||
        name !== `${featureKey(record)}.json` || !Array.isArray(record.argv) || !record.argv.length ||
        record.argv.some(arg => typeof arg !== "string") || !["web", "desktop"].includes(record.kind) ||
        !["queued", "starting", "running", "failed"].includes(record.state) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      throw new FeatureError(`Invalid preview record ${name}`);
    }
    return record;
  });
};
const save = (project: Project, preview: Preview) => replaceFile(filename(project, preview), JSON.stringify(preview), 0o600);
export const hasFeaturePreviews = (project: Project) => {
  try { return readdirSync(directory(project)).some(name => name.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

export function featurePreviewStatus(project: Project, scope: FeatureScope) {
  const path = filename(project, scope);
  if (!existsSync(path)) return;
  const { state, kind, port, error } = JSON.parse(readFileSync(path, "utf8")) as Preview;
  return { state, kind, port, ...(kind === "web" ? { url: `http://127.0.0.1:${port}` } : {}), ...(error ? { error } : {}) };
}

export function queueFeaturePreview(project: Project, scope: FeatureScope, retry = false) {
  return withTeamLock(project, "queue", () => {
    const key = featureKey(scope);
    if (confirmedFeatures(project).has(key)) throw new FeatureError(`Feature ${key} was already delivered`);
    if (!loadProject(project.root, { taskBodies: false, roleBodies: false }).tasks.some(task => featureWorkspace(task) && workspaceKey(task) === key)) {
      throw new FeatureError(`Dispatch a task for ${key} before starting its preview`);
    }
    const existing = featurePreviewStatus(project, scope);
    if (existing && (existing.state !== "failed" || !retry)) return existing;
    const path = join(project.root, "herdr-preview.json");
    if (!existsSync(path)) throw new FeatureError("Configure a preview command in herdr-preview.json first");
    const { argv, kind = "web", tauriBeforeDev } = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== "string") || !argv[0] ||
        !["web", "desktop"].includes(kind) || tauriBeforeDev !== undefined && (kind !== "desktop" || typeof tauriBeforeDev !== "string")) {
      throw new FeatureError("herdr-preview.json requires argv and an optional web or desktop kind");
    }
    const used = new Set(records(project).map(record => record.port));
    let port = existing?.port ?? 0;
    if (existing?.port) used.delete(existing.port);
    for (let attempt = 0; attempt < 128 && (!port || used.has(port)); attempt++) {
      const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      port = listener.port!;
      listener.stop(true);
    }
    if (!port || used.has(port)) throw new FeatureError("No free feature preview port");
    mkdirSync(dirname(filename(project, scope)), { recursive: true });
    save(project, { ...scope, argv, kind, tauriBeforeDev, port, state: "queued" });
    return featurePreviewStatus(project, scope)!;
  });
}

/** The daemon submits once, then reconciles the exact Core labels after a restart. */
export function reconcileFeaturePreviews(project: Project, client: DesktopClient, binding: DesktopBinding): void {
  withTeamLock(project, "queue", () => {
    const pending = records(project);
    if (!pending.length) return;
    const delivered = confirmedFeatures(project), spaces = desktopTaskSpaces(client, binding);
    const terminals = client.rpc<{ terminals: DesktopTerminal[] }>("terminal.list", { all: true,
      labels: { "team.project": binding.root, "team.owner_space": binding.space, "team.session": "preview" } }).terminals;
    for (const preview of pending) {
      const key = featureKey(preview);
      const labels = { "team.project": binding.root, "team.owner_space": binding.space, "team.session": "preview", "team.workspace": key };
      const matches = (terminal: DesktopTerminal) => !terminal.address.includes("/") && Object.entries(labels).every(([name, value]) => terminal.labels[name] === value);
      const found = terminals.filter(matches);
      try {
        if (found.length > 1) throw new FeatureError(`Multiple preview terminals for ${key}; inspect them before retrying`);
        if (delivered.has(key)) {
          const terminal = found[0];
          if (terminal) {
            const current = client.rpc<DesktopTerminal>("terminal.get", { terminal: terminal.address });
            if (!matches(current) || current.address !== terminal.address || current.pid !== terminal.pid) throw new FeatureError("Preview terminal ownership changed");
            if (current.state === "live") {
              const stopped = client.rpc<DesktopTerminal>("terminal.kill", { terminal: current.address });
              if (stopped.state !== "finished" || stopped.address !== current.address) throw new FeatureError("Core did not stop the preview");
            } else if (current.state !== "finished") throw new FeatureError("Unknown preview terminal state");
            client.rpc("terminal.rm", { terminal: current.address });
          }
          rmSync(filename(project, preview), { force: true });
          continue;
        }
        if (found[0]?.state === "live") {
          if (preview.state !== "running") save(project, { ...preview, state: "running", terminal: found[0].address });
          continue;
        }
        if (preview.state === "failed") continue;
        if (preview.state !== "queued") throw new FeatureError("Preview exited or launch was interrupted");
        if (found[0]?.state === "finished") client.rpc("terminal.rm", { terminal: found[0].address });
        const task = project.tasks.find(task => featureWorkspace(task) && workspaceKey(task) === key);
        const space = spaces.find(item => item.feature === key);
        if (!task || !space) throw new FeatureError("Feature workspace is unavailable");
        const checkout = inspectDesktopCheckout(project, binding, task);
        if (!checkout.owner || !checkout.tree || realpathSync(checkout.tree.path) !== space.checkout) throw new FeatureError("Feature checkout ownership changed");
        const hash = createHash("sha256").update(binding.root + "\0" + key).digest("hex").slice(0, 12);
        const appId = `dev.herdrteam.preview.p${hash}`;
        const port = String(preview.port);
        const argv = preview.tauriBeforeDev ? [...preview.argv, "--config", JSON.stringify({ identifier: appId,
          build: { devUrl: `http://127.0.0.1:${port}`, beforeDevCommand: preview.tauriBeforeDev } })] : preview.argv;
        const data = runtimePath(project, `desktop/preview-data/${key}`);
        const testPort = Bun.listen({ hostname: "127.0.0.1", port: preview.port, socket: { data() {} } });
        testPort.stop(true);
        save(project, { ...preview, state: "starting" });
        const terminal = client.rpc<DesktopTerminal>("terminal.run", { name: `preview-${hash}`, argv, cwd: space.checkout, no_parent: true, outlive_parent: true,
          env: { PORT: port, HERDR_TEAM_PREVIEW_PORT: port, HERDR_TEAM_PREVIEW_APP_ID: appId, HERDR_TEAM_PREVIEW_DATA_DIR: data },
          labels: { ...labels, "herdr.space": space.space } });
        if (!matches(terminal) || terminal.state !== "live") throw new FeatureError("Core did not confirm a live preview");
        save(project, { ...preview, state: "running", terminal: terminal.address });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (preview.state !== "failed" || preview.error !== message) save(project, { ...preview, state: "failed", error: message });
      }
    }
  });
}

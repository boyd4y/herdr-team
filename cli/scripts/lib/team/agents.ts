import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalKind, KINDS } from "../shared/types.ts";
import { formatColumns } from "../shared/text.ts";
import { readAsset } from "./templates.ts";

export interface AgentPreset {
  command?: string;
  args?: string[];
  model?: string;
  reasoning_effort?: string;
  daemon?: boolean;
  trust?: boolean;
  sandbox?: string;
  approval_policy?: string;
  permission_mode?: string;
  env?: Record<string, string>;
}

export type AgentPresets = Record<string, Record<string, AgentPreset>>;

const fields: Record<string, readonly string[]> = {
  codex: ["reasoning_effort", "daemon", "sandbox", "approval_policy"],
  claude: ["reasoning_effort", "permission_mode"],
  grok: ["trust"],
  acp: ["command", "args", "permission_mode"],
};

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read afresh: project presets are editable data, never a frozen launch snapshot. */
export function readAgentPresets(root?: string): AgentPresets {
  const file = root ? join(root, "agents.json") : undefined;
  try {
    const parsed: unknown = JSON.parse(file ? readFileSync(file, "utf8") : readAsset("agents.json"));
    if (!mapping(parsed)) throw new Error("Expected a mapping of harnesses to presets");
    const presets: Record<string, unknown> = { ...parsed };
    if (Object.hasOwn(presets, "qodercli")) {
      const old = presets.qodercli, current = presets.qoder;
      if (!mapping(old) || (current !== undefined && !mapping(current))) throw new Error("Qoder must contain a preset mapping");
      const duplicate = Object.keys(old).find(name => current && Object.hasOwn(current, name));
      if (duplicate) throw new Error(`Both qoder and qodercli define preset ${duplicate}; keep one definition`);
      presets.qoder = { ...old, ...(current as Record<string, unknown> | undefined) };
      delete presets.qodercli;
    }
    for (const [kind, entries] of Object.entries(presets)) {
      if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`Unsupported harness ${kind}`);
      if (!mapping(entries)) throw new Error(`Harness ${kind} must contain a preset mapping`);
      for (const [name, preset] of Object.entries(entries)) {
        if (!name || !mapping(preset)) throw new Error(`Invalid preset ${kind}/${name}`);
        const allowed = ["model", "env", ...(fields[kind] ?? [])];
        for (const [key, value] of Object.entries(preset)) {
          if (!allowed.includes(key)) throw new Error(`Unsupported field ${key} in preset ${kind}/${name}`);
          if (key === "env") {
            if (!mapping(value) || Object.values(value).some(v => typeof v !== "string")) {
              throw new Error(`Preset ${kind}/${name} env must map strings to strings`);
            }
          } else if (key === "args") {
            if (!Array.isArray(value) || value.some(v => typeof v !== "string" || /[\x00-\x1f\x7f]/.test(v))) throw new Error(`Preset ${kind}/${name} args must be a list of strings without control characters`);
          } else if (key === "daemon" || key === "trust") {
            if (typeof value !== "boolean") throw new Error(`Preset ${kind}/${name} ${key} must be a boolean`);
          } else if (typeof value !== "string" || !value.trim()) {
            throw new Error(`Preset ${kind}/${name} ${key} must be a nonempty string`);
          }
        }
        // Validate native syntax as well as shape before any launch can use the file.
        expandPreset(kind, preset as AgentPreset);
      }
    }
    return presets as AgentPresets;
  } catch (error) {
    throw new Error(`Invalid agent presets ${file ?? "skill/assets/agents.json"}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Defaults are explicit presets, not inferred overrides of user harness settings. */
function expandPreset(kind: string, preset: AgentPreset) {
  const args: string[] = [];
  const model = preset.model ?? "default";
  if (kind === "acp") {
    if (!preset.command || /[\x00-\x1f\x7f]/.test(preset.command)) throw new Error("ACP presets require a command executable; put arguments in args");
    if (preset.permission_mode && !["approve-reads", "approve-all", "deny-all"].includes(preset.permission_mode)) throw new Error("ACP permission_mode must be approve-reads, approve-all or deny-all");
    return { model, args: [], env: preset.env, acp: { command: preset.command, args: preset.args ?? [], model, permissionMode: preset.permission_mode ?? "approve-reads" } };
  }
  if (model !== "default") {
    if (kind === "codex") args.push("-m", model);
    else if (kind === "claude" || kind === "qoder") args.push("--model", model);
    else throw new Error(`Named model selection is not supported for harness ${kind}`);
  }
  if (kind === "codex") {
    if (preset.daemon === false) args.push("--no-daemon");
    if (preset.reasoning_effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(preset.reasoning_effort)}`);
    if (preset.sandbox) args.push("--sandbox", preset.sandbox);
    if (preset.approval_policy) args.push("--ask-for-approval", preset.approval_policy);
  }
  if (kind === "claude") {
    if (preset.reasoning_effort) args.push("--effort", preset.reasoning_effort);
    if (preset.permission_mode) args.push("--permission-mode", preset.permission_mode);
  }
  if (kind === "grok" && preset.trust) args.push("--trust");
  return { model, args, env: preset.env };
}

export function resolveAgentPreset(presets: AgentPresets, kind: string, name: string) {
  kind = canonicalKind(kind);
  const entries = Object.hasOwn(presets, kind) ? presets[kind] : undefined;
  const preset = entries && Object.hasOwn(entries, name) ? entries[name] : undefined;
  if (!preset) throw new Error(`Unknown agent preset ${kind}/${name} in agents.json`);
  return expandPreset(kind, preset);
}

/** Project configuration only: listing does not inspect live agents or task state. */
export function listAgentPresets(root: string, kind?: string) {
  if (kind !== undefined) kind = canonicalKind(kind);
  const presets = readAgentPresets(root);
  if (kind !== undefined && !Object.hasOwn(presets, kind)) throw new Error(`Unknown harness ${kind} in agents.json`);
  return (kind === undefined ? Object.keys(presets).sort() : [kind]).flatMap(harness =>
    Object.keys(presets[harness]!).sort().map(name => ({ kind: harness, preset: name, config: presets[harness]![name]! })),
  );
}

export function formatAgentPresets(rows: ReturnType<typeof listAgentPresets>): string {
  if (!rows.length) return "(no agent presets)";
  return formatColumns([
    ["HARNESS", "PRESET", "MODEL", "OPTIONS"],
    ...rows.map(({ kind, preset, config }) => [
      kind, preset, config.model ?? "default",
      Object.entries(config).filter(([key]) => key !== "model").map(([key, value]) =>
        `${key}=${Array.isArray(value) ? JSON.stringify(value) : typeof value === "object" ? Object.entries(value).map(([name, item]) => `${name}=${item}`).join(",") : value}`,
      ).join("  "),
    ]),
  ]);
}

/** Only init/plan preview may use the seed before the project file exists. */
export function initialAgentPresets(root: string): AgentPresets {
  return readAgentPresets(existsSync(join(root, "agents.json")) ? root : undefined);
}

export function checkPresetRole(
  meta: { kind?: unknown; preset?: unknown; model?: unknown; args?: unknown; env?: unknown },
  presets: AgentPresets,
) {
  if (meta.kind === "acp" && meta.preset === undefined) throw new Error("ACP roles require a preset in root agents.json");
  if (meta.preset === undefined) return;
  if (typeof meta.preset !== "string" || !meta.preset) throw new Error("preset must be a nonempty string");
  if ([meta.model, meta.args, meta.env].some(value => value !== undefined)) {
    throw new Error("A preset role cannot also define model, args or env; edit agents.json or clear preset first");
  }
  return resolveAgentPreset(presets, String(meta.kind), meta.preset);
}

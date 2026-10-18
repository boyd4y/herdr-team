import { parseRoleSpecs, type RoleSpec } from "./init.ts";
import { readAsset, rolePrompt } from "./templates.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PlanRole { name: string; kind: string; model: string; worktree?: boolean }
interface ModelCatalog {
  harnesses: Record<string, { args?: string[]; preferred?: string; models: Record<string, string[]> }>;
}

const plans: Record<string, PlanRole[]> = JSON.parse(readAsset("plans.json"));
function modelCatalog(root?: string): ModelCatalog {
  const file = root && join(root, ".herdr", "models.json");
  try {
    const catalog = JSON.parse(file && existsSync(file) ? readFileSync(file, "utf8") : readAsset("models.json"));
    if (!catalog?.harnesses || typeof catalog.harnesses !== "object" || Array.isArray(catalog.harnesses)) {
      throw new Error("harnesses must be a mapping");
    }
    return catalog;
  }
  catch (error) { throw new Error(`Invalid model catalog ${file || "skill/assets/models.json"}: ${error instanceof Error ? error.message : error}`); }
}
export type PlanName = string;
export const PLAN_NAMES: readonly PlanName[] = Object.keys(plans);

export function isPlanName(value: string): value is PlanName {
  return PLAN_NAMES.includes(value);
}

/** Catalog selections expand to explicit launch configuration; default adds no model override. */
export function modelSpec(kind: string, model?: string, root?: string) {
  return resolveModel(modelCatalog(root), kind, model);
}

function resolveModel(models: ModelCatalog, kind: string, selected?: string) {
  const harness = Object.hasOwn(models.harnesses, kind) ? models.harnesses[kind] : undefined;
  const model = selected ?? harness?.preferred ?? "default";
  const args = harness?.models && Object.hasOwn(harness.models, model) ? harness.models[model] : undefined;
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) throw new Error(`Unknown model ${model} for harness ${kind}`);
  const common = harness!.args ?? [];
  if (!Array.isArray(common) || common.some(value => typeof value !== "string")) throw new Error(`Invalid startup arguments for harness ${kind}`);
  return { kind, model, args: [...common, ...args] };
}

function rolesFor(plan: PlanName): PlanRole[] {
  const roles = Object.hasOwn(plans, plan) ? plans[plan] : undefined;
  if (!Array.isArray(roles)) throw new Error(`Unknown plan: ${plan}`);
  return roles;
}

/** Expand data assets into explicit role definitions; no workflow is selected here. */
export function planRoles(plan: PlanName, root?: string): RoleSpec[] {
  const models = modelCatalog(root);
  return parseRoleSpecs(JSON.stringify(rolesFor(plan).map((role) => ({
    ...role, ...resolveModel(models, role.kind, models.harnesses[role.kind]?.preferred ?? role.model),
    body: rolePrompt(role.name),
  }))));
}

export function describePlan(plan: PlanName): string {
  return rolesFor(plan).map((role) => `${role.name}=${role.kind}/${role.model}${role.worktree ? "(isolated)" : ""}`).join("  ");
}

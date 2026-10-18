import { parseRoleSpecs, type RoleSpec } from "./init.ts";
import { readAsset, rolePrompt } from "./templates.ts";

interface PlanRole { name: string; model: string; worktree?: boolean }
interface Catalog {
  models: Record<string, { kind: string; args?: string[]; env?: Record<string, string> }>;
  plans: Record<string, PlanRole[]>;
}

const catalog: Catalog = JSON.parse(readAsset("plans.json"));
export type PlanName = string;
export const PLAN_NAMES: readonly PlanName[] = Object.keys(catalog.plans);

export function isPlanName(value: string): value is PlanName {
  return PLAN_NAMES.includes(value);
}

function rolesFor(plan: PlanName): PlanRole[] {
  const roles = catalog.plans[plan];
  if (!Array.isArray(roles)) throw new Error(`Unknown plan: ${plan}`);
  return roles;
}

/** Expand the selected data file into explicit role definitions. */
export function planRoles(plan: PlanName): RoleSpec[] {
  return parseRoleSpecs(JSON.stringify(rolesFor(plan).map((role) => {
    const model = catalog.models[role.model];
    if (!model) throw new Error(`Unknown model ${role.model} in plan ${plan}`);
    return { ...model, ...role, body: rolePrompt(role.name) };
  })));
}

export function describePlan(plan: PlanName): string {
  return rolesFor(plan).map((role) => `${role.name}=${role.model}${role.worktree ? "(isolated)" : ""}`).join("  ");
}

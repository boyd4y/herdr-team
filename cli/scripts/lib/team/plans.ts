import { parseRoleSpecs, type RoleSpec } from "./init.ts";
import { readAsset, rolePrompt } from "./templates.ts";
import { initialAgentPresets, readAgentPresets, resolveAgentPreset } from "./agents.ts";

interface PlanRole { name: string; kind: string; preset: string; worktree?: boolean }
const plans: Record<string, PlanRole[]> = JSON.parse(readAsset("plans.json"));
export type PlanName = string;
export const PLAN_NAMES: readonly PlanName[] = Object.keys(plans);

export function isPlanName(value: string): value is PlanName {
  return PLAN_NAMES.includes(value);
}

function rolesFor(plan: PlanName): PlanRole[] {
  const roles = Object.hasOwn(plans, plan) ? plans[plan] : undefined;
  if (!Array.isArray(roles)) throw new Error(`Unknown plan: ${plan}`);
  return roles;
}

/** Select explicit presets without copying their launch settings into role metadata. */
export function planRoles(plan: PlanName, root?: string): RoleSpec[] {
  const presets = root ? initialAgentPresets(root) : readAgentPresets();
  return parseRoleSpecs(JSON.stringify(rolesFor(plan).map(role => {
    resolveAgentPreset(presets, role.kind, role.preset);
    return { ...role, body: rolePrompt(role.name) };
  })));
}

export function describePlan(plan: PlanName): string {
  return rolesFor(plan).map(role => `${role.name}=${role.kind}/${role.preset}${role.worktree ? "(isolated)" : ""}`).join("  ");
}

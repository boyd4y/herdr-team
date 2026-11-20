import { existsSync, readFileSync } from "node:fs";
import { NAME_RE } from "../shared/types.ts";

// Source checkout and the frozen runtime preserve the same cli/ + skill/ layout.
const assets = new URL("../../../../skill/assets/", import.meta.url);

export function readAsset(relative: string): string {
  return readFileSync(new URL(relative, assets), "utf8");
}

export function rolePrompt(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid role template name: ${name}`);
  const named = `roles/${name}/prompt.md`;
  return readAsset(existsSync(new URL(named, assets)) ? named : "roles/default/prompt.md");
}

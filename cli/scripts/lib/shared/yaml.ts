import { YAML } from "bun";

/** Preserve metadata field order; Bun owns YAML syntax, quoting and nested values. */
export function emitYaml(data: Record<string, unknown>, order: string[] = []): string {
  const keys = [...new Set([...order, ...Object.keys(data)])].filter((key) => data[key] !== undefined);
  return `${YAML.stringify(Object.fromEntries(keys.map((key) => [key, data[key]])), null, 2)}\n`;
}

/** Metadata must be a single mapping; malformed documents remain validation problems. */
export function parseYaml(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = YAML.parse(text); } catch { return null; }
  if (parsed === null || parsed === undefined) return {};
  return typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

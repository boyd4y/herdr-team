import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

export interface DemoSettings {
  enabled: boolean;
  speed: number;
  paused: boolean;
  concurrency: number;
}

/** Local-only switches; never put demo settings in the shared team agreement. */
export function demoSettings(root: string, env = process.env): DemoSettings {
  let record: Record<string, unknown> = {};
  try { record = JSON.parse(readFileSync(join(root, ".herdr", "demo.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid .herdr/demo.json: ${String(error)}`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Expected an object in .herdr/demo.json");
  const flag = (value: unknown, fallback: boolean, name: string) => {
    if (value === undefined) return fallback;
    if (value === true || value === "1" || value === "true") return true;
    if (value === false || value === "0" || value === "false") return false;
    throw new Error(`${name} must be true or false`);
  };
  const number = (value: unknown, fallback: number, name: string, min: number, max: number) => {
    if (value === undefined) return fallback;
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error(`Invalid ${name}`);
    const result = Number(value);
    if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return result;
  };
  const concurrency = number(env.HERDR_TEAM_DEMO_CONCURRENCY ?? record.concurrency, 3, "demo concurrency", 1, 9);
  if (!Number.isInteger(concurrency)) throw new Error("Demo concurrency must be an integer");
  return {
    enabled: flag(env.HERDR_TEAM_DEMO ?? record.enabled, record.kind === "herdr-team-demo", "demo enabled"),
    speed: number(env.HERDR_TEAM_DEMO_SPEED ?? record.speed, 1, "demo speed", 0.1, 100),
    paused: flag(record.paused, false, "demo paused"),
    concurrency,
  };
}

/** Re-read local controls during waits so a presenter can pause or change pace. */
export async function demoDelay(root: string, milliseconds: number, fast = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (fast) return;
  let remaining = milliseconds;
  while (remaining > 0) {
    const settings = demoSettings(root);
    const start = Date.now();
    await pause(Math.min(250, settings.paused ? 250 : remaining / settings.speed), undefined, { signal });
    if (!settings.paused) remaining -= (Date.now() - start) * settings.speed;
  }
}

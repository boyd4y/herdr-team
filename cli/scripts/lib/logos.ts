import type { Herdr } from "./herdr.ts";

// PUA assignments from hhdebb/herdr-radar lib/logos.js (Herdr Agent Icons Max).
// Keep explicit codepoints: gaps or additions upstream must never shift a vendor.
const LOGOS = new Map<string, number>([
  ["claude", 0xe1a0], ["codex", 0xe1a1], ["opencode", 0xe1a2],
  ["omp", 0xe1a3], ["cline", 0xe1a4], ["mastracode", 0xe1a5],
  ["kimi", 0xe1a6], ["kilo", 0xe1a7], ["maki", 0xe1a8],
  ["pi", 0xe1a9], ["hermes", 0xe1aa], ["cursor", 0xe1ab],
  ["copilot", 0xe1ac], ["deepseek", 0xe1ad], ["gemini", 0xe1ae],
  ["gpt", 0xe1af], ["qwen", 0xe1b0], ["grok", 0xe1b1],
  ["agy", 0xe1b2], ["kiro", 0xe1b3], ["amp", 0xe1b4],
  ["devin", 0xe1b5], ["qodercli", 0xe1b6], ["glm", 0xe1b7],
  ["kimchi", 0xe1b8], ["muse", 0xe1b9], ["crush", 0xe1ba],
]);

/** Display-only, opt-in metadata. A missing font or rejected report must not block work. */
export function reportHarnessLogo(herdr: Herdr, paneId: string, kind: string): void {
  if (process.env["HERDR_TEAM_LOGOS"] !== "font") return;
  const codepoint = LOGOS.get(kind);
  if (codepoint === undefined) return;
  try {
    herdr.reportTokens(paneId, "herdr-team-logo", { harness_logo: String.fromCodePoint(codepoint) }, 86_400_000);
  } catch {
    // Like display-name metadata, logos are best effort and do not affect launch/dispatch.
  }
}

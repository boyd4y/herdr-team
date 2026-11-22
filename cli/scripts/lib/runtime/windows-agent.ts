import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

/** Native agent executables accept multiline argv; npm's Windows batch shims cannot. */
export function windowsAgentExecutable(kind: "codex" | "claude", path: string | undefined): string | undefined {
  const executable = Bun.which(`${kind}.exe`, { PATH: path });
  if (executable) return executable;
  const shim = Bun.which(`${kind}.cmd`, { PATH: path });
  if (!shim) return;
  const prefix = dirname(shim);
  const modules = basename(prefix).toLowerCase() === ".bin" ? dirname(prefix) : join(prefix, "node_modules");
  if (kind === "claude") {
    const native = join(modules, "@anthropic-ai", "claude-code", "bin", "claude.exe");
    return existsSync(native) ? native : undefined;
  }

  const codex = join(modules, "@openai", "codex");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  let provider = codex;
  try {
    const resolve = createRequire(join(codex, "package.json")).resolve;
    provider = dirname(resolve(`@openai/codex-win32-${arch}/package.json`));
  } catch { /* Earlier releases shipped the platform binary in the main package. */ }
  return ["bin", "codex"].map(dir => join(provider, "vendor", target, dir, "codex.exe")).find(existsSync);
}

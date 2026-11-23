export function windowsPath(path) {
  return typeof path === "string" && /^(?:[a-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/i.test(path);
}

export function absolutePath(path) {
  return typeof path === "string" && (path.startsWith("/") || windowsPath(path));
}

export function pathKey(path) {
  if (!windowsPath(path)) return path;
  return path.replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
}

export function childPath(parent, name) {
  return windowsPath(parent) ? `${parent.replace(/[/\\]$/, "").replaceAll("/", "\\")}\\${name.replaceAll("/", "\\")}` : `${parent.replace(/\/$/, "")}/${name}`;
}

// Herdr loads each mod in its own directory. Keep this invocation in sync with the other mod.
const windowsLauncher = `
  import { existsSync } from "node:fs";
  import { delimiter, isAbsolute, join } from "node:path";
  import { homedir } from "node:os";
  import { pathToFileURL } from "node:url";
  const bins = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).map(bin => bin.replace(/^"|"$/g, ""));
  bins.push(join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin"));
  const bin = bins.find(bin => isAbsolute(bin) && existsSync(join(bin, "herdr-team.cmd")) && existsSync(join(bin, "herdr-team.mjs")));
  if (bin) {
    process.argv[1] = join(bin, "herdr-team.mjs");
    await import(pathToFileURL(process.argv[1]).href);
  } else {
    console.error("Herdr Team CLI not found. Run npm run setup:desktop to install it.");
    process.exitCode = 1;
  }
`;

export function teamArgv(args, platform, scope) {
  if (scope?.on ? windowsPath(scope.onFolder ?? scope.cwd) : platform === "windows") {
    return ["bun", "-e", windowsLauncher, "--", "herdr-team", ...args];
  }
  return ["/bin/sh", "-c", 'PATH="$HOME/.bun/bin:$HOME/.local/bin${PATH:+:$PATH}:/usr/bin:/bin" exec herdr-team "$@"', "herdr-team", ...args];
}

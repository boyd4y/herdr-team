import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { tmpdir } from "node:os";
import { teamCliPath } from "../scripts/lib/dispatch/queue.ts";
import { desktopAgentProgram, desktopProgramMatches, type DesktopTerminal } from "../scripts/lib/runtime/desktop.ts";
import { spawnWindowsDaemon, windowsCommandLine } from "../scripts/lib/runtime/windows-daemon.ts";
import { outsideRoot } from "../scripts/lib/shared/paths.ts";

test("worktree offsets stay inside their checkout on either host", () => {
  const root = "C:\\Projects\\测试 app";
  for (const child of [root, root + "\\src", root + "\\..cache"]) {
    expect(outsideRoot(win32.relative(root, child), win32)).toBeFalse();
  }
  for (const child of [root + "\\..\\other", "D:\\other", "\\\\host\\share"]) {
    expect(outsideRoot(win32.relative(root, child), win32)).toBeTrue();
  }
  expect(outsideRoot(posix.relative("/team/repo", "/team/repo/..\\cache"), posix)).toBeFalse();
});

test("Windows sessions recognize the native agent and preserve its executable identity", () => {
  const terminal: DesktopTerminal = { address: "t1", state: "live", cwd: "C:\\repo", labels: {},
    argv: ["C:\\Users\\开发\\bin\\CODEX.EXE", "--no-daemon"] };
  expect(desktopAgentProgram(terminal, "win32")).toBe("codex");
  expect(desktopProgramMatches(terminal, ["c:/users/开发/bin/codex.exe"], "win32")).toBeTrue();
  expect(desktopProgramMatches(terminal, ["D:\\other\\codex.exe"], "win32")).toBeFalse();
  expect(desktopAgentProgram({ ...terminal, argv: ["C:\\Windows\\System32\\cmd.exe"] }, "win32")).toBeUndefined();
});

test("Windows command arguments preserve quotes, spaces, trailing slashes and PowerShell paths", () => {
  expect(windowsCommandLine(["C:\\Program Files\\Bun\\bun.exe", "", "a\"b", "C:\\tmp\\", "%USERPROFILE% & \n中文"]))
    .toBe('"C:\\Program Files\\Bun\\bun.exe" "" "a\\"b" "C:\\tmp\\\\" "%USERPROFILE% & \n中文"');
  expect(teamCliPath("C:\\团队\\Pat's repo", "win32")).toBe("'C:\\团队\\Pat''s repo'");
});

test.skipIf(process.platform !== "win32")("Windows detached launch keeps child argv, environment and redirected output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-team 测试 "));
  const log = join(directory, "daemon.log");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const value = "two lines\r\n\"quoted\" \\ & %NAME% 中文";
  try {
    const pid = spawnWindowsDaemon([process.execPath, "-e",
      "console.log(JSON.stringify([process.pid, process.argv.at(-1), process.env.HERDR_TEAM_NATIVE_TEST]))",
      "--", value], directory, { ...env, HERDR_TEAM_NATIVE_TEST: value }, log);
    const until = Date.now() + 3000;
    while (Date.now() < until && !readFileSync(log, "utf8").includes("\n")) await Bun.sleep(20);
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([pid, value, value]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

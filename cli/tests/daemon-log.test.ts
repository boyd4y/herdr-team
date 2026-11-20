import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

test("daemon logs follows the last records and streams complete JSON lines across log rotation", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-follow-log-"));
  const path = join(home, "daemon.log");
  writeFileSync(path, '{"event":"old"}\n{"event":"recent"}\n');
  const child = spawn(process.execPath, [
    join(import.meta.dir, "../scripts/cli.ts"), "daemon", "logs", "--lines", "1", "-f", "--json",
  ], { env: { ...process.env, HERDR_TEAM_HOME: home }, stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(child, "close");
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill(), 2500);
  try {
    expect((await lines.next()).value).toBe('{"event":"recent"}');
    const bytes = Buffer.from('{"event":"收到"}\n');
    appendFileSync(path, bytes.subarray(0, 12));
    appendFileSync(path, bytes.subarray(12));
    expect((await lines.next()).value).toBe('{"event":"收到"}');
    renameSync(path, path + ".1");
    writeFileSync(path, '{"event":"new-file"}\n');
    expect((await lines.next()).value).toBe('{"event":"new-file"}');
    expect(child.kill("SIGINT")).toBe(true);
    expect(await closed).toEqual([0, null]);
  } finally {
    clearTimeout(timeout);
    output.close();
    child.kill();
    await closed;
    rmSync(home, { recursive: true, force: true });
  }
});

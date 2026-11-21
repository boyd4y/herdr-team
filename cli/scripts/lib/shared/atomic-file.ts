import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

export function replaceFile(destination: string, content: string, mode?: number): void {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { force: true }); }
}

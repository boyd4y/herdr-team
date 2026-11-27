import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_BODY, type Project, type TaskCard } from "../shared/types.ts";

const RECORD_HEADING = /^##\s*(?:History|\u6d41\u8f6c\u8bb0\u5f55)\s*$/m;
export const HANDOFF_SUMMARY_LIMIT = 400;

export function taskMessageBody(body: string, summaryRef?: string, summaryLength?: number): string {
  const heading = RECORD_HEADING.exec(body);
  const description = body.slice(0, heading?.index ?? body.length).trim();
  if (!heading || !summaryRef || !summaryLength || !Number.isSafeInteger(summaryLength) || summaryLength < 1) return description;
  const history = body.slice(heading.index + heading[0].length);
  const end = history.lastIndexOf(`\n<!-- team-operation:handoff-${summaryRef} -->`);
  if (end < 0) return description;
  const record = history.slice(0, end).trimEnd();
  return record.length >= summaryLength ? record.slice(-summaryLength) : description;
}

export function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 往 `## 流转记录` 追加一行。
 *
 * 只做**追加**，不整篇重写 —— 散文文件一个字都不该被工具碰掉。
 * 少了小节就先补上小节头，那条路径才需要写文件。
 */
export function appendRecord(project: Project, card: TaskCard, line: string): void {
  const dir = join(project.herdrDir, card.dir);
  const path = join(dir, TASK_BODY);
  mkdirSync(dir, { recursive: true });

  const body = card.body.replace(/\s*$/, "");
  if (!RECORD_HEADING.test(body)) {
    writeFileSync(path, body === "" ? `## History\n${line}\n` : `${body}\n\n## History\n${line}\n`);
    return;
  }

  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const needsNewline = raw !== "" && !raw.endsWith("\n");
  appendFileSync(path, `${needsNewline ? "\n" : ""}${line}\n`);
}

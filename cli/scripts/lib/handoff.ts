import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIfDone, type CleanupResult } from "./cleanup.ts";
import type { Herdr } from "./herdr.ts";
import { refreshSidebar } from "./sidebar.ts";
import { findRoleAgent, projectAgents } from "./team-scope.ts";
import { findTask, TaskError, writeTaskMeta } from "./task.ts";
import { TASK_BODY, isTerminal, isolatedAgentName, type Project, type TaskCard } from "./types.ts";

export interface HandoffResult {
  id: string;
  from: string;
  /** 交给谁；null 表示这是终态，没有下一步。 */
  to: string | null;
  status: string;
  previousStatus: string;
  /** 下游有没有真的收到 prompt。 */
  prompted: boolean;
  /** 走到终态时才有的 worktree 回收结果。 */
  cleanup?: CleanupResult;
  /** 给人看的一句话说明。 */
  note: string;
}

const RECORD_HEADING = /^##\s*流转记录\s*$/m;

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
    writeFileSync(path, body === "" ? `## 流转记录\n${line}\n` : `${body}\n\n## 流转记录\n${line}\n`);
    return;
  }

  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const needsNewline = raw !== "" && !raw.endsWith("\n");
  appendFileSync(path, `${needsNewline ? "\n" : ""}${line}\n`);
}

/**
 * 任务负责人的逻辑名称（显示用途，不能直接作为跨项目发送目标）。
 *
 * 常驻角色 → 名字就是角色名；隔离角色 → `<role>-<id>`（每个任务一个 worktree、
 * 一个 agent）。所以同一个角色可以同时在多个任务上，互不打架。
 */
export function agentNameForTask(project: Project, card: TaskCard): string {
  const role = project.roles.find((r) => r.name === card.role);
  return role?.worktree === true ? isolatedAgentName(card.role, card.id) : card.role;
}

/**
 * 推进一个任务。
 *
 * `handoff` 是"还要交给谁"，不是"还剩几步"。队列空只说明**当前这个负责人是最后一个** ——
 * 所以队列空时不是拒绝，而是"它干完了，收尾"。
 */
export function handoff(
  project: Project,
  herdr: Herdr,
  id: string,
  now: Date = new Date(),
): HandoffResult {
  const card = findTask(project, id);

  if (isTerminal(card.status)) {
    throw new TaskError(`${id} 已是终态（${card.status}），不能再流转`);
  }

  if (!herdr.envOk()) throw new TaskError("handoff 要在 Herdr 的 pane 里跑（HERDR_ENV=1）。");

  const from = card.role;
  const previousStatus = card.status;

  if (card.handoff.length === 0) {
    // 最后一个负责人干完了 —— 没有下一步，整个任务收尾。
    const status = "done";
    writeTaskMeta(project, card, { status });
    appendRecord(project, card, `- ${stamp(now)}  done  (${previousStatus} → ${status})`);
    refreshSidebar(project, herdr);

    // 收尾就该把 worktree 收掉，否则每做一个任务就多留一个 checkout。
    const cleanup = cleanupIfDone(project, herdr, { ...card, status });
    const tail =
      cleanup.action === "removed"
        ? ` ${cleanup.note}`
        : cleanup.action === "absent"
          ? ""
          : ` ⚠ ${cleanup.note}`;

    return {
      id,
      from,
      to: null,
      status,
      previousStatus,
      prompted: false,
      cleanup,
      note: `${id} 完成（${from} 是最后一个负责人）。${tail}`,
    };
  }

  const next = card.handoff[0] as string;
  const rest = card.handoff.slice(1);
  const status = "review";

  // 下一个负责人是常驻角色还是隔离角色，决定了它的 agent 叫什么。
  const nextRole = project.roles.find((r) => r.name === next);
  const nextAgent = nextRole?.worktree === true ? isolatedAgentName(next, card.id) : next;

  const target = nextRole === undefined ? undefined : findRoleAgent(project, projectAgents(project, herdr), nextRole, nextRole.worktree ? card.id : undefined)?.pane_id;

  writeTaskMeta(project, card, { role: next, handoff: rest, status });
  appendRecord(project, card, `- ${stamp(now)}  → ${next}  (${previousStatus} → ${status})`);
  refreshSidebar(project, herdr);

  if (target === undefined) {
    // 不启动新 agent —— 卡记录的是"该谁做了"，不是"agent 在不在"。
    const hint =
      nextRole?.worktree === true
        ? `请 lead 确认后跑 \`herdr-team edit ${id} --status todo --force\`，再跑 \`herdr-team dispatch ${id}\`，会在 \`feat/${id}-${card.slug}\` 上开好 worktree。`
        : `请 lead 跑 \`herdr-team up\` 拉起它，再安排接续这张 review 卡。`;
    return {
      id,
      from,
      to: next,
      status,
      previousStatus,
      prompted: false,
      note: `${id} 已流转到 ${next}（agent 名 ${nextAgent}），但它当前不在。${hint}`,
    };
  }

  herdr.agentPrompt(target, `任务 ${id} 已交付给你。团队根目录：${project.root}\n目录：${join(project.herdrDir, card.dir)}\n读它拿到任务描述和上游的流转记录。执行 herdr-team 时使用 --root 指向上述团队根目录。`);
  return {
    id,
    from,
    to: next,
    status,
    previousStatus,
    prompted: true,
    note: `${id} 已交给 ${nextAgent}（status=${status}）。`,
  };
}

/**
 * 常驻角色**刚起来**时收到的说明。
 *
 * 他们不等任务（没有任务时的 `lead` 也要知道自己是谁），所以起好就得把
 * identity 和角色正文送进去 —— 否则 agent 就是一个不知道自己角色的裸 TUI。
 */
export function startupPrompt(identity: string, roleBody: string, roleName: string): string {
  return [
    identity.trim(),
    "",
    roleBody.trim(),
    "",
    `你是 ${roleName}，现在没有派给你的任务。用户会直接跟你说话。`,
  ].join("\n");
}

/** 派活说明：identity + 角色正文 + 任务目录 + 交棒要求。顺序固定。 */
export function assignmentPrompt(identity: string, roleBody: string, card: TaskCard, root?: string): string {
  return [
    identity.trim(),
    "",
    roleBody.trim(),
    "",
    `你现在负责任务 ${card.id}：${card.title}`,
    `目录：${root === undefined ? `.herdr/${card.dir}` : join(root, ".herdr", card.dir)}（.task.yaml 是元数据，${TASK_BODY} 是描述和流转记录）`,
    "",
    `完成后运行 \`herdr-team handoff ${card.id}\` 交棒，不要自己改任务卡。`,
  ].join("\n");
}

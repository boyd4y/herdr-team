import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { report, type MockHarness } from "../mock-console.ts";

const turns = [
  {
    match: /test|verify|check|测试|验证|检查/i,
    action: "Plan verification",
    notes: ["Identify the entry point and its expected result.", "Start with one focused case.", "Compare the observed output with the expected result."],
    answer: "I’d check the normal case first, then add an edge case that would catch a regression.",
  },
  {
    match: /debug|fix|error|bug|错误|修复|问题/i,
    action: "Narrow the failure",
    notes: ["Write down a reproducible sequence.", "Identify the first step where the observed behavior changes.", "Check that boundary before changing any code."],
    answer: "I’d reproduce the failure with the smallest input and verify the fix against that same case.",
  },
  {
    match: /./s,
    action: "Draft an approach",
    notes: ["Identify the expected outcome.", "Find the existing entry point for the requested behavior.", "Choose a change and a focused check."],
    answer: "I’d start at the feature’s normal entry point and verify the result before expanding the change.",
  },
];

export const mockReply = (request: string) => turns.find(candidate => candidate.match.test(request))!;

type MockTui = Awaited<ReturnType<typeof import("../mock-tui.ts").openMockTui>>;
type Assignment = (tui: MockTui, signal: AbortSignal) => Promise<void>;

export async function runMockSession(harness: MockHarness, prompt = "", assignment?: Assignment, fast = false) {
  const { openMockTui } = await import("../mock-tui.ts");
  const initialPrompt = prompt.trim();
  const cwd = process.cwd();
  const home = homedir();
  const branch = harness !== "codex" && harness !== "claude"
    ? spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", timeout: 1000 }).stdout?.trim()
    : undefined;
  const tui = await openMockTui(harness, {
    session: cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd,
    directory: cwd,
    branch,
    fast,
    deferInput: Boolean(initialPrompt),
    async submit(request, signal) {
      const turn = mockReply(request);
      report("working", harness);
      if (/\breply\b.*\bjust\s+PONG\b/i.test(request)) {
        await pause(650, undefined, { signal });
        tui.completed("PONG");
      } else {
        await tui.step(1, turn.action, turn.notes, 400, signal);
        tui.completed(turn.answer);
      }
      report("done", harness);
    },
    idle() { report("idle", harness); },
  });
  if (!assignment) report("idle", harness);
  try {
    if (initialPrompt) {
      await tui.ready;
      await tui.submit(initialPrompt, assignment ? (_request, signal) => assignment(tui, signal) : undefined);
    }
    await tui.closed;
  } finally {
    tui.destroy();
    await tui.closed;
    process.stdout.write("\x1b]7501;state=clear\x1b\\");
  }
}

#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { isMockHarness, mockConsole, mockHarnesses, report, type MockHarness } from "./lib/mock-console.ts";

const usage = `Usage: herdr-mock <${mockHarnesses.join("|")}> [prompt]`;

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

async function chat(harness: MockHarness, firstPrompt: string): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { openMockTui } = await import("./lib/mock-tui.ts");
    const cwd = process.cwd();
    const home = homedir();
    const branch = harness !== "codex" && harness !== "claude"
      ? spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", timeout: 1000 }).stdout?.trim()
      : undefined;
    const tui = await openMockTui(harness, {
      session: cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd,
      directory: cwd,
      branch,
      interactive: {
        async submit(request, signal) {
          const turn = turns.find(candidate => candidate.match.test(request))!;
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
      },
    });
    report("idle", harness);
    try {
      if (firstPrompt) await tui.submit(firstPrompt);
      await tui.closed;
    } finally {
      tui.destroy();
      await tui.closed;
      process.stdout.write("\x1b]7501;state=clear\x1b\\");
    }
    return;
  }
  const view = mockConsole(harness);

  async function respond(prompt: string) {
    // Treat the entered text as conversation, including when it contains shell syntax.
    const request = prompt.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 240);
    if (!request) return;
    const turn = turns.find(candidate => candidate.match.test(request))!;
    report("working", harness);
    await view.step(0, "Read the request", [request]);
    await view.step(1, turn.action, turn.notes);
    view.completed(turn.answer);
    report("done", harness);
  }

  view.heading("Ready");
  report("idle", harness);
  if (firstPrompt) {
    await respond(firstPrompt);
    return;
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of input) {
      if (line.trim() === "/exit") break;
      await respond(line);
    }
  } finally {
    input.close();
  }
}

const [harness, ...request] = process.argv.slice(2);
if (harness === "--help" || harness === "-h") console.log(usage);
else if (!isMockHarness(harness)) { console.error(usage); process.exitCode = 2; }
else await chat(harness, request.join(" "));

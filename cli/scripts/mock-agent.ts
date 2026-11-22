#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { isMockHarness, mockConsole, mockHarnesses, report, type MockHarness } from "./lib/mock-console.ts";
import { mockReply, runMockSession } from "./lib/ui/mock-session.ts";

const usage = `Usage: herdr-mock <${mockHarnesses.join("|")}> [prompt]`;

async function chat(harness: MockHarness, firstPrompt: string): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) return runMockSession(harness, firstPrompt);
  const view = mockConsole(harness);

  async function respond(prompt: string) {
    // Treat the entered text as conversation, including when it contains shell syntax.
    const request = prompt.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 240);
    if (!request) return;
    const turn = mockReply(request);
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

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { completedDeliveries } from "../dispatch/delivery.ts";
import { isMockHarness, mockConsole, report } from "../mock-console.ts";
import type { TaskCard } from "../shared/types.ts";
import { checkArtifact, command, team, type MockRun } from "./shared.ts";

const harness = process.env.HERDR_SMOKE_HARNESS;

async function main(): Promise<void> {
  const manifest = process.env.HERDR_SMOKE_MANIFEST;
  const taskId = process.env.HERDR_TEAM_TASK_ID;
  const step = process.env.HERDR_SMOKE_STEP;
  const prompt = process.argv.at(-1) ?? "";
  const delivery = /^Delivery ID: ([\da-f-]+)$/m.exec(prompt)?.[1];
  if (!manifest || !taskId || !delivery || !isMockHarness(harness) ||
      (step !== "dev" && step !== "test" && step !== "review")) {
    throw new Error("A configured Herdr Team demo assignment is required");
  }
  const run = JSON.parse(readFileSync(manifest, "utf8")) as MockRun;
  const task = run.tasks.find(item => item.id === taskId);
  if (!task || !prompt.includes(`Team root: ${run.root}\n`)) throw new Error("The assignment is outside this demo");
  const cwd = realpathSync(process.cwd());
  if (cwd === realpathSync(run.root) || !/^demo\/[a-z0-9-]+\.ts$/.test(task.artifact)) {
    throw new Error("Expected the dedicated task worktree and a demo artifact");
  }

  const session = `${step === "dev" ? "Development" : step === "test" ? "Verification" : "Review"}  ·  #${taskId}`;
  const tui = process.stdin.isTTY && process.stdout.isTTY
    ? await (await import("../mock-tui.ts")).openMockTui(harness, { session, fast: run.fast })
    : undefined;
  const view = tui ?? mockConsole(harness, run.fast);
  if (!tui) view.heading(session);
  try {
    await doAssignment(view, harness, step, task, run, cwd, delivery);
    if (tui) await tui.closed;
    else for await (const _chunk of Bun.stdin.stream()) { /* Retain the assignment output until cleanup. */ }
  } finally {
    tui?.destroy();
    await tui?.closed;
  }
}

async function doAssignment(
  view: ReturnType<typeof mockConsole>, harness: NonNullable<Parameters<typeof report>[1]>,
  step: "dev" | "test" | "review", task: MockRun["tasks"][number], run: MockRun, cwd: string, delivery: string,
) {
  const taskId = task.id;
  const options = ["--delivery", delivery];
  report("working", harness);
  const receipt = team<{ duplicate: boolean }>(run.root, "task", "claim", taskId, ...options);
  if (receipt.duplicate) throw new Error("The delivery was already claimed");
  const card = team<TaskCard>(run.root, "task", "show", taskId);
  const branch = command(["git", "branch", "--show-current"], cwd).stdout;
  const base = command(["git", "rev-parse", "--short", "HEAD"], cwd).stdout;
  await view.step(0, card.title, [`Checkout ${basename(cwd)}`, `Branch ${branch} @ ${base}`], 540);

  let handoff: string[];
  if (step === "dev") {
    const accepted = !task.rejectOnce || completedDeliveries(card).length > 0;
    await view.step(1, "Prepare the implementation", [
      `Open ${task.artifact}`,
      "Write the fixture contract and keep the change isolated.",
      "Stage the single generated file for review.",
    ], 590);
    mkdirSync(dirname(task.artifact), { recursive: true });
    writeFileSync(task.artifact, `// ${task.artifact}\nexport const result = { lane: ${task.ordinal}, accepted: ${accepted} } as const;\n`);
    command(["git", "add", "--", task.artifact], cwd);
    command(["git", "diff", "--cached", "--check"], cwd);
    await view.step(2, "Validate the staged patch", [
      command(["git", "diff", "--cached", "--stat"], cwd).stdout.replace(/\s*\n\s*/g, " · "),
      "git diff --cached --check passed.",
    ], 640);
    command(["git", "commit", "-qm", `Complete demo lane ${task.ordinal}`], cwd);
    const sha = command(["git", "rev-parse", "HEAD"], cwd).stdout;
    handoff = ["--commit", sha, "--summary", "Implemented and submitted the fixture."];
  } else {
    const review = card.meta.review as { commit?: string } | undefined;
    const sha = review?.commit;
    if (!sha || command(["git", "rev-parse", "HEAD"], cwd).stdout !== sha) throw new Error("The assigned commit changed");
    const changed = command(["git", "show", "--format=", "--name-only", sha], cwd).stdout;
    await view.step(1, step === "test" ? "Run the fixture checks" : "Inspect the pinned change", [
      `Confirm ${sha.slice(0, 7)} matches the assigned commit.`,
      `Read ${changed}`,
      "Compare the fixture with the expected contract.",
    ], 550);
    const passed = checkArtifact(run, task, cwd);
    if (!passed && step === "test") {
      report("blocked", harness);
      await view.step(2, "The fixture failed its contract", ["Expected accepted = true", "Return the finding to development."], 610);
      report("working", harness);
      handoff = ["--reject", "--summary", "The fixture returned the wrong contract result. Correct it and resubmit."];
    } else {
      if (!passed) throw new Error("The demo artifact failed validation");
      command(["git", "show", "--check", sha], cwd);
      await view.step(2, step === "test" ? "Checks passed" : "Review complete", [
        "The fixture matches its contract.", "No whitespace errors in the pinned patch.",
      ], 620);
      handoff = ["--accept", sha, "--summary", "Validated the pinned commit and its contract."];
    }
  }

  team(run.root, "task", "handoff", taskId, ...options, ...handoff);
  view.completed("Saved the result for the next step.");
  report("done", harness);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    if (isMockHarness(harness)) report("error", harness);
    console.error(String(error));
    process.exitCode = 1;
  }
}

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../scripts/lib/team/project.ts";
import { deliveryFor } from "../scripts/lib/dispatch/delivery.ts";
import { handoff } from "../scripts/lib/tasks/handoff.ts";
import { realHerdr } from "../scripts/lib/runtime/herdr.ts";
import { dispatch, up } from "../scripts/lib/dispatch/launch.ts";
import { claimTask, pumpQueue } from "../scripts/lib/dispatch/queue.ts";
import { buildReport } from "../scripts/lib/ui/status.ts";
import { fakeHerdr, makeProject, taskMeta, twoResidentRoles, twoRoles, writeTask } from "./helpers.ts";

for (const isolated of [false, true]) {
  describe(`explicit delivery confirmation (${isolated ? "isolated" : "resident"})`, () => {
    function fixture() {
      const project = makeProject();
      (isolated ? twoRoles : twoResidentRoles)(project.root);
      writeTask(project.root, "0001-a", taskMeta());
      const herdr = fakeHerdr();
      if (!isolated) herdr.live("dev");
      const load = () => loadProject(project.root);
      const body = () => readFileSync(join(project.root, ".herdr/tasks/0001-a/task.md"), "utf8");
      return { ...project, herdr, load, body };
    }

    test("submission is journaled before sending, and explicit claim confirms receipt", () => {
      const f = fixture();
      try {
        const calls: string[][] = [];
        f.herdr.agentPrompt = realHerdr((args) => {
          calls.push(args);
          expect(args).toHaveLength(4);
          expect(f.load().tasks[0]?.status).toBe("todo");
          expect(deliveryFor(f.load().tasks[0]!)?.state).toBe("sending");
          expect(args[3]).toContain("herdr-team claim 0001 --delivery");
          return { code: 0, stdout: "", stderr: "" };
        }).agentPrompt;
        expect(dispatch(f.load(), f.herdr)[0]?.action).toBe("dispatched");
        expect(calls).toHaveLength(1);
        expect(f.load().tasks[0]?.status).toBe("doing");
        expect(buildReport(f.load(), f.herdr, false).inconsistencies).toMatchObject([{ kind: "awaiting-claim" }]);
        const id = deliveryFor(f.load().tasks[0]!)!.id;
        expect(claimTask(f.load(), "0001", id).duplicate).toBe(false);
        expect(claimTask(f.load(), "0001", id).duplicate).toBe(true);
        expect(buildReport(f.load(), f.herdr, false).inconsistencies).toMatchObject([{ kind: "maybe-finished" }]);
        pumpQueue(f.load(), f.herdr);
        expect(calls).toHaveLength(1);
      } finally { f.cleanup(); }
    });

    test.each(["agent_prompt_stalled", "timeout", "unknown_error"])("%s becomes uncertain and is never automatically resent", (code) => {
      const f = fixture();
      try {
        let prompts = 0;
        const originalBody = f.body();
        f.herdr.agentPrompt = realHerdr(() => {
          prompts++;
          return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
        }).agentPrompt;
        expect(dispatch(f.load(), f.herdr)[0]?.action).toBe("uncertain");
        expect(f.load().tasks[0]?.status).toBe("todo");
        expect(f.body()).toBe(originalBody);
        expect(buildReport(f.load(), f.herdr, false).inconsistencies).toMatchObject([{ kind: "delivery-uncertain" }]);
        pumpQueue(f.load(), f.herdr);
        expect(prompts).toBe(1);
        expect(claimTask(f.load(), "0001", deliveryFor(f.load().tasks[0]!)!.id).duplicate).toBe(false);
      } finally { f.cleanup(); }
    });

    test.each(["agent_blocked", "agent_not_found", "pane_not_found"])("%s rejects before submission and remains queued", (code) => {
      const f = fixture();
      try {
        const originalBody = f.body();
        f.herdr.agentPrompt = realHerdr(() => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) })).agentPrompt;
        expect(dispatch(f.load(), f.herdr)[0]?.action).toBe("queued");
        expect(f.load().tasks[0]?.status).toBe("todo");
        expect(deliveryFor(f.load().tasks[0]!)?.state).toBe("queued");
        expect(f.body()).toBe(originalBody);
        f.herdr.agentPrompt = () => {};
        expect(pumpQueue(f.load(), f.herdr)).toMatchObject([{ state: "submitted" }]);
      } finally { f.cleanup(); }
    });
  });
}

test("up does not submit tasks; handoff submits without waiting for lifecycle activity", () => {
  const { root, cleanup } = makeProject();
  try {
    twoRoles(root);
    const herdr = fakeHerdr();
    const calls: string[][] = [];
    herdr.agentPrompt = realHerdr((args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }).agentPrompt;
    up(loadProject(root), herdr);
    expect(calls).toHaveLength(0);
    writeTask(root, "0001-a", taskMeta({ status: "doing", handoff: ["docs"] }));
    expect(handoff(loadProject(root), herdr, "0001").prompted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
  } finally { cleanup(); }
});

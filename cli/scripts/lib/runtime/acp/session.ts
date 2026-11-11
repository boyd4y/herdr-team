import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpPermissionHandler, type AcpRuntimeEvent, type AcpRuntimeHandle, type AcpRuntimeTurn } from "acpx/runtime";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpLaunch } from "./client.ts";

export async function openAcpSession(config: Pick<AcpLaunch, "cwd" | "stateDir" | "fresh" | "agent">, onPermissionRequest?: AcpPermissionHandler, signal?: AbortSignal) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const savedFile = join(config.stateDir, "session.json");
  let resume: string | undefined;
  if (!config.fresh && existsSync(savedFile)) {
    const saved = JSON.parse(readFileSync(savedFile, "utf8"));
    if (saved.cwd !== config.cwd || JSON.stringify(saved.agent) !== JSON.stringify(config.agent) || typeof saved.sessionId !== "string" || !saved.sessionId) throw new Error("ACP session scope changed; use an explicit fresh start");
    if (saved.resumable !== false) resume = saved.sessionId;
  }
  // A new store forces the runtime to validate exact remote resume at startup;
  // it cannot satisfy ensureSession from an old local record without connecting.
  const store = createRuntimeStore({ stateDir: join(config.stateDir, `records-${randomUUID()}`) });
  const runtime = createAcpRuntime({ cwd: config.cwd,
    sessionStore: store,
    agentRegistry: createAgentRegistry({ overrides: { remote: [config.agent.command, ...config.agent.args] } }),
    permissionMode: config.agent.permissionMode as "approve-reads" | "approve-all" | "deny-all",
    nonInteractivePermissions: "deny", onPermissionRequest,
  });
  let handle: AcpRuntimeHandle;
  let resumable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { void runtime.shutdown().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("ACP session startup cancelled");
    handle = await Promise.race([
      runtime.ensureSession({ sessionKey: "remote", agent: "remote", mode: "persistent", resumeSessionId: resume,
        sessionOptions: config.agent.model === "default" ? undefined : { model: config.agent.model } }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        void runtime.shutdown().catch(() => {});
        reject(new Error("ACP session startup timed out after 30000 ms"));
      }, 30_000); }),
    ]);
    if (!handle.backendSessionId) throw new Error("ACP agent did not confirm a session ID");
    const record = handle.acpxRecordId ? await store.load(handle.acpxRecordId) : undefined;
    resumable = Boolean(record?.agentCapabilities?.loadSession || record?.agentCapabilities?.sessionCapabilities?.resume);
    const temp = `${savedFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ cwd: config.cwd, agent: config.agent, sessionId: handle.backendSessionId, resumable }), { flag: "wx", mode: 0o600 });
    renameSync(temp, savedFile);
  } catch (error) { await runtime.shutdown(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  let active: AcpRuntimeTurn | undefined;
  return {
    sessionId: handle.backendSessionId!, resumed: Boolean(resume), resumable,
    start(text: string, id: string, render: (event: AcpRuntimeEvent) => void) {
      if (active) throw new Error("ACP session is busy");
      const turn = runtime.startTurn({ handle, requestId: id, text, mode: "prompt" });
      active = turn;
      const done = (async () => {
        try { for await (const event of turn.events) render(event); return await turn.result; }
        finally { active = undefined; }
      })();
      void done.catch(() => {}); // Callers may still be awaiting prompt admission.
      return { started: turn.promptStarted, done };
    },
    async cancel() { await active?.cancel({ reason: "Cancelled in ACP pane" }); },
    async close() { if (active) await active.cancel({ reason: "Pane closed" }); await runtime.shutdown(); },
  };
}

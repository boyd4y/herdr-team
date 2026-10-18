import {
  BoxRenderable, CliRenderEvents, InputRenderable, InputRenderableEvents,
  ScrollBoxRenderable, SelectRenderable, SelectRenderableEvents, TextRenderable,
  createCliRenderer, type CliRenderer, type KeyEvent,
} from "@opentui/core";
import type { Project } from "../shared/types.ts";
import type { Herdr } from "../runtime/herdr.ts";
import { deliveryFor, deliveryState } from "../dispatch/delivery.ts";
import { integrationStatus } from "./status.ts";
import { sanitize } from "../shared/text.ts";
import { buildModel, formatStatusLine, initialState, selectTasks, type ConsoleModel } from "./console-model.ts";

export interface ConsoleOptions {
  initial: Project;
  load: () => Project;
  herdr: Herdr;
  intervalMs: number;
  showAll: boolean;
  tick?: () => void;
  shouldQuit?: () => boolean;
}

/** OpenTUI owns layout, input parsing, scrolling, drawing, and terminal restoration. */
export function mountConsole(renderer: CliRenderer, options: ConsoleOptions) {
  const state = initialState(options.showAll);
  let project = options.initial;
  let model: ConsoleModel;
  let updating = false;
  let stopped = false;
  const root = new BoxRenderable(renderer, { id: "team-console", width: "100%", height: "100%", flexDirection: "column" });
  const heading = new TextRenderable(renderer, { id: "heading", height: 1, truncate: true, fg: "#89b4fa" });
  const pending = new TextRenderable(renderer, { id: "pending", height: 1, truncate: true });
  const health = new TextRenderable(renderer, { id: "health", height: 1, truncate: true, fg: "#f9e2af" });
  const search = new InputRenderable(renderer, { id: "search", width: "100%", placeholder: "Search tasks by ID, title or role", visible: false });
  const main = new BoxRenderable(renderer, { id: "panels", flexGrow: 1, flexDirection: "row" });
  const left = new BoxRenderable(renderer, { id: "overview", width: "48%", flexDirection: "column", flexShrink: 0 });
  const taskPanel = new BoxRenderable(renderer, { id: "tasks-panel", title: "TASKS", border: true, flexGrow: 1, minHeight: 4 });
  const tasks = new SelectRenderable(renderer, { id: "tasks", width: "100%", height: "100%", showDescription: false,
    showScrollIndicator: true, wrapSelection: false, selectedBackgroundColor: "#313244", selectedTextColor: "#cdd6f4",
    keyBindings: [{ name: "j", action: "move-down" }, { name: "k", action: "move-up" }] });
  const roles = new ScrollBoxRenderable(renderer, { id: "roles", title: "ROLES", border: true, height: 6, scrollY: true });
  const roleText = new TextRenderable(renderer, { id: "role-text", width: "100%", wrapMode: "word" });
  const details = new ScrollBoxRenderable(renderer, { id: "details", title: "DETAIL", border: true, flexGrow: 1, scrollY: true, minHeight: 4 });
  const detailText = new TextRenderable(renderer, { id: "detail-text", width: "100%", wrapMode: "word" });
  const footer = new TextRenderable(renderer, { id: "footer", height: 1, truncate: true,
    content: "↑/↓ j/k select · PgUp/PgDn detail · / search · a all · r refresh · Tab focus · q quit", fg: "#a6adc8" });
  taskPanel.add(tasks); roles.add(roleText); left.add(taskPanel); left.add(roles); details.add(detailText);
  main.add(left); main.add(details); root.add(heading); root.add(pending); root.add(health); root.add(search); root.add(main); root.add(footer);
  renderer.root.add(root);

  const showDetail = () => {
    const task = model.tasks[tasks.getSelectedIndex()];
    const changed = state.selectedId !== (task?.id ?? null);
    state.selectedId = task?.id ?? null;
    state.selectedIndex = task ? tasks.getSelectedIndex() : -1;
    model.selectedIndex = state.selectedIndex;
    const live = task && model.taskAgents.get(task.id);
    const flow = task && (integrationStatus(task)?.state ?? deliveryState(task) ?? "not queued");
    const delivery = task && deliveryState(task) !== "invalid" ? deliveryFor(task) : undefined;
    detailText.content = task ? sanitize([
      `#${task.id} ${task.title}`, `${task.priority} · ${task.status} · ${task.role}`,
      `Delivery: ${flow}${delivery ? ` · ${delivery.id.slice(0, 8)} · ${delivery.reason ?? ""}` : ""}`,
      `Agent: ${live?.name ?? "—"} · ${live?.agent_status ?? "—"} · ${live?.pane_id ?? "—"}`,
      `Next: ${task.handoff.join(" → ") || "none"}`, `Dependencies: ${task.dependsOn.join(", ") || "none"}`,
      "", task.body,
    ].join("\n"), true) : "No matching tasks.";
    if (changed) details.scrollTo(0);
  };

  const refresh = (reload = true) => {
    if (stopped || renderer.isDestroyed) return;
    if (options.shouldQuit?.()) { renderer.destroy(); return; }
    if (reload) {
      const errors: string[] = [];
      try { options.tick?.(); } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
      try { project = options.load(); } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
      state.loadError = errors.join(" · ") || null;
      model = buildModel(project, options.herdr, state, new Date().toLocaleTimeString("en-GB"));
    } else model = { ...model, ...selectTasks(project, state) };
    heading.content = sanitize(`Team Console · ${model.projectName} · ${formatStatusLine(model, project.tasks)} · ${model.now}`);
    const counts = model.pending;
    const pendingParts = [["waiting", counts.waiting], ["delivering", counts.delivering], ["claimed", counts.claimed],
      ["needs you", counts.needsYou], ["integration", counts.integration]] as const;
    pending.content = `PENDING · ${pendingParts.filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(" · ")}`;
    pending.visible = pendingParts.some(([, n]) => n > 0);
    const issues = [state.loadError, ...model.problems, ...model.inconsistencies.map((issue) => issue.message),
      ...(!model.herdrOk ? ["Herdr unavailable"] : [])].filter(Boolean);
    health.content = sanitize(issues.length ? `NEEDS YOU · ${issues.join(" · ")}` : "Ready");
    health.visible = issues.length > 0;
    taskPanel.title = `TASKS ${model.tasks.length}/${model.candidateCount}${state.showAll ? " · all" : ""}`;
    updating = true;
    try {
      tasks.options = model.tasks.map((task) => ({ name: sanitize(`#${task.id} ${task.priority} ${task.status} ${task.title}`),
        description: "", value: task.id }));
      tasks.setSelectedIndex(model.selectedIndex);
    } finally { updating = false; }
    roleText.content = sanitize(model.roles.map((role) =>
      `${role.role} · ${role.herdrStatus} · active ${role.current?.join(",") || "—"} · queued ${role.queued ?? 0}`).join("\n"), true);
    showDetail();
  };
  const resize = () => {
    const narrow = renderer.width < 90;
    main.flexDirection = narrow ? "column" : "row";
    left.width = narrow ? "100%" : "48%";
    left.height = narrow ? "48%" : "100%";
    roles.height = renderer.height < 22 ? 3 : 6;
  };
  const select = () => { if (!updating) showDetail(); };
  const input = () => { state.query = search.value; refresh(false); };
  const keypress = (key: KeyEvent) => {
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    if (search.focused) {
      if (key.name === "escape" || key.name === "return" || key.name === "enter") {
        consume();
        if (key.name === "escape") { search.value = ""; state.query = ""; search.visible = false; refresh(false); }
        tasks.focus();
      }
      return;
    }
    switch (key.name) {
      case "q": consume(); renderer.destroy(); break;
      case "escape":
        consume();
        if (state.query) { state.query = ""; search.value = ""; search.visible = false; refresh(false); }
        else renderer.destroy();
        break;
      case "/": consume(); search.visible = true; search.focus(); break;
      case "a": consume(); state.showAll = !state.showAll; refresh(false); break;
      case "r": consume(); refresh(); break;
      case "pageup": consume(); details.scrollBy(-Math.max(1, renderer.height - 8)); break;
      case "pagedown": consume(); details.scrollBy(Math.max(1, renderer.height - 8)); break;
      case "tab": consume(); if (tasks.focused) details.focus(); else tasks.focus(); break;
    }
  };
  tasks.on(SelectRenderableEvents.SELECTION_CHANGED, select);
  search.on(InputRenderableEvents.INPUT, input);
  renderer.keyInput.on("keypress", keypress);
  renderer.on(CliRenderEvents.RESIZE, resize);
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    renderer.keyInput.off("keypress", keypress);
    renderer.off(CliRenderEvents.RESIZE, resize);
    renderer.off(CliRenderEvents.DESTROY, dispose);
  };
  renderer.on(CliRenderEvents.DESTROY, dispose);
  resize(); tasks.focus(); refresh();
  if (!stopped && options.intervalMs > 0) timer = setInterval(refresh, options.intervalMs);
  return { refresh, dispose, get model() { return model; } };
}

export async function runConsole(options: ConsoleOptions): Promise<number> {
  const renderer = await createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: true,
    exitSignals: ["SIGTERM", "SIGHUP"], consoleMode: "disabled" });
  let app: ReturnType<typeof mountConsole> | undefined;
  try { app = mountConsole(renderer, options); await renderer.closed; return 0; }
  finally { app?.dispose(); renderer.destroy(); await renderer.closed; }
}

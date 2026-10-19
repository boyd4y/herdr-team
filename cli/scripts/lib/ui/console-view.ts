import {
  BoxRenderable, CliRenderEvents, InputRenderable, InputRenderableEvents,
  ScrollBoxRenderable, SelectRenderable, SelectRenderableEvents, TextRenderable,
  createCliRenderer, fg, t, type CliRenderer, type KeyEvent,
} from "@opentui/core";
import type { Project } from "../shared/types.ts";
import { worktreeBranch } from "../shared/types.ts";
import type { Herdr } from "../runtime/herdr.ts";
import { deliveryFor } from "../dispatch/delivery.ts";
import { reviewFor, taskScoped } from "../tasks/verification.ts";
import { integrationStatus } from "./status.ts";
import { sanitize } from "../shared/text.ts";
import { buildModel, formatStatusLine, initialState, selectTasks, taskFlow, type ConsoleModel } from "./console-model.ts";
import { createFlowView } from "./console-flow.ts";
import { consoleColors as c } from "./console-theme.ts";
import { sampleConsole } from "./console-sample.ts";
import { createRolesView } from "./console-roles.ts";

export type ConsoleOptions = {
  intervalMs: number;
  showAll: boolean;
  tick?: () => void;
  shouldQuit?: () => boolean;
  subscribe?: (refresh: () => void) => () => void;
  nextDeadline?: (project: Project) => number | undefined;
} & ({ sample: true } | { sample?: false; initial: Project; load: (force?: boolean) => Project; herdr: Herdr });

/** OpenTUI owns layout, input parsing, scrolling, drawing, animation and terminal restoration. */
export function mountConsole(renderer: CliRenderer, options: ConsoleOptions) {
  const state = initialState(options.sample || options.showAll);
  let sample = options.sample === true;
  let sampleStarted = Date.now();
  let project = options.sample ? sampleConsole(state).project : options.initial;
  let liveProject = options.sample ? undefined : options.initial;
  let liveShowAll = options.showAll;
  let model: ConsoleModel;
  let updating = false;
  let stopped = false;
  let focused = true;
  let taskOptionsSignature = "";
  let detailBody = "";
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const root = new BoxRenderable(renderer, { id: "team-console", width: "100%", height: "100%", flexDirection: "column",
    backgroundColor: c.background, paddingX: 1 });
  const heading = new TextRenderable(renderer, { id: "heading", height: 1, truncate: true });
  const pending = new TextRenderable(renderer, { id: "pending", height: 1, truncate: true, fg: c.muted });
  const health = new TextRenderable(renderer, { id: "health", height: 1, truncate: true, fg: c.red });
  const search = new InputRenderable(renderer, { id: "search", width: "100%", placeholder: "Search tasks by ID, title or role", visible: false });
  const main = new BoxRenderable(renderer, { id: "panels", flexGrow: 1, minHeight: 0, flexDirection: "row", gap: 1 });
  const left = new BoxRenderable(renderer, { id: "overview", width: "28%", minWidth: 24, flexDirection: "column", flexShrink: 0 });
  const taskPanel = new BoxRenderable(renderer, { id: "tasks-panel", title: "TASKS", border: true,
    borderColor: c.border, titleColor: c.green, flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 4 });
  const tasks = new SelectRenderable(renderer, { id: "tasks", width: "100%", height: "100%", showDescription: true,
    showScrollIndicator: true, wrapSelection: false, selectedBackgroundColor: "#223638", selectedTextColor: c.green,
    textColor: c.text, descriptionColor: c.muted, selectedDescriptionColor: c.text,
    keyBindings: [{ name: "j", action: "move-down" }, { name: "k", action: "move-up" }] });
  const empty = new TextRenderable(renderer, { id: "empty", visible: false, width: "100%", fg: c.muted, wrapMode: "word" });
  const roleTable = createRolesView(renderer);
  const roles = roleTable.view;
  const workspace = new BoxRenderable(renderer, { id: "workspace", flexGrow: 1, minWidth: 0, flexDirection: "column" });
  const selectedTitle = new TextRenderable(renderer, { id: "selected-title", height: 1, truncate: true, fg: c.text });
  const flow = createFlowView(renderer);
  const details = new ScrollBoxRenderable(renderer, { id: "details", title: "DETAIL", border: true,
    borderColor: c.border, focusedBorderColor: c.blue, titleColor: c.blue,
    flexGrow: 1, flexBasis: 0, minWidth: 0, scrollY: true, minHeight: 4 });
  const detailText = new TextRenderable(renderer, { id: "detail-text", width: "100%", wrapMode: "word", fg: c.text });
  const bodyText = new TextRenderable(renderer, { id: "detail-body", width: "100%", wrapMode: "word", fg: c.text });
  const footer = new TextRenderable(renderer, { id: "footer", height: 1, truncate: true, fg: c.muted });
  const sizeHint = new TextRenderable(renderer, { id: "size-hint", flexGrow: 1, width: "100%", wrapMode: "word", fg: c.muted,
    content: "Resize the terminal to at least 40 columns and 20 rows. Ctrl-C exits.", visible: false });
  taskPanel.add(tasks); taskPanel.add(empty); left.add(taskPanel); left.add(roles);
  details.add(detailText); details.add(bodyText);
  workspace.add(selectedTitle); workspace.add(flow.view); workspace.add(details);
  main.add(left); main.add(workspace); root.add(heading); root.add(pending); root.add(health); root.add(search); root.add(main); root.add(sizeHint); root.add(footer);
  renderer.root.add(root);

  const updateFooter = () => {
    const preview = options.sample ? "preview" : sample ? "s live" : "s sample";
    footer.content = renderer.width < 40 ? "q quit · Ctrl-C exit" : renderer.width < 60 ? "Tab panels · / search · q quit" :
      renderer.width < 100 ? `↑↓ tasks · Tab focus · / search · ${preview} · q quit` :
      `↑↓ select · / search · a all · Tab focus · PgUp/Dn scroll · ${preview} · q quit`;
  };

  const showDetail = () => {
    const task = model.tasks[tasks.getSelectedIndex()];
    const changed = state.selectedId !== (task?.id ?? null);
    state.selectedId = task?.id ?? null;
    state.selectedIndex = task ? tasks.getSelectedIndex() : -1;
    model.selectedIndex = state.selectedIndex;
    if (changed) details.scrollTo(0);
    bodyText.visible = !!task?.body;
    if (!task) {
      selectedTitle.content = "No matching tasks.";
      detailText.content = project.tasks.length ? "No matching tasks." : "Your team is ready. Create a task with the herdr-team skill, or press s for a sample.";
      flow.update("", { nodes: [], current: -1 }, renderer.width < 90);
      return;
    }
    const live = model.taskAgents.get(task.id);
    const integration = integrationStatus(task);
    let delivery: ReturnType<typeof deliveryFor>;
    let deliveryStatus = "not queued";
    try { delivery = deliveryFor(task); deliveryStatus = delivery?.state ?? deliveryStatus; }
    catch { deliveryStatus = "invalid"; }
    const age = delivery && Math.max(0, Math.floor((model.observedAt - Date.parse(delivery.sent_at ?? delivery.queued_at)) / 1000));
    const role = project.roles.find(role => role.name === task.role);
    let commit: string | undefined;
    try { commit = reviewFor(task)?.commit; } catch { /* Visible in validation issues. */ }
    selectedTitle.content = t`${fg(c.blue)(`#${task.id}`)} ${sanitize(task.title)}`;
    detailText.content = sanitize([
      `${task.priority} · ${task.status} · ${task.role}`,
      `Delivery: ${integration?.state ?? deliveryStatus}${delivery ? ` · ${delivery.id.slice(0, 8)}` : ""}`,
      ...(age !== undefined ? [`Delivery age: ${Math.floor(age / 60)}m ${age % 60}s`] : []),
      ...(delivery?.reason ? [delivery.reason] : []),
      ...(integration && "reason" in integration && integration.reason ? [`Integration: ${integration.reason}`] : []),
      `Agent: ${live?.name ?? "—"} · ${live?.agent_status ?? "—"}`,
      ...(role ? [`Model: ${role.kind} · ${role.model ?? "default"}`] : []),
      ...(live?.pane_id ? [`Pane: ${live.pane_id}`] : []),
      ...(taskScoped(task, role) ? [`Branch: ${worktreeBranch(task)}`] : []),
      ...(commit ? [`Commit: ${commit.slice(0, 12)}`] : []),
      `Next: ${task.handoff.join(" → ") || "none"}`, `Dependencies: ${task.dependsOn.join(", ") || "none"}`,
    ].join("\n"), true);
    if (detailBody !== task.body) { detailBody = task.body; bodyText.content = `\n${sanitize(task.body, true)}`; }
    flow.update(task.id, taskFlow(task, project, model), renderer.width < 90);
  };

  const layout = () => {
    const narrow = renderer.width < 90;
    const tooSmall = renderer.width < 40 || renderer.height < 20;
    main.visible = !tooSmall;
    sizeHint.visible = tooSmall;
    flow.setActive(focused && !tooSmall);
    const available = renderer.height - 3 - Number(health.visible) - Number(search.visible);
    const roleHeight = project.roles.length * 2 + 3;
    main.flexDirection = narrow ? "column" : "row";
    left.width = narrow ? "100%" : "28%";
    left.flexDirection = narrow ? "row" : "column";
    left.gap = narrow ? 1 : 0;
    left.height = narrow ? Math.min(Math.max(5, roleHeight), Math.max(4, Math.floor(available * 0.35))) : "100%";
    roles.width = narrow ? "48%" : "100%";
    roles.height = narrow ? "100%" : Math.min(Math.max(4, roleHeight), Math.max(4, available - 4));
    updateFooter();
  };

  const refresh = (reload = true, force = false) => {
    if (stopped || renderer.isDestroyed) return;
    if (options.shouldQuit?.()) { renderer.destroy(); return; }
    if (sample) {
      const frame = sampleConsole(state, Date.now() - sampleStarted);
      project = frame.project; model = frame.model;
    } else if (!options.sample && reload) {
      const errors: string[] = [];
      project = liveProject!;
      try { if (force) options.load(true); options.tick?.(); } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
      try { project = options.load(); liveProject = project; } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
      state.loadError = errors.join(" · ") || null;
      model = buildModel(project, options.herdr, state, new Date().toLocaleTimeString("en-GB"));
    } else model = { ...model, ...selectTasks(project, state) };
    heading.content = t`${fg(c.green)("Team Console")} · ${sanitize(model.projectName)}  ${fg(sample ? c.yellow : c.green)(sample ? "SAMPLE · simulated" : model.herdrOk ? "● Connected" : "○ Offline")}  ${fg(c.muted)(model.now)}`;
    const counts = model.pending;
    const pendingParts = [["delivering", counts.delivering], ["claimed", counts.claimed], ["integration", counts.integration]] as const;
    const summary = [formatStatusLine(model, project.tasks), ...pendingParts.filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`)].filter(Boolean);
    pending.content = sanitize(summary.join(" · ") || "No active tasks · press s for a sample");
    const issues = [state.loadError, ...model.problems, ...model.inconsistencies.map((issue) => issue.message),
      ...(!model.herdrOk ? ["Herdr unavailable"] : [])].filter(Boolean);
    health.content = sanitize(issues.length ? `NEEDS YOU · ${issues.join(" · ")}` : "Ready");
    health.visible = issues.length > 0;
    taskPanel.title = `TASKS ${model.tasks.length}/${model.candidateCount}${state.showAll ? " · all" : ""}`;
    tasks.visible = model.tasks.length > 0;
    empty.visible = model.tasks.length === 0;
    empty.content = project.tasks.length ? "No matching tasks.\n\nClear the search or press a to include completed tasks." : "No tasks yet.\n\nPress s to explore the sample team.\n\nUse the herdr-team skill to create your first task.";
    updating = true;
    try {
      const taskOptions = model.tasks.map((task) => ({ name: sanitize(`#${task.id} ${task.title}`),
        description: sanitize(`${task.priority} · ${task.status} · ${task.role}`), value: task.id }));
      const signature = JSON.stringify(taskOptions);
      if (signature !== taskOptionsSignature) { tasks.options = taskOptions; taskOptionsSignature = signature; }
      if (tasks.getSelectedIndex() !== model.selectedIndex) tasks.setSelectedIndex(model.selectedIndex);
    } finally { updating = false; }
    roleTable.update(model.roles);
    layout();
    showDetail();
    if (reload) {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const deadline = !sample && options.nextDeadline?.(project);
      // An expired deadline is handled by this pass. Failed records wait for an event or reconciliation.
      if (deadline && deadline > Date.now()) deadlineTimer = setTimeout(refresh, Math.min(deadline - Date.now(), 2_147_483_647));
    }
  };
  const resize = () => {
    layout();
    if (model) showDetail();
  };
  const select = () => { if (!updating) showDetail(); };
  const focus = () => { focused = true; layout(); };
  const blur = () => { focused = false; flow.setActive(false); };
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
    const scrollTarget = flow.view.focused ? flow.view : roles.focused ? roles : details;
    switch (key.name) {
      case "q": consume(); renderer.destroy(); break;
      case "escape":
        consume();
        if (state.query) { state.query = ""; search.value = ""; search.visible = false; refresh(false); }
        else renderer.destroy();
        break;
      case "/": consume(); search.visible = true; search.focus(); break;
      case "a": consume(); state.showAll = !state.showAll; refresh(false); break;
      case "r": consume(); refresh(true, true); break;
      case "s":
        consume();
        if (options.sample) break;
        if (!sample) liveShowAll = state.showAll;
        sample = !sample; sampleStarted = Date.now();
        state.showAll = sample ? true : liveShowAll;
        state.selectedId = null; state.selectedIndex = 0; state.query = ""; state.loadError = null;
        search.value = ""; search.visible = false;
        syncTimer(); refresh(); tasks.focus(); break;
      case "pageup": consume(); scrollTarget.scrollBy(-Math.max(1, scrollTarget.height - 2)); break;
      case "pagedown": consume(); scrollTarget.scrollBy(Math.max(1, scrollTarget.height - 2)); break;
      case "tab": {
        consume();
        const panes = [tasks, roles, flow.view, details];
        panes[(panes.findIndex(pane => pane.focused) + 1) % panes.length]!.focus();
        break;
      }
    }
  };
  tasks.on(SelectRenderableEvents.SELECTION_CHANGED, select);
  search.on(InputRenderableEvents.INPUT, input);
  renderer.keyInput.on("keypress", keypress);
  renderer.on(CliRenderEvents.RESIZE, resize);
  renderer.on(CliRenderEvents.FOCUS, focus);
  renderer.on(CliRenderEvents.BLUR, blur);
  let timer: ReturnType<typeof setInterval> | undefined;
  const syncTimer = () => {
    if (timer) clearInterval(timer);
    const interval = sample && !options.sample ? 2000 : options.intervalMs;
    if (!stopped && interval > 0) timer = setInterval(refresh, interval);
  };
  const unsubscribe = options.subscribe?.(() => refresh());
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    unsubscribe?.();
    flow.dispose();
    tasks.off(SelectRenderableEvents.SELECTION_CHANGED, select);
    search.off(InputRenderableEvents.INPUT, input);
    renderer.keyInput.off("keypress", keypress);
    renderer.off(CliRenderEvents.RESIZE, resize);
    renderer.off(CliRenderEvents.FOCUS, focus);
    renderer.off(CliRenderEvents.BLUR, blur);
    renderer.off(CliRenderEvents.DESTROY, dispose);
  };
  renderer.on(CliRenderEvents.DESTROY, dispose);
  resize(); tasks.focus(); refresh();
  syncTimer();
  return { refresh, dispose, get model() { return model; } };
}

export async function runConsole(options: ConsoleOptions): Promise<number> {
  const renderer = await createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: true,
    exitSignals: ["SIGTERM", "SIGHUP"], consoleMode: "disabled", targetFps: 60, maxFps: 60 });
  let app: ReturnType<typeof mountConsole> | undefined;
  try { app = mountConsole(renderer, options); await renderer.closed; return 0; }
  finally { app?.dispose(); renderer.destroy(); await renderer.closed; }
}

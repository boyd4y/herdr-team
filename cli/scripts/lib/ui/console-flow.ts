import { BoxRenderable, CliRenderEvents, RGBA, ScrollBoxRenderable, StyledText, TextRenderable, createTimeline, fg, getTimelineEngine,
  type CliRenderer, type Timeline } from "@opentui/core";
import { sanitize } from "../shared/text.ts";
import type { FlowState, TaskFlow } from "./console-model.ts";

export const consoleColors = { background: "#111719", panel: "#151d20", border: "#344449", text: "#c4d3d6",
  muted: "#829298", green: "#3ed6ac", blue: "#79aafa", yellow: "#e9b85b", red: "#ed8e91", purple: "#b39af7" };
const colors: Record<FlowState, string> = { done: consoleColors.green, running: consoleColors.blue,
  sending: consoleColors.yellow, blocked: consoleColors.red, waiting: consoleColors.border, idle: consoleColors.purple, cancelled: consoleColors.muted };

const mix = (from: RGBA, to: RGBA, amount: number) => RGBA.fromValues(
  from.r + (to.r - from.r) * amount, from.g + (to.g - from.g) * amount, from.b + (to.b - from.b) * amount, 1);

function nodeKeys(flow: TaskFlow): string[] {
  const visits = new Map<string, number>();
  return flow.nodes.map(node => {
    const key = `${node.kind}:${node.role}`;
    const visit = (visits.get(key) ?? 0) + 1;
    visits.set(key, visit);
    return `${key}:${visit}`;
  });
}

/** Thin component assembly: native boxes/text/scrolling and renderer-owned timelines. */
export function createFlowView(renderer: CliRenderer) {
  const engine = getTimelineEngine(renderer);
  const view = new ScrollBoxRenderable(renderer, { id: "flow", title: "FLOW", border: true,
    borderColor: consoleColors.border, focusedBorderColor: consoleColors.blue, titleColor: consoleColors.blue,
    flexGrow: 1, flexBasis: 0, minHeight: 4,
    scrollX: true, scrollY: true, contentOptions: { flexDirection: "row", alignItems: "center", justifyContent: "center",
      minWidth: "100%", minHeight: "100%", paddingX: 1 } });
  let previous: { id: string; flow: TaskFlow } | undefined;
  let active = true;
  let disposed = false;
  const revealCurrent = () => {
    if (!disposed && active && !view.isDestroyed && previous?.flow.nodes[previous.flow.current]) view.scrollChildIntoView(`flow-node-${previous.flow.current}`);
  };
  const scheduleReveal = () => {
    if (disposed || !active) return;
    renderer.off(CliRenderEvents.FRAME, revealCurrent);
    renderer.once(CliRenderEvents.FRAME, revealCurrent);
  };
  // Native layout/scroll limits settle during a frame; reveal once after presentation, not before layout.
  view.content.on("resize", scheduleReveal);
  view.viewport.on("resize", scheduleReveal);
  let signature = "";
  let vertical = false;
  const timelines: Timeline[] = [];
  const clearAnimations = () => {
    for (const timeline of timelines.splice(0)) { timeline.pause(); engine.unregister(timeline); }
  };
  const update = (id: string, flow: TaskFlow, narrow = false) => {
    if (disposed) return;
    const nextSignature = JSON.stringify([id, flow, narrow]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    clearAnimations();
    for (const child of view.getChildren()) { view.remove(child); child.destroyRecursively(); }
    vertical = narrow;
    view.content.flexDirection = vertical ? "column" : "row";
    view.content.alignItems = "center";
    const before = previous?.id === id ? previous.flow : undefined;
    const keys = nodeKeys(flow), beforeKeys = before ? nodeKeys(before) : [];
    const beforeKey = before && beforeKeys[before.current];
    const from = beforeKey === undefined ? -1 : keys.indexOf(beforeKey);
    const changedOwner = before && beforeKey !== keys[flow.current];
    const returning = !!changedOwner && from > flow.current;
    const inFlight = flow.nodes[flow.current]?.state === "sending";
    const pulseNode = flow.nodes[flow.current]?.state === "running" || inFlight && flow.current === 0;
    flow.nodes.forEach((node, index) => {
      if (index > 0) {
        const line = new BoxRenderable(renderer, { id: `flow-link-${index}`, width: vertical ? 24 : 7,
          height: vertical ? 1 : 5, flexShrink: 0 });
        const crossed = returning ? index > flow.current && index <= from : !!changedOwner && index > from && index <= flow.current;
        const backwards = returning && crossed;
        const animate = crossed || inFlight && index === flow.current;
        const color = animate ? consoleColors.yellow : index <= flow.current ? consoleColors.green : consoleColors.border;
        const arrow = new TextRenderable(renderer, { id: `flow-signal-${index}`, content: vertical ? backwards ? "↑" : "↓" : backwards ? "◀──────" : "──────▶",
          width: vertical ? 1 : 7, height: 1, position: "absolute", top: vertical ? 0 : 2, left: vertical ? 2 : 0, fg: color });
        line.add(arrow);
        if (animate) {
          const base = RGBA.fromHex(consoleColors.border), light = RGBA.fromHex(consoleColors.yellow);
          const length = vertical ? 1 : 7;
          const progress = { position: backwards ? length + 2 : -2 };
          const timeline = createTimeline({ duration: 1600, autoplay: false, loop: inFlight,
            onComplete: () => {
              arrow.content = vertical ? "↓" : "──────▶";
              arrow.fg = index <= flow.current ? consoleColors.green : consoleColors.border;
            } }, renderer);
          timeline.add(progress, { position: backwards ? -2 : length + 2, duration: 1600, ease: "linear", onUpdate: () => {
            // Cross-fade adjacent character cells instead of rounding a moving dot to whole columns.
            arrow.content = new StyledText(Array.from({ length }, (_, cell) => {
              const intensity = Math.max(0, 1 - Math.abs(cell - progress.position) / 2);
              const head = vertical ? backwards ? "↑" : "↓" : cell === (backwards ? 0 : length - 1) ? backwards ? "◀" : "▶" : undefined;
              return fg(mix(base, light, intensity))(head ?? (intensity > 0.75 ? "●" : intensity > 0.3 ? "•" : "─"));
            }));
          } });
          timelines.push(timeline); if (active) timeline.play();
        }
        view.add(line);
      }
      const title = node.kind === "integration" ? "MERGE QUEUE" : sanitize(node.role.toUpperCase());
      const box = new BoxRenderable(renderer, { id: `flow-node-${index}`, title: vertical ? undefined : title,
        titleColor: vertical ? undefined : colors[node.state], border: !vertical,
        borderColor: vertical ? undefined : colors[node.state], backgroundColor: consoleColors.panel,
        width: vertical ? 32 : 18, height: vertical ? 1 : 5, paddingX: 1, flexShrink: 0 });
      if (index === flow.current) box.on("resize", scheduleReveal);
      const mark = node.state === "done" ? "✓" : node.state === "blocked" ? "!" : node.state === "running" ? "●" : "○";
      const status = new TextRenderable(renderer, { content: `${mark} ${vertical ? `${title} · ` : ""}${node.label}`, height: 1, truncate: true,
        fg: node.state === "waiting" ? consoleColors.muted : colors[node.state] });
      box.add(status);
      if (!vertical) box.add(new TextRenderable(renderer, { content: sanitize(node.model.replace(" · ", "\n"), true), height: 2, truncate: true, fg: consoleColors.muted }));
      view.add(box);
      const accent = RGBA.fromHex(colors[node.state]);
      const highlight = RGBA.fromHex(consoleColors.text);
      const glow = (amount: number) => {
        const color = mix(accent, highlight, amount);
        if (vertical) status.fg = color;
        else box.borderColor = color;
      };
      if (index === flow.current && pulseNode) {
        const pulse = { amount: 0 };
        const timeline = createTimeline({ duration: 2800, loop: true, autoplay: false }, renderer);
        timeline.add(pulse, { amount: 0.3, duration: 1400, ease: "inOutSine", alternate: true, loop: 1,
          onUpdate: () => glow(pulse.amount) });
        timelines.push(timeline); if (active) timeline.play();
      } else if (node.state === "done" && beforeKeys.includes(keys[index]!) && before!.nodes[beforeKeys.indexOf(keys[index]!)]?.state !== "done") {
        const pulse = { amount: 0.5 };
        glow(pulse.amount);
        const timeline = createTimeline({ duration: 650, autoplay: false }, renderer);
        timeline.add(pulse, { amount: 0, duration: 650, ease: "outQuad", onUpdate: () => glow(pulse.amount) });
        timelines.push(timeline); if (active) timeline.play();
      }
    });
    if (!flow.nodes.length) view.add(new TextRenderable(renderer, { content: "Select a task to inspect its handoff path.", fg: consoleColors.muted }));
    if (previous?.id !== id || !!changedOwner) view.scrollTo(0);
    previous = { id, flow };
    scheduleReveal();
  };
  const setActive = (enabled: boolean) => {
    if (disposed || active === enabled) return;
    active = enabled;
    for (const timeline of timelines) {
      if (!active) timeline.pause();
      else if (!timeline.isComplete) timeline.play();
    }
    if (active) scheduleReveal();
    else renderer.off(CliRenderEvents.FRAME, revealCurrent);
  };
  return { view, update, setActive, dispose: () => {
    if (disposed) return;
    disposed = true;
    clearAnimations();
    renderer.off(CliRenderEvents.FRAME, revealCurrent);
    view.content.off("resize", scheduleReveal);
    view.viewport.off("resize", scheduleReveal);
  } };
}

import { BoxRenderable, ScrollBoxRenderable, TextRenderable, createTimeline, getTimelineEngine,
  type CliRenderer, type Timeline } from "@opentui/core";
import { sanitize } from "../shared/text.ts";
import type { FlowState, TaskFlow } from "./console-model.ts";

export const consoleColors = { background: "#111719", panel: "#151d20", border: "#344449", text: "#c4d3d6",
  muted: "#829298", green: "#3ed6ac", blue: "#79aafa", yellow: "#e9b85b", red: "#ed8e91", purple: "#b39af7" };
const colors: Record<FlowState, string> = { done: consoleColors.green, running: consoleColors.blue,
  sending: consoleColors.yellow, blocked: consoleColors.red, waiting: consoleColors.border, idle: consoleColors.purple, cancelled: consoleColors.muted };

/** Thin component assembly: native boxes/text/scrolling and renderer-owned timelines. */
export function createFlowView(renderer: CliRenderer) {
  const engine = getTimelineEngine(renderer);
  const view = new ScrollBoxRenderable(renderer, { id: "flow", title: "FLOW", border: true,
    borderColor: consoleColors.border, titleColor: consoleColors.blue, height: 9, flexShrink: 0,
    scrollX: true, scrollY: true, contentOptions: { flexDirection: "row", alignItems: "center", padding: 1 } });
  let previous: { id: string; flow: TaskFlow } | undefined;
  let signature = "";
  let vertical = false;
  const timelines: Timeline[] = [];
  const clearAnimations = () => {
    for (const timeline of timelines.splice(0)) { timeline.pause(); engine.unregister(timeline); }
  };
  const update = (id: string, flow: TaskFlow, narrow = false) => {
    const nextSignature = JSON.stringify([id, flow, narrow]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    clearAnimations();
    for (const child of view.getChildren()) { view.remove(child); child.destroyRecursively(); }
    vertical = narrow;
    view.content.flexDirection = vertical ? "column" : "row";
    view.content.alignItems = vertical ? "flex-start" : "center";
    const before = previous?.id === id ? previous.flow : undefined;
    const from = before ? flow.nodes.findIndex(node => node.role === before.nodes[before.current]?.role) : -1;
    const changedOwner = before && before.nodes[before.current]?.role !== flow.nodes[flow.current]?.role;
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
        const arrow = new TextRenderable(renderer, { content: vertical ? backwards ? "↑" : "↓" : backwards ? "◀──────" : "──────▶",
          width: vertical ? 1 : 7, height: 1, position: "absolute", top: vertical ? 0 : 2, left: vertical ? 2 : 0, fg: color });
        line.add(arrow);
        if (animate) {
          const dot = new TextRenderable(renderer, { id: `flow-dot-${index}`, content: "●", width: 1, height: 1,
            position: "absolute", top: vertical ? 0 : 2, left: vertical ? 2 : backwards ? 5 : 0,
            fg: consoleColors.text });
          line.add(dot);
          const progress = { position: backwards ? 1 : 0 };
          const timeline = createTimeline({ duration: 1000, autoplay: false, loop: inFlight,
            onComplete: () => {
              dot.visible = false;
              arrow.content = vertical ? "↓" : "──────▶";
              arrow.fg = index <= flow.current ? consoleColors.green : consoleColors.border;
            } }, renderer);
          timeline.add(progress, { position: backwards ? 0 : 1, duration: 900, ease: "inOutSine", onUpdate: () => {
            if (vertical) dot.opacity = 0.4 + progress.position * 0.6;
            else dot.left = Math.round(progress.position * 5);
          } });
          timelines.push(timeline); timeline.play();
        }
        view.add(line);
      }
      const box = new BoxRenderable(renderer, { id: `flow-node-${index}`, title: vertical ? undefined : sanitize(node.role.toUpperCase()),
        titleColor: vertical ? undefined : colors[node.state], border: !vertical,
        borderColor: vertical ? undefined : colors[node.state], backgroundColor: consoleColors.panel,
        width: vertical ? 32 : 18, height: vertical ? 1 : 5, paddingX: 1, flexShrink: 0 });
      const mark = node.state === "done" ? "✓" : node.state === "blocked" ? "!" : node.state === "running" ? "●" : "○";
      box.add(new TextRenderable(renderer, { content: `${mark} ${vertical ? `${node.role.toUpperCase()} · ` : ""}${node.label}`, height: 1, truncate: true,
        fg: node.state === "waiting" ? consoleColors.muted : colors[node.state] }));
      if (!vertical) box.add(new TextRenderable(renderer, { content: sanitize(node.model.replace(" · ", "\n"), true), height: 2, truncate: true, fg: consoleColors.muted }));
      view.add(box);
      if (index === flow.current && pulseNode) {
        const timeline = createTimeline({ duration: 1800, loop: true, autoplay: false }, renderer);
        timeline.add(box, { opacity: 0.72, duration: 900, ease: "inOutSine", alternate: true, loop: 1 });
        timelines.push(timeline); timeline.play();
      } else if (node.state === "done" && before?.nodes.some(previous => previous.role === node.role && previous.state !== "done")) {
        box.opacity = 0.6;
        const timeline = createTimeline({ duration: 450, autoplay: false }, renderer);
        timeline.add(box, { opacity: 1, duration: 450, ease: "outQuad" });
        timelines.push(timeline); timeline.play();
      }
    });
    if (!flow.nodes.length) view.add(new TextRenderable(renderer, { content: "Select a task to inspect its handoff path.", fg: consoleColors.muted }));
    if (previous?.id !== id || !!changedOwner) view.scrollTo(0);
    if (flow.nodes[flow.current]) view.scrollChildIntoView(`flow-node-${flow.current}`);
    previous = { id, flow };
  };
  return { view, update, dispose: clearAnimations };
}

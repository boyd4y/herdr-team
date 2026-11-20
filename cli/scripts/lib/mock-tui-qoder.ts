import { BoxRenderable, TextRenderable, fg, t } from "@opentui/core";
import type { ExtraMockTuiProfile } from "./mock-tui-profile.ts";

const foreground = "#DDDDE1";
const muted = "#93939B";

export const qoderProfile: ExtraMockTuiProfile = {
  title: "Qoder CLI",
  version: "v1.1.93",
  model: "DeepSeek-Flash",
  accent: "#22BA4E",
  edge: "#53535D",
  fill: "#18191C",
  background: "#18191C",
  shape: "single",
  input: "Type a message",
  prompt: text => `>   ${text}`,
  step: (_index, text) => `•  ${text}`,
  note: text => `   ${text}`,
  answer: "•  Response",
  working: "⠙ Generating…",
  ready: "",

  mount({ renderer, root, transcript, input, status, activity, session }) {
    const divider = {
      borderStyle: qoderProfile.shape,
      borderColor: qoderProfile.edge,
    };
    const line = (content: string | ReturnType<typeof t>, color = muted) => new TextRenderable(renderer, {
      content, fg: color, height: 1, width: "100%", flexShrink: 0, truncate: true,
    });

    const header = new BoxRenderable(renderer, {
      width: "100%", flexDirection: "row", flexShrink: 0, marginTop: 1, gap: 3,
    });
    const identity = new BoxRenderable(renderer, {
      flexDirection: "row", alignItems: "center", flexShrink: 0, gap: 2,
    });
    const emblem = new TextRenderable(renderer, {
      content: "  ██████\n██      ██\n██  ██  ██\n██    ██\n  ████  ██",
      width: 10, height: 5, flexShrink: 0, fg: qoderProfile.accent,
    });
    const title = line(t`${fg(foreground)(qoderProfile.title)} ${fg(muted)(qoderProfile.version)}`);
    title.width = 22;
    identity.add(emblem);
    identity.add(title);
    const tips = new BoxRenderable(renderer, {
      width: 46, minWidth: 0, flexShrink: 1, flexDirection: "column",
      border: true, borderStyle: "rounded", borderColor: qoderProfile.edge,
      title: " Keyboard shortcuts ", titleColor: muted, paddingX: 1,
    });
    tips.add(line("Enter sends · Esc interrupts"));
    tips.add(line("PgUp/PgDn scroll the conversation"));
    tips.add(line("/exit ends the session"));
    header.add(identity);
    header.add(tips);

    const mode = new BoxRenderable(renderer, {
      ...divider, width: "100%", border: ["top"], flexDirection: "row",
      flexShrink: 0, gap: 1, paddingX: 1,
    });
    status.width = "auto";
    status.minWidth = 0;
    status.flexGrow = 1;
    status.fg = qoderProfile.accent;
    mode.add(status);
    const shortcuts = line("PgUp/PgDn history · /exit quit");
    shortcuts.width = 30;
    mode.add(shortcuts);

    const composer = new BoxRenderable(renderer, {
      ...divider, width: "100%", border: ["top", "bottom"],
      flexShrink: 0, flexDirection: "row", paddingX: 1, gap: 2,
    });
    const caret = line(">", "#DA9FF0");
    caret.width = 1;
    composer.add(caret);
    composer.add(input);

    const footer = new BoxRenderable(renderer, {
      width: "100%", flexDirection: "row", height: 1, flexShrink: 0, gap: 1, paddingX: 1,
    });
    const context = line("", muted);
    footer.add(context);

    transcript.flexGrow = 0;
    transcript.flexBasis = "auto";
    transcript.height = 1;
    transcript.visible = false;
    transcript.content.minHeight = 0;
    transcript.content.paddingY = 0;
    const fit = () => {
      if (!transcript.visible) return;
      const available = Math.max(1, renderer.height - header.height - (renderer.height < 14 ? 7 : 11) - Number(activity.visible));
      transcript.height = Math.min(Math.max(1, transcript.content.height), available);
    };
    const scrollbar = transcript.content.onSizeChange;
    transcript.content.onSizeChange = () => { scrollbar?.(); fit(); };
    header.onSizeChange = fit;
    activity.onSizeChange = fit;

    const size = () => {
      const short = renderer.height < 14;
      header.marginTop = short ? 0 : 1;
      header.marginBottom = short ? 0 : 4;
      emblem.visible = !short && renderer.width >= 35;
      tips.visible = !short && renderer.width >= 78;
      shortcuts.visible = renderer.width >= 55;
      const stats = renderer.width >= 64 ? " · ctx ░░░░░░░░░░ 0%" : " · ctx 0%";
      const summary = `${qoderProfile.model} Model${stats}`;
      const available = renderer.width - Bun.stringWidth(summary) - 7;
      const shortPath = `…/${session.split("/").slice(-2).join("/")}`;
      const path = Bun.stringWidth(session) <= available ? session : shortPath;
      context.content = available >= Bun.stringWidth(path) ? `${summary} · ${path}` : summary;
      fit();
    };
    renderer.on("resize", size);
    size();

    root.add(header);
    root.add(transcript);
    root.add(activity);
    root.add(mode);
    root.add(composer);
    root.add(footer);
  },
};

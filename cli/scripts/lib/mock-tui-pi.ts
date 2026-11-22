import { BoxRenderable, TextRenderable, fg, t } from "@opentui/core";
import type { ExtraMockTuiProfile } from "./mock-tui-profile.ts";

const foreground = "#E1E2E6";
const muted = "#85858D";

export const piProfile: ExtraMockTuiProfile = {
  title: "pi",
  version: "v0.85.1",
  model: "deepseek-flash • high",
  accent: "#BFA4CF",
  edge: "#AD8CB8",
  fill: "#18191C",
  background: "#18191C",
  shape: "single",
  input: "",
  prompt: text => `  ${text}`,
  step: (_index, text) => text,
  note: text => `  ${text}`,
  working: "⠋  Working",
  ready: "0.0%/1.0M",

  mount({ renderer, root, transcript, input, status, activity, session, branch }) {
    const header = new BoxRenderable(renderer, {
      width: "100%", flexDirection: "column", flexShrink: 0, marginTop: 1,
    });
    header.add(new TextRenderable(renderer, {
      content: t`${fg(foreground)(piProfile.title)} ${fg(muted)(piProfile.version)}`,
      width: "100%", height: 1, flexShrink: 0, truncate: true,
    }));
    header.add(new TextRenderable(renderer, {
      content: "Enter send · Esc interrupt · PgUp/PgDn history · /exit quit",
      fg: muted, width: "100%", height: 1, flexShrink: 0, truncate: true,
    }));

    const composer = new BoxRenderable(renderer, {
      width: "100%", flexDirection: "row", flexShrink: 0,
      border: ["top", "bottom"], borderStyle: piProfile.shape, borderColor: piProfile.edge,
    });
    composer.add(input);

    const workspace = new TextRenderable(renderer, {
      content: branch ? `${session} (${branch})` : session,
      width: "100%", height: 1, flexShrink: 0, fg: muted, truncate: true,
    });
    const footer = new BoxRenderable(renderer, {
      width: "100%", height: 1, flexDirection: "row", flexShrink: 0, gap: 1,
    });
    const model = new TextRenderable(renderer, {
      height: 1, width: 32, flexShrink: 0, fg: muted, truncate: true,
    });
    status.width = "auto";
    status.flexGrow = 1;
    status.minWidth = 0;
    status.fg = muted;
    footer.add(status);
    footer.add(model);

    const size = () => {
      const slim = renderer.width < 60;
      model.width = slim ? 22 : 32;
      model.content = slim ? piProfile.model : `(deepseek) ${piProfile.model}`;
      model.visible = renderer.width >= 34;
    };
    renderer.on("resize", size);
    size();

    root.add(header);
    root.add(transcript);
    root.add(activity);
    root.add(composer);
    root.add(workspace);
    root.add(footer);
  },
};

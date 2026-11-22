import { BoxRenderable, TextRenderable, fg, t } from "@opentui/core";
import type { ExtraMockTuiProfile } from "./mock-tui-profile.ts";

const background = "#18191C";
const foreground = "#DFE1E5";
const muted = "#8C8E93";
const edge = "#55565A";

export const kimiProfile: ExtraMockTuiProfile = {
  title: "Kimi Code",
  version: "2.3.0",
  model: "K3",
  accent: "#49A4F1",
  edge,
  fill: background,
  background,
  shape: "rounded",
  input: "",
  ready: "",
  prompt: text => `❯  ${text}`,
  step: (index, text) => `${index === 1 ? "✦" : index === 2 ? "✓" : "·"}  ${text}`,
  note: text => `   ${text}`,
  working: "✦  Thinking",
  mount({ renderer, root, transcript, input, status, activity, session, directory: cwd, branch }) {
    const welcome = new BoxRenderable(renderer, {
      width: "100%", flexDirection: "column", flexShrink: 0,
      border: true, borderStyle: "rounded", borderColor: kimiProfile.accent, paddingX: 1, paddingY: 1,
    });
    const introduction = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, gap: 1 });
    introduction.add(new TextRenderable(renderer, {
      content: "▐█▛█▛█▌\n▐█████▌", fg: kimiProfile.accent, width: 7, height: 2, flexShrink: 0,
    }));
    introduction.add(new TextRenderable(renderer, {
      content: t`${fg(kimiProfile.accent)(`Welcome to ${kimiProfile.title}`)}\n${fg(muted)("Enter a request to begin.")}`,
      fg: foreground, flexGrow: 1, minWidth: 0, wrapMode: "word",
    }));
    welcome.add(introduction);
    welcome.add(new TextRenderable(renderer, {
      content: `Directory  ${cwd ?? session}\nSession    —\nModel      ${kimiProfile.model}\nVersion    ${kimiProfile.version}`,
      width: "100%", fg: muted, marginTop: 1, wrapMode: "word",
    }));
    transcript.add(welcome);
    root.add(transcript);
    root.add(activity);

    const composer = new BoxRenderable(renderer, {
      flexDirection: "row", flexShrink: 0, border: true, borderStyle: "rounded",
      borderColor: edge, backgroundColor: background, marginX: 1, paddingX: 1,
    });
    composer.add(new TextRenderable(renderer, { content: ">", width: 2, height: 1, flexShrink: 0, fg: foreground }));
    composer.add(input);
    root.add(composer);

    const details = new BoxRenderable(renderer, {
      flexDirection: "row", flexShrink: 0, height: 1, gap: 2, marginX: 1,
    });
    details.add(new TextRenderable(renderer, { content: "K3 thinking: max", fg: foreground, height: 1, flexShrink: 0 }));
    const shortPath = session.split("/").slice(-3).join("/");
    const directory = shortPath === session ? session : `…/${shortPath}`;
    details.add(new TextRenderable(renderer, {
      content: branch ? `${directory}  ${branch}` : directory,
      fg: muted, height: 1, flexGrow: 1, minWidth: 0, truncate: true,
    }));
    root.add(details);

    const footer = new BoxRenderable(renderer, { flexDirection: "row", height: 1, flexShrink: 0, marginX: 1, gap: 1 });
    status.width = "auto";
    status.flexGrow = 1;
    status.minWidth = 0;
    footer.add(status);
    footer.add(new TextRenderable(renderer, { content: "context: 0% (0/1M)", fg: foreground, height: 1, flexShrink: 0 }));
    const resize = () => { footer.marginBottom = renderer.height > 14 ? 1 : 0; };
    renderer.on("resize", resize);
    resize();
    root.add(footer);
  },
};

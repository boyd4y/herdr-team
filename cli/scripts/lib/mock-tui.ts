import {
  BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable,
  createCliRenderer, fg, t, type KeyEvent,
} from "@opentui/core";
import { setTimeout as pause } from "node:timers/promises";
import type { MockHarness } from "./mock-console.ts";
import { kimiProfile } from "./mock-tui-kimi.ts";
import { piProfile } from "./mock-tui-pi.ts";
import { qoderProfile } from "./mock-tui-qoder.ts";
import type { ExtraMockTuiProfile, MockTuiProfile } from "./mock-tui-profile.ts";

const profiles: Record<MockHarness, MockTuiProfile | ExtraMockTuiProfile> = {
  claude: {
    title: "Claude Code", version: "v2.1.236", accent: "#D97757", edge: "#55565D", fill: "#18191C",
    model: "deepseek-v4.1-flash-1017[1m]",
    shape: "single", input: "Try “check the test output”", prompt: text => `❯  ${text}`,
    step: (_index, text) => text, note: text => `  ${text}`,
    working: "✦  Preparing a response",
  },
  codex: {
    title: "Codex", version: "v0.170.0", accent: "#95BFE6", edge: "#494E59", fill: "#313236",
    model: "GPT-6.2-Sol high fast",
    shape: "single", input: "Describe a change or ask a question", prompt: text => `›  ${text}`,
    step: (index, text) => `[0${index + 1}]  ${text}`, note: text => `     └  ${text}`,
    working: "◌  Working",
  },
  grok: {
    title: "Grok Build", version: "1.0.89", accent: "#C0BAC7", edge: "#4A484C", fill: "#161618",
    model: "Grok 4.7 (high)",
    shape: "rounded", input: "", prompt: text => `❯ ${text}`,
    step: (_index, text) => `◆  ${text}`, note: text => `   ${text}`,
    working: "⠴  Thinking",
  },
  pi: piProfile,
  kimi: kimiProfile,
  qoder: qoderProfile,
};

type Submit = (text: string, signal: AbortSignal) => Promise<void>;

type Options = {
  session: string;
  directory?: string;
  branch?: string;
  fast?: boolean;
  deferInput?: boolean;
  submit: Submit;
  idle(): void;
};

const muted = "#999CA7";
const foreground = "#E5E6EA";
const responseMarker: Record<MockHarness, string> = { codex: "• ", claude: "⏺ ", grok: "", pi: "", kimi: "● ", qoder: "▪ " };
const timeLabel = () => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date());

export async function openMockTui(harness: MockHarness, options: Options) {
  const theme = profiles[harness];
  const extra = "mount" in theme ? theme : undefined;
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen", externalOutputMode: "passthrough",
    consoleMode: "disabled", exitOnCtrlC: true, exitSignals: ["SIGTERM", "SIGHUP"], useKittyKeyboard: null, useMouse: true,
  });
  const claude = harness === "claude";
  const compact = harness === "codex";
  const grokWelcome = harness === "grok";
  const root = new BoxRenderable(renderer, {
    width: "100%", height: "100%", flexDirection: "column", paddingX: compact ? 0 : 1,
    backgroundColor: extra?.background ?? (grokWelcome ? theme.fill : "#18191C"),
  });
  const header = new BoxRenderable(renderer, {
    width: "100%", maxWidth: grokWelcome ? 58 : "100%", flexShrink: 0, flexDirection: "column",
    alignSelf: grokWelcome ? "center" : "flex-start",
    marginTop: compact ? 2 : 1, marginBottom: compact ? 2 : 0, paddingX: compact ? 2 : claude ? 0 : 1, paddingY: 0,
  });
  const text = (content: string | ReturnType<typeof t>, ink = foreground) => new TextRenderable(renderer, {
    width: "100%", flexShrink: 0, content, fg: ink, wrapMode: "word",
  });
  const hint = compact ? text(t`${fg("#EC9CB4")("Try:")} ${fg(foreground)("Verify the sidebar after reconnect")}`, muted) : null;
  const grokMark = grokWelcome ? new TextRenderable(renderer, {
    content: [
      "⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄",
      "⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀",
      "⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀",
      "⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀",
      "⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀",
      "⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀",
      "⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    ].join("\n"),
    width: 14, height: 7, flexShrink: 0, alignSelf: "center", marginBottom: 1, fg: "#696969",
  }) : null;
  if (extra) {
    // The added harnesses assemble their own terminal chrome.
  } else if (claude) {
    const intro = new BoxRenderable(renderer, { flexDirection: "row", alignItems: "center", gap: 1, width: "100%" });
    const signature = new TextRenderable(renderer, {
      width: 9, height: 3, flexShrink: 0, content: " ▐▛███▛█\n▝▜██████▀\n  ▝▝ ▝▝", fg: theme.accent,
    });
    const identity = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, minWidth: 0 });
    identity.add(text(t`${fg(foreground)(theme.title)} ${fg(muted)(theme.version)}`));
    identity.add(text(theme.model, muted));
    identity.add(text(options.session, muted));
    intro.add(signature);
    intro.add(identity);
    header.add(intro);
  } else if (grokWelcome) {
    if (grokMark) header.add(grokMark);
    for (const [action, shortcut] of [["Send a prompt", "Enter"], ["Review history", "PgUp/PgDn"], ["Quit session", "/exit"]]) {
      const item = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", flexShrink: 0 });
      item.add(new TextRenderable(renderer, { content: action, height: 1, flexGrow: 1, fg: foreground, truncate: true }));
      item.add(new TextRenderable(renderer, { content: shortcut, height: 1, flexShrink: 0, fg: muted }));
      header.add(item);
    }
  } else {
    header.add(compact ? text(t`${fg(theme.accent)("›·")} ${fg(foreground)(theme.title)} ${fg(muted)(theme.version)}`)
      : text(`${theme.title} ${theme.version}`, theme.accent));
    header.add(text(options.session, muted));
  }
  if (hint) {
    hint.marginTop = 1;
    header.add(hint);
  }

  const transcript = new ScrollBoxRenderable(renderer, {
    width: "100%", flexGrow: compact ? 0 : 1, flexBasis: compact ? "auto" : 0, flexShrink: 1,
    height: compact ? 1 : "auto", visible: !compact && !grokWelcome, minHeight: 0,
    scrollY: true, stickyScroll: true, stickyStart: "bottom",
    contentOptions: {
      flexDirection: "column", width: "100%", minHeight: compact ? 0 : "100%",
      paddingX: claude ? 2 : 1, paddingY: compact ? 0 : 1,
    },
  });
  const activity = new TextRenderable(renderer, {
    width: "100%", height: 1, flexShrink: 0, visible: false, fg: muted, truncate: true,
  });
  function fitCompactTranscript() {
    // Reserve the heading margins, three-row composer and two-line footer.
    if (!compact || !transcript.visible) return;
    const available = Math.max(1, renderer.height - header.height - (renderer.height < 14 ? 7 : 9) - Number(activity.visible));
    transcript.height = Math.min(Math.max(1, transcript.content.height), available);
  }
  if (compact) {
    const recalculateScrollbars = transcript.content.onSizeChange;
    transcript.content.onSizeChange = () => {
      recalculateScrollbars?.();
      fitCompactTranscript();
    };
    header.onSizeChange = fitCompactTranscript;
  }
  const footer = new TextRenderable(renderer, { height: 1, minHeight: 1, flexShrink: 0, width: "100%", fg: muted, truncate: true });
  const input = new InputRenderable(renderer, {
    flexGrow: 1, flexBasis: 0, minWidth: 0, maxLength: 240, placeholder: theme.input, backgroundColor: theme.fill,
    focusedBackgroundColor: theme.fill, focusedTextColor: foreground, cursorColor: compact ? "#CFD0D4" : theme.accent, placeholderColor: muted,
  });

  const spacers = grokWelcome ? [new BoxRenderable(renderer, { flexGrow: 1 }), new BoxRenderable(renderer, { flexGrow: 1 })] : [];
  if (grokWelcome) {
    const workspace = options.branch ? `⎇  ${options.branch}  ${options.session}` : options.session;
    root.add(new TextRenderable(renderer, { content: workspace, width: "100%", height: 1, fg: muted, flexShrink: 0, truncate: true }));
  }
  if (extra) {
    header.destroyRecursively();
    extra.mount({ renderer, root, transcript, input, status: footer, activity, session: options.session,
      directory: options.directory, branch: options.branch });
  } else {
    if (spacers[0]) root.add(spacers[0]);
    root.add(header);
    if (spacers[1]) root.add(spacers[1]);
    root.add(transcript);
    root.add(activity);
  }
  if (!extra) {
    const composer = new BoxRenderable(renderer, {
      width: "100%", flexShrink: 0, flexDirection: "row", backgroundColor: theme.fill,
      ...(!compact ? { border: claude ? ["top", "bottom"] : true, borderStyle: theme.shape, borderColor: theme.edge } : {}),
      ...(grokWelcome ? { bottomTitle: ` ${theme.model} `, bottomTitleAlignment: "right" } : {}),
      paddingX: compact ? 0 : 1, paddingY: compact ? 1 : 0,
    });
    composer.add(new TextRenderable(renderer, {
      width: compact || claude ? 2 : 3, flexShrink: 0, height: 1, fg: compact || claude ? foreground : theme.accent, content: claude ? "❯" : "›",
    }));
    composer.add(input);
    root.add(composer);
  }
  if (compact) {
    root.add(new TextRenderable(renderer, {
      content: t`${fg("#E7CB9C")(theme.model)}  ·  ${fg("#A1C7A9")(options.session)}`, width: "100%", height: 1, minHeight: 1,
      flexShrink: 0, marginLeft: 2, fg: theme.accent, truncate: true,
    }));
    footer.marginLeft = 2;
  }
  if (grokWelcome) {
    const footerRow = new BoxRenderable(renderer, {
      flexDirection: "row", flexShrink: 0, height: 1, width: "100%", gap: 1, marginTop: 1, marginBottom: 1,
    });
    footer.width = "auto";
    footer.flexGrow = 1;
    footer.minWidth = 0;
    footerRow.add(footer);
    footerRow.add(new TextRenderable(renderer, {
      width: 17, height: 1, flexShrink: 0,
      content: t`${fg(foreground)(theme.title)} ${fg(muted)(theme.version)}`, truncate: true,
    }));
    root.add(footerRow);
  } else if (!extra) root.add(footer);
  renderer.root.add(root);

  const size = () => {
    const short = renderer.height < 14;
    if (hint) hint.visible = !short;
    if (compact) {
      header.marginTop = short ? 1 : 2;
      header.marginBottom = short ? 1 : 2;
    }
    if (grokMark) grokMark.visible = renderer.height >= 24;
    const lowerSpacer = spacers[1];
    if (lowerSpacer) lowerSpacer.flexGrow = grokMark?.visible ? 2 : 1;
    if (grokWelcome) header.visible = !transcript.visible;
    fitCompactTranscript();
  };
  renderer.on("resize", size);
  size();

  let running: AbortController | undefined;
  let startedAt = 0;
  let closed = false;
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "escape" && running) {
      key.preventDefault();
      running.abort();
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      key.stopPropagation();
      transcript.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(transcript.viewport.height - 1, 1));
    }
  });

  const idle = "/exit quit  ·  PgUp/PgDn history";
  const shortcuts = extra?.ready ?? (compact ? "↵ send  ·  PgUp/PgDn history  ·  /exit quit"
    : claude ? `↵ send  ·  ${idle}`
    : "");
  footer.content = shortcuts;
  input.on(InputRenderableEvents.ENTER, (value: string) => { void submit(value); });
  if (!options.deferInput) input.focus();

  function add(content: string, color = foreground, spacing = 0, fill?: string, timestamp?: string) {
    if (closed) return;
    transcript.visible = true;
    if (grokWelcome) header.visible = false;
    for (const spacer of spacers) spacer.visible = false;
    const row = text(content, color);
    if (fill || timestamp) {
      const surface = new BoxRenderable(renderer, {
        width: "100%", flexShrink: 0, marginTop: spacing, paddingX: 1, backgroundColor: fill,
        flexDirection: "row", paddingY: fill && grokWelcome ? 1 : 0,
      });
      row.width = "auto";
      row.minWidth = 0;
      row.flexGrow = 1;
      surface.add(row);
      if (timestamp && renderer.width >= 45) {
        surface.add(new TextRenderable(renderer, {
          content: timestamp, width: Bun.stringWidth(timestamp), flexShrink: 0, height: 1, marginLeft: 2, fg: muted,
        }));
      }
      transcript.add(surface);
    } else {
      row.marginTop = spacing;
      transcript.add(row);
    }
  }

  async function submit(value: string, assignment?: Submit) {
    if (running || closed) return;
    const request = value.trim();
    if (!request) return;
    input.value = "";
    if (!assignment && request === "/exit") {
      renderer.destroy();
      return;
    }
    const current = new AbortController();
    running = current;
    startedAt = Date.now();
    input.blur();
    if (claude) input.placeholder = "";
    activity.content = `${theme.working}  ·  Esc interrupt`;
    activity.visible = true;
    add(theme.prompt(request), foreground, 1, compact ? theme.fill : grokWelcome ? "#242424" : undefined,
      grokWelcome ? timeLabel() : undefined);
    fitCompactTranscript();
    try {
      await (assignment ?? options.submit)(request, current.signal);
    } catch (error) {
      if (!closed) add(current.signal.aborted ? "Turn interrupted." : String(error), muted, 1);
      if (assignment) throw error;
    } finally {
      running = undefined;
      if (!closed) {
        if (current.signal.aborted && !assignment) options.idle();
        input.placeholder = claude ? "" : theme.input;
        activity.visible = false;
        fitCompactTranscript();
        footer.content = shortcuts;
        input.focus();
      }
    }
  }

  renderer.on("destroy", () => { closed = true; running?.abort(); });
  renderer.requestRender();
  return {
    ready: renderer.idle(),
    closed: renderer.closed,
    destroy: () => renderer.destroy(),
    submit,
    async step(index: number, detail: string, notes: string[], delay = 400, signal?: AbortSignal) {
      add(theme.step(index, detail), theme.accent, harness === "grok" && index > 0 ? 0 : 1);
      for (const note of notes) {
        await pause(options.fast ? 30 : delay, undefined, { signal });
        add(theme.note(note), harness === "claude" ? foreground : muted);
      }
    },
    completed(result: string) {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (grokWelcome) add(`◆  Thought for ${seconds}s`, muted, 1);
      add(responseMarker[harness] + result, foreground, 1, undefined, grokWelcome ? timeLabel() : undefined);
      if (compact || grokWelcome || claude) {
        add(claude ? `✻  Crunched for ${seconds}s` : `Worked for ${seconds}s${compact ? `  ·  ${timeLabel()}` : ""}`, muted, 1);
      }
    },
  };
}

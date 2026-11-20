type Accent = (text: string) => string;
type Step = 0 | 1 | 2;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
function lineProfile(title: string, color: number, marker: string) {
  return {
    color,
    intro: (text: string, accent: Accent) => `${accent(title)}  ${dim(text)}`,
    step: (_index: Step, text: string, accent: Accent) => `${accent(marker)}  ${text}`,
    note: (text: string) => `   ${dim(text)}`,
    end: (text: string) => `\n${text}\n`,
  };
}
const profiles = {
  codex: {
    color: 96,
    intro: (text: string, accent: Accent) => `\n${accent("› CODEX")}   ${dim(text)}\n`,
    step: (index: Step, text: string, accent: Accent) => `\n  ${accent(`[0${index + 1}]`)}  ${text}`,
    note: (text: string) => `         ${dim("└ " + text)}`,
    end: (text: string, accent: Accent) => `\n  ${accent("› Result")}\n    ${text}\n`,
  },
  claude: {
    color: 33,
    intro: (text: string, accent: Accent) => `\n  ${accent("✦")} Claude\n    ${dim(text)}\n`,
    step: (_index: Step, text: string, accent: Accent) => `\n  ${accent("•")} ${text}`,
    note: (text: string) => `    ${text}`,
    end: (text: string, accent: Accent) => `\n  ${accent("In summary")}\n  ${text}\n`,
  },
  grok: {
    color: 95,
    intro: (text: string, accent: Accent) => `\n  ┌─ ${accent("GROK")} ─────────\n  │  ${text}\n  └─────────────────\n`,
    step: (index: Step, text: string, accent: Accent) => `  ${accent(["INPUT", "TRACE", "CHECK"][index]!)}  │  ${text}`,
    note: (text: string) => `         │    ${dim(text)}`,
    end: (text: string, accent: Accent) => `\n  ${accent("[ OK ]")}  ${text}\n`,
  },
  pi: lineProfile("pi", 95, "•"),
  kimi: lineProfile("Kimi Code", 36, "›"),
  qoder: lineProfile("Qoder CLI", 32, "▸"),
};

export type MockHarness = keyof typeof profiles;
export const mockHarnesses = Object.keys(profiles) as MockHarness[];

export function isMockHarness(value: string | undefined): value is MockHarness {
  return value !== undefined && Object.hasOwn(profiles, value);
}

export function report(state: "idle" | "working" | "blocked" | "done" | "error", app: MockHarness): void {
  const program = app === "qoder" ? "qodercli" : app;
  process.stdout.write(`\x1b]7501;state=${state}:app=${program}${state === "blocked" ? ":kind=other" : ""}\x1b\\`);
}

export function mockConsole(harness: MockHarness, fast = false) {
  const profile = profiles[harness];
  const accent = (text: string) => `\x1b[${profile.color}m${text}\x1b[0m`;
  return {
    heading(detail: string) {
      console.log(profile.intro(detail, accent));
    },
    async step(index: Step, detail: string, notes: string[], delay = 400) {
      console.log(profile.step(index, detail, accent));
      for (const note of notes) {
        await Bun.sleep(fast ? 30 : delay);
        console.log(profile.note(note));
      }
    },
    completed(text: string) { console.log(profile.end(text, accent)); },
  };
}

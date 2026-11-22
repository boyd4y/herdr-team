import type { BoxRenderable, CliRenderer, InputRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";

export interface MockTuiProfile {
  title: string;
  version: string;
  accent: string;
  edge: string;
  fill: string;
  model: string;
  shape: "rounded" | "single" | "double";
  input: string;
  prompt(text: string): string;
  step(index: number, text: string): string;
  note(text: string): string;
  working: string;
}

export interface MockLayoutContext {
  renderer: CliRenderer;
  root: BoxRenderable;
  transcript: ScrollBoxRenderable;
  input: InputRenderable;
  status: TextRenderable;
  activity: TextRenderable;
  session: string;
  directory?: string;
  branch?: string;
}

export interface ExtraMockTuiProfile extends MockTuiProfile {
  background: string;
  ready: string;
  mount(context: MockLayoutContext): void;
}

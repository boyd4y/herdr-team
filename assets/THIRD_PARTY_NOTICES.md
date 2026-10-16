# Third-party notices

The bundled `HerdrAgentIconsMax-Regular.ttf` is copied without modification from
[hhdebb/herdr-radar](https://github.com/hhdebb/herdr-radar/tree/ae46869a0a40f675a333342510c915dbc155ae6a),
revision `ae46869a0a40f675a333342510c915dbc155ae6a` (18,052 bytes).
SHA-256: `1b8199496b223d0761fc3a49d5b2510bda38deab82cb3758bf3980495bf05272`.
That project inherits the icon font, SVG marks and glyph design from
[qintmb/herdr-icon-agent-ui](https://github.com/qintmb/herdr-icon-agent-ui)
(MIT); its full copyright and permission notice is included as `ICON-LICENSE.txt`.
The JetBrains Mono SIL OFL 1.1 text is included in full as `OFL.txt`.
This source table is adapted from radar's `THIRD_PARTY_NOTICES.md` at that revision.

The marks built into the font come from radar's `tools/svg/`. The table below names where a mark
was taken from, or — where it was not taken from a published icon set — who owns the brand
it depicts. Marks identify third-party products and do not imply affiliation or endorsement.

| Icon | Source or owner |
|---|---|
| claude | Anthropic `cwc-workshops` (Apache-2.0) |
| codex | OpenAI `codex` (Apache-2.0) |
| opencode | anomalyco `opencode` (MIT) |
| omp | can1357 `oh-my-pi` (MIT) |
| cline | Cline (MIT) |
| mastracode | MastraCode (MIT) |
| kimi | Moonshot AI Kimi Code CLI (Apache-2.0) |
| kilo | Kilo Code CLI (Apache-2.0) |
| maki | Maki (MIT) |
| pi | Pi coding agent |
| hermes | Hermes Agent |
| cursor | Cursor (proprietary) |
| copilot | GitHub Copilot (proprietary) |
| deepseek | DeepSeek (proprietary) |
| gemini | Google Gemini (proprietary) |
| gpt | OpenAI (proprietary) |
| qwen | Alibaba Qwen (proprietary) |
| grok | xAI Grok (proprietary) |
| agy | Google Antigravity (proprietary) |
| kiro | AWS Kiro (proprietary) |
| glm | Z.ai / GLM (proprietary) |
| amp | Amp (proprietary) |
| devin | Cognition Devin (proprietary) |
| qodercli | Alibaba Qoder (proprietary) |
| kimchi | CAST AI Kimchi (proprietary) |
| muse | Meta Platforms / Muse Code (proprietary) |
| crush | Charmbracelet, Inc. / Crush — the heart drawn in Crush's own source, `internal/oauth/callback/heartbit.svg` |

Marks for `cursor`, `opencode`, `hermes`, `copilot`, `deepseek`, `gemini`,
`gpt`, `qwen`, `agy`, `kiro`, `glm`, and `muse` were taken from [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons)
(MIT) and re-normalized to bare `<path>` geometry. The MIT license covers that
project's packaging, not the trademarks of the depicted brands.

See each project's repository for license details and modifications.

## JetBrains Mono

Radar's separate `dist/JetBrainsMonoHerdr-Regular.ttf` is JetBrains Mono v2.304 (© 2020 The JetBrains
Mono Project Authors, SIL Open Font License 1.1) with this project's 33 icon glyphs
patched in and the family renamed to "JetBrains Mono Herdr", as the OFL requires for a
modified build. That merged font is not included in this plugin. The font's own
copyright and license name records are kept intact.
Source: https://github.com/JetBrains/JetBrainsMono

The bundled `HerdrAgentIconsMax-Regular.ttf` is built from the SVG marks above and contains no
JetBrains Mono outlines; only its vertical metrics (units per em, advance width, ascent
and descent) are copied so the icons sit on the same line as that face.

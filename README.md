# Herdr Desktop Team

[中文](README.zh-CN.md)

A layout and native team console mod for **Herdr desktop**, using **herdr-core (`hc`)** for terminal facts. This is the initial research and preview repository, separate from the terminal-multiplexer plugin [herdr-team](https://github.com/boyd4y/herdr-team).

The preview includes a visibly marked sample, newest-first tasks, remaining assignees, a compact role list, and native animation. With explicit bindings it can read existing project tasks/roles and display scoped Core terminals. It does not start agents, dispatch tasks, hand off, merge, or clean worktrees. The Core execution adapter is a planned migration, not an implemented feature.

## Check locally

Requires the Herdr desktop app and Node.js. Development baseline: app **0.1.16**, Core **0.1.21**, checked on 2026-11-18.

```sh
npm test
npm run check
```

`check` uses the real app's initial-render validator. It does not install the mod, select a layout, or prove live interaction. No npm dependencies are required.

## Try the preview

Copy `mods/team-console/` and `layouts/team.json` into the corresponding folders under your Herdr app home, normally `~/.config/herdr-app`. Preserve any existing personal copies. Then choose the `team` layout in Herdr. The shipped Spaces, Agents, Tabs, Files and Changes mods are reused.

The layout starts in **Sample** mode. Sample never starts processes or writes project data. To bind a live read-only panel, change its content props:

```json
{
  "mod": "team-console",
  "props": {
    "sample": false,
    "root": "/absolute/main-checkout",
    "space": "actual-space-id",
    "machine": null
  }
}
```

Get actual space IDs from `herdr-app ls`. A remote binding uses that machine's root, machine name and qualified space ID. Never copy an old multiplexer workspace ID.

Live reads require `herdr-team` on the selected machine's PATH. The mod only calls `tasks --json` and `role list --json`. It reads the existing CLI format rather than implementing YAML/task parsing. Local `.herdr/` changes use `watchFolder`; remote changes and unavailable watchers require **Refresh**. Core facts are reactive and are not polled.

Terminals are matched by machine plus labels `team.project=<exact-root>`, `herdr.space=<machine-local-space-id>` and `team.role=<role>`. The future execution adapter must write these labels; old `herdr` metadata does not migrate automatically. Without matching terminals roles remain unknown. **Open** focuses the actual terminal; it sends no message.

A task displayed in its own worktree space can additionally carry `team.owner_space=<coordinating-space-id>`. This explicitly groups it under that team instance; the actual `herdr.space` still controls where the desktop shows it. These `team.*` labels are this project's proposed convention, not built-in Core policies.

## Design and contribution

Read [the research](docs/research.zh-CN.md) and [the migration plan](docs/plan.zh-CN.md). Keep UI in the host mod APIs, runtime operations in a Core adapter, task validity in the CLI, and collaboration decisions in Skill. See [AGENTS.md](AGENTS.md).

Run `npm test` and `npm run check` for a change. Test live async states and inspect the running window before claiming visual acceptance. Do not modify a user's layout, programs or Core just to run checks.

MIT. Herdr's built-in mods are referenced, not bundled.

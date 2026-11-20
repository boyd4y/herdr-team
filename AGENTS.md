# Boundaries

- Keep Desktop presentation in `mods/` and `layouts/`, the team CLI and its runtime adapters in `cli/`, and the shared Skill and templates in `skill/`. Use the installed Herdr app guide and generated types as the authority for its version.
- Read `herdr-app --skill` and `hc --skill` before controlling the window or terminals. The old `herdr` runtime and `herdr-plugin.toml` are different APIs.
- Layout JSON arranges the window. Mods use the host's `gpui-kit`, `gpui-base`, and `herdr` modules. Do not add a webview, DOM renderer, terminal emulator, or custom widget toolkit.
- Core owns terminals, lifecycle, labels, input gating and events. The desktop app owns spaces, tabs, panes and their layout document. A terminal address is not a pane ID.
- Use reactive `terminals()` / `agents()` data in mods. Use native motion instead of redraw timers. Watch local task folders; cancel watches when leaving the binding. Do not poll Core status.
- Skill owns responsibilities, task decomposition, handoff order, validation scope and orchestration decisions. CLI owns task/delivery records, deduplication, locks and explicit operations. Mods never edit task metadata or mark a task complete because a program reports done.
- Keep `TEAM.md` and `agents.json` shareable. Keep `.herdr/` ignored. Use the shared runtime and templates directly. Keep the OpenTUI Console isolated from desktop mods.
- Reuse existing task formats, deduplication, session checks, SHA gates and locks. Test with isolated project, trust, session and runtime state.
- Bind live views explicitly to root, machine and space. Do not infer ownership from display names or reuse runtime IDs from the old multiplexer.
- Codex launches and resume must use `--no-daemon`. Inspect actual agent status support; do not infer status from the screen.
- Do not overwrite shipped layouts/mods or switch the user's active layout during development. Use namespaced files. Do not stop a core or close user terminals for tests.
- Keep UI labels, errors and default agent instructions English. Chinese documentation and TEAM.md checklists are allowed; preserve user-authored Unicode content.
- Before claiming a mod works, run the real `herdr-app check`. It validates initial rendering only; visual interaction and later async states need separate verification. Keep sample data visibly separate from live data.

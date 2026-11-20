# Team workspace for Herdr desktop

Build a personal `team` layout using shipped Spaces, Tabs and terminal panes. Add a right-side `team-console` mod and a namespaced extension of native Agents without replacing shipped code, theme preferences or keyboard bindings.

Team Agents keeps native harness icons, priority/space grouping, pinning, sub-agent navigation and reported statuses. Use a 30px single row: a narrow space-colored marker immediately before the harness icon, the role name, optional task ID, a muted session title and status. Keep the role legible and truncate the title to available space. Match the installed Spaces avatar palette and its stored color by qualified space ID. Put responsibilities and full session details in tooltips; do not add role-letter avatars or a second text line. Read responsibility records only after the CLI confirms the terminal's project/owner-space binding. Never infer roles or ownership from names, titles or cwd. Use cancellable role-folder watches and reactive agents/terminals, not status polling or redraw timers.

The mod shows tasks newest first, the selected task's recorded current and remaining assignees, then role, harness, model and live instance count. Separate agent status from task status. Use native GPUI animation for working indicators. Follow the user's theme and use English labels.

Provide an explicitly marked sample that requires no project and performs no operations. For live reads require a fixed main root, machine and space; use existing herdr-team read-only task/role JSON and the app's reactive Core terminal list. Never guess ownership by name or route tasks from a mod. Missing reports stay unknown.

Local file changes use a cancellable folder watch. Core status does not use polling. Failed watches and remote project changes use manual refresh in this initial preview.

This mod runs the read-only `herdr-team` CLI on the selected machine and watches the bound project's `.herdr/` folder. It does not fetch network URLs, start agents, write task records, merge code, install software or change settings. Focusing an agent changes only the window focus.

The initial repository has no marketplace preview screenshot and is not presented as a published gallery entry.

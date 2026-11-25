# Herdr Team

[中文](README.zh-CN.md)

Herdr Team brings together native **Herdr Desktop** layouts and mods, the `herdr-team` CLI, and the agent Skill. Desktop uses **herdr-core (`hc`)** for terminal facts.

The preview includes a visibly marked sample, newest-first tasks, remaining assignees, a compact role list, and native animation. With explicit bindings it can read existing project tasks/roles and display scoped Core terminals. The mod itself does not start agents, dispatch tasks, hand off, merge, or clean worktrees; runtime operations belong to the shared CLI.

`desktop/` contains the native mods, layout and hot-reload setup. `tui/` contains the Herdr terminal plugin and sidebar configuration. Both use the team CLI in `cli/` and the agent Skill in `skill/`. See the [team runtime guide](docs/team-runtime.md) for CLI operations and Skill installation.
A local Space without an initialized project opens a centered setup view.
**Initialize now** uses the current terminal directory, falling back to the
Space folder, and registers the project. Choose an installed agent to
configure the team with the shared Skill, or select **View demo** to explore
sample data. After initialization, **Up** starts the team in the same Space.
The panel checks the team's daemon status to show whether it is running.

The CLI verifies the caller, records the Space binding, and starts resident
roles with `herdr-team team up`. Task sessions receive isolated Git checkouts.
`herdr-team task clean` reclaims finished task worktrees and their Desktop resources.

## Check locally

Requires the Herdr desktop app and Node.js. Development baseline: app **0.1.16**, Core **0.1.21**, checked on 2026-11-18.

```sh
npm test
npm run check
(cd cli && bun install --frozen-lockfile)
npm run test:cli
npm run test:install
npm run typecheck
```

`check` uses the real app's initial-render validator. CLI development dependencies are installed under `cli/`.

## Try the preview

Install Herdr Desktop, Node.js 22+ and Bun 1.3.14+. From a single checkout of this repository, install the CLI and Skill and register the Desktop development layout:

```sh
npm run setup:desktop
```

On Windows x64, use Git for Windows and make `bun.exe` and the agent CLI
available on your user PATH. The installer puts `herdr-team.cmd` in Bun's
`bin` directory (`%USERPROFILE%\.bun\bin` by default), or in `XDG_BIN_HOME`
when set. The destination must already be on PATH. In PowerShell, you can run
`npm.cmd run setup:desktop` to use npm's command launcher.

In Herdr, select the `herdr-team` layout. Inside a project terminal,
run `herdr-team team up` to establish the binding and start resident roles.
Isolated roles start when dispatched.

### Desktop hot reload

For local development (Node.js 22+), run `npm run dev`. It registers the
`herdr-team` layout and the Team and Agents mods under `HERDR_APP_HOME` (default
`~/.config/herdr-app`), then watches `desktop/mods/` and `desktop/layouts/herdr-team.json`
and syncs changes for the app's native hot reload. No dependencies or repeated
installation are needed. Generated types, `jsconfig.json`, hidden files and
`node_modules` are excluded. The script never launches the app, starts agents,
or switches your active layout. With the desktop app open, select it manually:

```sh
herdr-app do layout.switch --name herdr-team
```

`npm run dev:register` performs only the initial sync. Ctrl+C stops watching and
leaves the registration installed. Edit source files, including live binding
props, in this repository. A hidden `.herdr-team.json` in app home
tracks ownership; pre-existing personal files, another checkout's registration,
and externally modified installed files are preserved with an error. Move
conflicting files aside before retrying. Use the same `HERDR_APP_HOME` for both
the script and app commands when overriding it.

The **Team** button at the right of the tab bar shows or hides the console, like
Files. To toggle it from the keyboard, bind a key in your `keys.json` (any edit makes that file yours, so Herdr
stops adding new default shortcuts to it):

```json
"layout:herdr-team": { "cmd-shift-e": "layout.toggle:team-console" }
```

**Board** groups tasks by their recorded status: Todo, In progress, Review,
Blocked and Done. Cards include the current assignee. In narrow panels,
populated columns wrap and empty statuses appear as counts.
Hover over the Team icon to see the binding path, machine and Space.
Routine approvals and questions show **Needs input** on the current card and in
Agents. Use the agent row to return to its terminal and reply.

**List** is the compact sidebar view. Its status filters show counts and wrap
to fit the panel. **All** is the default, ordered by newest task first. **Open**
orders blocked, review, in progress, then todo. Done has its own filter.
Rows show the title, task ID, owner and recorded status; P0/P1 stays
visible, with full titles and handoff details available on hover or selection.
List / Board switching remembers the view and preserves the current List filter.

From a local task detail, use **Archive** to move a card to Archive or **Delete**
to send it to Trash after confirmation. Both folders support **Restore**.
Historical cancelled tasks appear in Archive.
For keyboard bindings or app commands, the console accepts `<mod>.list`,
`<mod>.board` and `<mod>.filter-<status>` (including `open`). The mod name is
`herdr-team`.

Task details separate **Description** and **History**. **Issues** shows requirements
and defects and supports independent type and iteration filters.
A shared iteration filter applies to Issues and to both Tasks views. Tasks can
set their own iteration or inherit the linked issue's iteration.
A task can stand alone or link to one issue. An issue can link to several tasks.
Open a link from either detail view. The CLI accepts `--requirement R0001` when
creating a task and `backlog link R0001 0001` for an existing task.

**Inbox** groups external **Email** and **Internal messages**. Both show a sender,
recipient, subject, and message body. **Active / Trash** selects the folder, and
**All / Unread / Read** filters messages by read status. Opening an email marks it
as read. An internal message becomes read after the recipient successfully hands
off the assignment. Open an internal message to read it or follow its link to
the associated task. Trash shows why an email could not be routed. See the
[handoff guide](skill/references/handoff.md#inbox-与投递) for how agents process messages.

The layout uses Herdr's shipped Spaces, Tabs, Files and Changes mods.

Team Agents retains native **Priority / Grouped by space** sorting, pins and
sub-agent trees. It defaults to grouped when no explicit sort preference exists.
Agent rows use one 30px line: a small space-colored marker, the native harness
icon, role name, muted session title and status. Task IDs stay inline when present. Session/tool
details and responsibilities are in the tooltip;
responsibilities are read via `role list --details` only after verifying the
CLI binding. Local role changes use cancellable watches; Refresh handles
unavailable watches. Remote role lookups are skipped. The shipped Agents mod is untouched.
In grouped mode, verified team task spaces join their parent space's heading
and color marker. Pins and Priority keep their native behavior. Row clicks
still focus the agent's actual worktree pane; grouping never moves a terminal.

The layout reads the shown Space's explicit CLI binding for project data. The
terminal directory is used for setup. To pin the panel to a project and Space,
change its content props:

```json
{
  "mod": "herdr-team",
  "props": {
    "sample": false,
    "root": "/absolute/main-checkout",
    "space": "actual-space-id",
    "machine": null
  }
}
```

Get actual space IDs from `herdr-app ls`. For a pinned remote panel, specify the
machine name and its qualified Space ID (`machine/space-id`).

The Team Panel follows the selected Space's machine. With the shared `herdr-team`
CLI installed on that machine, it reads Tasks, Issues, and Inbox for the bound
project. On a remote host, run `herdr-team space bind --core` once from the project's
terminal in that Space. Each Core stores the binding for its own checkout and
Space, including when that host has no Desktop window. Remote task and issue views are read-only.
The panel loads remote records on entry or **Refresh**, and opening an email records
its read status on that machine. Local `.herdr/` changes use `watchFolder`, with
**Refresh** also available. Core terminal status updates reactively on both.

Terminals are matched by machine plus labels `team.project=<exact-root>`, `herdr.space=<machine-local-space-id>` and `team.role=<role>`. Resident `up` writes these labels; old `herdr` metadata does not migrate automatically. Without matching terminals roles remain unknown. **Open** focuses the actual terminal; it sends no message.

The CLI gives each task checkout one native space and sets
`team.owner_space=<coordinating-space-id>` while `herdr.space` selects its actual
task space. The shipped Spaces mod supplies its existing Git worktree nesting;
it is not replaced or extended. The CLI registry maps task space IDs to their
parent team. Switching between them preserves the Team view, filter, selection
and local watcher; another project resolves to another team. A registered task
space never borrows ownership from its display name or checkout path.

## Herdr TUI

With Herdr 0.9.3+, Node.js 22+ and Bun 1.3.14+, link the plugin from the checkout root and install the shared CLI, Skill and managed sidebar configuration:

```sh
herdr plugin link ./tui
npm run setup:tui
```

From within a managed TUI session, `herdr plugin action invoke herdr-team.install` also applies the setup and reloads the config. For a GitHub install, use `herdr plugin install boyd4y/herdr-team/tui --ref main`. On Windows, use the `tui` directory for local and GitHub installs. Existing repo-root installs on macOS and Linux can continue to update through the original source. The [team runtime guide](docs/team-runtime.md) covers CLI-only and Skill-only installs.

## Design and contribution

Read [the research](docs/research.zh-CN.md) and [the migration plan](docs/plan.zh-CN.md). Keep UI in the host mod APIs, runtime operations in a Core adapter, task validity in the CLI, and collaboration decisions in Skill. See [AGENTS.md](AGENTS.md).

Run `npm test` and `npm run check` for a change. Test live async states and inspect the running window before claiming visual acceptance. Do not modify a user's layout, programs or Core just to run checks.

MIT. Herdr's built-in mods are referenced, not bundled.

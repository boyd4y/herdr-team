# Herdr Team

[中文](README.zh-CN.md)

Herdr Team brings together native **Herdr Desktop** layouts and mods, the `herdr-team` CLI, and the agent Skill. Desktop uses **herdr-core (`hc`)** for terminal facts.

The preview includes a visibly marked sample, newest-first tasks, remaining assignees, a compact role list, and native animation. With explicit bindings it can read existing project tasks/roles and display scoped Core terminals. The mod itself does not start agents, dispatch tasks, hand off, merge, or clean worktrees; runtime operations belong to the shared CLI.

`desktop/` contains the native mods, layout and hot-reload setup. `tui/` contains the Herdr terminal plugin and sidebar configuration. Both use the team CLI in `cli/` and the agent Skill in `skill/`. See the [team runtime guide](docs/team-runtime.md) for CLI operations and Skill installation.
Run `herdr-team up --demo` in the prepared demo project's Desktop Space. The
Team Board and Agents sidebar show mock Codex, Claude and Grok as the release runs.
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

In Herdr, select the `herdr-desktop-team-dev` layout. Inside a project terminal,
run `herdr-team team up` to establish the binding and start resident roles.
Isolated roles start when dispatched.

### Desktop hot reload

For local development (Node.js 22+), run `npm run dev`. It registers a separate
`herdr-desktop-team-dev` mod and layout under `HERDR_APP_HOME` (default
`~/.config/herdr-app`), then watches `desktop/mods/` and `desktop/layouts/team.json`
and syncs changes for the app's native hot reload. No dependencies or repeated
installation are needed. Generated types, `jsconfig.json`, hidden files and
`node_modules` are excluded. The script never launches the app, starts agents,
or switches your active layout. With the desktop app open, select it manually:

```sh
herdr-app do layout.switch --name herdr-desktop-team-dev
```

`npm run dev:register` performs only the initial sync. Ctrl+C stops watching and
leaves the registration installed. Edit source files, including live binding
props, in this repository. A hidden `.herdr-desktop-team-dev.json` in app home
tracks ownership; pre-existing personal files, another checkout's registration,
and externally modified installed files are preserved with an error. Move
conflicting files aside before retrying. Use the same `HERDR_APP_HOME` for both
the script and app commands when overriding it.

The **Team** button at the right of the tab bar shows or hides the console, like
Files. To toggle it from the keyboard, bind a key in your `keys.json` (any edit makes that file yours, so Herdr
stops adding new default shortcuts to it):

```json
"layout:herdr-desktop-team-dev": { "cmd-shift-e": "layout.toggle:team-console" }
```

**Board** groups tasks by their recorded status: Todo, In progress, Review,
Blocked and Done. Cards include the current assignee. Cancelled tasks get a
separate column when present. Narrow panels scroll horizontally; agent reports
never move a task between columns.
Hover over the Team icon to see the binding path, machine and Space.

**List** is the compact sidebar view. Its status filters show counts and wrap
to fit the panel. **All** is the default, ordered by newest task first. **Open**
orders blocked, review, in progress, then todo. Done and cancelled tasks have their own
filters. Rows show the title, task ID, owner and recorded status; P0/P1 stays
visible, with full titles and handoff details available on hover or selection.
List / Board switching remembers the view and preserves the current List filter.
For keyboard bindings or app commands, the console accepts `<mod>.list`,
`<mod>.board` and `<mod>.filter-<status>` (including `open`). The development
mod name is `herdr-desktop-team-dev`.

Task details separate **Description** and **History**. **Issues** shows requirements
and defects and supports independent type and iteration filters.
A shared iteration filter applies to Issues and to both Tasks views. Tasks can
set their own iteration or inherit the linked issue's iteration.
A task can stand alone or link to one issue. An issue can link to several tasks.
Open a link from either detail view. The CLI accepts `--requirement R0001` when
creating a task and `backlog link R0001 0001` for an existing task.
**Inbox** displays current deliveries and AgentMail, including message bodies and
the routing reasons in Trash.

For a regular preview installation:

Copy `desktop/mods/team-console/`, `desktop/mods/team-agents/` and `desktop/layouts/team.json` into the corresponding folders under your Herdr app home, normally `~/.config/herdr-app`. Preserve any existing personal copies. Then choose the `team` layout in Herdr. The shipped Spaces, Tabs, Files and Changes mods are reused. Team Agents extends the installed native Agents interface under its own name.

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
terminal directory is used for setup. In Inbox, **Email** opens the message body
and routing information, and **Task deliveries** opens the corresponding task.
To pin a read-only panel explicitly, change its content props:

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

Get actual local space IDs from `herdr-app ls`. Never copy an old multiplexer workspace ID.
Remote spaces show a neutral unsupported empty state; the console does not run
CLI commands, install dependencies or start file watches on remote machines.

Live reads require the shared local `herdr-team` CLI. The mod uses read-only
`space show`, `tasks --json` and `role list --json` contracts. It reads the existing
CLI format rather than implementing YAML/task parsing. Local `.herdr/` changes
use `watchFolder`; unavailable watchers require **Refresh**. Core facts are
reactive and are not polled.

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

From within a managed TUI session, `herdr plugin action invoke herdr-team.install` also applies the setup and reloads the config. For a GitHub install, use `herdr plugin install boyd4y/herdr-team/tui --ref main`. Existing repo-root installs can continue to update through the original source. The [team runtime guide](docs/team-runtime.md) covers CLI-only and Skill-only installs.

## Design and contribution

Read [the research](docs/research.zh-CN.md) and [the migration plan](docs/plan.zh-CN.md). Keep UI in the host mod APIs, runtime operations in a Core adapter, task validity in the CLI, and collaboration decisions in Skill. See [AGENTS.md](AGENTS.md).

Run `npm test` and `npm run check` for a change. Test live async states and inspect the running window before claiming visual acceptance. Do not modify a user's layout, programs or Core just to run checks.

MIT. Herdr's built-in mods are referenced, not bundled.

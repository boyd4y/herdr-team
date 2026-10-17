# Herdr Team

[简体中文](README.zh-CN.md) · English

Herdr Team is a public Herdr plugin for coordinating project-scoped agent teams. It bundles a `herdr-team` CLI and an agent skill. The CLI reads and updates a project's `.herdr/` identity, role cards, and task cards; Herdr runs the native agent sessions; Team Console schedules explicitly queued work. No separate daemon or runtime npm dependencies are required.

## Install

Herdr Team supports macOS and Linux. Install Herdr 0.9.3 or later, Node.js 22.20 or later (with `npm`/`npx`), and Bun 1.2 or later. The CLI installer requires Bun on `PATH`; the skill installer uses `npx` and may need network access the first time it downloads Skills CLI.

Install the public plugin from GitHub:

```sh
herdr plugin install boyd4y/herdr-team
```

The setup hook installs the bundled CLI and skill and writes Herdr's managed sidebar and popup configuration. It does not initialize a project, start agents, or modify a project's `.herdr/` directory. The CLI is placed at `$XDG_BIN_HOME/herdr-team` or, when unset, `~/.local/bin/herdr-team`; make that directory and Bun available on `PATH` in both your shell and Herdr server environment. The installer does not edit shell startup files. If setup could not reload a running session, invoke `herdr-team.configure` from a Herdr session.

Check the installation:

```sh
herdr-team --help
```

## Start a project team

From the project root, initialize a team. Choose a preset, or supply role definitions with `--roles-file`; see the [CLI guide](cli/README.md) and the bundled skill's [team setup reference](skill/references/team-setup.md) before accepting preset responsibilities.

```sh
herdr-team init --plan balanced
herdr-team validate
```

Review `.herdr/identity.md`, role metadata in `.herdr/roles/<role>/.role.yaml`, and role instructions in `.herdr/roles/<role>/prompt.md`. Edit the identity and role instructions for your project. Add a task with its owner and optional ordered handoff roles:

```sh
herdr-team add "Implement login" --role dev --handoff test
herdr-team tasks
```

Run team lifecycle commands from a Herdr pane. Start the resident roles and Team Console, then explicitly dispatch the task:

```sh
herdr-team up
herdr-team dispatch
herdr-team status
```

`up` creates or reuses the project workspace and resident agents, then opens or reuses a Team Console tab without taking focus. It does not enqueue todo tasks. `dispatch` enqueues todo cards and attempts delivery; Console automatically schedules the remaining queued work as roles become available. Use `herdr-team tasks <id>` to read a full card and `herdr-team status` to compare card progress with live Herdr activity.

## How work moves

The `.herdr/` task card is the workflow record. Its `status` describes task progress (`todo`, `doing`, `review`, or terminal states). Herdr's live agent state describes whether a native session is available or working. The card's `delivery` record describes one queued or attempted assignment (`queued`, `sending`, `submitted`, `claimed`, or `uncertain`). These are related but distinct states.

Each assignment has a unique delivery ID. The receiving agent must claim that ID before starting and pass the same ID to handoff. Busy, blocked, unknown, or unavailable receivers stay queued. Handoff appends an optional summary to the task's `task.md`, records the next owner, and queues the next delivery. A task with no remaining handoff roles is completed by its final owner. Review [queue and delivery details](cli/README.md#team-console) for state transitions and examples.

Console is the automatic scheduler and runs in the project's Team Console tab. Closing it pauses automatic delivery while queue records remain on disk; run `herdr-team up` or `herdr-team console` to resume. `console --observe`, `console --once`, and `console --line` are read-only views and do not schedule work. An uncertain delivery may already have reached an agent: inspect the agent and its task artifacts before a lead uses `herdr-team queue retry <id>`. A retry receives a new delivery ID. This queue prevents blind repeat sends; it cannot guarantee exactly-once execution by the underlying terminal or agent.

Resident roles can resume a saved native session when Herdr's official integration reports its session ID. Install or update the matching Herdr integration (for example, `herdr integration install codex`) and let it report a session before shutdown. `herdr-team up --fresh` ignores saved session records for roles that need starting; already running agents are reused. See [session recovery](cli/README.md#快速开始) for limits and troubleshooting.

## Upgrade, remove, and troubleshoot

To upgrade, update/reinstall `boyd4y/herdr-team` through Herdr's plugin manager so the bundled CLI, skill, and managed configuration are refreshed. If new event hooks or configuration are not active, use the plugin's `configure` action; a CLI update that requires refreshed hooks may also require relinking the plugin. Keep the user bin directory and Bun on Herdr's `PATH`.

Before removing the plugin, remove the plugin-managed skill, Herdr configuration, and CLI shim with the corresponding actions:

```sh
herdr plugin action invoke herdr-team.uninstall-skill
herdr plugin action invoke herdr-team.unconfigure
herdr plugin action invoke herdr-team.uninstall-cli
```

Then remove the plugin using Herdr's plugin manager. For a local development link, use `herdr plugin unlink herdr-team` after those actions. These actions preserve user-modified files and configuration outside Herdr Team's managed blocks. `herdr-team down` stops the team's agents but keeps the project workspace by default; it is not an uninstall command.

Common checks:

- `herdr-team` not found: add the configured user bin directory and Bun to `PATH`, open a new shell, and confirm Herdr's server environment also includes them.
- `No team project found`: run inside a project containing `.herdr/`, or pass `--root <project-directory>` where supported.
- `up` or `dispatch` requires a Herdr pane: run it inside a managed Herdr pane, not an ordinary terminal.
- Agent session was not resumed: recovery depends on a supported Herdr integration reporting a session ID; inspect the error before trying `up --fresh`.
- Delivery is uncertain: inspect task history, the receiving agent, and artifacts before explicitly retrying.

For the complete command reference, queue details, native session behavior, and configuration boundaries, see the [CLI guide](cli/README.md). For development and pull requests, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Contribute

Issues and pull requests are welcome. Please include the Herdr, Node, Bun, and agent integration versions involved, exact commands, expected and actual behavior, and a minimal reproduction. Never include credentials, private task contents, or session IDs. See [contribution instructions](CONTRIBUTING.md) for layout, checks, and local plugin testing.

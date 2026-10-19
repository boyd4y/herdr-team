# Herdr Team

[简体中文](README.zh-CN.md) · English

Herdr Team is a public Herdr plugin for coordinating project-scoped agent teams. It bundles a `herdr-team` CLI and an agent skill. The CLI reads and updates a project's `.herdr/` identity, role cards, and task cards; Herdr runs the native agent sessions; Team Console schedules explicitly queued work. Team Console uses [OpenTUI Core](https://github.com/anomalyco/opentui) for terminal rendering and input; no separate daemon is required.

## Install

Herdr Team supports macOS and Linux. Install [Herdr](https://herdr.dev) 0.9.3 or later, [Node.js](https://nodejs.org) 22.20 or later (with `npm`/`npx`), and [Bun](https://bun.sh) 1.3.14 or later. The CLI installer requires Bun on `PATH` and installs locked production dependencies, including the platform-specific OpenTUI native library; its first run may need network access. No Zig compiler is needed. The skill installer uses `npx` and may need network access the first time it downloads Skills CLI.

Install the public plugin from GitHub:

```sh
herdr plugin install boyd4y/herdr-team
```

The setup hook installs the bundled CLI and skill and writes Herdr's managed sidebar and action keybindings. It does not initialize a project, start agents, or modify a project's `.herdr/` directory. The CLI is placed at `$XDG_BIN_HOME/herdr-team` or, when unset, `~/.local/bin/herdr-team`; make that directory and Bun available on `PATH` in both your shell and Herdr server environment. The installer does not edit shell startup files. If setup could not reload a running session, invoke `herdr-team.configure` from a Herdr session.

Check the installation:

```sh
herdr-team --help
```

## Start a project team

Choose a workflow first, then configure each role’s responsibilities, harness, model, and launch mode together in one table. `dev-test-review` is a recommendation: develop and test in the same local task worktree, publish a PR after testing, and let an independent reviewer approve automatic merge or reject it back to development and testing. `dev-test`, `direct`, and custom workflows are also supported. Confirm responsibilities and supply the definitions in `roles.json` with `--roles-file`; see the [CLI guide (Chinese)](cli/README.md) and [team setup reference (Chinese)](skill/references/setup.md).

```sh
herdr-team init --roles-file roles.json
herdr-team validate
```

The skill saves the agreed flow in `.herdr/workflow.md`, including responsibilities, handoff order, PR delivery, and merge policy. It supplies each task's `--role` and `--handoff` explicitly. The CLI has no workflow command, preset, or implicit default chain. Changing the agreement leaves existing assignments intact; the CLI does not execute old workflow snapshots. Historical records stay readable; unsupported active snapshots require explicit reconciliation.

Onboarding is a conversation guided by the herdr-team skill. The CLI has no `onboard` command; `init` saves confirmed configuration. The skill checks the effective roles with `role list --json`, reads the workflow agreement, and runs validation before starting or dispatching. Existing roles are preserved by default; research and docs are optional. Role prompts define responsibilities, while the skill guides collaboration; assignments ask agents to read the skill before using the supplied CLI argument templates. `herdr-team --help` lists every available command, including task operations. Sidebar refresh runs through internal plugin hooks.

Review `.herdr/identity.md`, role metadata in `.herdr/roles/<role>/.role.yaml`, and role instructions in `.herdr/roles/<role>/prompt.md`. Edit the identity and role instructions for your project.

Commit `.herdr/.gitignore`, `identity.md`, `models.json`, `roles/`, and the optional `workflow.md` to share team configuration across machines. Initialization creates an internal `.gitignore` for tasks, reports, retired task IDs, and Herdr's local project/worktree records; existing ignore files are preserved. Keep `.herdr/` itself visible to Git. Use `git rm --cached` for local records already tracked, keeping the files on disk. Tasks and native sessions remain local; install and authenticate the selected tools on each machine.

To inspect roles, run `herdr-team role list`. Add a role with `herdr-team role add <name> --kind <kind>`; update an existing role's responsibilities with `herdr-team role add <name> --force --body <text>` or `--body-file <file>`; remove a role with `herdr-team role rm <name>`. Run `herdr-team up` after adding roles so they are started and reported.

Add a task with its owner and optional ordered handoff roles:

```sh
herdr-team add "Implement login" --role dev --handoff test,review
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

Each assignment has a unique delivery ID. The receiving agent must claim that ID before starting and pass the same ID to handoff. Busy, blocked, unknown, or unavailable receivers stay queued. Handoff appends an optional summary to the task's `task.md`, records the next owner, and queues the next delivery. A task with no remaining handoff roles is completed by its final owner. See the [Chinese CLI guide's queue and delivery details](cli/README.md#team-console) for state transitions and examples.

Console is the automatic scheduler and runs in a Herdr-managed plugin tab in the project's workspace. `up` opens it without stealing focus; no shell command is injected into an existing pane. Task file changes and native Herdr plugin events wake it; delivery deadlines use individual timers, with a 60-second reconciliation fallback. Closing it pauses automatic delivery while queue records remain on disk; run `herdr-team up` or `herdr-team console` to resume. `console --observe`, `console --once`, and `console --line` are read-only views and do not schedule work. An uncertain delivery may already have reached an agent: inspect the agent and its task artifacts before a lead uses `herdr-team queue retry <id>`. A retry receives a new delivery ID. This queue prevents blind repeat sends; it cannot guarantee exactly-once execution by the underlying terminal or agent.

Console lists the newest task IDs first and splits the selected task's flow and details equally on the right. Delivery uses a fading light trail; the active node has a gentle border glow. Compact role rows show the full team when space allows and remain scrollable in small terminals. Try `herdr-team console --sample` for a looping demo without a project or Herdr connection. It uses in-memory data and never schedules work or writes team files. In a live Console, press `s` to preview the sample and return; scheduling pauses while the preview is open.

`prefix+t` invokes **Open Console**: it starts or focuses the project's single scheduler tab, named **Console**. The action uses the invoking workspace/pane context, including the main checkout when invoked from a task worktree. Existing user bindings take precedence. You can also invoke `herdr plugin action invoke herdr-team.open-console`. A missing or stale project context reports an error instead of using the plugin checkout or a later UI focus. Quit with `q`.

The status strip summarizes nonzero task and delivery counts. The roles table shows current tasks and queue counts; `NEEDS YOU` collects warnings. Details include the task branch and reviewed commit. The read-only tab-bar line includes a nonzero `N queued` count after task counts. See the [Team Console guide](cli/README.md#team-console) for layout and controls.

Resident roles can resume a saved native session when Herdr's official integration reports its session ID. Claude and Codex IDs are saved and marked confirmed only after the local transcript contains a real user/assistant message; startup-only IDs are not saved or used for automatic resume. Confirmation respects role and inherited config paths (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`). Grok can resume an empty session; current Kimi creates a session on its first message, so neither needs this extra gate. Already-confirmed IDs do not reread transcripts during status updates. Older references need the same confirmation before use. Resume failures preserve the reference and do not silently switch to a new session. Session IDs alone do not transfer history between machines. Install or update the matching Herdr integration (for example, `herdr integration install codex`) and let it report a session before shutdown. `herdr-team up --fresh` ignores saved session records for roles that need starting; already running agents are reused. See the [Chinese CLI guide](cli/README.md) for recovery limits and troubleshooting.

Task sessions resume separately by project, task, role, and worktree directory when the queue starts them. Team reads Herdr's `agent_session`; it requires no additional session hook. Resuming does not replay assignments or resolve uncertain deliveries.

Each task owns a worktree and its role sessions: `dev-0046` and `dev-0047`, or `test-0050` and `test-0052`, can run concurrently. Dev and test reuse the task checkout, with writes paused during testing/review. Submit a commit with `handoff <id> --delivery ID --commit SHA`. For agreed PR delivery, the skill pushes the tested SHA and creates or reuses its PR, then test records it with `--accept SHA --pr URL --summary TEXT`. Review uses `--accept SHA --summary TEXT` or `--reject --summary TEXT`; rejection repeats the recorded validation path. Approval queues integration. Under an agreed automatic merge policy, the reviewer's skill immediately invokes `merge <id>`; otherwise lead merges explicitly. Lead remains the project's single resident coordinator.

PR workflows require an authenticated GitHub CLI (`gh`) and a matching GitHub.com `origin`. PR head, testing, and review must name the same SHA. The skill requests merge after review approval; the CLI verifies that request under the integration lock, and branch protection is respected. With one shared GitHub account, Team publishes its decision as a clearly labeled PR comment because authors cannot approve their own PRs; this does not replace an independent GitHub approval required by repository rules. Separate reviewer accounts submit formal commit-specific reviews. Failed/interrupted merges require inspection before `merge retry <id>` and `merge <id>`; merged PRs are reconciled before local synchronization is retried. The optional local workflow retains `merge next` / `merge <id> --migrate 'command'`. Other tasks keep running; isolated service variables are described in the [CLI guide](cli/README.md#按任务开发验收与合并).

## Upgrade, remove, and troubleshoot

For a GitHub installation, upgrade by updating or reinstalling `boyd4y/herdr-team` through Herdr's plugin manager. For a locally linked checkout, run `herdr plugin link .` from the checkout root to refresh the plugin manifest and event hooks, then run `herdr plugin action invoke herdr-team.install` to refresh the bundled CLI, skill, and managed configuration. The `configure` action only applies Herdr Team's managed layout and configuration and reloads config; it does not register changed event hooks or refresh the CLI and skill. Keep the user bin directory and Bun on Herdr's `PATH`.

To update a GitHub installation and check the installed versions:

```sh
herdr plugin install boyd4y/herdr-team --ref main
herdr plugin list --plugin herdr-team
herdr-team --version
```

Installation refreshes the plugin, bundled CLI, skill, and managed configuration. Exit an already-running Console and reopen it with `prefix+t` to load the new runtime. Project initialization is not an upgrade step. Plugin and CLI versions are both `0.1.4` in this release.

Before removing the plugin, remove the plugin-managed skill, Herdr configuration, and CLI shim with the corresponding actions:

```sh
herdr plugin action invoke herdr-team.uninstall-skill
herdr plugin action invoke herdr-team.unconfigure
herdr plugin action invoke herdr-team.uninstall-cli
```

`unconfigure` removes only Herdr Team's managed configuration block and preserves content outside it. `uninstall-cli` removes an unchanged plugin-owned CLI shim; edited or replaced shims are left in place. `uninstall-skill` delegates removal to Skills CLI and does not promise to preserve edits inside the installed skill, so copy any custom skill changes before reinstalling or removing it.

Then remove the plugin using Herdr's plugin manager. For a local development link, use `herdr plugin unlink herdr-team` after those actions. `herdr-team down` stops the team's agents but keeps the project workspace by default; it is not an uninstall command.

Common checks:

- `herdr-team` not found: add the configured user bin directory and Bun to `PATH`, open a new shell, and confirm Herdr's server environment also includes them.
- `No team project found`: run inside a project containing `.herdr/`, or pass `--root <project-directory>` where supported.
- `up` or `dispatch` requires a Herdr pane: run it inside a managed Herdr pane, not an ordinary terminal.
- Agent session was not resumed: recovery depends on a supported Herdr integration reporting a session ID; inspect the error before trying `up --fresh`.
- Delivery is uncertain: inspect task history, the receiving agent, and artifacts before explicitly retrying.

For the complete command reference, queue details, native session behavior, and configuration boundaries, see the [CLI guide (Chinese)](cli/README.md). For development and pull requests, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Contribute

Issues and pull requests are welcome. Please include the Herdr, Node, Bun, and agent integration versions involved, exact commands, expected and actual behavior, and a minimal reproduction. Never include credentials, private task contents, or session IDs. See [contribution instructions](CONTRIBUTING.md) for layout, checks, and local plugin testing.

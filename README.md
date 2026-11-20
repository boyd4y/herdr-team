# Herdr Team Skill

The shared `herdr-team` Skill and CLI, extracted from the TUI package. The Skill
owns team decisions and procedures. The CLI owns persisted records, validation,
locks, runtime detection and execution adapters. Desktop layouts/mods and TUI
plugin configuration remain presentation integrations.

Initial extraction source: `boyd4y/herdr-team` commit
`ad90a8e3fdeb68b861565a8bb7f58494471447c7` (MIT).

The Skill keeps its existing name, `herdr-team`, so installed role instructions
and existing projects do not need a second workflow or renamed references.
`TEAM.md`, `agents.json` and `.herdr/` record formats remain unchanged.

## Local installation

Requires Node.js 22+, Bun 1.3.14+, and the selected native agent CLIs on PATH.
From this repository:

```sh
npm run setup
```

This installs the shared CLI and Skill without modifying a UI layout, plugin
keybindings or project data. The existing installer ownership ledger is retained
so a managed CLI can be updated without overwriting personal replacements.
Skill installation uses the pinned Skills CLI and requires network on first use.
Back up custom installed Skill edits before an explicit update.

```sh
npm run install:cli
npm run install:skill
```

The public command remains `herdr-team`. Runtime operations verify their managed
caller; they do not choose a runtime by space names, window focus, project paths
or copied runtime IDs. Missing or ambiguous contexts fail before execution.
Runtime-specific behavior belongs in the CLI, never in the shared Skill.

Local Desktop execution supports native Codex/Claude task launches, claim,
handoff and inbox recovery. It uses the same delivery IDs, task records,
locks, dependency checks and exact-commit review gates as TUI execution. Each
task owns a Git checkout; Core addresses are stored as `terminal`, never
`pane_id`. New native processes receive their assignment in argv. Existing
sessions accept messages only through Core's atomic idle guard; a later
delivery after a completed task turn can start a new conversation in the same
checkout. Unknown sends become uncertain and are not resent automatically.

Each task checkout also owns one native Desktop space. All of that task's role
sessions use the same space; the shipped Spaces mod groups it under the main
checkout using Git's normal worktree identity. The CLI registry explicitly maps
that space back to the coordinating team. `space show --space ID` returns the
same team binding from the main or task space, with `view_space`, task ID and
checkout added for a task view. No name or cwd supplies team ownership.
`space sync [TASK] --root ROOT` attaches existing owned task terminals without
restarting them, sending input or changing delivery/task metadata.

Run `herdr-team team up` inside each project's Herdr terminal. The command registers
the project with its verified parent Space or workspace, then starts or reuses
the shared daemon. The same service handles multiple registered projects.

```sh
herdr-team daemon status
herdr-team daemon logs --lines 50
herdr-team daemon start
herdr-team daemon stop
herdr-team project list
herdr-team project show
herdr-team inbox list --role lead
herdr-team inbox retry <task-id>
```

`~/.herdr-team` holds project registrations, daemon state and the service log.
CLI commands print readable text by default. Pass `--json` to commands that
support structured output, including `daemon logs`. The raw log at
`~/.herdr-team/daemon.log` stores a JSON record per line for tools that tail it.
Task contents and handoff summaries stay in the task records.
Tasks and delivery IDs remain in each project's `.herdr/`. The daemon wakes on
Herdr events and on explicit CLI operations. It leaves uncertain deliveries for
reconciliation. `daemon stop` preserves registrations for the next start.
`herdr-team team down` pauses automatic delivery for the current project and keeps
it in the global project list.

Use `role add ... --lifecycle resident` for project-wide agents and
`--lifecycle temporary` for agents launched on demand. Tasks for temporary
roles need a feature and iteration. Use `add ... --feature NAME --iteration VERSION`
or set these fields on an existing task with `edit`. A task can inherit the
linked issue's iteration.

After confirming delivery, run `herdr-team feature finish NAME --iteration VERSION`.
The daemon closes settled temporary sessions launched for that feature and
iteration. Open assignments keep shared sessions available. Resident agents
run until `herdr-team team down`. Task records, worktrees and branches are retained.
Closure and failures are recorded in `daemon logs`.
Run `herdr-team feature clean NAME --iteration VERSION` to reclaim the worktrees
and Desktop resources of the task IDs in that confirmation.

Agents, Tasks and Inbox commands each use a single project. Run them in that
project or its Git worktree to select it by default. From elsewhere or when
multiple projects match, use `--root DIR` or `--project ID`, with the ID from
`project list`. The project list and daemon controls work from any directory.

Desktop mods display team records. After final handoff, run `herdr-team task clean <id>`
from the team Space to reclaim the task's owned Git worktree, terminals and
native task Space. The cleanup keeps the branch and task history. It reports
any changes or other sessions that prevent safe removal.

## Source ownership

- `skill/`: the single Skill and reusable assets.
- `cli/scripts/lib/team`, `tasks`, `dispatch`, `integration`: shared records and explicit operations.
- `cli/scripts/lib/runtime`: runtime clients, caller detection, bindings and lifecycle.
- `cli/scripts/lib/ui`: legacy Console presentation and read-only CLI projections.
- `bin/`: shared installation only; no UI-specific configuration.

The TUI plugin opens its own read-only Console.
Desktop mods do not import the TUI Console or its rendering
dependencies. This local extraction is not a published GitHub/npm release;
presentation packages use an explicit local source link until publication.

## Desktop showcase

Install the separate interactive simulator with `npm run install:mock`.
Run `herdr-mock <codex|claude|grok|pi|kimi|qoder>` in any terminal.
Enter prompts one at a time, or pass a first prompt on the command line.
`/exit` closes the session. Each turn reports activity to Herdr through OSC.

In the prepared demo project's first shell in Herdr Desktop, run:

```sh
herdr-team team up --demo
```

`up -demo` is an alias. The demo uses the current Space and a local mock team.
The right-hand Team Board and native Agents list show the workflow. Eighteen tasks
cover seven issues, with up to nine task flows in flight across mock Codex, Claude
and Grok. The mock terminals show checkout, patch, and validation output. The
demo task driver uses the normal task CLI for claim, handoff, rejection and acceptance.
The showcase integrates the changes, confirms the release and reclaims its task
worktrees. Use `--fast` for a shorter validation run.

## Validation

From a terminal in the registered `herdr-team-test` Desktop space, run
`bun /path/to/herdr-team-skill/tests/desktop-smoke.ts v1.2-smoke.4 --paired`.
Use a new version suffix for each run. The TypeScript runner uses the same
mock harnesses and task flow as the showcase. It integrates the fixture into
the test project's `main`, exercises rejection and rework on the second batch,
and checks the dirty-checkout guard and cleanup. The latest result is stored in
`.herdr/typescript-smoke/result.json`.

```sh
cd cli
bun install --frozen-lockfile
bun test
bun run typecheck
```

Tests use isolated data and runtime clients. See [the CLI guide](cli/README.md)
for existing record and command contracts.

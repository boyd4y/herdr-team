# Language conventions

Use English for CLI help, command output, errors, TUI labels, and generated
default instructions. Keep a single English interface; do not add localization,
locale detection, translation catalogs, or language flags.

Documentation may use Chinese or English. Separate English and Chinese README
files are welcome. Preserve user-provided titles, descriptions, role prompts,
and summaries in their original language; Unicode input remains supported.

# Skill and CLI responsibilities

- Skill: own onboarding, workflow recommendations, role responsibilities,
  task decomposition, handoff order, validation scope, and next-step decisions.
- Skill: maintain the project's workflow agreement in `.herdr/workflow.md`;
  explicitly request PR creation and merging under the user's agreed policy.
- Skill: require final delivery cleanup after any required merge succeeds. Use
  explicit task-scoped clean from the coordinating workspace; preserve resident
  sessions, other tasks, branches, and unfinished work. CLI does not infer cleanup
  policy from workflow prose or review approval.
- CLI: standardize inputs, outputs, and persisted task/delivery records; execute
  explicit operations for agents, worktrees, handoffs, and merges.
- CLI: enforce record validity, delivery deduplication, project/session scope,
  exact commit checks, and concurrency locks. Do not decide orchestration policy.
- Do not add workflow presets, workflow management commands, or role-specific
  next-step decisions to the CLI. A handoff must not implicitly publish a PR or
  merge because of a preset. Do not retain obsolete workflow execution engines.
- Keep task state CLI-owned. Workflow prose is Skill-owned; it must not override
  an active task's recorded assignment. Reject unsupported active task formats explicitly;
  leave completed historical records readable.
- Keep `skill/SKILL.md` a short entry point. Put setup, workflow, and handoff
  instructions in their respective references; link to each topic instead of
  copying its procedures or role prompts into multiple files.

# Role prompts and shared context

- Maintain reusable role prompts in `skill/assets/roles/<role>/prompt.md` and the
  harness model catalog in `skill/assets/models.json`; role plans reference it from
  `skill/assets/plans.json`, and the shared identity template in
  `skill/assets/identity.md`; do not embed these texts or catalogs in code.
- Role `prompt.md`: define the role's responsibilities, allowed scope, boundaries,
  and expected deliverables. Direct agents to the herdr-team skill for procedures;
  do not copy command catalogs, workflow rules, or handoff/PR/merge recipes here.
- `identity.md`: provide shared project background, stable conventions, and user
  preferences. Do not assign roles, route tasks, prescribe command sequences, or
  duplicate the skill. Reference existing `AGENTS.md` conventions instead of
  maintaining a competing copy; identity text does not override them.
- Delivery messages: request skill loading first, then supply assignment facts,
  task/artifact paths, SHAs, delivery IDs, and exact CLI argument templates.
  Templates identify an operation; the skill determines when and how to use it.
  Do not turn the message builder into a second workflow guide.
- Keep these layers separate when updating defaults and onboarding instructions.
  Do not silently overwrite existing customized role prompts or identity files,
  or alter active task records to enforce a new prompt convention.

# Local team state

Keep the entire project `.herdr/` directory out of Git, including identity, roles,
models, workflow, tasks, reports, and temporary artifacts. Initialization adds a
root `.gitignore` entry without replacing existing rules. Reusable templates stay
in `skill/assets/`; do not force-add local team files to share them.

# Tests

Keep tests focused on observable behavior and meaningful failure recovery.
Check existing coverage before adding a case; avoid repeating it at every layer.
Do not lock down prompt wording, preset model lists, exact spacing, or colors.
Retain coverage for delivery, session recovery, commit acceptance, merge safety,
and preserving user files. Remove obsolete compatibility tests with their code.

# CLI module layout

Keep `cli/scripts/cli.ts` as the argument/input/output adapter. Put implementation
under `lib/team`, `tasks`, `dispatch`, `runtime`, `integration`, `ui`, or `shared`
according to responsibility; see `cli/README.md` for the map. Do not add new flat
`lib/*.ts` files, compatibility re-export shims, or a generic helpers bucket.
Use direct module imports instead of importing implementation from the CLI entry.

# Terminal UI

Use `@opentui/core` components for Console layout, input, focus, scrolling, drawing,
and terminal lifecycle. Keep application code to data models, component assembly,
and business key bindings. Do not add a custom ANSI renderer, escape-sequence
parser, raw-mode loop, or replacement widget toolkit. Use OpenTUI's test renderer
for interaction tests; keep plain `--once` and `--line` output independent of it.

Use runtime or established library APIs for generic serialization and formatting.
YAML syntax and quoting belong to `Bun.YAML`; the metadata adapter only orders
fields and checks the document shape. Do not add a custom YAML writer. Use
`Bun.stringWidth` and `Intl.Segmenter` for plain table text instead of hand-maintained
Unicode width ranges; interactive text layout stays with OpenTUI.

# Harness model catalog

Keep the initial model catalog in `skill/assets/models.json`, separate from role
plans and prompts. Initialize `.herdr/models.json` only when missing, preserve it
even with force, and prefer the project catalog and its optional per-harness
`preferred` choices. Customers may edit that local file. Codex and Claude entries use their respective official model IDs or
native aliases; do not bundle third-party backend mappings. Every harness offers
`default` without model override arguments or environment variables. Keep general
launch flags separate from model flags. Skill owns checking official sources and
refreshing the catalog/date; CLI expands explicit inputs without fetching models.
Refreshing the skill seed never overwrites project catalogs. Project catalog
changes are read on the next selection without reinstalling; they do not silently
rewrite existing project roles or running sessions.

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
- Skill: own execution feedback and improvement reports. Use existing task,
  delivery, artifact and Git evidence; separate observed timing from inference.
  Propose upstream issues and repository fixes under the user's requested scope;
  do not add a feedback CLI, background telemetry, or automatic workflow rewriting.
  Complete the local report first; search upstream issues only after the report is
  reviewed, the upstream problem is confirmed, and the user decides to submit it.
  Present core findings, traceable evidence, and concrete owner/action/validation
  recommendations in the conversation; a report link alone is not the deliverable.
- Skill: check the repository-root `TEAM.md` on every invocation and initialize it
  when missing. Maintain shared project identity, preferences, role boundaries,
  and workflow there; keep it in Git. Follow the setup reference for migration;
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

# Workspace ownership

CLI owns project workspace discovery and creation. Serialize same-project startup,
prefer canonical checkout identity and verified ownership, and reject ambiguous or
conflicting bindings. A task workspace cannot stand in for a missing main workspace.
Skill uses team up/dispatch/handoff instead of creating additional workspaces to
recover from errors; inspect existing state before retrying an uncertain operation.

# Role prompts and shared context

- Maintain reusable role prompts in `skill/assets/roles/<role>/prompt.md` and the
  harness model catalog in `skill/assets/models.json`; role plans reference it from
  `skill/assets/plans.json`, and the shared team agreement template in
  `skill/assets/TEAM.md`; do not embed these texts or catalogs in code.
- Role `prompt.md`: define the role's responsibilities, allowed scope, boundaries,
  and expected deliverables. Direct agents to the herdr-team skill for procedures;
  do not copy command catalogs, workflow rules, or handoff/PR/merge recipes here.
- `TEAM.md`: maintain shared project background, stable preferences, role boundaries,
  and the agreed workflow. Reference `AGENTS.md` for code and agent constraints;
  do not duplicate skill procedures, task assignments, or local launch settings.
  Skill owns migration from old identity/workflow files. When creating or rebuilding
  TEAM.md, present the proposed migration and exact old paths and ask whether to
  migrate and clean them, unless this operation is already explicitly authorized.
  Verify the saved agreement before deleting only approved, unchanged old files;
  preserve existing prose and all task/runtime records. Ordinary reads do not prompt.
  CLI only initializes a missing template and passes the root agreement to agents;
  it does not interpret the workflow or overwrite an existing agreement.
- Delivery messages: request skill loading first, then supply assignment facts,
  task/artifact paths, SHAs, delivery IDs, and exact CLI argument templates.
  Templates identify an operation; the skill determines when and how to use it.
  Do not turn the message builder into a second workflow guide.
- Keep these layers separate when updating defaults and onboarding instructions.
  Do not silently overwrite existing customized role prompts or TEAM.md,
  or alter active task records to enforce a new prompt convention.

# Local team state

Keep root `TEAM.md` in Git. Keep the entire project `.herdr/` directory out of Git,
including local roles, models, tasks, reports, and temporary artifacts.
Initialization adds a root `.gitignore` entry without replacing existing rules. Reusable templates stay
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

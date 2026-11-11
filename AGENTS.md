# Language conventions

Use English for CLI help, command output, errors, TUI labels, and generated
default instructions, except the Chinese TEAM.md template and role checklists. Keep a single English interface; do not add localization,
locale detection, translation catalogs, or language flags.

Documentation may use Chinese or English. Separate English and Chinese README
files are welcome. Preserve user-provided titles, descriptions, role prompts,
and summaries in their original language; Unicode input remains supported.

# Skill and CLI responsibilities

- Skill: own onboarding, role responsibilities,
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
  when missing. Keep it in Git as brief Chinese numbered steps per actual role;
  do not require workflow selection or a project workflow configuration. Follow the setup reference for migration;
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
- Keep task state CLI-owned. Collaboration procedures are Skill-owned; it must not override
  an active task's recorded assignment. Reject unsupported active task formats explicitly;
  leave completed historical records readable.
- Keep `skill/SKILL.md` a short entry point. Put setup, delivery, and handoff
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
  agent preset seed in `skill/assets/agents.json`; role plans reference it from
  `skill/assets/plans.json`, and the shared team agreement template in
  `skill/assets/TEAM.md`; do not embed these texts or catalogs in code.
- Role `prompt.md`: define the role's responsibilities, allowed scope, boundaries,
  and expected deliverables. Direct agents to the herdr-team skill for procedures;
  do not copy command catalogs, workflow rules, or handoff/PR/merge recipes here.
- `TEAM.md`: keep only short Chinese numbered work steps under each actual role.
  Do not add identity, preferences, Workflow or Completion sections. Handoff,
  collaboration, task routing, PR/merge and cleanup procedures belong in the skill,
  not TEAM.md. Engineering constraints stay in AGENTS.md; shared agent presets belong in root agents.json; role references stay local.
  Skill owns migration from old identity/workflow files. When creating or rebuilding
  TEAM.md, present the proposed migration and exact old paths and ask whether to
  migrate and clean them, unless this operation is already explicitly authorized.
  Verify the saved agreement before deleting only approved, unchanged old files;
  preserve existing prose and all task/runtime records. Ordinary reads do not prompt.
  CLI only initializes a missing template and passes the root agreement to agents;
  it does not interpret role steps or overwrite an existing checklist.
- Delivery messages: request skill loading first, then supply assignment facts,
  task/artifact paths, SHAs, delivery IDs, and exact CLI argument templates.
  Templates identify an operation; the skill determines when and how to use it.
  Do not turn the message builder into a second workflow guide.
- Keep these layers separate when updating defaults and onboarding instructions.
  Do not silently overwrite existing customized role prompts or TEAM.md,
  or alter active task records to enforce a new prompt convention.

# Local team state

Keep root `TEAM.md` and `agents.json` in Git. Keep the entire project `.herdr/` directory out of Git,
including local role references, tasks, reports, and temporary artifacts.
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

# Agent configuration presets

Keep the initial preset data in `skill/assets/agents.json`, separate from role plans
and prompts. Initialize repository-root `agents.json` only when missing; preserve it
even with force and plugin updates. Users may maintain this shared file manually.
Group complete presets under native harness names such as codex and claude; a role
references kind + preset. Keep model, reasoning_effort, native permission settings,
and ACP command/args structured. Do not duplicate preset launch settings in role metadata
or require users to concatenate model or command arguments. CLI adapters translate fields
to native options; unknown fields and unresolved references fail explicitly.

Codex/Claude seed entries use their own official model IDs or aliases, without
third-party backend mappings. Every harness offers default with no model override.
Model names live in preset data, not a hardcoded CLI allowlist. Skill owns checking
official sources and refreshing presets; CLI never fetches models. Read project
presets on the next start without reinstalling, while preserving running sessions,
custom role prompts and active task records. Presets do not grant native Herdr
support to an unsupported harness. Do not masquerade custom agents as Codex or bypass Herdr.
ACP roles use kind acp with command/args presets. ACPC owns their complete terminal
UI and ACP connection; the adapter observes its structured app-server events and
submits tasks through that same session. Keep one client per scoped session, use
Herdr's custom-agent reporting API, and retain the authenticated local delivery
channel. Do not build another chat UI, print protocol updates as transcript lines,
or submit assignments through terminal keystrokes or native agent prompt. Keep
bundled acpx for isolated headless response tests. Reuse existing task/delivery
records and preserve uncertain submission handling. Exact resume failures must
not silently create a conversation.
Keep credentials in native user configuration or external environment, not shared
presets. Existing explicit role launch settings remain readable; migrate them only
when requested, preserving custom flags, environment and prompt contents.

Standalone `agents check`, `agents run` and `agents test` are explicit local preset checks, separate
from team orchestration. They may invoke native binaries directly for interactive
diagnostics. ACPC is the internal ACP UI client and can also be used manually; it
is not a team harness or preset type. Inside Herdr, standalone ACP runs may report
their own display identity and lifecycle without acquiring a team assignment.
Do not use standalone diagnostics as a dispatch fallback, bind them to
roles or save team resume references. Response tests use isolated temporary working
directories, bounded subprocess output, timeouts and cancellation cleanup; report
unsupported response adapters as skipped rather than a passing model response.
Local CLI checks use native version and read-only auth-status commands, respect
preset environments, and report unsupported or unrecognized login status as unknown.
Do not infer authentication from files or environment variable presence, expose raw
auth output, send prompts during checks, or probe automatically when listing presets.

Use `qoder` in project configuration, role kinds, CLI selectors and display. Translate
to Herdr native `qodercli` only in the runtime adapter; preserve native session
source identifiers and read existing qodercli configuration without overwriting it.

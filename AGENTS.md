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
- CLI: standardize inputs, outputs, and persisted task/delivery records; execute
  explicit operations for agents, worktrees, handoffs, and merges.
- CLI: enforce record validity, delivery deduplication, project/session scope,
  exact commit checks, and concurrency locks. Do not decide orchestration policy.
- Do not add workflow presets, workflow management commands, or role-specific
  next-step decisions to the CLI. A handoff must not implicitly publish a PR or
  merge because of a preset; retain such behavior only for existing legacy tasks.
- Keep task state CLI-owned. Workflow prose is Skill-owned; it must not override
  an active task's recorded assignment or silently migrate legacy workflows.
- Keep `skill/SKILL.md` a short entry point. Put setup, workflow, and handoff
  instructions in their respective references; link to each topic instead of
  copying its procedures or role prompts into multiple files.

# Role prompts and shared context

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

# Tests

Keep tests focused on observable behavior and meaningful failure recovery.
Check existing coverage before adding a case; avoid repeating it at every layer.
Do not lock down prompt wording, preset model lists, exact spacing, or colors.
Retain coverage for delivery, session recovery, commit acceptance, merge safety,
and preserving user files. Remove obsolete compatibility tests with their code.

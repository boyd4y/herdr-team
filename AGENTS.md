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

# Tests

Keep tests focused on observable behavior and meaningful failure recovery.
Check existing coverage before adding a case; avoid repeating it at every layer.
Do not lock down prompt wording, preset model lists, exact spacing, or colors.
Retain coverage for delivery, session recovery, commit acceptance, merge safety,
and preserving user files. Remove obsolete compatibility tests with their code.

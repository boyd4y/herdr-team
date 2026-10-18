# Language conventions

Use English for CLI help, command output, errors, TUI labels, and generated
default instructions. Keep a single English interface; do not add localization,
locale detection, translation catalogs, or language flags.

Documentation may use Chinese or English. Separate English and Chinese README
files are welcome. Preserve user-provided titles, descriptions, role prompts,
and summaries in their original language; Unicode input remains supported.

# Skill and CLI responsibilities

Keep the CLI small: standardize inputs, outputs, persisted records, and reliable
execution of explicit operations. The skill owns workflow choices, role
coordination, validation scope, and decisions about what to do next. Put new
orchestration policy in the skill instead of adding role-specific or
workflow-specific branches to the CLI. Preserve existing authorized behavior
while simplifying it; do not silently change active task workflows.

# Tests

Keep tests focused on observable behavior and meaningful failure recovery.
Check existing coverage before adding a case; avoid repeating it at every layer.
Do not lock down prompt wording, preset model lists, exact spacing, or colors.
Retain coverage for delivery, session recovery, commit acceptance, merge safety,
and preserving user files. Remove obsolete compatibility tests with their code.

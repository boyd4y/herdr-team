# Shared Herdr Team package

- This repository owns the single `herdr-team` Skill, CLI, task/delivery contracts and runtime adapters. Presentation packages depend on it; do not introduce a second workflow engine.
- Skill owns responsibilities, task decomposition, validation and orchestration decisions. CLI owns records, locks, exact operation validation and runtime selection. Keep Skill procedures independent of TUI/Desktop.
- Detect and verify the actual managed caller for runtime operations. Never infer it from display names or UI focus. Reject missing, conflicting or unverifiable contexts. Core terminal addresses are not TUI pane IDs.
- Keep project root, machine and coordinating space bindings explicit and persistent. Never overwrite another team's binding or adopt unrelated terminals by name.
- Read `herdr-app --skill` and `hc --skill` before using Desktop controls. Use the installed guide/generated types for the installed version. Never stop a user's core, switch their layout or close unrelated terminals in tests.
- Reuse the existing CLI record formats, deduplication, session checks, SHA gates and locks. Do not edit task metadata by hand or treat program completion as task acceptance.
- Keep root `TEAM.md` and `agents.json` shareable; ignore `.herdr/`. Preserve customized role prompts, Unicode content, installed skills and active runtime records.
- Use English for CLI/UI output and default instructions; Chinese documentation and TEAM.md checklists are allowed.
- Codex launch/resume must include `--no-daemon`. Unknown or recovered shell status must remain unknown. Core status comes from reports/events, never screen parsing or status polling.
- Tests must isolate project data, trust stores, session stores and runtime state. Use native OpenTUI for the legacy Console; do not invent a renderer or copy UI into the Desktop package.

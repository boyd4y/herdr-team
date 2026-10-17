# Public documentation audit and bilingual README

The user explicitly requests that docs review this public GitHub project from an end user's perspective: explain how to use it and how to contribute. Split the primary README into English and Chinese documents.

## Assigned checkout and scope

- Team root (all task commands use --root): /Users/winston/workspace/self/herdr-team
- Writable feature checkout: /Users/winston/workspace/self/herdr-team-docs-public-readmes
- Branch: docs/public-readmes
- Edit and commit documentation only in the writable feature checkout. The main checkout contains uncommitted team initialization; preserve it. Do not switch branches, merge, push, close workspaces, install anything globally, or control agents.
- Read the actual code, manifests, existing documentation, and skill sources. Use current source and CLI help as the authority. Report implementation issues instead of editing runtime code or tests.

## Required deliverables

1. Make root README.md the English entry point, and create README.zh-CN.md as its Chinese counterpart. Put clear links between them at the top. Keep scope, commands, requirements, and behavior consistent across both.
2. Lead with what Herdr Team does and who it is for. Explain the relationship between the Herdr plugin, bundled CLI, agent skill, and per-project .herdr configuration without assuming the reader knows this repository.
3. Provide a usable newcomer path: prerequisites and supported systems from actual manifests, public GitHub installation (boyd4y/herdr-team), PATH requirements, what setup changes, then project initialization, role configuration, starting the team and Console, creating and explicitly dispatching a task, and viewing progress.
4. Explain task progress versus native Herdr activity versus delivery state. Cover busy receivers, explicit claims, handoff summaries and role chains, Console automatic scheduling, read-only modes, pause/resume, uncertain deliveries and deliberate retries, plus native session restore and its integration dependency. Avoid implying terminal delivery guarantees exactly-once execution.
5. Include contributor instructions: fork/clone or local checkout, repository layout, Bun development dependency setup, actual test and typecheck commands, local Herdr plugin linking for integration testing, English runtime strings and generated instructions, Unicode user data, documentation conventions, and how to submit a useful issue or pull request. Separate using the project from developing it. No nonexistent Makefile or obsolete monorepo paths.
6. Make safe upgrade/uninstall/troubleshooting information discoverable; keep lengthy ownership details in suitable linked documentation rather than overwhelming the quick start. Fix affected relative links and heading anchors in cli/README.md or other documentation as needed.
7. Remove stale private-repository assumptions and maintainer-only conversational instructions. Do not include local usernames, absolute personal paths, credentials, session IDs, or live task delivery IDs in public documentation. Generic examples are fine.
8. A CONTRIBUTING.md (with a Chinese counterpart if useful) is optional; if created, link it clearly from both READMEs. Keep this a focused documentation change and preserve useful existing technical details through links or appropriate relocation.

## Validation and handoff

- Check Markdown relative links and heading anchors, including the language switch links and any existing backlinks affected by renamed headings.
- Validate CLI examples against source/help. Do not execute mutating installation/startup/dispatch examples against the real user session just to test documentation.
- State exactly which checks you performed and which prerequisites or platform/version combinations you could not verify.
- Commit only the documentation changes on docs/public-readmes. Save a handoff summary with the checkout, full commit hash, changed files, usability improvements, checks, and remaining concerns.
- Claim this exact assignment before work, then use its delivery ID and the absolute team root for handoff. The next owner is lead.

## Instructions for the next owner (lead)

Review the documentation commit in the supplied feature checkout against the requirements above. Check that English and Chinese entry points cover usage and contributions consistently, commands match the source, and links are valid. Return actionable corrections to docs if needed. Otherwise summarize the review and complete the task with your own claimed delivery ID. Do not merge, push, remove the feature checkout, or modify the uncommitted initialization files; the coordinating parent will integrate the reviewed result.

## History
- 2026-10-17 09:03  submitted 3ebeceab-d3fc-49da-aa80-e7f6358756aa  (todo → doing)
<!-- team-operation:submit-3ebeceab-d3fc-49da-aa80-e7f6358756aa -->
- 2026-10-17 09:05  → lead  (doing → review)

### Delivery 2026-10-17 09:05 · docs → lead

Completed bilingual public documentation in feature checkout /Users/winston/workspace/self/herdr-team-docs-public-readmes on branch docs/public-readmes. Commit: b4439a952b9cb20aa9d84545a7fa944bd1c84a64. Changed README.md and README.zh-CN.md with matched end-user install, setup, queue/session, removal, troubleshooting, and contribution entry points; added CONTRIBUTING.md and CONTRIBUTING.zh-CN.md; updated cli/README.md installation backlink. Checked CLI command examples against current CLI help/source; ran local Markdown link and heading-anchor validation across 11 Markdown files (passed), git diff --check (passed), and public-doc scan for personal paths/live delivery IDs (none). Did not run product test suites or test installation/startup against a live Herdr session. Checkout was clean after commit. Remaining limitation: I did not verify installation on live macOS/Linux or the stated version combinations. Next owner: lead review.

<!-- team-operation:handoff-3ebeceab-d3fc-49da-aa80-e7f6358756aa -->
- 2026-10-17 09:05  submitted fabc69ac-1114-4f8e-81ea-df7f47350e89  (review → review)
<!-- team-operation:submit-fabc69ac-1114-4f8e-81ea-df7f47350e89 -->
- 2026-10-17 09:07  → docs  (review → review)

### Delivery 2026-10-17 09:07 · lead → docs

Lead review of delivery b4439a952b9cb20aa9d84545a7fa944bd1c84a64 (docs/public-readmes, checkout /Users/winston/workspace/self/herdr-team-docs-public-readmes).

Verdict: requirements are substantially met. Three actionable corrections are required before acceptance. Return to lead when done.

Independently verified (passed):
- Checkout clean at b4439a9; only the five intended files changed.
- All 33 relative links and heading anchors across 11 Markdown files resolve, including cli/README.md#team-console, cli/README.md#快速开始, and the corrected ../README.md#install backlink.
- No absolute personal paths, local usernames, credentials, session IDs, or delivery IDs in README.md, README.zh-CN.md, CONTRIBUTING.md, CONTRIBUTING.zh-CN.md.
- Command and flag examples match cli/scripts/cli.ts and herdr-plugin.toml: plan names cheap/balanced/strong; add --role/--handoff; up --fresh; dispatch <id>; queue retry <id>; console --observe/--once/--line; down --workspace; action ids install/uninstall-skill/unconfigure/uninstall-cli; $XDG_BIN_HOME fallback ~/.local/bin; Bun >=1.2.0; min_herdr_version 0.9.3; platforms linux/macos.
- Exactly-once wording, uncertain-delivery handling, read-only modes, pause/resume, and session-restore integration dependency are all stated accurately.

Corrections required:
1. README.zh-CN.md (req 8). Both CONTRIBUTING links point at the English CONTRIBUTING.md even though CONTRIBUTING.zh-CN.md exists. Point the Chinese entry point at CONTRIBUTING.zh-CN.md so each README links its own-language counterpart, matching what README.md already does.
2. README.md (req 6, English entry point usability). Every deeper reference from the English README lands on a Chinese-only document without saying so: cli/README.md is called "the CLI guide" and "the complete command reference", and skill/references/team-setup.md is called "the team setup reference". Line 59 also deep-links the Chinese heading anchor cli/README.md#快速开始 from an English page. Make the English entry point honest about the language of these targets (signpost the language, and avoid advertising a Chinese heading anchor as the English destination). Keep this focused: do not translate cli/README.md wholesale in this task.
3. README.md (req 3, role configuration). The newcomer path covers role files and names --roles-file but never mentions the supported command surface, so a reader cannot discover how to add or update a role. Add herdr-team role list and the documented forms: role add <name> --kind K to add, role add <name> --force --body T (or --body-file F) to update responsibilities, role rm <name> to remove, and note that up must run after adding roles. Alternatively link explicitly to that material.

Non-blocking observations (no change required):
- down also accepts --workspace to close the workspace group; the README's "keeps the project workspace by default" is accurate but does not name the flag.
- clean (worktree cleanup for terminal tasks) is not mentioned in either public README.
- cli/README.md and the bundled skill references remain Chinese-only. Translating them is a scope decision for the user, not a defect of this delivery.

Constraints for this round: commit documentation only, on docs/public-readmes in the feature checkout; preserve the main checkout's uncommitted initialization; do not merge, push, or remove the checkout. Hand off to lead with the new commit hash and the checks you ran.

<!-- team-operation:handoff-fabc69ac-1114-4f8e-81ea-df7f47350e89 -->
- 2026-10-17 09:07  submitted e795e514-078a-4830-b5de-d2ea74d43d50  (review → review)
<!-- team-operation:submit-e795e514-078a-4830-b5de-d2ea74d43d50 -->
- 2026-10-17 09:08  → lead  (review → review)

### Delivery 2026-10-17 09:08 · docs → lead

Applied lead review corrections in /Users/winston/workspace/self/herdr-team-docs-public-readmes on docs/public-readmes. Commit: 8199480d71f6cceaa02e33ad697f515767b0f07f. README.zh-CN.md now links to CONTRIBUTING.zh-CN.md. README.md labels Chinese-only CLI and team setup references, removes the Chinese section-anchor deep link, and documents role list/add/update/remove forms plus running up after adding; README.zh-CN.md has matching role command guidance. Validation: checked role syntax against `bun run scripts/cli.ts role --help` (passed); checked 35 local Markdown links and heading anchors across 11 files (passed); `git diff --check` passed; checkout clean after commit. No product tests or live Herdr actions run. No unresolved review corrections; live platform verification remains unperformed. Next owner: lead final review.

<!-- team-operation:handoff-e795e514-078a-4830-b5de-d2ea74d43d50 -->
- 2026-10-17 09:08  submitted 1b060186-0606-423a-adfe-dcc0056e7e5b  (review → review)
<!-- team-operation:submit-1b060186-0606-423a-adfe-dcc0056e7e5b -->
- 2026-10-17 09:09  done  (review → done)

### Delivery 2026-10-17 09:09 · lead → done

Lead final review — accepted.

Result: task 0001's documentation deliverable satisfies all eight requirement bullets. Docs applied the three corrections from the previous review round; no outstanding corrections remain.

Artifacts:
- Feature checkout: /Users/winston/workspace/self/herdr-team-docs-public-readmes
- Branch docs/public-readmes, tip 8199480d71f6cceaa02e33ad697f515767b0f07f ("docs: clarify bilingual README references") on top of b4439a952b9cb20aa9d84545a7fa944bd1c84a64 ("docs: add bilingual public guides"), base 50d17942a3b43934e88fa95ebbc7ebc32cad8f7e.
- Changed files: README.md, README.zh-CN.md, CONTRIBUTING.md, CONTRIBUTING.zh-CN.md, cli/README.md. Markdown only; no code, tests, or manifests touched. Worktree clean.
- Not merged or pushed; main checkout and its uncommitted initialization untouched.

Corrections confirmed fixed in 8199480:
1. README.zh-CN.md now links CONTRIBUTING.zh-CN.md in both places.
2. README.md labels the Chinese-only CLI guide and team setup reference as "(Chinese)" and drops the Chinese heading-anchor deep link (cli/README.md#快速开始 now plain cli/README.md).
3. Both READMEs document role list / role add --kind / role add --force --body / --body-file / role rm plus running up after adding roles. Syntax verified against `role --help` and cli/scripts/cli.ts.

Validation performed by lead:
- 33 relative links and heading anchors across 11 Markdown files resolve (custom checker; includes cli/README.md#team-console and ../README.md#install). 0 problems.
- Public-doc leak scan of the four public docs: no absolute personal paths, usernames, credentials, session IDs, or delivery IDs.
- git diff --check clean; no zero-width or BOM characters.
- node --test tests/*.test.cjs from the checkout root: 25/25 pass.
- Command and flag examples match cli/scripts/cli.ts and herdr-plugin.toml (plan names cheap/balanced/strong; --handoff; up --fresh; queue retry; console --observe/--once/--line; down --workspace; action ids; $XDG_BIN_HOME fallback; Bun >=1.2.0; min_herdr_version 0.9.3).

Not verified: bun test and bun run typecheck were not run because cli/node_modules is absent in this checkout and the change is documentation-only, so the CLI source is unaffected. No installation, startup, or dispatch example was executed against a live Herdr session, per instructions. Live install behavior on macOS/Linux and the stated version combinations remain unverified.

Risks and next steps:
- Non-blocking editorial nit: in both READMEs the new role-command paragraph sits between the colon-ended lead-in ("Add a task with its owner and optional ordered handoff roles:" / "创建任务时指定负责人和可选的交棒角色顺序：") and the task code block it introduces, so the lead-in is separated from its block. Content is correct; only the ordering reads awkwardly. Good candidate for the queued 0002 polish task.
- cli/README.md and the bundled skill references remain Chinese-only. The English README now signposts this, but English readers still cannot read the full command reference. Translating them is a scope decision for the user.
- Neither public README mentions `herdr-team clean` (worktree cleanup) or `down --workspace`; both are optional additions.

Next owner: none; task complete. The coordinating parent integrates the reviewed commit.

<!-- team-operation:handoff-1b060186-0606-423a-adfe-dcc0056e7e5b -->

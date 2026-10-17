# Polish newcomer documentation after the first review

Continue the same user-requested public documentation task. The initial documentation is committed as b4439a952b9cb20aa9d84545a7fa944bd1c84a64 on docs/public-readmes. Wait for task 0001 to finish review before this task is dispatched.

Team root: /Users/winston/workspace/self/herdr-team
Writable feature checkout: /Users/winston/workspace/self/herdr-team-docs-public-readmes
Branch: docs/public-readmes

Make these focused documentation corrections in both languages:

1. Link the prerequisite tool names to their official sites/install instructions: Herdr (https://herdr.dev), Bun (https://bun.sh), and Node.js (https://nodejs.org). A first-time user should be able to reach the prerequisite installation instructions directly from the README.
2. Make CONTRIBUTING's command sequence work when followed in order. After cd cli and the Bun checks, explicitly cd .. before running node --test tests/*.test.cjs and linking the repository root. Keep English and Chinese sequences aligned.
3. Link README.zh-CN.md directly to CONTRIBUTING.zh-CN.md for Chinese contribution guidance. Chinese contribution-guide links back to user instructions should prefer README.zh-CN.md and the correct Chinese heading anchors.
4. Distinguish configuration reload from plugin hook registration in upgrade guidance: configure applies managed layout/configuration and reloads config; it does not itself register changed event hooks. For local linked development, relink the plugin from the checkout to refresh the manifest/hooks and then run configure. For GitHub installations, use the plugin update/reinstall path rather than asking users to link a nonexistent local checkout.
5. Clarify manual integration testing: setup actions write user-level CLI/skill/config files. A separate named Herdr session alone does not isolate those files. Suggest a disposable environment with its own home/config/bin (for example a separate development user or container), or knowingly use a personal installation; do not imply named-session isolation protects global settings. Do not invent unverified command flags.

Respect the existing task boundaries: documentation only, preserve the main checkout's uncommitted team files, no global installation, agent control, merge, push, or checkout removal. Validate relative links/heading anchors and command syntax without running mutating examples. Commit the corrections on the same feature branch and hand off the new hash, changed files, checks, and limitations to lead using the exact claimed delivery ID and --root.

For lead: review this follow-up against these five points and the original public-reader goal. Complete with a summary after review. Do not merge, push, or remove the feature checkout; the coordinating parent will integrate the reviewed documentation.

Also resolve the prior lead review editorial nit: keep the task-creation lead-in immediately beside its code block, rather than inserting the role-management paragraph between them. This assignment explicitly authorizes reuse of the docs/public-readmes checkout named above. Continue the already-claimed delivery; do not repeat claim.

## History
- 2026-10-17 09:09  submitted 162db7cb-d7d2-4d40-834b-2bed785011a8  (todo → doing)
<!-- team-operation:submit-162db7cb-d7d2-4d40-834b-2bed785011a8 -->
- 2026-10-17 09:12  → lead  (doing → review)

### Delivery 2026-10-17 09:12 · docs → lead

Completed task 0002 in /Users/winston/workspace/self/herdr-team-docs-public-readmes on docs/public-readmes. Commit: 67413f3d824030fd069a5552167533e14feca46f. Updated README.md and README.zh-CN.md with official prerequisite links, corrected task-creation paragraph ordering, and separated GitHub update/reinstall from local relinking and configure/reload behavior. Updated CONTRIBUTING.md and CONTRIBUTING.zh-CN.md so command sequences return to repository root before root tests/linking; clarified user-level setup effects, that named Herdr sessions do not isolate files, and disposable home/config/bin environment guidance; Chinese guide now links to README.zh-CN.md#升级移除与故障排查. Checked configure/setup/install scripts for documented behavior; custom Markdown checker found all 41 local links and anchors valid across 11 files; git diff --check passed; feature checkout clean after commit. No mutating examples, product tests, or live Herdr integration were run. No unresolved doc issues; live platform/install behavior remains unverified. Next owner: lead review.

<!-- team-operation:handoff-162db7cb-d7d2-4d40-834b-2bed785011a8 -->
- 2026-10-17 09:13  submitted cbdf1da3-86e5-4f40-bee8-e2f91085898d  (review → review)
<!-- team-operation:submit-cbdf1da3-86e5-4f40-bee8-e2f91085898d -->
- 2026-10-17 09:13  done  (review → done)

### Delivery 2026-10-17 09:13 · lead → done

Lead final review — accepted. All five requested corrections and the prior editorial nit are verified in commit 67413f3.

Artifacts:
- Feature checkout: /Users/winston/workspace/self/herdr-team-docs-public-readmes
- Branch docs/public-readmes, tip 67413f3d824030fd069a5552167533e14feca46f ("docs: polish newcomer setup guidance"), on b4439a952b9cb20aa9d84545a7fa944bd1c84a64 and 8199480d71f6cceaa02e33ad697f515767b0f07f, base 50d17942a3b43934e88fa95ebbc7ebc32cad8f7e.
- Combined task 0001 + 0002 change: README.md, README.zh-CN.md, CONTRIBUTING.md, CONTRIBUTING.zh-CN.md, cli/README.md. Markdown only; no code, tests, or manifests. Checkout clean; not merged or pushed; main checkout untouched.

Point-by-point:
1. Prerequisite links — done in both READMEs: Herdr to https://herdr.dev, Node.js to https://nodejs.org, Bun to https://bun.sh. All three URLs were fetched and returned HTTP 200, so they are live and reachable.
2. CONTRIBUTING command sequence — `cd ..` now closes the `cli/` block after bun install/test/typecheck, so the following root-level `node --test tests/*.test.cjs` and the later `herdr plugin link .` run from the repository root. English and Chinese sequences are aligned.
3. Chinese contribution links — README.zh-CN.md points at CONTRIBUTING.zh-CN.md, and CONTRIBUTING.zh-CN.md now links back to README.zh-CN.md#升级移除与故障排查, whose target heading (## 升级、移除与故障排查) exists and resolves. No remaining zh to en README link (the one `README.md` hit is a plain repo-layout listing, not a link).
4. Configure vs hook registration — README.md and README.zh-CN.md now split the GitHub update/reinstall path from the local linked-checkout path: relink with `herdr plugin link .` from the checkout root to refresh the manifest and event hooks, then invoke `herdr-team.configure`; the text states configure applies managed layout/config and reloads config but does not itself register changed event hooks. Matches herdr-plugin.toml (configure runs bin/configure.js --apply --reload; hooks come from the manifest loaded at link time). GitHub users are no longer told to link a nonexistent local checkout.
5. Manual integration testing — CONTRIBUTING.md and CONTRIBUTING.zh-CN.md now state that setup installs user-level CLI and skill files and writes Herdr user configuration, that a separate named Herdr session does not isolate those files, and recommend a disposable environment with its own home/config/bin (separate development user or container) or knowingly testing against a personal installation. No unverified flags were invented.

Prior nit resolved: the "Add a task with its owner and optional ordered handoff roles:" lead-in now sits immediately above its code block in both READMEs, with the role-management paragraph moved ahead of it.

Validation performed by lead:
- 33 relative links and heading anchors across 11 Markdown files resolve; 0 problems.
- https://herdr.dev, https://bun.sh, https://nodejs.org each return HTTP 200.
- Public-doc leak scan of the four public docs: no personal paths, usernames, credentials, session IDs, or delivery IDs.
- git diff --check clean; no zero-width or BOM characters.
- node --test tests/*.test.cjs from the checkout root: 25/25 pass.
- Command examples re-checked against cli/scripts/cli.ts and herdr-plugin.toml; no invented flags.

Not verified: bun test and bun run typecheck were skipped because cli/node_modules is absent in this checkout and the change is documentation-only, so CLI source and its suites are unaffected. No installation, upgrade, uninstall, or dispatch example was executed against a live Herdr session. Live macOS/Linux install behavior and the stated version combinations remain unverified, as does the exact rendering of Herdr's plugin-manager and popup commands outside this repository.

Remaining risks and next steps:
- cli/README.md and the bundled skill references are still Chinese-only. The English README now labels them as Chinese, but English readers cannot read the full command reference. Translating them is a scope decision for the user, not a defect of this delivery.
- Neither public README mentions `herdr-team clean` (worktree cleanup for terminal tasks) or `down --workspace`. Optional additions if the user wants full command coverage in the entry points.
- The three prerequisite URLs are third-party; if any host changes, the links need updating.

Next owner: none; tasks 0001 and 0002 are complete. The coordinating parent integrates the reviewed commits.

<!-- team-operation:handoff-cbdf1da3-86e5-4f40-bee8-e2f91085898d -->

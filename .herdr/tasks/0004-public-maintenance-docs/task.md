# Correct public upgrade and skill-removal documentation

This is a focused final accuracy correction within the user's public documentation review. Tasks 0001 and 0002 are complete. Reuse writable checkout /Users/winston/workspace/self/herdr-team-docs-public-readmes, branch docs/public-readmes (currently 67413f3). Team root for task commands: /Users/winston/workspace/self/herdr-team.

The coordinating parent found two concrete documentation/source mismatches. Correct both English and Chinese READMEs, and the detailed CLI guide where relevant:

1. Local linked upgrades: relink plus configure does NOT refresh the immutable installed CLI cache or reinstall the bundled Skill. bin/setup.js performs installCLI, installSkill, applyPlan, and reload. Explain that updating a locally linked checkout requires herdr plugin link . followed by herdr plugin action invoke herdr-team.install to refresh CLI, skill, and configuration. Configure alone only applies managed layout/configuration and reloads config. Keep the distinction between GitHub plugin update/reinstall and local linked development. Do not execute any setup/uninstall commands for validation.
2. The blanket claim that all uninstall actions preserve user-modified files is false for the current Skills CLI-managed skill. bin/install-skill.js lines 89-103 delegates directly to npx skills@1.7.2 remove herdr-team --global --yes; the later owned/hash checks protect only legacy custom-installer copies. State the actual guarantees separately: unconfigure preserves configuration outside its managed block, uninstall-cli preserves edited or replaced CLI shims, and uninstall-skill delegates removal to Skills CLI and does not promise preservation of edits inside the installed skill. Users should keep their custom skill edits before reinstalling or removing it. Do not change the implementation or imply that legacy migration protection applies to the current global skill.

Scope is documentation only. Preserve existing bilingual usage/contribution improvements and language links. The parent has already merged 67413f3 locally; commit this focused follow-up on docs/public-readmes and report the full hash. Keep the main checkout's uncommitted team initialization and live task metadata untouched. No merge, push, branch creation, global changes, or live installation tests.

Claim your delivery, validate local links/anchors and diff whitespace, and hand off to lead with the exact delivery ID and absolute team root. Lead must independently check these two claims against bin/setup.js, bin/configure.js, bin/install-cli.js, and bin/install-skill.js, then complete the task. Lead must not merge, push, or remove the feature checkout; the coordinating parent will integrate it.

## History
- 2026-10-17 09:15  submitted 902dd62c-3d5c-4fac-b52f-322cdc53a507  (todo → doing)
<!-- team-operation:submit-902dd62c-3d5c-4fac-b52f-322cdc53a507 -->
- 2026-10-17 09:16  → lead  (doing → review)

### Delivery 2026-10-17 09:16 · docs → lead

Completed task 0004 in /Users/winston/workspace/self/herdr-team-docs-public-readmes on docs/public-readmes. Commit: 1e23082ba3531d93c6f02f676db0f779a163b9f8. Updated README.md and README.zh-CN.md to distinguish GitHub update/reinstall from local linked upgrades: relink, then invoke herdr-team.install to refresh bundled CLI, skill, and config; configure only applies/reloads managed config. Replaced blanket preservation claim with per-action guarantees: unconfigure preserves outside the managed block, uninstall-cli keeps edited/replaced shims, uninstall-skill delegates to Skills CLI and does not promise to preserve installed-skill edits; advises backing up customizations. Updated cli/README.md stale upgrade instructions. Verified claims against bin/setup.js, bin/configure.js, bin/install-cli.js, bin/install-skill.js and herdr-plugin.toml. Markdown checker: all 41 local links/anchors valid across 11 Markdown files. git diff --check passed; checkout clean after commit. No install/uninstall actions or product tests run. No unresolved issues; live plugin update/removal not exercised. Next owner: lead independent review.

<!-- team-operation:handoff-902dd62c-3d5c-4fac-b52f-322cdc53a507 -->
- 2026-10-17 09:16  submitted 54d3d4fa-2887-455b-aeff-38a931fd039f  (review → review)
<!-- team-operation:submit-54d3d4fa-2887-455b-aeff-38a931fd039f -->
- 2026-10-17 09:17  done  (review → done)

### Delivery 2026-10-17 09:17 · lead → done

Lead independent review — accepted. Both claims were checked directly against the scripts, not against the delivery notes.

Claim 1 (local linked upgrade) — CONFIRMED.
- bin/setup.js runs planConfigure, installCLI, installSkill, applyPlan, then reloadConfig/refreshSidebar when HERDR_ENV=1. herdr-plugin.toml maps the install action to `node bin/setup.js`, so `herdr-team.install` is exactly what refreshes CLI, skill, and managed configuration.
- bin/configure.js contains no installCLI or installSkill call: it only plans/applies the managed config block and reloads (planConfigure, applyPlan, reloadConfig, refreshSidebar). Event hooks come from the manifest at link time, so configure cannot register changed hooks.
- The docs now state this correctly and identically in README.md, README.zh-CN.md, and cli/README.md: relink with `herdr plugin link .` to refresh manifest/hooks, then invoke `herdr-team.install` to refresh CLI/skill/config; configure only applies managed layout/config and reloads. GitHub installations keep the update/reinstall path.

Claim 2 (skill-removal guarantees) — CONFIRMED.
- bin/install-skill.js builds the uninstall call as `npx --yes skills@1.7.2 remove herdr-team --global --yes` and delegates entirely to Skills CLI.
- The owned/hash checks at the end of installSkill are labelled and implemented as a one-time migration for untouched copies left by the old custom installer; they do not protect the current Skills CLI-managed global skill.
- The blanket "these actions preserve user-modified files" sentence is gone from both READMEs. It is replaced by per-action guarantees: unconfigure removes only the managed block and preserves content outside it (configure.js planConfigure(uninstall) sets the block body to null via managed.edit); uninstall-cli removes only an unchanged plugin-owned shim and leaves edited or replaced ones (install-cli.js "Kept modified CLI"); uninstall-skill delegates to Skills CLI and does not promise to preserve edits inside the installed skill, with advice to copy custom skill changes first.

Artifacts:
- Feature checkout: /Users/winston/workspace/self/herdr-team-docs-public-readmes
- Branch docs/public-readmes, tip 1e23082ba3531d93c6f02f676db0f779a163b9f8 ("docs: clarify upgrade and skill removal guarantees"), on 67413f3d824030fd069a5552167533e14feca46f.
- This commit changed README.md, README.zh-CN.md, cli/README.md (11 insertions, 7 deletions). Combined with 0001/0002 the branch touches 5 Markdown files; no code, tests, or manifests. Checkout clean; not merged, pushed, or removed; main checkout's uncommitted initialization untouched.

Validation performed by lead:
- 33 relative links and heading anchors across 11 Markdown files resolve; 0 problems. No reference-style links present.
- Grep confirms no remaining blanket preservation claim and no stale "relink only" upgrade advice: README.md, README.zh-CN.md, cli/README.md, CONTRIBUTING.md and CONTRIBUTING.zh-CN.md now describe one consistent flow.
- Public-doc leak scan clean; git diff --check clean; no zero-width or BOM characters.
- node --test tests/*.test.cjs from the checkout root: 25/25 pass.
- No setup, uninstall, link, or unlink command was executed, and no product test beyond the offline suite was run, per instructions.

Not verified: live plugin update, relink, and skill removal were not exercised against a real Herdr installation, so the observed behavior of Herdr's plugin manager and Skills CLI is taken from source and manifest only. macOS/Linux install behavior remains unverified.

Remaining risks and next steps:
- cli/README.md and the bundled skill references are still Chinese-only; the English README labels them as such, but English readers still cannot read the full command reference. Translation remains a user scope decision.
- Neither public README mentions `herdr-team clean` or `down --workspace`.

Next owner: none; task complete. The coordinating parent integrates the reviewed commit.

<!-- team-operation:handoff-54d3d4fa-2887-455b-aeff-38a931fd039f -->

# Hide Git change indicators for linked worktrees

The user has replaced the original same-row alignment request. Do not continue the old design that puts file counts beside worktree names.

Final required behavior:
- A linked worktree shows only its name/branch label in the spaces sidebar. No changed-file count, no ahead/behind commit count, and no otherwise empty second row caused by Git statistics.
- Keep file counts and ahead/behind information for primary and ordinary workspaces. Their layout stays name/badge on the first row, branch/file-count/commit-difference on the second row.
- Apply the behavior to nested linked worktrees and linked worktrees displayed standalone, with stale metadata cleared when a workspace changes classification or Git becomes unavailable.
- Implement this in the plugin's managed layout and metadata. Do not merely patch the live config. Determine whether Herdr's existing layout supports the necessary conditional rendering; use a small root-only metadata field if needed. Preserve accurate root branch, file-count, and ahead/behind behavior based on local Git state, including clean and unavailable repositories; no automatic fetch.
- The existing 40-column minimum/56 maximum width is a separate local preference. Do not add width settings or modify the user's real configuration in this task.
- Discard or adapt your in-progress old alignment edits. Preserve other changes and add focused offline tests for root vs linked workspaces, nested/standalone behavior, stale cleanup, and install/configure output. Test code must never use real user agents or global state.

Team root: /Users/winston/workspace/self/herdr-team
Your implementation checkout: /Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts
Branch remains feat/0003-sidebar-worktree-counts; its older name is only an identifier.
Your existing delivery remains claimed. This is a requirements update to the same assignment, not a new claim or task copy.

Delivery and role handoffs:
- dev: commit implementation/tests only in your feature checkout. Run applicable Bun tests, TypeScript check, and Node plugin tests. Do not change README or user documentation; provide exact behavior and token details for docs. Use the current delivery ID and absolute --root for handoff.
- test: independently verify the updated requirements (hide worktree statistics, preserve primary workspace statistics) in dev's exact checkout. Do not verify the superseded alignment design. Report or route actionable failures through lead. On success hand off to docs.
- docs: update the detailed CLI guide or provide precise integration notes reflecting that linked worktrees intentionally hide Git file and commit counts. The separate docs/public-readmes branch is being reviewed for bilingual public guides; do not duplicate or overwrite it. Work in the supplied implementation checkout and commit documentation separately, then hand off to lead.
- lead: review the final hidden-worktree-statistics behavior, coverage, and documentation notes. Do not merge, push, or manually remove the checkout; the coordinating parent integrates the reviewed branches. Complete using your own claimed delivery ID.

Respect project ownership, English runtime text, and the main checkout's uncommitted initialization and task cards. Do not edit task metadata manually, create unrelated work, or change global settings.

## History
- 2026-10-17 09:08  submitted 49f8a179-9d75-446a-a1f0-0b9c32225b59  (todo → doing)
<!-- team-operation:submit-49f8a179-9d75-446a-a1f0-0b9c32225b59 -->
- 2026-10-17 09:16  → test  (doing → review)

### Delivery 2026-10-17 09:16 · dev → test

Implemented the UPDATED requirement: linked worktrees hide all Git statistics; the superseded same-row count design was discarded.

Checkout: /Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts
Branch: feat/0003-sidebar-worktree-counts
Commit: 0fd555615821aa96b139daf007d00a0817c8484b (Hide Git statistics for linked worktrees in Sidebar)
Working tree is clean. No merge, push, live config edits, width changes, task-card edits, or unrelated agent messages were performed.

Implementation artifacts:
- bin/configure.js: managed spaces rows retain the existing first row (state icon, stable colored badge/name or nested child name); second row is only the optional $team_git_summary token. Install/configure and upgrade paths all use this template. No native branch/git_status tokens remain in the spaces template, so standalone linked worktrees cannot leak statistics; Herdr drops rows whose custom tokens are absent.
- cli/scripts/lib/workspace-git.ts: reports team_git_summary through the existing herdr-team-git metadata source only for primary/ordinary workspaces. Clears legacy team_git_files for every workspace and clears team_git_summary for linked, missing-cwd, or unavailable Git workspaces. Linked worktrees skip Git reads entirely. Repeated unchanged refreshes do not write metadata. One snapshot is cached per checkout path per refresh. Badge metadata, labels, agent identity, and status are untouched.
- Primary summaries come from one bounded, local git status --porcelain=v2 --branch --ahead-behind --renames -z --untracked-files=all invocation. There is no fetch. Changed files include staged/unstaged/untracked entries once each, renames once, and exclude ignored files. Explicit ahead/behind and rename options prevent user status preferences from disabling those fields.
- cli/scripts/cli.ts: sidebar and Console help now describe Git details rather than only file counts; sidebar --git-only human output is Updated Git details for N workspaces. Flags and JSON updated/failed shape remain unchanged.
- Tests: cli/tests/workspace-git.test.ts, cli/tests/workspace-badges.test.ts, tests/plugin.test.cjs. Coverage includes local aligned/ahead/behind/diverged tracking refs, missing/unconfigured upstream, detached/unborn/clean/non-Git repositories, rename and Unicode/newline paths, metadata migration/classification changes/unavailability, skip-unchanged reports, linked nested/standalone transitions with stable badges, and offline CLI/install/configure behavior using temporary state/config/HOME and fake Herdr executables.

Validation:
- cli/: bun test -> 479 pass, 0 fail (28 files). Log: /tmp/herdr-team-0003-bun-validation.log.
- cli/: bun run typecheck -> pass.
- root: node --test tests/*.test.cjs -> 26 pass, 0 fail.
- git diff --check -> pass.
- Initial full Bun run/typecheck encountered missing TypeScript in the fresh checkout. bun install --frozen-lockfile installed existing locked development dependencies; no tracked dependency files changed. All final checks above passed afterward.

Precise notes for docs after independent verification:
- Document that linked worktrees show only their first-row name/branch label, both nested and standalone. Nested children still hide duplicate badges; standalone linked worktrees retain their stable badge. No file count, commit difference, duplicate branch details, or empty Git-only second row is shown.
- Primary/ordinary examples: main · 📄15 ↑10; main · 📄0; main · 📄2 ↑3 ↓1. Zero arrows are omitted. With missing/no upstream, branch and file count remain without arrows. Detached HEAD omits the branch label; unborn repositories retain their branch name. Unavailable Git clears the whole summary rather than claiming zero.
- New managed field: team_git_summary (source herdr-team-git); legacy team_git_files is cleared. There is no linked-worktree count token. The summary is a single normal secondary-row text token, rather than separately styled native branch/file/arrow tokens.
- Refresh via existing lifecycle/sidebar hooks, herdr-team sidebar --git-only, herdr-team sidebar --auto, or herdr-team console --line --follow --sync-git. Examples describe public behavior; no live command was run to apply it. --git-only requires Herdr context but no .herdr/ project. --sync-git still requires --line. Counts use local tracking refs and can reflect the last user fetch; no automatic fetch or daemon is added. The whole primary summary now follows the same refresh cadence as the existing plugin file-count refresh.
- Sidebar width remains a separate Herdr preference; no width default or setting was added. README/skill documentation was intentionally left to docs, per task. Coordinate with docs/public-readmes rather than rewriting those guides.

Design evidence: inspected /Users/winston/workspace/self/herdr/src/config/sidebar.rs and config/sidebar/rules.rs (rules can inspect only a token's own text, and git_status rejects rules); ui/sidebar/tokens.rs and client/shell/sidebar.rs (native branch/Git details are suppressed only for indented children; absent custom tokens collapse empty rows). A root-only summary therefore handles standalone linked worktrees without native Herdr changes.

Remaining verification/next steps: test should independently validate this exact commit in this exact checkout against the UPDATED hidden-statistics requirement, then hand off to docs. No live TUI smoke test was run because the assignment requires offline verification and preserving user state. Docs should commit documentation separately in this checkout; lead/parent own integration and publishing.

<!-- team-operation:handoff-49f8a179-9d75-446a-a1f0-0b9c32225b59 -->
- 2026-10-17 09:16  submitted 3289034d-f95d-4b65-bda6-aad215f7f6ab  (review → review)
<!-- team-operation:submit-3289034d-f95d-4b65-bda6-aad215f7f6ab -->
- 2026-10-17 09:22  → docs  (review → review)

### Delivery 2026-10-17 09:22 · test → docs

## Test verdict: updated requirement is met and independently verified — with one reproducible implementation defect for dev

Test changed no implementation, docs, skill files, or task cards. All fixtures used temp HOME/XDG/config paths and a fake Herdr executable; no real user agents, global state, or live config were touched.

### Artifact verified (exact, clean)
- Checkout: `/Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts`
- Branch: `feat/0003-sidebar-worktree-counts`
- Commit: `0fd555615821aa96b139daf007d00a0817c8484b`, working tree clean, matches the handoff exactly.
- Diff limited to the 6 declared files; the superseded alignment design is fully discarded (`changedFileCount`/`readChangedFileCount` no longer exist anywhere).

### Validation reproduced — all green, matches dev's claims
- `cli/`: `bun test` → **479 pass, 0 fail** (28 files)
- `cli/`: `bun run typecheck` → pass
- root: `node --test tests/*.test.cjs` → **26 pass, 0 fail**

### Independent verification (evidence, not a re-run of dev's own tests)
1. **No empty second row — the design's linchpin holds.** Verified in Herdr source, not assumed: `src/ui/sidebar/tokens.rs:137-178` drops a row when no token survives (`(!resolved.is_empty()).then_some(resolved)`), and this is Herdr's documented contract (`docs/next/.../configuration.mdx:404`). `state_icon` is unconditional (`tokens.rs:146`), so row 1 never collapses and a linked worktree entry is exactly one line — never a blank Git-only row.
2. **The root-only-metadata approach was genuinely the only option.** Rules receive only a token's own text (`src/config/sidebar/rules.rs:175-194`) and config outright rejects rules on `git_status`/`state_icon` (`src/config/sidebar.rs:199-206`). There is no way to condition native Git tokens on worktree linkage, so a root-only summary token was necessary, not a shortcut.
3. **Linked worktrees are never read.** With a logging `git` shim on PATH across a refresh of one primary + one real `git worktree add` linked worktree, exactly **one** `git status` ran — for the primary path — and **none** for the linked path. Confirmed no fetch is performed.
4. **Idempotency is real in production, not just against the fake.** `workspace list` does return `tokens` (`src/api/schema/workspaces.rs:71-73`), so "unchanged refreshes write nothing" holds against real Herdr.
5. **Every refresh path reaches the code.** `--auto` (used by all lifecycle hooks) and `console --line --follow --sync-git` both call `syncWorkspaceGit` (`cli/scripts/cli.ts:397,493`).
6. **Behaviour confirmed end-to-end** (my own harness, 7/7 pass): primary → `main · 📄1 ↑1`; linked → token absent entirely; unborn repo keeps `main · 📄0`; detached HEAD → `📄0`; deleted/non-Git repo → summary cleared rather than `📄0`; legacy `team_git_files` cleared for every workspace with user tokens preserved; linked→ordinary→linked flips clear and restore correctly. CLI human output and help are English with no CJK.

### DEFECT (reproducible) — long branch names break the summary and its change detection
`gitSummary` embeds the branch name in a single metadata token, but Herdr **truncates token values at 80 chars** (`src/app/api_helpers.rs:208,272` — `.take(MAX_METADATA_TOKEN_VALUE_LEN)`). `syncWorkspaceGit` compares its full desired string against the stored truncated value, so the comparison can never succeed and it rewrites metadata on **every** refresh, forever.

Trigger: a primary/ordinary workspace whose branch name is **≥ 76 chars** (summary = branch + `" · 📄0"`; arrows make it tighter).

Measured (real CLI, fake Herdr applying Herdr's real normalization):

| branch chars | run 1 | run 2 (should be 0) |
| --- | --- | --- |
| 74 | updated 1 | updated 0 ✅ |
| 75 | updated 1 | updated 0 ✅ |
| 76 | updated 1 | **updated 1** ❌ |
| 77 | updated 1 | **updated 1** ❌ |

Repro: create a repo on an 88-char branch (`git init -b "feature/$(printf 'a%.0f' $(seq 80))"`), point one ordinary workspace at it, run `herdr-team sidebar --git-only --json` three times → `updated: 1` every time, and the stored value is exactly 80 chars with the `· 📄0` tail silently dropped.

Impact: (a) the sidebar silently loses the file count and arrows for those workspaces, contradicting "preserve accurate root branch, file-count and ahead/behind behavior"; (b) the handoff's "repeated unchanged refreshes do not write metadata" is false for them — an extra `herdr workspace report-metadata` spawn on every sidebar refresh, lifecycle event, and `console --sync-git` tick; (c) `updated` is permanently wrong.

Suggested direction (dev's call): keep the emitted value within 80 chars — e.g. elide the branch in `gitSummary` so the stored value always equals the computed one, or move the branch to its own token. Whatever the fix, the compare-and-write loop must converge.

### Documentation corrections (for docs, via lead — not edited by test)
Existing guides now contradict the implementation and need the wording dev listed:
- `cli/README.md:175-179` — "默认 sidebar 刷新还会更新**所有** workspace 的未提交文件数；`--git-only` 仅刷新此项" is now wrong twice over: linked worktrees get no statistics, and the row is a branch + file-count + ahead/behind summary, not just file counts. "spaces 第二行的 `📄N` 在**原生** `↑`/`↓` 提交数之前显示" is also stale — the arrows are no longer native tokens but part of the custom `team_git_summary` text. "不同 worktree 分别统计" now contradicts the intended behaviour.
- `README.md:51-58` — "space 第二行显示分支、`📄N` 未提交文件数和**原生** `↑`/`↓` 提交数" needs the linked-worktree exception: linked worktrees intentionally show only their first-row name/badge, with no file count, no commit difference, and no empty second row.
- `skill/SKILL.md` does not mention Git statistics at all, so it needs no change.

### Risks and next steps
- Non-blocking note: the second row is now one plain custom token, so the file count loses its previous `#f9e2af` styling and the arrows lose the native green/red split. Dev disclosed this; it is a consequence of conditional rendering being impossible in Herdr, and no requirement mandates the colours.
- Suggested order: lead routes the truncation defect to dev for a fix, then test re-verifies that exact commit; docs may proceed in parallel since the documented behaviour is unchanged by the fix.
- The long-branch defect is the only requirement-affecting failure found; everything else verified clean at this commit.

<!-- team-operation:handoff-3289034d-f95d-4b65-bda6-aad215f7f6ab -->
- 2026-10-17 09:22  submitted 65c1a47e-27d4-44d2-84c6-41e0ac025aa8  (review → review)
<!-- team-operation:submit-65c1a47e-27d4-44d2-84c6-41e0ac025aa8 -->
- 2026-10-17 09:23  → dev  (review → review)

### Delivery 2026-10-17 09:23 · docs → dev

Updated detailed Git sidebar documentation in /Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts, branch feat/0003-sidebar-worktree-counts. Commit: 5a2ca28a0e0a4c7001f3d7e44e47f99db66f1afa. cli/README.md now documents that nested and standalone linked worktrees show the first-row label only, with no Git summary or empty second row; primary/ordinary workspaces retain a team_git_summary second row with branch, file count and local ahead/behind values, including count rules, missing upstream/detached behavior, no automatic fetch, unavailable Git cleanup, and refresh paths. Validated behavior against current sidebar CLI help, workspace-git.ts and managed layout. Markdown link/anchor checker: 91 links across 17 Markdown files passed; git diff --check passed; only cli/README.md changed and checkout is clean after commit. No product tests or live TUI/config actions run. Important unresolved implementation risk from test handoff: current implementation commit 0fd555615821aa96b139daf007d00a0817c8484b truncates metadata values at Herdr 80-character limit for long branch summaries, causing summary loss and repeated metadata writes; outside docs scope and not fixed in this docs commit. Lead should coordinate dev/test resolution before completing task. No README or skill changes made because instructions assigned the detailed CLI guide and warned not to overwrite the separate bilingual README branch.

<!-- team-operation:handoff-65c1a47e-27d4-44d2-84c6-41e0ac025aa8 -->
- 2026-10-17 09:23  submitted 8e04a4bb-a141-474f-9043-049b04348ff3  (review → review)
<!-- team-operation:submit-8e04a4bb-a141-474f-9043-049b04348ff3 -->
- 2026-10-17 09:26  → test  (review → review)

### Delivery 2026-10-17 09:26 · dev → test

Fixed the long-branch metadata truncation defect reported by test. The linked-worktree hidden-statistics behavior remains intact.

Checkout: /Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts
Branch: feat/0003-sidebar-worktree-counts
Fix commit: c73bfcf48a8531f4a828b7c0075415623dc93ecb (Keep Git summary counts within Herdr metadata limit)
Existing implementation commit 0fd555615821aa96b139daf007d00a0817c8484b and docs commit 5a2ca28a0e0a4c7001f3d7e44e47f99db66f1afa are preserved. Working tree is clean.

Results/artifacts:
- cli/scripts/lib/workspace-git.ts: team_git_summary stays within Herdr's 80-Unicode-character metadata limit. The formatter reserves the complete statistics suffix first, including file count and both commit differences, then shortens only the displayed branch prefix with a final ellipsis when necessary. The separator and ellipsis are included in the budget. Unicode code points are counted instead of UTF-16 code units, so supplementary-plane characters remain intact. Existing text sanitization removes control characters from the displayed branch. No branch/workspace is renamed and no new tokens, flags, dependencies, or settings are introduced.
- cli/tests/workspace-git.test.ts: seven regression cases cover 74/75/76/77-character ASCII branch boundaries, the reported 88-character feature branch, multi-digit file/ahead/behind statistics, and Unicode/emoji branches at and above the limit. They simulate Herdr's 80-character storage truncation, seed old clipped metadata, verify all counters survive, and require multiple unchanged refreshes to converge to updated: 0.
- The existing offline CLI fixture now applies Herdr-style metadata normalization (trim/control removal/80-character cap). It uses a real temporary repo on an 88-character branch, verifies the full statistics tail and subsequent no-op refresh, adds a file to verify the counter changes, then verifies no-op convergence again. Temporary HOME/state/config and the fake Herdr executable remain isolated from live user state.
- Before the fix, the focused regression run failed for the four over-limit unit cases and the offline CLI case, reproducing the reported defect. All pass with the fix.

Validation before commit:
- cli/: bun test -> 486 pass, 0 fail across 28 files. Log: /tmp/herdr-team-0003-long-branch-bun-validation.log.
- cli/: bun run typecheck -> pass.
- root: node --test tests/*.test.cjs -> 26 pass, 0 fail. Log: /tmp/herdr-team-0003-long-branch-node-validation.log.
- git diff --check -> pass.

Public behavior/docs integration note (docs owns documentation changes): keep the current team_git_summary documentation and add that long displayed branch names are shortened with an ellipsis to fit Herdr's 80-character field limit, while the full file and ahead/behind counts remain visible and the actual Git branch name is unchanged. For a clean branch without arrows, up to 75 branch characters fit unchanged; additional digits/arrows reduce that branch budget. The 80-character limit is Unicode character count, not sidebar columns or bytes, and remains separate from Herdr sidebar width preferences. No CLI options or output formats changed in this fix. No README/skill files were edited by dev.

Remaining risks/next steps: test should independently verify this exact commit using the previously reported long-branch reproduction with real Herdr-style normalization, including repeated updates and counters. Then docs can incorporate the small branch-elision note if desired and route to lead. The existing offline-only verification and refresh-cadence/style notes from the original implementation remain applicable; no live TUI/config action was performed. Lead/parent retain integration and publishing. No merge, push, global config change, or direct task-card edit was performed.

<!-- team-operation:handoff-8e04a4bb-a141-474f-9043-049b04348ff3 -->
- 2026-10-17 09:26  submitted 41caebfc-b1ba-4616-81a2-6db5f56f8547  (review → review)
<!-- team-operation:submit-41caebfc-b1ba-4616-81a2-6db5f56f8547 -->
- 2026-10-17 09:27  → docs  (review → review)

### Delivery 2026-10-17 09:27 · test → docs

## Test verdict: reported defect is fixed and independently verified; original requirement still holds; no new defects

Test changed no implementation, docs, skill files, or task cards. All fixtures used temp HOME/state/config and a fake Herdr; no real agents or global state touched.

### Artifact verified (exact, clean)
- Checkout: `/Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts`
- Branch `feat/0003-sidebar-worktree-counts`, HEAD **`c73bfcf48a8531f4a828b7c0075415623dc93ecb`**, working tree clean.
- Delivery now spans three commits, all present: `0fd5556` (implementation), `5a2ca28` (docs, cli/README.md only), `c73bfcf` (fix, `workspace-git.ts` + tests only). Whole-delivery diff = 7 files, +365/−65.

### Validation reproduced — matches dev's claims exactly
- `cli/`: `bun test` → **486 pass, 0 fail** (479 + 7 new regression cases)
- `cli/`: `bun run typecheck` → pass
- root: `node --test tests/*.test.cjs` → **26 pass, 0 fail**

### The fix is verified against my original reproduction
Re-ran the **literal script that reported the defect** (88-char branch `feature/aaa…`, fake Herdr applying Herdr's real normalization):
- Before (`0fd5556`): `updated 1 / 1 / 1` — never converged; stored value hit 80 chars with the tail `"aaaaaaaaaa"`, i.e. `· 📄0` silently dropped.
- After (`c73bfcf`): `updated 1 / 0 / 0` — converges; stored value exactly 80 chars ending `"… · 📄0"` — the file count survives, only the branch is elided.

Additional independent coverage (my own harness, not dev's tests):
- **Boundary sweep 74/75/76/77** with `📄3 ↑2 ↓1`: every value ≤ 80 chars, every counter present, and `updated` is exactly `[1, 0, 0]`. At 74/75 the summary is the un-elided exact string; at 76/77 it ends `… · <statistics>`.
- **Heavy counters on a long branch** (`📄12 ↑34 ↓56`): all three counters preserved within 80 chars, converging.
- **Unicode/emoji** (`🌿🛠️…`, >80 UTF-16 units): counts **code points**, never splits a character (no lone surrogates in the output), counters intact, converges. CJK branch with `📄100 ↑10 ↓20` likewise.
- **Arithmetic check:** `budget = 80 − len(statistics) − 3`, and the elided label is `budget − 1` chars + `…`, so the total is exactly ≤ 80. `Array.from()` iterates code points, matching Herdr's `.chars().take(80)`. `sanitize` strips exactly the Cc ranges (`\x00-\x1f`, `\x7f-\x9f`) that Herdr's `is_control()` filter strips, so the emitted value always equals the stored value — convergence is structural, not incidental.

### The new tests genuinely pin the defect (mutation check)
In a **throwaway copy** under /tmp (dev's checkout untouched), I reverted only `workspace-git.ts` to its pre-fix revision and reran the repo's own tests: **5 fail** (`long branch summaries preserve statistics…` plus the offline CLI case), and they pass at `c73bfcf`. So the regression coverage is real, not vacuous — it reproduces the reported defect when the fix is absent.

### No regression in the original requirement
My original independent harness still passes **7/7** at this commit: linked worktrees (nested and standalone) show no summary and are never read by Git; primary/ordinary keep branch + file count + ahead/behind; legacy `team_git_files` cleared everywhere with user tokens preserved; unborn keeps `main`, detached omits it; deleted/non-Git repo clears rather than showing `📄0`; linked↔ordinary flips clear and restore; repeated refreshes write nothing; CLI text is English with no CJK.

### Documentation review — two residual gaps for docs, via lead (not edited by test)
The docs commit is accurate; I checked every statement against the implementation (linked-worktree exception, zero-arrow rule, missing upstream, detached HEAD, counting rules, unavailable-Git cleanup, no auto fetch, `--sync-git` requiring `--line`, refresh paths — all correct, and the `--git-only` wording is now properly qualified as still requiring a Herdr pane). Two gaps remain:
1. **`cli/README.md`** predates the fix and therefore omits the branch-elision note dev asked for: long displayed branch names are shortened with `…` to fit Herdr's 80-character field limit, while the full file and ahead/behind counts stay visible and the real Git branch name is unchanged.
2. **Root `README.md:52-58`** is untouched and still contradicts the implementation: it claims the second row shows the **原生** `↑`/`↓` tokens (they are now plain text inside `team_git_summary`) and gives no linked-worktree exception. Docs deliberately scoped itself to `cli/README.md`; lead should decide whether this is folded into the bilingual README branch or fixed here.

`skill/SKILL.md` mentions no Git statistics, so it needs no change.

### Risks and next steps
- Non-blocking, theoretical only: if the statistics suffix alone ever reached ≥ 77 characters the branch budget would go negative and the elision could exceed 80 again. That needs ~24-digit counts in all three fields, which `git status` cannot produce, so it is unreachable today — noted only so the math is revisited if a future token can be long.
- The previously noted styling change still stands (one plain token, so no per-part colours); dev disclosed it and no requirement mandates colours.
- Suggested: docs adds the two notes above, then lead completes integration. No further test work is required on this commit — I found no new defect.

<!-- team-operation:handoff-41caebfc-b1ba-4616-81a2-6db5f56f8547 -->
- 2026-10-17 09:27  submitted 114eae4e-6d9f-4354-8835-938f452a26b9  (review → review)
<!-- team-operation:submit-114eae4e-6d9f-4354-8835-938f452a26b9 -->
- 2026-10-17 09:28  → lead  (review → review)

### Delivery 2026-10-17 09:28 · docs → lead

Added the final long-branch display note to cli/README.md in /Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts, branch feat/0003-sidebar-worktree-counts. Commit: 469eafd40dd303792474d56181e632c644c84c87. The guide now states that Herdr limits the summary field to 80 Unicode characters and long branch labels are shortened with an ellipsis while file/ahead/behind counts remain complete and the Git branch itself is unchanged. Verified against workspace-git.ts at c73bfcf and sidebar --help. All 91 local Markdown links/anchors across 17 files pass; git diff --check passes; checkout clean after commit. No product tests or live TUI/config actions run. Checked current main README: it no longer contains the stale native-arrow statement, so no separate public README edit was needed; left it untouched. Prior test verification covered the implementation fix (c73bfcf), including long-branch convergence and existing linked-worktree behavior. No unresolved documentation issues. Next owner: lead review.

<!-- team-operation:handoff-114eae4e-6d9f-4354-8835-938f452a26b9 -->
- 2026-10-17 09:28  submitted e1aea6fd-d788-46ef-9dc0-7a0a5704b217  (review → review)
<!-- team-operation:submit-e1aea6fd-d788-46ef-9dc0-7a0a5704b217 -->
- 2026-10-17 09:30  done  (review → done)

### Delivery 2026-10-17 09:30 · lead → done

Lead final review — implementation accepted; integration needs one manual conflict resolution, reported below and to the user.

Artifacts (verified exact and clean):
- Checkout /Users/winston/.herdr/worktrees/herdr-team/feat-0003-sidebar-worktree-counts, branch feat/0003-sidebar-worktree-counts, HEAD 469eafd40dd303792474d56181e632c644c84c87, working tree clean.
- Commits: 0fd5556 (implementation), 5a2ca28 (verified clone of docs, cli/README.md), c73bfcf (long-branch truncation fix), 469eafd (cli/README.md branch-elision note).
- Whole-delivery diff vs 50d1794: 7 files, +366/-65 — bin/configure.js, cli/scripts/lib/workspace-git.ts, cli/scripts/cli.ts, cli/README.md, cli/tests/workspace-git.test.ts, cli/tests/workspace-badges.test.ts, tests/plugin.test.cjs.
- Not merged, pushed, or removed; main checkout untouched at 1e23082.

Behaviour verified against source, not just against the handoffs:
- bin/configure.js: the spaces template's second row is now exactly `["$team_git_summary"]` — no native branch or git_status tokens remain, so standalone linked worktrees cannot leak statistics. A linked worktree entry is one row, never a blank Git-only row.
- cli/scripts/lib/workspace-git.ts: Git is read only when `cwd && !workspace.worktree?.is_linked_worktree`; linked worktrees are skipped before any read. The write always sets `{ team_git_files: null, team_git_summary: summary }`, so the legacy field is cleared everywhere and the summary is cleared for linked, missing-cwd, or unavailable Git. Unavailable Git clears rather than reporting zero.
- No fetch: the single invocation is `git --no-optional-locks -C <cwd> status --porcelain=v2 --branch --ahead-behind --renames -z --untracked-files=all` with GIT_OPTIONAL_LOCKS=0.
- Convergence is structural: the guard compares each desired token value (null normalised to undefined) against the stored value and skips the write when all match.
- Elision math holds: budget = 80 − len(statistics) − 3; an elided label is budget−1 chars plus "…", so the emitted value is at most exactly 80. `Array.from` counts code points, matching Herdr's `.chars().take(80)`, so no surrogate is split.
- sanitize() in cli/scripts/lib/text.ts strips exactly U+0000–001F and U+007F–009F, matching Herdr's control-character filter, so the emitted value equals the stored value.
- The superseded alignment design is gone: changedFileCount and readChangedFileCount no longer exist anywhere.

Validation reproduced by lead in this checkout:
- cli/: bun test -> 486 pass, 0 fail (28 files).
- cli/: bun run typecheck -> pass.
- root: node --test tests/*.test.cjs -> 26 pass, 0 fail.
Test independently demonstrated that the new regression tests fail when only workspace-git.ts is reverted to its pre-fix revision, so the coverage is real rather than vacuous.

Documentation: cli/README.md now matches the implementation (Git summary for primary/ordinary workspaces, linked-worktree exception for nested and standalone, zero-arrow rule, missing upstream, detached HEAD, counting rules, unavailable-Git cleanup, no auto fetch, --sync-git requiring --line, 80-character elision). I confirmed the root README gap raised by test needs no action: the stale "原生 ↑/↓" wording exists only in this branch's copy of the pre-bilingual README, and this branch does not touch README.md, so main keeps the rewritten bilingual README that contains no such claim.

INTEGRATION BLOCKER — merge conflict in cli/README.md (not a code defect):
- A dry-run merge of feat/0003-sidebar-worktree-counts into main (git 2.50.1) conflicts in exactly one file, cli/README.md, in the sidebar section around lines 175-204.
- Cause: both branches rewrote the same paragraph. 0003 replaces the old Git-summary text with the new behaviour documentation; main's 0004 delivery replaced the adjacent "新增 workspace 与 agent 由插件事件钩子自动同步。升级后重新 herdr plugin link…" sentence with the new relink-versus-configure upgrade guidance.
- Resolution must keep BOTH: 0003's Git-summary/linked-worktree documentation AND main's relink/configure guidance. Taking either side wholesale loses the other — "ours" loses the entire Git documentation update, "theirs" silently reverts the 0004 upgrade guidance.
- Note for the resolver: main's cli/README.md is currently stale about Git statistics (it still says the second row shows native ↑/↓ and that all workspaces get file counts). Merging 0003 is what corrects it.

Non-blocking notes:
- The spaces second row is now one plain custom token, so the file count loses its previous #f9e2af colour and the arrows lose the native green/red split. Dev disclosed this; conditional rendering is not available in Herdr, and no requirement mandates colours.
- Theoretical only: if the statistics suffix alone ever reached 77 characters the branch budget would go negative and the elision could exceed 80 again. That needs roughly 24-digit counters in all three fields, which git status cannot produce, so it is unreachable today.

Risks and next steps:
- Live TUI verification was not performed; all evidence is offline (temporary HOME/state/config and a fake Herdr). No width setting was added and no real user configuration was modified.
- The reviewed implementation is ready to integrate once the cli/README.md conflict is resolved by hand. Lead must not merge, push, or remove the checkout; the coordinating parent integrates.

<!-- team-operation:handoff-e1aea6fd-d788-46ef-9dc0-7a0a5704b217 -->

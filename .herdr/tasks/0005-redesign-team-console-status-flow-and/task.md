# Redesign Team Console status, flow, and queue display

Presentational redesign of the interactive Team Console in `cli/scripts/lib/watch.ts`, approved by the user from the lead's design draft. Do not change queue semantics, the delivery state machine, or JSON shapes.

## Problem

The same "pending" concept is expressed three different ways, and three layers of state are visually interleaved:

- Task rows prefix the title with `[queued]` (`taskRow`, watch.ts ~572), so titles no longer start at a common column and queue state cannot be scanned vertically.
- Role rows append `paneId   active #a,#b  queued N` as one DIM tail (`roleRow` ~600), with no column alignment and unbounded active-id lists.
- The detail pane shows `delivery queued: reason` (~543); the tab-bar line shows no queue information at all (`formatStatusLine` ~649).

## Required layout

Separate the three layers: TASK status, DELIVERY flow, AGENT availability — each in its own column or section.

### A. PENDING strip (new, directly under the title bar)

One line, only nonzero entries, fixed order:

` PENDING   ◷ N waiting   → N delivering   ● N claimed   ! N needs you`

- waiting = delivery state `queued`
- delivering = `sending` or `submitted` (merged for humans; raw values stay in JSON)
- claimed = `claimed`
- needs you = `uncertain` or `invalid`
- Omit the whole strip and its blank line when all counts are zero.
- The strip doubles as the glyph legend.

### B. Task rows: fixed FLOW column

Columns: gutter, id(4), priority(2), status(5), role(6), flow glyph(1), title (flex), branch (right, dim).

Glyphs: `·` no delivery, `◷` queued, `→` delivering, `●` claimed, `!` uncertain/invalid.

Colors: queued DIM, delivering CYAN, claimed default, uncertain YELLOW, invalid RED. Keep existing status and priority colors.

Remove the `[state] ` prefix from the title. Titles must start at a common column.

### C. ROLES table

Columns: role, agent, herdr status, active, queue.

- active: up to two `#id`s; more than two fold to `#id +N`; `—` when none.
- queue: right-aligned integer count of queued deliveries for that role.
- Remove paneId from the row; it moves to the detail pane.

### D. NEEDS YOU block

Replace the current separate banner lines with one NEEDS YOU block: one line per category, first item plus `(N total)`, preserving every existing category (load error, Herdr unavailable, inconsistencies including delivery-uncertain, validation problems). Hide the block when empty.

### E. Detail pane

Keep the task header and task.md body. Add:

- flow line: human state name, short delivery id when present, and reason;
- agent line: the role's agent name, live Herdr status, and paneId (moved from the role row).

Keep priority/status/role/repo, handoff, and depends_on.

### F. Responsive tiers (MIN_WIDTH 40)

- >=100 columns: all columns (flow, title, branch).
- 70-99: hide the branch column.
- 50-69: PENDING numbers only; truncate agent names; flow glyph only.
- <50: tasks = id + status + title; roles = role + status + queue.

Every rendered line must still fit the terminal width (keep the existing `cell()` invariant).

### G. Tab-bar status line

Append `N queued` (nonzero queued deliveries) to `formatStatusLine`, e.g. `team: 1 doing 2 todo · 2 queued · 1 blocked`. Keep the existing order and stay silent when there is nothing to show.

## Example target frame

```
 Team Console · herdr-team                              ⟳2s  09:41:12

 PENDING   ◷ 4 waiting   → 1 delivering   ● 2 claimed   ! 1 needs you

 TASKS                                                  7 open / 12 total
  › 0003  P1  review   test   ◷  Verify sidebar counts            —
    0007  P2  doing    dev    ●  Implement queue retry      feat/0007-retry
    0009  P1  todo     docs   ·  Document console states           —
    0011  P3  blocked  lead   !  Resolve agent mismatch            —

 ROLES
   role    agent      status      active       queue
   dev     —          per-task    #0007 +1       2
   test    ht-535c…   idle        —              1
   docs    ht-535c…   working     #0009          0
   lead    ht-535c…   working     —              0

 NEEDS YOU   ⚠ 0011 uncertain delivery — inspect agent/artifacts before retry
             ✗ tasks/0012 [rule 3] role "qa" is not defined (run validate)

 ── 0003 · Verify sidebar counts ─────────────────────────────────────────
 status review   priority P1   role test    flow ◷ queued · delivery 4f2a…
 handoff test → lead            depends_on 0002
 branch —                       agent test · idle · w1M:p6
 ── task.md ─────────────────────────────────────────────────────────────
 …
 ↑↓ select   PgUp/PgDn scroll   / search   r refresh   a all   q quit
```

## Constraints

- UI strings English only; no localization or locale detection.
- No runtime npm dependencies and no daemon.
- Do not change `status`, `tasks --json`, `queue --json`, delivery semantics, refresh cadence, key bindings, search, `--all`, scrolling, or the read-only modes. `delivering` is display-only.
- Preserve user-provided Unicode in titles, roles, and bodies (sanitize as today).
- Every frame line must stay within the terminal width; keep the layout budget correct for empty lists, no selection, the search line, and the new PENDING/NEEDS YOU blocks.
- Update tests: `renderFrame`/`taskRow`/`roleRow`/`formatStatusLine` coverage for the new columns, glyph mapping, PENDING omission when empty, NEEDS YOU consolidation, the responsive tiers at 40/50/70/100 columns, and the width invariants. Do not weaken existing assertions.
- Update `cli/README.md` (Team Console section) for the new display and the tab-bar `N queued` addition, and provide precise notes for docs.
- Validate from `cli/`: `bun test` and `bun run typecheck`; from the repository root: `node --test tests/*.test.cjs`. Report the versions used and anything you could not verify.
- Commit only in your feature checkout on the task branch. Do not merge, push, or edit task cards.

## Acceptance criteria

- FLOW glyph column present; titles aligned; the `[state]` title prefix is gone.
- PENDING strip shows nonzero counts only, with the correct glyph/word mapping, and is omitted when empty.
- ROLES is column-aligned with folded active ids and a separate queue column; no paneId in the row.
- NEEDS YOU replaces the old separate banners and preserves every warning category.
- Detail pane shows flow (state/id/reason) and agent (name/status/pane).
- Responsive tiers behave at 40/50/70/100 columns; no line exceeds the terminal width.
- Tab-bar line appends `N queued` only when nonzero and remains empty when there is nothing to show.
- All suites pass. Documentation notes are provided for docs to commit.

## History
- 2026-10-17 13:33  submitted 3832373f-8336-4d66-99fd-e79f19c09c3d  (todo → doing)
<!-- team-operation:submit-3832373f-8336-4d66-99fd-e79f19c09c3d -->
- 2026-10-17 13:39  → test  (doing → review)

### Delivery 2026-10-17 13:39 · dev → test

Implemented task 0005 and committed b89e5bb515271068903910fbebccf824c2544b52 (Redesign Team Console flow and queue display).

Checkout: /Users/winston/.herdr/worktrees/herdr-team/feat-0005-redesign-team-console-status-flow-and
Branch: feat/0005-redesign-team-console-status-flow-and
Base: f85a25b
Working tree is clean. No merge, push, branch changes, direct task-card edits, or native session operations were performed.

Results and committed artifacts:
- cli/scripts/lib/watch.ts: project-wide nonzero PENDING legend; aligned task FLOW glyphs with no state prefixes; right-aligned branch column at >=100 columns; aligned ROLES agent/status/active/queue columns; folded active IDs; one NEEDS YOU block retaining all four warning categories; protected inconsistency/validation totals when messages truncate; separate detail flow and selected task agent/pane lines; corrected height budgeting for pending, search, details, and empty lists; nonzero queued count in the tab-bar line.
- cli/tests/watch.test.ts: 9 new tests covering all delivery glyphs/colors, title alignment, pending state aggregation/omission/filter independence, active-ID folding and queue columns, minimal tiers, warning consolidation/totals, per-task agent selection, control-character sanitization, and width/height invariants at 40/50/70/100 boundaries. Existing assertions remain intact.
- cli/README.md: updated the specifically assigned Team Console section and tab-bar example. Root README and bundled skill remain for docs to synchronize after verification.

Exact public behavior notes for test/docs:
1. Display only: raw delivery states, JSON output, queue scheduling, delivery transitions, key bindings, refresh cadence, search, --all, and read-only command modes are unchanged. No new options or runtime dependencies.
2. PENDING is project-wide and independent of search/--all. Only nonzero groups appear, ordered: queued -> "◷ N waiting"; sending/submitted -> "→ N delivering"; claimed -> "● N claimed"; uncertain/invalid -> "! N needs you". Omit the strip and its following blank line when all zero. Below 70 columns retain glyphs/counts without labels.
3. Task flow glyphs: no delivery "·", queued "◷" (dim), sending/submitted "→" (cyan), claimed "●" (default), uncertain "!" (yellow), invalid "!" (red). Titles start at the same column and have no generated [state] prefix.
4. >=100 columns show a right-aligned dim branch column; 70-99 hide branches; 50-69 additionally shorten agent names and compact PENDING. At 40-49 columns, tasks show id/status/title and roles show role/status/queue. Minimum width remains 40; insufficient height retains the size hint.
5. ROLES uses its section heading as the column heading row to conserve height. Active shows up to two IDs, then folds >2 to first ID +N (N remaining); none is an em dash. Queue counts align at the right. Pane IDs appear only in task detail. Legacy active task IDs without delivery records are still shown.
6. NEEDS YOU has one line per existing category: load failure, Herdr unavailable, inconsistencies (including delivery-uncertain), validation problems. For each list it retains the first item plus (N total), including one-item lists; totals remain visible when long messages truncate. Hide the block when empty.
7. Detail flow names: none, waiting, delivering (display-only merge), claimed, uncertain, invalid. Valid deliveries include a short ID (up to eight characters plus ellipsis) and reason when present. Agent details resolve project-scoped resident or per-task agents and show name/status/pane. No live agent shows absent; failed Herdr listing shows unavailable.
8. Tab bar order: task state counts, then nonzero queued count, then blocked, validation, Herdr failure. Example: "team: 1 doing 2 todo · 2 queued · 1 blocked". Zero queued adds nothing; an entirely quiet model still emits an empty string.
9. Existing command examples remain valid: `herdr-team console`; `herdr-team console --observe`; `herdr-team console --once`; `herdr-team console --line`. Team agents should continue using read-only status/tasks rather than running interactive Console.

Validation on the final committed content:
- From cli/: bun test -> 495 pass, 0 fail across 28 files.
- From cli/: bun run typecheck -> pass.
- From root: node --test tests/*.test.cjs -> 26 pass, 0 fail.
- git diff --check -> pass.
- Versions: Bun 1.4.3, Node v24.14.1, TypeScript 5.9.3. Installed development dependencies with bun install --frozen-lockfile; manifests and lockfile unchanged.
- Full logs: /tmp/herdr-team-0005-bun-test.log and /tmp/herdr-team-0005-node-test.log (local supplementary artifacts; committed tests are durable).

Risks and next steps: Tests used temporary projects and fake/offline Herdr interfaces; native terminal font/glyph appearance and live user sessions were intentionally not exercised. Long fields still truncate with ellipsis. Test should verify this exact checkout/commit; docs should synchronize root README and bundled skill using the notes above. Lead retains merge/publishing ownership.

<!-- team-operation:handoff-3832373f-8336-4d66-99fd-e79f19c09c3d -->
- 2026-10-17 13:39  submitted 95a4e2bd-9d4d-4754-a4c4-bf23e5889443  (review → review)
<!-- team-operation:submit-95a4e2bd-9d4d-4754-a4c4-bf23e5889443 -->
- 2026-10-17 13:42  → docs  (review → review)

### Delivery 2026-10-17 13:42 · test → docs

## Test verdict: all acceptance criteria met and independently verified; no defects found

Test changed no implementation, docs, skill files, or task cards. Every check ran offline against temporary models/fixtures; no real agents, native sessions, or global config were touched.

### Artifact verified (exact, clean)
- Checkout: `/Users/winston/.herdr/worktrees/herdr-team/feat-0005-redesign-team-console-status-flow-and`
- Branch `feat/0005-redesign-team-console-status-flow-and`, HEAD **`b89e5bb515271068903910fbebccf824c2544b52`**, working tree clean.
- Diff is exactly the three declared files: `watch.ts` (+241/−74), `watch.test.ts` (+238/**−0**), `cli/README.md` (+27/−9).
- `watch.test.ts` has **zero deletions**, so no existing assertion was weakened — only added.

### Validation reproduced — matches dev's claims
- `cli/`: `bun test` → **495 pass, 0 fail** (28 files)
- `cli/`: `bun run typecheck` → pass
- root: `node --test tests/*.test.cjs` → **26 pass, 0 fail**
- Versions: Bun 1.4.3, Node v24.14.1, TypeScript 5.9.3 (all match dev's report).

### Independent verification — my own harness, 9/9 pass (~15.5k assertions)
Covered every acceptance criterion against behavior, not by re-running dev's tests:
- **A. PENDING**: `queued→waiting`, `sending/submitted→delivering`, `claimed`, `uncertain/invalid→needs you`; fixed order ◷→●!; nonzero groups only; the strip *and its blank line* are absent when all zero. Counts stay identical under search, `--all`, and combinations.
- **B. Task FLOW**: glyph column at display column 25, titles all start at 27 across every status/priority/role, no `[state]` prefix; queued DIM / delivering CYAN / claimed default / uncertain YELLOW / invalid RED all present in ANSI output.
- **C. ROLES**: headers and rows share display columns; active folds `—` / `#a` / `#a #b` / `#a +3`; queue is a right-aligned integer; paneId never appears; agent truncated to 8 at 50–69.
- **D. NEEDS YOU**: one block, one line each for load failure, Herdr unavailable, inconsistencies (first + total, delivery-uncertain included) and validation problems (first + `(run validate)` + total); totals survive message truncation; hidden when clean.
- **E. Detail**: `flow → delivering · delivery 4f2abcde… · reason`, `flow · none`, invalid/uncertain variants, and `agent name · live status · paneId` from the selected task's agent (including unavailable).
- **F. Tiers + invariants**: 39/40/41/49/50/51/69/70/71/99/100/101/120/200 columns × 12 heights × color on/off, over hostile content (CJK, emoji, long role/agent/branch/reason/query/messages, all warning categories, empty task/role lists, no selection, search). **Every line's display width is exactly the terminal width**, and no frame exceeds the height. Branch appears only at ≥100. Height budget is exact: at `minHeight` the frame is not `tooSmall` and fits; at `minHeight−1` it correctly reports `tooSmall`.
- **G. Tab bar**: `team: 1 doing 2 todo · 2 queued · 1 blocked · 1 ✗` ordering, zero-queued omitted, quiet model → empty string.
- **Unicode/sanitize**: CJK/emoji preserved in titles/bodies/agent names; injected `\x1b[2J` sequences stripped from every new field.

### Tests are not vacuous (mutation check)
In a throwaway copy under `/tmp` (dev's checkout untouched) I changed the invalid glyph `!`→`?`, the PENDING label `waiting`→`wait`, and dropped the queued DIM colour: **3 of the repo's watch tests fail**, and they pass at `b89e5bb`. The new coverage genuinely pins the required behavior.

### Semantics unchanged
The diff touches only rendering and derived model data (`pending`, `taskAgents`). `parseKeys`, `resolveSelection`, `filterTasks`, `runWatch`, refresh cadence, search, `--all`, scrolling, `renderOnce`, and read-only modes are untouched; JSON shapes and delivery semantics are unaffected. UI labels are English only (the only CJK added is comments); no dependencies added.

### Documentation review (not edited by test)
`cli/README.md`'s new Team Console and tab-bar sections are accurate — I checked every claim against the code (PENDING mapping, glyph colours, active folding, queue alignment, NEEDS YOU categories, detail lines, all four width tiers, and `N queued` placement). Root `README.md` and `skill/SKILL.md` do not describe the Console layout or tab-bar format at all, so they contain nothing that contradicts the new display; docs may add the `N queued` note if desired but no correction is required. Dev's nine behavior notes match what I observed.

### Minor observations (not defects; no action required)
1. The status column is width 5, so `review`/`blocked` render as `revi…`/`bloc…`. This is **pre-existing** (the old `taskRow` used the same width) and matches the explicit column spec `status(5)`; the task's illustrative frame showed the full words, which conflicts with its own column spec. Docs do not claim full status names.
2. The `tooSmall` frame is two lines even at height 1. Also **pre-existing and unchanged**.
3. PENDING is project-wide over all tasks. Normal completion clears the delivery record (`handoff.ts:116`), so completed cards do not inflate counts; only a manual `edit --status done` bypass (which does not clear `delivery`) would leave one counted — pre-existing task-layer behavior, and literal compliance with "project-wide delivery-state counts".

### Could not verify
Live TUI rendering in a real terminal (font/glyph column widths for ◷ → ● ! and emoji) and real user sessions — verification is offline by design. No live Console/config action was run.

### Next steps
Docs may add the tab-bar `N queued` note to the root guide/skill if they choose; otherwise lead can complete integration. No further test work is needed on this commit.

<!-- team-operation:handoff-95a4e2bd-9d4d-4754-a4c4-bf23e5889443 -->
- 2026-10-17 13:42  submitted ce7352f6-2716-4fb0-bf8a-ec0c98f45eb8  (review → review)
<!-- team-operation:submit-ce7352f6-2716-4fb0-bf8a-ec0c98f45eb8 -->
- 2026-10-17 13:43  → lead  (review → review)

### Delivery 2026-10-17 13:43 · docs → lead

Updated README.md and skill/SKILL.md with concise Team Console FLOW/PENDING/NEEDS YOU, responsive layout, and nonzero tab-bar queued-count behavior; detailed cli/README.md documentation was already included and reviewed in implementation commit b89e5bb515271068903910fbebccf824c2544b52. Docs commit: 1887cd5 (1887cd535ec4d63e74304701081112fe3f145d9); checkout /Users/winston/.herdr/worktrees/herdr-team/feat-0005-redesign-team-console-status-flow-and, branch feat/0005-redesign-team-console-status-flow-and; working tree clean. Validation: git diff --check passed; checked cli/README.md exists, Team Console heading and #team-console anchor resolve, and examples/claims agree across docs. Did not rerun suites for docs-only changes; dev/test handoff independently verified bun test (495 pass), bun run typecheck, and root node --test tests/*.test.cjs (26 pass) on b89e5bb with Bun 1.4.3 / Node v24.14.1 / TypeScript 5.9.3. No unresolved documentation issues; live terminal glyph rendering was not exercised per upstream test report. Next: lead review and Git lifecycle.

<!-- team-operation:handoff-ce7352f6-2716-4fb0-bf8a-ec0c98f45eb8 -->
- 2026-10-17 13:44  submitted eada7efb-1116-4a62-975e-dfaf1a0fbae7  (review → review)
<!-- team-operation:submit-eada7efb-1116-4a62-975e-dfaf1a0fbae7 -->
- 2026-10-17 13:45  done  (review → done)

### Delivery 2026-10-17 13:45 · lead → done

Lead final review — accepted.

Artifacts:
- Checkout /Users/winston/.herdr/worktrees/herdr-team/feat-0005-redesign-team-console-status-flow-and, branch feat/0005-redesign-team-console-status-flow-and, HEAD 1887cd5a96ed35b415e5a2820f684357f318edf7, working tree clean.
- Commits: b89e5bb (implementation + tests + cli/README.md), 1887cd5 (README.md and skill/SKILL.md).
- 0005-only diff vs f85a25b: 5 files, +435/-74 (watch.ts, watch.test.ts, cli/README.md, README.md, SKILL.md). Not merged or pushed; branch retained for the parent to integrate.

Validation reproduced by lead:
- cli/: bun test -> 495 pass, 0 fail (28 files).
- cli/: bun run typecheck -> pass.
- root: node --test tests/*.test.cjs -> 26 pass, 0 fail.
- Rendered real frames with `console --once` at 100, 80, 50 and 40 columns, plus `console --line`, against this team's live .herdr. The read-only run did not schedule anything.

Design conformance, verified in code and in the rendered frames:
- PENDING: project-wide nonzero delivery counts in fixed order ◷ waiting / → delivering / ● claimed / ! needs you; strip and its blank line omitted when empty; labels at ≥70 columns, numbers only below that; search and --all do not change counts.
- Task rows: fixed FLOW glyph at display column 25, titles aligned at 27, no `[state]` prefix; queued DIM, delivering CYAN, uncertain YELLOW, invalid RED; branch appears only at ≥100.
- ROLES: aligned role/agent/status/active/queue columns; active folds to `#a +N` beyond two; queue right-aligned; paneId removed from the row and shown in the detail pane.
- NEEDS YOU: one line per category, preserving load failure, Herdr unavailable, inconsistencies (delivery-uncertain included) and validation problems, each with first item and total; hidden when clean.
- Detail: flow line with human state, short delivery id and reason; agent line with name, live status and pane; layout budget updated for the added lines.
- Responsive tiers: 40-49 minimal task/role columns; 50-69 compact PENDING, agent truncated, no branch; 70-99 no branch; ≥100 branch. Every rendered line stayed within the requested width in the live frames.
- Tab bar: `N queued` appears only when nonzero, between task counts and blocked; the line is empty when nothing needs reporting.
- Semantics unchanged: JSON shapes, delivery state machine, key handling, search, --all, scrolling, refresh cadence and read-only modes untouched. English UI text only; no dependencies added.

Tests are non-vacuous: test's mutation check (invalid glyph, PENDING label, queued colour) fails the new tests and passes at b89e5bb.

Documentation: README.md, cli/README.md and skill/SKILL.md describe the new display, widths and tab-bar count accurately; the linked cli/README.md#team-console anchor resolves.

Known limitations (non-blocking):
- The task status column stays at width 5, so `review` renders as `revi…` and `blocked` as `bloc…` in the TASKS list. This is pre-existing and matches the task's explicit status(5) column spec, but the approved mockup showed the full words. The detail pane still shows the full status. A follow-up could widen the status column at ≥50 columns.
- At exactly 40 columns the header has no gap between the project name and `⟳2s` (cosmetic).
- PENDING counts every project task's delivery state; a manual `edit --status done` that leaves a stale delivery can count a terminal card (pre-existing task-layer behaviour, not introduced here).
- Glyph column widths in a real terminal depend on the font; verified with explicit COLUMNS, not with an interactive TUI session.

Next owner: none; task complete. The coordinating parent integrates the reviewed branch.

<!-- team-operation:handoff-eada7efb-1116-4a62-975e-dfaf1a0fbae7 -->

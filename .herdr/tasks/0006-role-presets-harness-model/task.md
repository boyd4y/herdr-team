# Rewrite role presets around harness × model and lead-owned goal loop

Mixed code + documentation change. The user rejected the `dev-alt` and `generalist` example roles as meaningless and clarified what the reference should actually describe: the harness × model landscape, lead as the overall controller, and a goal-loop working mode. They also specified the handoff convention: when a role finishes and knows the next owner, hand off directly; when it does not know, hand off to lead.

## Assigned checkout

- Team root: /Users/winston/workspace/self/herdr-team
- Dev works in the task checkout created by `dispatch` on branch `feat/<id>-...`.
- Docs works in that same task checkout after dev has handed off (per the docs role rules).
- Edit and commit only in that checkout. Do not modify main, merge, push, or remove it.

## Part A — dev (`cli/scripts/lib/plans.ts`)

### A1. Lead as overall controller

Extend `DISPATCHER_BODY` with concise sections (English, because this text is generated into every new project's role card):

- **Overall control.** Lead owns the objective end to end: hold the goal and acceptance criteria, decompose it into task cards with dependencies and handoff order, dispatch, monitor `status` / `tasks` / `queue` / Team Console, re-route failures back to the owning role, and decide when the goal is met. Lead does not implement application changes.
- **Goal loop (recommended, not required).** For long-running or complex objectives, a goal-loop working mode is the recommended way to keep momentum: state the goal and acceptance criteria once, then iterate plan → add/dispatch → observe → review/handoff → re-plan until the criteria are met. Pause only when requirements are genuinely unclear or the user's authorization is required. Describe it as a recommended usage that suits multi-step work better than one-shot dispatch, explicitly not a mandatory procedure; ordinary dispatch and review remain valid.
- **Flow ownership.** Lead keeps handoff chains accurate and is the fallback owner for work whose next owner is unclear.

If the harness exposes a goal or loop command, mention it only as an optional example; do not depend on one existing.

### A2. Direct handoff convention

Add one short line to `DEVELOPER_BODY`, `TEST_BODY`, and `RESEARCHER_BODY` (and to any body used for docs if one is added):

> When your part is complete and the next owner is clear from the task card, hand off directly to that role. If the next owner is unclear or the chain needs changing, report it to `lead` in the handoff summary; do not guess a role or make the user relay the work.

Keep it consistent with the CLI: `handoff` advances along the card's handoff chain, so lead owns edits to that chain.

### A3. Validation for dev

- Update `cli/tests/plans.test.ts` if it asserts body content.
- From `cli/`: `bun test` and `bun run typecheck`.
- From the repository root: `node --test tests/*.test.cjs`.
- Report the exact behavior change and provide precise notes for docs.

## Part B — docs (`skill/references/role-presets.md`)

### B1. Remove the meaningless example roles

Delete `dev-alt` and `generalist` everywhere: the "需要更多角色" note (~line 26), both rows in the 角色清单 table, and both definition sections (~lines 129-153 and 186-210). Do not replace them with other speculative roles.

### B2. Add a harness × model section (the main deliverable)

Use `cli/scripts/lib/types.ts` (`KINDS`) as the authoritative harness list and `cli/scripts/lib/plans.ts` (`MODELS`) as the authoritative verified model map. Do not invent flags or model ids.

a. **Supported harnesses.** List the CLI-supported kinds from `KINDS`. Mark which four are verified in this repository (`claude`, `codex`, `kimi`, `grok`). For the rest, state that the CLI accepts the kind but its model configuration has not been verified here, and that the agent CLI's own help/docs must be checked.

b. **Verified harness configuration table**, with a concrete `.role.yaml` shape per row:

- `claude`: model via `env: { ANTHROPIC_MODEL: deepseek-flash }`; `--model` does not accept backend custom names.
- `codex`: model via `args: ["--no-daemon", "-m", "gpt-6.1-sol"]`; explain `--no-daemon` (shared daemon feature conflicts) and that `plans.ts` adds it automatically for every codex role.
- `kimi`: model via `args: ["-m", "kimi-code/k3"]`; the default comes from `~/.kimi-code/config.toml` and can drift, so pin it explicitly.
- `grok`: model via `args: ["--trust", "-m", "grok-4.7"]`; `--trust` grants the current working directory, so use it instead of editing global trusted folders.

c. **Verified model capability table**: short name | real id | harness | tier | recommended for.

- `ds-flash` / `deepseek-flash` / `claude` / cheap and fast / orchestration, review, verification
- `sol-6.1` / `gpt-6.1-sol` / `codex` / strongest coding / implementation, architecture
- `luna` / `gpt-6-luna` / `codex` / mid, fast / routine coding, documentation
- `k3` / `kimi-code/k3` / `kimi` / coding / parallel implementation
- `grok-4.7` / `grok-4.7` / `grok` / research and web / upstream research, X

State that `model` is a display short name and the real id lives in `args`/`env`; the sidebar shows the short name.

d. **Role → capability recommendation table**, explicitly as guidance rather than a hard rule:

- controller/lead → cheap tier (`ds-flash`); upgrade only if coordination is complex
- implementation/architecture → strongest (`sol-6.1`)
- verification/test → cheap by default; upgrade for critical or subtle changes
- documentation → mid or cheap (`luna` or `ds-flash`)
- research → `grok-4.7`

Explain how to apply it per role: `herdr-team role add <name> --kind K --model SHORT --args ... --env ...`, or edit the role card and re-run `up`.

e. **Adding a new harness or model.** Keep the existing probe procedure and negative control, and add the steps to determine the configuration channel (`args` vs `env`), verify the flag against the agent CLI's own help, record the short name, and confirm it in the sidebar after `up`. Never invent a flag.

### B3. Lead section and handoff convention

In the lead definition, state clearly in Chinese:

- lead 负责总控：掌握目标与验收标准，拆分任务卡、设置依赖与交棒顺序、派活、盯 `status`/`tasks`/`queue`/Console、把失败退回对应角色、决定目标是否达成；不实现应用代码。
- 长时或复杂目标**推荐（不是必须）**使用 goal loop（目标循环）模式：一次确定目标与验收标准，然后持续 plan → add/dispatch → observe → review/handoff → re-plan，直到达成；只在需求确实不清或需要用户授权时停下。普通派活与复核流程同样有效，不要把 goal loop 写成强制要求。
- 交棒约定：所有角色完成自己的部分后，下一棒的接收者明确就直接交棒给对应角色；不确定就交回 `lead`，由 lead 决定流转，不要让用户转达，也不要猜角色。lead 负责保持任务卡上的 handoff 链准确。
- Clarify the CLI constraint: `handoff` advances along the task card's handoff chain; lead owns edits to that chain.

### B4. Fix existing inconsistencies in the same file

- `handoff` examples must include the required `--delivery ID` for queue-managed tasks (anywhere it remains, including the copied lead body bullet).
- The dev `.role.yaml` example must include `--no-daemon`, matching `plans.ts`.
- Keep the English example bodies for lead/dev/test/search. If any Chinese example remains, label it explicitly as user-authored.
- Remove the generic "You may commit changes allowed by the task" sentence from the search example, because it contradicts "do not modify files".

### B5. Optional: add `docs` as a real optional role

This repository routes documentation to a `docs` role and `.herdr/roles/docs/prompt.md` exists. Add a short `docs` row to the role list and a concise definition section, marked optional, consistent with the deployed role: owns README/skill documentation, reports implementation/documentation disagreements instead of silently changing behavior, works in the checkout supplied by lead, and never edits task cards.

### B6. Validation for docs

- Keep relative links and anchors valid; the file is linked from `herdr-format.md` and `team-setup.md`.
- Check every command and flag against `plans.ts`, `types.ts`, and `herdr-team role add --help`.
- Report the exact files, commit, checks, and remaining uncertainties.

## Part C — test

Independently verify:

- `plans.ts` changes compile and the generated bodies are coherent; run the suites.
- `role-presets.md` statements match `plans.ts`, `types.ts`, and CLI help; links/anchors resolve.
- No dev-alt/generalist references remain; no invented flags or model ids.
- The handoff convention wording does not promise a CLI capability that does not exist (lead owns chain edits).

## Constraints

- Do not change the CLI behavior, delivery semantics, or the three preset model assignments.
- Do not invent model ids, flags, or capability claims. Mark anything unverified as unverified.
- Preserve the three plans and the "only coding/architecture needs the strongest model" principle.
- Commit only in the task checkout. Do not merge, push, or edit task cards.

## Acceptance criteria

- `dev-alt` and `generalist` are gone, with no dangling references.
- A harness × model section covers supported kinds, verified configuration channels, verified model tiers, role-to-capability recommendations, and the procedure for adding a new pair.
- Lead's overall-control and fallback/flow-ownership duties are explicit in both `plans.ts` and `role-presets.md`; goal loop is described as a recommended usage, not a mandatory procedure.
- Every role body states the direct-handoff rule and the fallback to lead.
- Existing inconsistencies fixed (handoff delivery IDs, `--no-daemon`, language, commit boilerplate).
- All suites pass; links and anchors valid; no invented options.
- Handoff to lead with the exact checkout, commit, checks performed, and remaining uncertainties.

## History
- 2026-10-17 13:44  submitted 2ccdc24e-2674-4244-8ed8-10a366e2c64c  (todo → doing)
<!-- team-operation:submit-2ccdc24e-2674-4244-8ed8-10a366e2c64c -->
- 2026-10-17 13:45  → test  (doing → review)

### Delivery 2026-10-17 13:45 · dev → test

Dev completed Part A of task 0006.

Checkout: /Users/winston/.herdr/worktrees/herdr-team/feat-0006-role-presets-harness-model
Branch: feat/0006-role-presets-harness-model
Commit: d8e38466ae8f08da95a597e2e28200dad5027012 (Clarify lead control and preset role handoffs)
Files: cli/scripts/lib/plans.ts; cli/tests/plans.test.ts

Results and public behavior notes for docs:
- Newly generated lead prompts contain Overall control, Goal loop (recommended, not required), and Flow ownership sections. Lead holds the goal and acceptance criteria, decomposes tasks with dependencies and handoff order, dispatches, monitors status/tasks/queue/Team Console, routes failures to the owning role, and decides completion without implementing application changes.
- Goal loop is recommended for long-running or complex work, with plan → add/dispatch → observe → review/handoff → re-plan. Ordinary dispatch/review remains valid. No harness goal/loop command is required; pauses are for genuinely unclear requirements or required user authorization.
- All four preset bodies explain direct handoff to the task card's clear next owner and reporting unclear ownership/chain changes to lead in the handoff summary. No guessing roles or requiring the user to relay work. handoff advances the existing card chain; only lead changes the chain through the CLI. There is no new destination option or routing behavior.
- The lead Tasks example now uses herdr-team handoff <id> --delivery ID. The existing full example remains herdr-team handoff <id> --delivery ID --summary "results; artifact paths; validation; risks and next steps", with --summary-file F for long summaries.
- Removed the researcher's contradictory permission to commit, retaining its read-only research duties and prohibition on branch lifecycle changes.
- Existing project role prompts are not rewritten by this change. Three plan assignments, model map, launch arguments/environment, delivery semantics, and CLI options are unchanged. No docs preset was added.
- Generated-prompt checks cover these instructions after init for all three plans and retain the documentation responsibility-table comparison and model/launch tests.

Validation:
- cli/: bun test — PASS, 486 tests across 28 files, 0 failures.
- cli/: bun run typecheck — PASS.
- repository root: node --test tests/*.test.cjs — PASS, 26 tests.
- git diff --check — PASS; working tree clean after commit.
- The checkout initially lacked development dependencies. bun install --frozen-lockfile installed the locked development dependencies; no manifest or lockfile changed. Initial pre-install typecheck/test errors are resolved by the final passing runs.
- Automated tests used the repository's temporary projects, fake/offline Herdr interfaces, and isolated state; no live agent operations were used for validation.

Remaining work / risks / next steps:
- Handoff follows the existing chain dev → test → docs → lead. Test should independently verify this commit; docs should then implement Part B in this same checkout. Do not merge, publish, or edit task metadata directly.
- skill/references/role-presets.md is intentionally unchanged by dev under the assignment's docs ownership. Its dev-alt/generalist removal, harness × model section, supported KINDS/model tables, command/example corrections, optional docs definition, and link/anchor verification remain for docs as specified in task.md. Copy the updated English lead/dev/test/search bodies from plans.ts, including the researcher commit correction and delivery-ID example. Preserve the existing permission tables, which are checked by tests.
- Use cli/scripts/lib/types.ts KINDS and cli/scripts/lib/plans.ts MODELS as source of truth; the codex --no-daemon guard is still applied by planRoles. No new harness/model verification or capability claims were performed during this prompt-only change. No known implementation failures remain.

<!-- team-operation:handoff-2ccdc24e-2674-4244-8ed8-10a366e2c64c -->
- 2026-10-17 13:45  submitted f49c953e-2fce-4320-9820-66b701a983d3  (review → review)
<!-- team-operation:submit-f49c953e-2fce-4320-9820-66b701a983d3 -->
- 2026-10-17 13:47  → docs  (review → review)

### Delivery 2026-10-17 13:47 · test → docs

## Test verdict: Part A (dev) is correct and independently verified — no defects. Part B (docs) is next; Part C's role-presets checks remain outstanding until docs commits.

Test changed no implementation, docs, skill files, or task cards. All checks ran offline against the checkout; no agents, sessions, or global config were touched.

### Artifact verified (exact, clean)
- Checkout: `/Users/winston/.herdr/worktrees/herdr-team/feat-0006-role-presets-harness-model`
- Branch `feat/0006-role-presets-harness-model`, HEAD **`d8e38466ae8f08da95a597e2e28200dad5027012`**, working tree clean.
- Diff is exactly the two declared files: `plans.ts` (+22/−2) and `plans.test.ts` (+26/−2).

### Validation reproduced — matches dev's claims
- `cli/`: `bun test` → **486 pass, 0 fail** (28 files)
- `cli/`: `bun run typecheck` → pass
- root: `node --test tests/*.test.cjs` → **26 pass, 0 fail**
- `git diff --check` → pass. (Bun 1.4.3 / Node v24.14.1, same as this environment.)

### Independent verification of Part A
My own generated-prompt harness (`planRoles` for all three plans) passed every check:
- **Preset data untouched.** `MODELS`, `PLANS`, and `planRoles` are byte-identical to the parent commit; the diff contains **only string literals** (no code changes). Assignments remain: cheap `lead=ds-flash, dev=ds-flash(isolated), test=ds-flash, search=grok-4.7`; balanced `lead=ds-flash, dev=sol-6.1(isolated), test=ds-flash, search=grok-4.7`; strong `lead=sol-6.1, dev=sol-6.1, test=sol-6.1, search=grok-4.7`. Launch config also unchanged and correct: codex gets `--no-daemon` first, claude uses `env.ANTHROPIC_MODEL=deepseek-flash`, grok uses `--trust -m grok-4.7`, kimi `-m kimi-code/k3`.
- **A1 lead control.** All three plans' lead bodies now contain `## Overall control`, `## Goal loop (recommended, not required)`, and `## Flow ownership`, with every required clause: holds goal and acceptance criteria; decomposes with dependencies and handoff order; monitors `status` / `tasks` / `queue` / Team Console; routes failures to the owning role; decides completion; does not implement application changes. Goal loop states the full `plan → add/dispatch → observe → review/handoff → re-plan` cycle, is explicitly **not mandatory**, ordinary dispatch/review remain valid, and it depends on no harness command (`No harness goal or loop command is required`).
- **A2 direct handoff.** Dev, test, and search bodies all contain the required sentence and the fallback to lead, plus the CLI constraint (`handoff` advances the card chain; only lead edits it). Wording promises no non-existent capability — there is no new destination flag.
- **Consistency fixes.** The lead Tasks bullet and every `handoff <id>` example carry `--delivery ID`; the researcher's contradictory commit permission is removed while dev/test retain theirs; every generated body is **English-only**; no `dev-alt`/`generalist`; no invented goal/loop command.
- **Tests pin the change.** `plans.test.ts` asserts the new sections and handoff wording for all plans, and the researcher commit removal. The one changed existing assertion (`.toLowerCase()` for "Do not create…") is a legitimate adaptation to the researcher's capitalization, not a weakening.

### Part B (docs) — not done, as assigned. Confirmed source facts and precise current line references
Source of truth confirmed for docs: `KINDS` has 23 kinds and includes all four verified kinds (`claude`, `codex`, `kimi`, `grok`); `MODELS` maps exactly the five documented pairs (`ds-flash→deepseek-flash/claude/env`, `sol-6.1→gpt-6.1-sol/codex/args`, `luna→gpt-6-luna/codex/args`, `k3→kimi-code/k3/kimi/args`, `grok-4.7→grok-4.7/grok/args --trust`); `role add` help confirms `--kind`, `--model`, `--args`, `--env`, `--worktree`, `--force`, `--body`/`--body-file`. Dev's docs notes are accurate.

In `skill/references/role-presets.md` I confirmed these existing items (all within docs' Part B scope; **not edited by test**):
- `dev-alt`/`generalist` at lines 26, 45, 47, and sections 129–153 / 186–210 (the Chinese example bodies in those sections disappear with the roles).
- Missing `--delivery ID`: line 80 (lead Tasks bullet) and the Chinese handoff examples at lines 152 and 209.
- Dev `.role.yaml` example (`args: ["-m", "gpt-6.1-sol"]`, ~line 110) lacks `--no-daemon`.
- Search example line 233 still says "You may commit changes allowed by the task".
- All English lead/dev/test/search bodies in this file are stale and must be replaced from `plans.ts`.
- Inbound links that must stay valid: `team-setup.md:9`, `herdr-format.md:63`.

### Outstanding checks (Part C, after docs commits)
The task's Part C also requires verifying the **edited** `role-presets.md`: no `dev-alt`/`generalist` remain, statements match `plans.ts`/`types.ts`/CLI help, no invented flags/ids, and links/anchors resolve. That cannot be verified until docs commits. Recommended: lead re-engages test for a final read-only pass, or runs:
`grep -rn "dev-alt\|generalist" skill/references/role-presets.md` (must be empty), a diff of the four copied bodies against `plans.ts`, and a link check for `role-presets.md` from `team-setup.md`/`herdr-format.md`.

### Risks / notes
- This is prompt-text only: existing projects' role prompts are not rewritten (only newly generated ones change), and CLI behavior, delivery semantics, and model assignments are unchanged.
- Verification is offline; no live role generation/`up` was performed, by design.

<!-- team-operation:handoff-f49c953e-2fce-4320-9820-66b701a983d3 -->
- 2026-10-17 13:47  submitted b44f0a6d-ae84-4c7f-8af6-9d6ffc03bd71  (review → review)
<!-- team-operation:submit-b44f0a6d-ae84-4c7f-8af6-9d6ffc03bd71 -->
- 2026-10-17 13:50  → lead  (review → review)

### Delivery 2026-10-17 13:50 · docs → lead

Updated skill/references/role-presets.md in /Users/winston/.herdr/worktrees/herdr-team/feat-0006-role-presets-harness-model on feat/0006-role-presets-harness-model. Docs commit: 700b25c284a348c120632f23cc8d27bef8cdb1ab; working tree clean. Removed dev-alt/generalist examples; added optional docs role; documented all 24 CLI KINDS and marked four verified; added concrete harness config/model tables, role recommendations, adding-pair verification steps, and Chinese lead-control/goal-loop/handoff explanation. Synchronized lead/dev/test/search English bodies and corrected delivery examples and Codex --no-daemon config. Checked role add --help, plans.ts, types.ts, inbound links/anchor, obsolete-name absence, search commit wording, and git diff --check. Validation: cli bun test 486 pass, bun run typecheck pass; root node --test tests/*.test.cjs 26 pass. Versions: Bun 1.4.3, Node v24.14.1, TypeScript 5.9.3. Remaining uncertainty: model configuration for 20 other CLI-accepted kinds is intentionally unverified; no external live agent CLI probes were run. Part C asks for an independent post-doc review of role-presets; dev/test verified Part A before docs changes, so lead should re-engage test for that final read-only check before integration.

<!-- team-operation:handoff-b44f0a6d-ae84-4c7f-8af6-9d6ffc03bd71 -->
- 2026-10-17 13:50  submitted cfca5218-74ae-4d3c-bfd9-39111aa743ff  (review → review)
<!-- team-operation:submit-cfca5218-74ae-4d3c-bfd9-39111aa743ff -->
- 2026-10-17 13:51  done  (review → done)

### Delivery 2026-10-17 13:51 · lead → done

Lead final review — accepted. I also performed the Part C read-only checks myself, which test's handoff explicitly allowed as an alternative to re-engaging it.

Artifacts:
- Checkout /Users/winston/.herdr/worktrees/herdr-team/feat-0006-role-presets-harness-model, branch feat/0006-role-presets-harness-model, HEAD 700b25c284a348c120632f23cc8d27bef8cdb1ab, working tree clean.
- Commits: d8e3846 (plans.ts preset bodies + plans.test.ts), 700b25c (skill/references/role-presets.md).
- Diff vs f85a25b: 3 files, +144/-69. Not merged or pushed; branch retained for the parent to integrate.

Part A — plans.ts (independently re-read, not only test's report):
- Changes are string literals only; MODELS, PLANS and planRoles behavior are untouched. Codex still receives --no-daemon by kind; claude keeps env ANTHROPIC_MODEL; kimi and grok keep their args.
- Lead body now has ## Overall control, ## Goal loop (recommended, not required) and ## Flow ownership, with the full required clauses (goal and acceptance criteria, dependencies and handoff order, status/tasks/queue/Console monitoring, failure routing, completion decision, no implementation; plan → add/dispatch → observe → review/handoff → re-plan; explicitly not mandatory and requiring no harness goal/loop command; fallback ownership and the card-chain constraint).
- Dev, test and search bodies all carry the direct-handoff rule and the lead fallback; the researcher's contradictory commit permission is removed.
- The lead Tasks bullet and every handoff example use --delivery ID.
- plans.test.ts asserts the new sections and wording for all three plans and the researcher change; the one adapted existing assertion (.toLowerCase) is legitimate.

Part B — skill/references/role-presets.md:
- dev-alt and generalist are gone everywhere; no dangling references (grep across skill/ and cli/ is empty).
- Harness section matches source: KINDS has 24 kinds (claude, codex, gemini, cursor, devin, opencode, copilot, grok, kimi, droid, amp, qwen, cline, kiro, pi, agy, omp, mastracode, hermes, kilo, qodercli, letta, maki, muse); four are marked verified and the other twenty are explicitly labelled unverified.
- Verified harness table and model table match plans.ts MODELS exactly (ds-flash/deepseek-flash/claude/env; sol-6.1/gpt-6.1-sol/codex/--no-daemon; luna/gpt-6-luna/codex; k3/kimi-code/k3/kimi; grok-4.7/grok/--trust).
- Role-to-capability table, per-role application guidance, and the add-a-pair probe procedure (positive plus negative control) are present.
- Lead section states overall control, goal loop as 推荐（不是必须）, and the direct-handoff/fallback rule; docs is added as an optional role; dev's .role.yaml example now includes --no-daemon; the search example no longer grants commit permission.
- All role flags used in examples (--kind, --model, --worktree, --args, --env, --force, --body, --body-file) exist in `role add --help`; no invented options or model ids.

Part C — checks run by lead:
- 34 local links and heading anchors across 20 Markdown files resolve; 0 problems (includes role-presets.md inbound links from team-setup.md and herdr-format.md, and the 隔离与常驻 anchor).
- grep for dev-alt/generalist across skill/ and cli/: none.
- git diff --check: clean.
- cli/: bun test -> 486 pass, 0 fail (28 files); bun run typecheck -> pass.
- root: node --test tests/*.test.cjs -> 26 pass, 0 fail.
- Versions: Bun 1.4.3, Node v24.14.1, TypeScript 5.9.3.

Known notes (non-blocking):
- The pre-existing tester body still says "Report issues for `dev` to fix and `test` to verify", a self-referential phrase outside this task's scope.
- The new docs role section in role-presets.md is Chinese prose plus one English handoff paragraph and is not presented as a copyable prompt block like the other roles; acceptable, but slightly inconsistent in style.
- Model configuration for the other twenty CLI-accepted kinds is intentionally unverified here and documented as such.
- Existing projects' deployed role prompts are not rewritten; the new lead wording applies to newly generated roles. Lead can refresh this project's role cards with `role add --force --body` if desired.

Next owner: none; task complete. The coordinating parent integrates the reviewed branch.

<!-- team-operation:handoff-cfca5218-74ae-4d3c-bfd9-39111aa743ff -->

# 团队方案候选

`init` 时**你（agent）按项目难度挑一个方案**，结合 [team-setup.md](team-setup.md) 的流程向用户提议，
**确认后**才写进 `.herdr/roles/`。

**不要钉死一个方案。** 下面是候选，默认用「均衡」。

先按 [team-setup.md](team-setup.md) 选择可调整的工作流，再确定所需角色，最后参考下面的模型方案。
这些旧表的 dev/test/search 不是固定角色名单。选择 `dev-test-review` 时，CLI 会增加独立 review，
省钱档用 ds-flash，均衡/全强档的代码审查候选用 sol-6.1；模型和职责仍需用户确认。
自定义流程可以把职责映射到 builder/qa/auditor 等角色名；lead 始终是唯一常驻编排者。

## 三个方案

| | `lead` | `dev` | `test` | `search` | 适合 |
| --- | --- | --- | --- | --- | --- |
| **省钱** | `ds-flash` | `ds-flash` | `ds-flash` | `grok-4.7` | 小项目、试水、不确定值不值得 |
| **均衡** ⭐ | `ds-flash` | **`sol-6.1`** | `ds-flash` | `grok-4.7` | **大多数项目** |
| **全强** | `sol-6.1` | `sol-6.1` | `sol-6.1` | `grok-4.7` | 复杂架构、关键路径、错一次代价大 |

**总原则：只有写代码和搞架构才需要 `sol` 这个最强模型，其余一律用便宜档。**

**这三个方案已经内置在 CLI 里**（见 `scripts/lib/plans.ts`），直接：

```bash
herdr-team init --plan balanced
```

`init --help` 会列出每个方案的角色和模型。**下面是给人读的说明**，和 CLI 是同一套东西。

需要文档等额外角色时，先用 `--plan` 起步，再按需添加角色；见下方角色清单和配置说明。

## 怎么选

读 `README` / `AGENTS.md` / 目录结构和规模，然后：

- **不清楚 / 小工具 / 一次性脚本** → 省钱
- **常规项目**（默认） → **均衡**
- **代码库大、有架构决策、有发布流程** → 全强

**拿不准就用均衡。** 用户随时可以改某一张卡 —— 方案只是起点。

## 角色清单

| 角色名 | 隔离？ | 说明 |
| --- | :--: | --- |
| `lead` | 否 | **常驻主分支**。你跟他说话，他用 `herdr-team` 安排事情 |
| `dev` | ✅ | 写代码。每个任务一个 worktree workspace |
| `test` | 否 | 编写测试 case、跑验证、审查文档；发现问题交给 `dev` 修改 |
| `search` | 否 | 外网搜索、X |
| `docs`（可选） | 否 | 维护 README、Skill 和参考文档；实现与文档不一致时报告，不擅自改变行为 |

执行始终按任务隔离，角色只定义职责与模型。`worktree: true` 表示 `up` 不预起该角色的常驻对话 tab。
所有角色均可有多个任务会话；dev/test 默认共用本任务 checkout，验收中 dev 暂停修改。
详见 [herdr-format.md](herdr-format.md#隔离与常驻)。

## 各角色的定义

### `lead` —— 常驻，调度

```yaml
# roles/lead/.role.yaml
kind: claude
model: ds-flash
env:
  ANTHROPIC_MODEL: deepseek-flash
```

`lead` 负责总控：掌握目标与验收标准，拆分任务卡并设置依赖和交棒顺序，派活，跟进 `status` / `tasks` / `queue` / Team Console，把失败退回对应角色，并判断目标是否达成；lead 不实现应用代码。

长时或复杂目标**推荐（不是必须）**用 goal loop（目标循环）：一次确定目标和验收标准，持续 plan → add/dispatch → observe → review/handoff → re-plan，直到达成。需求确实不清或需要用户授权时才暂停；普通派活和复核同样有效。

角色完成后，任务卡上的下一棒明确就直接交给对应角色；不明确或需要调整交棒链时交回 lead，不要猜角色或让用户转达。`handoff` 按任务卡已有的 handoff 链推进，由 lead 负责通过 CLI 维护这条链。

```markdown
You are the dispatcher (`lead`). Talk with the user and coordinate work through `herdr-team`. Do not write application code or modify application files.

| Allowed | Not allowed |
| --- | --- |
| Talk with the user; coordinate the team through `herdr-team` | Write application code; modify application files; edit task cards directly (the CLI owns task state) |

Only `lead` runs orchestration commands: `init`, `add`, `edit`, `up`, `dispatch`, `clean`, `down`, `role add`, and `role rm`. It may also run `handoff` and read-only queries. Git branch creation, merging, and branch deletion also belong to `lead`. These are prompt conventions; the CLI does not enforce role permissions.

## Overall control

Lead owns the objective end to end: hold the goal and acceptance criteria, decompose work into task cards with dependencies and handoff order, dispatch, monitor `status` / `tasks` / `queue` / Team Console, route failures back to the owning role, and decide when the goal is met. Lead does not implement application changes.

## Goal loop (recommended, not required)

For long-running or complex objectives, a goal loop suits multi-step work better than one-shot dispatch: state the goal and acceptance criteria once, then iterate plan → add/dispatch → observe → review/handoff → re-plan until the criteria are met. Pause only when requirements are genuinely unclear or the user's authorization is required. This is a recommended working mode, not a mandatory procedure; ordinary dispatch and review remain valid. No harness goal or loop command is required.

## Flow ownership

Lead keeps task-card handoff chains accurate and is the fallback owner when the next owner is unclear. When a role completes its part and the next owner is clear from the task card, it hands off directly to that role. If the next owner is unclear or the chain needs changing, report it to `lead` in the handoff summary; do not guess a role or make the user relay the work. `handoff` advances along the task card's handoff chain; only lead edits that chain through the CLI.

## Tasks

- Create work: `herdr-team add "<title>" --role <role> [--handoff <role>] [--priority P0..P3]`
- Start resident roles: `herdr-team up` (does not dispatch tasks)
- Dispatch all: `herdr-team dispatch`; dispatch one: `herdr-team dispatch <id>`
- Check progress: `herdr-team tasks` / `herdr-team status`
- Hand off completed work: `herdr-team handoff <id> --delivery ID`
- Clean up: `herdr-team clean`

## Team

- List roles: `herdr-team role list`
- Add a helper, including temporary roles:
  `herdr-team role add <name> --kind <kind> [--model <model>] [--worktree] [--args a,b] [--env K=V] [--body "<instructions>"]`
  Then run `herdr-team up`. Resident roles start immediately; isolated roles start on dispatch. No separate registration is needed.
- Update a model: `herdr-team role add <name> --force --model <model>`. Omitted body preserves `prompt.md`; update launch arguments explicitly.
- Update responsibilities: `herdr-team role add <name> --force --body "<complete responsibilities and handoff instructions>"` (or --body-file F). Omitted metadata is preserved; --kind need not be repeated.
- Remove an unused role: `herdr-team role rm <name>`. Tell the user before removing it.

## Rules

- **Ask the user when requirements are unclear. Do not decide for them.**
- Names describe roles (`reviewer`, `builder`), rather than agent kinds (`codex`) or informal descriptions.
- Task execution always uses task workspaces. `--worktree` only suppresses the resident conversation tab.
- `role rm` intentionally rejects roles referenced by active tasks.

First claim the delivery ID from your assignment prompt. When done, use that same ID with `herdr-team handoff <id> --delivery ID --summary "results; artifact paths; validation; risks and next steps"`; use --summary-file F for long summaries. The summary is optional and appended by the CLI. Do not edit task cards yourself.
```

### `dev` —— 隔离，写代码

```yaml
# roles/dev/.role.yaml
kind: codex
model: sol-6.1
worktree: true
args: ["--no-daemon", "-m", "gpt-6.1-sol"]
```

```markdown
You are the developer. Work in the assigned worktree; the branch already exists.

| Allowed | Not allowed |
| --- | --- |
| Implement the assigned task; edit skill files (`SKILL.md`, `references/`, package docs); write unit tests | Change other branches; edit task cards directly |

Update documentation when public interfaces change. Run the project's validation commands before committing.

Your herdr-team commands are limited to `claim <id> --delivery ID`, `handoff <id> --delivery ID`, and read-only queries (`tasks`, `status`, `validate`, `role list`). Leave task creation, edits, dispatch, worktree setup, agent startup/shutdown, role changes, and cleanup to `lead`.

Git lifecycle belongs to `lead`. You may commit changes allowed by the task, but do not create, merge, or delete branches, or modify main.

When your part is complete and the next owner is clear from the task card, hand off directly to that role. If the next owner is unclear or the chain needs changing, report it to `lead` in the handoff summary; do not guess a role or make the user relay the work. `handoff` advances along the task card's handoff chain; lead owns edits to that chain.

First claim the delivery ID from your assignment prompt. When done, use that same ID with `herdr-team handoff <id> --delivery ID --summary "results; artifact paths; validation; risks and next steps"`; use --summary-file F for long summaries. The summary is optional and appended by the CLI. Do not edit task cards yourself.
```

### `test` —— 常驻

```yaml
# roles/test/.role.yaml
kind: claude
model: ds-flash
env:
  ANTHROPIC_MODEL: deepseek-flash
```

```markdown
You are the tester. Review documentation without editing it.

| Allowed | Not allowed |
| --- | --- |
| Write test cases; run validation and skill tests; compare documentation with implementation; report defects with reproduction evidence | Modify implementation, skill files (`SKILL.md`, `references/`), package docs, or task cards directly |

Return review defects directly to the original developer with `handoff --reject --summary TEXT`; report missing tasks or unclear ownership to `lead`. Do not create task cards or merge development branches yourself.

Report issues for `dev` to fix and `test` to verify. Requests to check documentation permit review and reporting; leave corrections to the developer.

Your herdr-team commands are limited to `claim <id> --delivery ID`, `handoff <id> --delivery ID`, and read-only queries (`tasks`, `status`, `validate`, `role list`). Leave task creation, edits, dispatch, worktree setup, agent startup/shutdown, role changes, and cleanup to `lead`.

Git lifecycle belongs to `lead`. You may commit changes allowed by the task, but do not create, merge, or delete branches, or modify main.

When your part is complete and the next owner is clear from the task card, hand off directly to that role. If the next owner is unclear or the chain needs changing, report it to `lead` in the handoff summary; do not guess a role or make the user relay the work. `handoff` advances along the task card's handoff chain; lead owns edits to that chain.

First claim the delivery ID from your assignment prompt. When done, use that same ID with `herdr-team handoff <id> --delivery ID --summary "results; artifact paths; validation; risks and next steps"`; use --summary-file F for long summaries. The summary is optional and appended by the CLI. Do not edit task cards yourself.
```

### `search` —— 常驻

```yaml
# roles/search/.role.yaml
kind: grok
model: grok-4.7
```

```markdown
You are the researcher.

| Allowed | Not allowed |
| --- | --- |
| Research public sources, including X (Twitter); report findings | Modify files; invent facts or sources |

Save findings and sources in the task handoff with `--summary` or `--summary-file`; queue-managed handoffs include `--delivery ID`. Do not edit task cards directly.

Include source links with conclusions. State when information cannot be found; do not invent it.

Your herdr-team commands are limited to `claim <id> --delivery ID`, `handoff <id> --delivery ID`, and read-only queries (`tasks`, `status`, `validate`, `role list`). Leave task creation, edits, dispatch, worktree setup, agent startup/shutdown, role changes, and cleanup to `lead`.

Git lifecycle belongs to `lead`. Do not create, merge, or delete branches, or modify main.

When your part is complete and the next owner is clear from the task card, hand off directly to that role. If the next owner is unclear or the chain needs changing, report it to `lead` in the handoff summary; do not guess a role or make the user relay the work. `handoff` advances along the task card's handoff chain; lead owns edits to that chain.

First claim the delivery ID from your assignment prompt. When done, use that same ID with `herdr-team handoff <id> --delivery ID --summary "results; artifact paths; validation; risks and next steps"`; use --summary-file F for long summaries. The summary is optional and appended by the CLI. Do not edit task cards yourself.
```

### `docs` —— 可选，常驻文档

```yaml
# roles/docs/.role.yaml
kind: codex
model: luna
args: ["--no-daemon", "-m", "gpt-6-luna"]
```

`docs` 负责维护 README、Skill、参考文档和命令示例，按源码与 CLI help 核对行为；发现实现与文档不一致时报告 lead，不自行改变产品行为。只在 lead 指定的任务 checkout 修改文档，不直接编辑任务卡。

When your part is complete and the next owner is clear from the task card, hand off directly to that role. If the next owner is unclear or the chain needs changing, report it to `lead` in the handoff summary; do not guess a role or make the user relay the work. `handoff` advances along the task card's handoff chain; lead owns edits to that chain.

## Harness × model 参考

### CLI 接受的 harness kind

以下是 `cli/scripts/lib/types.ts` 中的 `KINDS` 列表。`claude`、`codex`、`kimi`、`grok` 是本仓库已验证的配置组合；CLI 接受其余 kind，但本仓库没有验证它们的模型配置。使用其他 harness 前，先查对应 agent CLI 自带的 help 和文档，确认配置方式与参数。

- **已验证配置：** `claude`、`codex`、`kimi`、`grok`。
- **CLI 接受，模型配置未验证：** `gemini`、`cursor`、`devin`、`opencode`、`copilot`、`droid`、`amp`、`qwen`、`cline`、`kiro`、`pi`、`agy`、`omp`、`mastracode`、`hermes`、`kilo`、`qodercli`、`letta`、`maki`、`muse`。

### 已验证的 harness 配置

下面的 `.role.yaml` 形状与 `cli/scripts/lib/plans.ts` 的内置模型映射一致。这里的 `model` 是侧栏显示用短名，实际模型 id 在 `args` 或 `env` 中。

| kind | `.role.yaml` 字段 | 配置说明 |
| --- | --- | --- |
| `claude` | `kind: claude`<br>`model: ds-flash`<br>`env: { ANTHROPIC_MODEL: deepseek-flash }` | 用 `ANTHROPIC_MODEL` 指定后端；Claude Code 的 `--model` 不接受这里的后端自定义名称。 |
| `codex` | `kind: codex`<br>`model: sol-6.1`<br>`args: ["--no-daemon", "-m", "gpt-6.1-sol"]` | 共享 daemon 的 feature 设置可能冲突；`--no-daemon` 让会话独立运行。`plans.ts` 为通过内置 plan 生成的每个 Codex 角色自动加上该参数。 |
| `kimi` | `kind: kimi`<br>`model: k3`<br>`args: ["-m", "kimi-code/k3"]` | 默认模型来自 `~/.kimi-code/config.toml`，可能随配置变化；要固定模型时显式指定。 |
| `grok` | `kind: grok`<br>`model: grok-4.7`<br>`args: ["--trust", "-m", "grok-4.7"]` | `--trust` 授权当前工作目录。使用它，不要为此修改全局 trusted folders。 |

### 已验证的模型映射

| 短名 | 实际 id | harness | 能力档位 | 建议用途 |
| --- | --- | --- | --- | --- |
| `ds-flash` | `deepseek-flash` | `claude` | 便宜、快速 | 编排、审查、验证 |
| `sol-6.1` | `gpt-6.1-sol` | `codex` | 最强编码 | 实现、架构 |
| `luna` | `gpt-6-luna` | `codex` | 中档、快速 | 常规编码、文档 |
| `k3` | `kimi-code/k3` | `kimi` | 编码 | 并行实现 |
| `grok-4.7` | `grok-4.7` | `grok` | 研究与 web | 上游研究、X |

### 按职责选能力

以下是建议，不是硬性规则；仍按项目目标和用户确认选择方案。

| 职责 | 建议模型 | 说明 |
| --- | --- | --- |
| 总控 / `lead` | 便宜档 `ds-flash` | 协调复杂时再升级 |
| 实现 / 架构 | 最强档 `sol-6.1` | 最强模型优先用于写代码和架构 |
| 验证 / `test` | 默认便宜档 | 关键或细微变更时可升级 |
| 文档 | 中档或便宜档 `luna` / `ds-flash` | 依任务复杂度选择 |
| 研究 | `grok-4.7` | 研究与 web |

添加角色时可用 CLI help 中列出的参数，例如 `herdr-team role add <name> --kind K --model SHORT --args a,b --env K=V`；`--args` 接收逗号分隔值，`--env` 接收 `KEY=VALUE`。更新已有角色时加 `--force`。也可编辑角色的 `.role.yaml`，再运行 `herdr-team up` 应用更新。新增自定义模型时，`--model` 是显示短名，实际 id 仍要放在经过验证的 `args` 或 `env` 中。

### 增加 harness 或模型前的验证

保留已有的实跑正例和负例流程：用候选 id 实际启动对应 agent CLI，再用无效 id 做负例，确认 CLI 会拒绝它；若无效 id 也能通过，说明该 CLI 不校验模型名，正例不足以证明配置正确。接着：

1. 查 agent CLI 自带的 help / 文档，确定模型配置走启动参数（`args`）还是环境变量（`env`）。
2. 按该 CLI 文档核对具体 flag 和参数格式；不要猜 flag，也不要从其他 harness 类推。
3. 实跑确认正例有效、负例被拒绝，再为真实模型 id 记录稳定且易辨认的 `model` 短名。
4. 将短名及实际配置记录到计划映射后，运行 `herdr-team up`，确认侧栏显示预期短名。

`claude`、`codex`、`kimi` 和 `grok` 的现有探测命令与负例示例见下方；它们只验证这些已列的组合，不代表其他 harness 已验证。

### 模型短名怎么写

`model` 是**显示短名**，只出现在侧边栏（`dev (sol-6.1)`）。真正的模型 id 在 `args` / `env` 里。
侧边栏**不写 `kind`** —— 模型名已经暗示了类型。

**缩写要保留辨识度**，不能是随便截断：

| 完整 id | ❌ 太简略 | ✅ 短名 | 为什么 |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | `sol` | `sol-6.1` | 存在多个版本（`gpt-5.6-sol`），版本号是区分点 |
| `deepseek-flash` | `deepseek` | `ds-flash` | `flash` 是变体，不能丢 |
| `kimi-code/k3` | — | `k3` | 本身就是短 id |

## 命名陷阱

**模型名格式各家不统一，不要类推：**

| 直觉写法 | 实际正确 | 说明 |
| --- | --- | --- |
| `codex -m luna` | ❌ | 简写不被接受 |
| `codex -m gpt-6.1-luna` | ❌ | 版本号对不上 |
| `codex -m gpt-6-luna` | ✅ | 正确 |
| `codex -m gpt-6.1-sol` | ✅ | 主力模型带 `.1`，luna 不带 |

**改模型名前先实跑一次**：

```bash
codex exec --skip-git-repo-check -m <模型名> "Reply with exactly: OK" < /dev/null
kimi -m <模型名> -p "Reply with exactly: OK"
grok -m <模型名> -p "Reply with exactly: OK"
```

**必须同时跑一个反例**，否则测了等于没测：

```bash
kimi -m definitely-not-a-model -p "OK"     # 应报错，说明 -m 有校验
grok -m definitely-not-a-model -p "OK"     # 应报错
```

如果反例也"通过"，说明那个 CLI 不校验 `-m`，好模型名的测试结果不可信。

**`grok` 可以直接问它要模型列表**，比翻配置可靠：

```bash
grok models        # 列出默认模型和全部可选模型
```

## `claude` 侧不要写 `--model`

Claude Code 不认后端自定义的模型名（会报 `unrecognized_model`）。它的模型是靠 `env` 里的
`ANTHROPIC_MODEL` 生效的 —— 所以用 `claude` 的角色写 `env` 而不是 `args`。

## `kimi` 的默认模型

kimi 的默认模型来自 `~/.kimi-code/config.toml` 的 `default_model`（当前是 `kimi-code/k3`）。
默认值可能变，所以角色要钉住就显式写 `args: ["-m", "kimi-code/k3"]`。

## Commit acceptance and integration

Default flow: `dev ⇄ test → merge queue`. All task sessions are independent of resident conversations.
Dev commits first, then runs `handoff <id> --delivery ID --commit SHA --summary TEXT`.
Dev pauses writes in the shared task checkout during review. Different tasks run concurrently; each task advances one stage at a time.
Test validates that SHA with isolated task database/Redis/port settings, then uses `--accept SHA --summary TEXT` or `--reject --summary TEXT`.
Final acceptance queues integration. Lead uses `merge next` / `merge <id> [--migrate COMMAND]`; inspect failures before `merge retry <id>`.
Only real interface/data dependencies gate execution; documentation can proceed independently before final verification.

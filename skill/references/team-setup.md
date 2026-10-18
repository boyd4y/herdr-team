# Team onboard —— 从项目到可运行团队

对话引导由 herdr-team Skill 完成，CLI `onboard` 保存已确认的配置并报告下一步。
它不是自动替用户选择的交互向导。完整顺序是：了解项目 → 选流程 → 配置角色（职责与模型一起定） → 汇总确认与落盘 → 校验环境与配置 → 启动团队 → 明确派发任务。
复用用户在本会话已确认的选择，只问缺失信息，不要求逐个重复确认。

## 第一步：了解项目和已有团队

先读 README、AGENTS.md、目录结构、Git 状态和已有 `.herdr/`。已有团队同时检查
`workflow show`、`role list`、任务和队列，区分新建团队与调整团队。
总结项目目标、验收命令和已知偏好；未知的身份或业务要求不编造。

## 第二步：先选择工作流（你和用户）

先确定工作流，再按职责配置角色和模型。先读项目约定，向用户提供选择：

| 候选 | 步骤与合并策略 |
| --- | --- |
| `dev-test-review`（推荐） | dev/test 在同一任务 worktree 串行执行；test 通过后创建 PR，独立 review 批准后自动合并；拒绝回 dev 并重新测试 |
| `dev-test` | 本地开发与验收；通过后由 lead 手动串行合入 |
| `direct` | 一步交付 |
| 自定义 | JSON 指定有序步骤的 kind/role、local/pull-request、manual/auto；角色名可以调整 |

推荐不等于默认强制，不先建角色再反推流程。确认选项与手动/自动合并策略后，用
`workflow set NAME` 或 `workflow set --file F` 保存，或在最终 `onboard` 命令同时传入。
lead 始终只有一个常驻编排会话；独立 review 的职责由审查阶段决定，不是多开一个 lead。

## 第三步：配置角色（职责、harness 和模型一起定）

按已选工作流，用一张表一起列出角色、职责、harness、模型和启动方式，不拆成两轮确认。
为每个角色按职责选择合适的模型。流程中没有的 research/search、docs 等角色按需要提出，不自动附加：

| 每个角色要确认的内容 | 说明 |
| --- | --- |
| 负责什么 | 具体工作、交付物、验收要求；职责从用户意图和项目约定提炼，不能照抄预设了事 |
| 边界在哪里 | 哪些事由其他角色处理，和相邻角色如何衔接 |
| 怎么交棒 | 交付前检查什么、用 `handoff <id>` 交接；后续角色由任务卡的 handoff 队列决定 |
| 用什么执行 | harness 和模型；按职责与预算选择，保留用户已指定的偏好 |
| 怎么运行 | 角色 id、常驻或按任务启动；lead 始终只有一个常驻会话 |

把不明确的边界问清：lead 管哪些编排与 Git 生命周期？dev 改接口后是否同步文档？
test 是验证并反馈，还是允许修复代码？遵守已有项目约定，有冲突就请用户明确调整。
让用户增删改职责，已有明确选择直接复用。不要用模型方案代替职责确认。

例如可以提议：lead 负责澄清需求、建卡与派活；dev 负责实现、接口文档和自测；
test 独立验证并把缺陷反馈给 dev。明确各自不负责的工作，再由用户确认这些边界是否适合本项目。

角色名是**角色 id**，用英文角色词。**不要**用 `codex`、`kimi` 这类 agent 类型当名字，
也不要用「主力开发」这类描述 —— 那些是属性，不是身份。详见
[herdr-format.md](herdr-format.md#名字即身份)。

配置角色时，可从 [role-presets.md](role-presets.md) 的 cheap / balanced / strong 中选择模型起点，
或逐个指定。编码和架构审查可考虑强模型，文档、调度和常规验证优先便宜档。
核对对应 CLI 与登录可用；不要把模型方案当作固定角色名单。保留用户已指定的模型偏好。

## 第四步：汇总确认，然后落盘（CLI）

用一份简表汇总流程顺序、PR/本地交付、自动/手动合并，以及各角色职责、边界、harness、模型和启动方式。
用户明确授权整份配置后执行；已有授权无需再问。自定义流程和角色名必须相互对应。

把确认过的分工逐个写进角色定义的 `body`，包含职责、边界、交付要求和交棒说明。
保留所选预设的运行配置，用 `--roles-file F`（或 `--roles '<json>'`）交给 CLI：

```bash
herdr-team onboard --workflow dev-test-review --roles-file roles.json
```

`roles.json` 是确认后的定义输入（形状见下），使用临时文件或用户指定的位置，不往项目中额外创建业务文件。
**只有用户也原样接受预设职责和模型**时，才用
`herdr-team onboard --workflow dev-test-review --plan balanced`。自定义流程使用 `--workflow-file F`。
`init` 是兼容旧项目的底层初始化入口；`onboard` 要求先明确选择或保存工作流。

已有角色默认跳过；`init --force` 只重写 `.role.yaml`，已有 `prompt.md` 始终保留，缺失时才补齐。
它不会把输入中的新 `body` 应用到已有正文；改已有角色职责走下方的 `role add --force --body`。

JSON 形状 —— 一个数组，每项一张角色卡：

```json
[
  {
    "name": "lead",
    "kind": "claude",
    "model": "ds-flash",
    "env": { "ANTHROPIC_MODEL": "deepseek-flash" },
    "body": "你负责澄清需求、建卡、派活和 Git 生命周期；实现与测试交给对应角色。任务交付通过 herdr-team handoff <id> 流转，不手改任务卡。"
  },
  {
    "name": "dev",
    "kind": "codex",
    "model": "sol-6.1",
    "worktree": true,
    "args": ["--no-daemon", "-m", "gpt-6.1-sol"],
    "body": "你负责在当前工作树实现功能、同步接口文档、自测并提交；编排和 Git 分支生命周期交给 lead。完成后运行 herdr-team handoff <id> 交棒，不要自己改任务卡。"
  },
  {
    "name": "test",
    "kind": "claude",
    "model": "ds-flash",
    "worktree": true,
    "env": { "ANTHROPIC_MODEL": "deepseek-flash" },
    "body": "你在同一任务 worktree 测试被提交的 SHA；claim 后验证，通过用 handoff --accept SHA --summary TEXT 交给 PR review，失败用 --reject --summary TEXT 退原开发者，不改实现或直接合并。"
  },
  {
    "name": "review",
    "kind": "codex",
    "model": "sol-6.1",
    "worktree": true,
    "args": ["--no-daemon", "-m", "gpt-6.1-sol"],
    "body": "你独立审查被测 SHA 的 PR、验收标准和测试证据。claim 后用 handoff --accept SHA --summary TEXT 批准，或 --reject --summary TEXT 退回开发和测试；由 CLI 按已选策略合并，不直接修改代码、主分支或任务卡。"
  }
]
```

`name` 会变成目录名 `roles/<name>/`；其余字段与 `.role.yaml` 一一对应（`kind` / `model` /
`worktree` / `cwd` / `args` / `env`），外加 `body` 作为 `prompt.md` 的散文。
`name` 和 `kind` 必填。

所有新投递任务都会按任务隔离，角色只定义职责、harness 和模型，任务 agent 名是 `<role>-<id>`。
`worktree: true` 现用于跳过该角色的常驻对话 tab；它不再控制 dev/test 是否可以并发。
同一任务 dev/test 共用 checkout，按开发、验收顺序串行推进，不同任务并发。
PR 方案中 test 通过后才发布 PR；review 的通过/拒绝决定是否允许合并。默认自动合并，也可
自定义 workflow.json 选择 manual。新任务保存完整流程，默认配置变化不移动正在执行的任务。
可随时 `workflow set` 更改默认；未开始任务用 `workflow apply ID` 显式切换，再重新 dispatch。
见 [herdr-format.md](herdr-format.md#隔离与常驻)。

**你自己不拼元数据。** CLI 负责写 —— 保证字段顺序稳定、缩进正确、该加引号的加引号。
手写 YAML 是这类工具最容易出错的地方，不要碰。

## 第五步：核对落盘结果和运行条件

检查 `.herdr/workflow.json`、`identity.md` 和每个角色的元数据、prompt.md。
`onboard --json` 的 `onboarding.state` 为 `needs-roles` 时继续补齐；`configured` 只表示所需角色齐全，
还需按项目事实填写 identity，运行 `validate`，核对实际保留的模型和职责。
重新 onboard 默认保留已有角色，即使传入了另一套模型方案；修改职责用 `role add NAME --force --body-file F`，
修改模型也要显式更新启动参数或环境。现有任务使用自己的工作流，不随默认配置改变。

启动前确认 Herdr、Bun、选定的 agent CLI 与登录状态可用。PR 流程再核对 Git origin、GitHub.com 仓库、
已登录的 gh、base 分支和独立测试资源配置。同一 GitHub 账号的审查结论是 PR 评论中的 Team 门禁，
不替代分支保护要求的他人 Approve。只核对选定流程需要的条件，不主动替用户登录、改权限或改数据库。

## 第六步：启动团队

需要启动时，在 Herdr pane 中执行 `herdr-team up`，检查角色启动/恢复与 Team Console 的结果。
它不自动派活。

## 第七步：明确派发任务

用户已有具体任务和验收要求时，再用 `add`、`dispatch ID` 派发；不要编造一张业务任务试运行。
选定的 PR 流程通过一次真实任务确认 dev → test → PR → review → 合并；缺失条件记录清楚，不把写配置成功当作运行已验证。

默认共享 `.herdr/` 团队配置，tasks、reports 等本机记录由内部 `.gitignore` 忽略；具体规则见下节。已有明确的项目约定优先。

## init 不覆盖已有文件

已有的 `identity.md` 和 `.gitkeep` 始终跳过；已有角色默认整张跳过。
`--force` 仅重写角色元数据，保留已有正文，避免批量初始化冲掉手调分工。
输出会分别列出已写入的元数据、已写入的正文、已保留的正文；保留的正文也会出现在 `skipped` 中。

## 改已有角色的职责（lead）

先读现有 `prompt.md`，和用户确认完整的新职责、边界和交棒说明，再运行：

```bash
herdr-team role add dev --force --body "你负责实现功能和同步接口文档，自测后提交；编排与分支管理交给 lead。完成后运行 herdr-team handoff <id> 交棒，不要自己改任务卡。"
```

长正文可替换为 `--body-file F`。正文是**整篇替换**，交棒与权限约定也要保留在新正文里。
已有角色必须加 `--force`；更新时 `--kind` 可省略，模型、隔离方式、启动参数等未提供的元数据字段也保持原值。
不给 `--body` / `--body-file` 就逐字保留原文；新角色仍必须给 `--kind`。
不要用重跑 `init --roles-file ... --force` 改职责，因为它保留已有正文。

修改角色文件不会自动给已运行的 agent 重发设定；新正文随后续派活或交棒发送，`up` 不发送消息。

## `identity.md`

`init` 只写标题骨架（`# 我是谁` / `## 代码风格` / `## 偏好`），**不编内容**。写完提示用户填。

它会随派活或交棒的任务说明发送，作为行为基线 —— 内容质量直接决定 agent 的表现。

## 不要做的事

- **不要未经确认就写角色卡。** 可以扫项目、可以提议，但用户没点头之前不落盘。
- **`init` 不生成任务卡。** 任务是用户的意图，不是从项目结构能推出来的东西。建卡走 `herdr-team add`。
- **团队文件写在 `.herdr/` 内。** Git 忽略规则按下节处理，不额外创建业务文件。

## 跨机器共享团队配置

默认将 `.herdr/.gitignore`、`identity.md`、`roles/` 和可选的 `workflow.json` 纳入 Git，另一台机器 clone 后即可复用团队定义。
`init` / `onboard` 会创建以下 `.herdr/.gitignore`；已有文件原样保留，`--force` 也不覆盖：

```gitignore
/tasks/
/reports/
/.retired-ids
/projects/
/worktrees/
```

`init` 不改项目根 `.gitignore`。若旧规则整体忽略 `.herdr/`，由 Skill 按用户约定移除该规则，
改为内部忽略。已被 Git 跟踪的任务与报告需用 `git rm --cached` 取消跟踪，保留磁盘文件。
任务进度、报告、会话与 worktree 不随团队配置跨机器恢复；新机器仍需安装工具并登录。
角色卡使用相对路径和可共享的模型配置，凭证放在各机器的登录或环境中，不写进 Git。

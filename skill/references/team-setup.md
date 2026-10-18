# `init` —— 建骨架并写角色卡

`init` 分两半：**提议角色**需要判断，归你；**写文件**是机械的，归 CLI。

## 第一步：先选择工作流（你和用户）

工作流在角色之前确定，模型在职责之后确定。先读项目约定，向用户提供选择：

| 候选 | 步骤与合并策略 |
| --- | --- |
| `dev-test-review`（推荐） | dev/test 在同一任务 worktree 串行执行；test 通过后创建 PR，独立 review 批准后自动合并；拒绝回 dev 并重新测试 |
| `dev-test` | 本地开发与验收；通过后由 lead 手动串行合入 |
| `direct` | 一步交付 |
| 自定义 | JSON 指定有序步骤的 kind/role、local/pull-request、manual/auto；角色名可以调整 |

推荐不等于默认强制，不先建角色再反推流程。确认选项与手动/自动合并策略后，用
`workflow set NAME` 或 `workflow set --file F` 保存，或在最终 `onboard` 命令同时传入。
lead 始终只有一个常驻编排会话；独立 review 的职责由审查阶段决定，不是多开一个 lead。

## 第二步：逐个确认职责与模型（你和用户）

读 `README` / `AGENTS.md` / 目录结构，判断项目是什么、大概需要哪些工种。

从 [role-presets.md](role-presets.md) 的**三个方案**里选一个起点（省钱 / 均衡 / 全强），
结合项目规模推荐给用户。模型与角色名单只是起点，还要逐个给出本项目的分工草案：

| 每个角色要确认的内容 | 说明 |
| --- | --- |
| 负责什么 | 具体工作、交付物、验收要求；职责从用户意图和项目约定提炼，不能照抄预设了事 |
| 边界在哪里 | 哪些事由其他角色处理，和相邻角色如何衔接 |
| 怎么交棒 | 交付前检查什么、用 `handoff <id>` 交接；后续角色由任务卡的 handoff 队列决定 |
| 怎么运行 | 角色 id、agent 类型、模型、常驻或隔离，与职责一起让用户审阅 |

把不明确的边界问清：lead 管哪些编排与 Git 生命周期？dev 改接口后是否同步文档？
test 是验证并反馈，还是允许修复代码？遵守已有项目约定，有冲突就请用户明确调整。
逐个让用户增删改职责，确认整份分工后才落盘。不要只问「选哪个模型方案」。

**总原则：只有写代码和搞架构才上 `sol` 最强模型，其余用便宜档；拿不准就用均衡。**

例如可以提议：lead 负责澄清需求、建卡与派活；dev 负责实现、接口文档和自测；
test 独立验证并把缺陷反馈给 dev。明确各自不负责的工作，再由用户确认这些边界是否适合本项目。

角色名是**角色 id**，用英文角色词。**不要**用 `codex`、`kimi` 这类 agent 类型当名字，
也不要用「主力开发」这类描述 —— 那些是属性，不是身份。详见
[herdr-format.md](herdr-format.md#名字即身份)。

## 第三步：落盘（CLI）

把确认过的分工逐个写进角色定义的 `body`，包含职责、边界、交付要求和交棒说明。
保留所选预设的运行配置，用 `--roles-file F`（或 `--roles '<json>'`）交给 CLI：

```bash
herdr-team onboard --workflow dev-test-review --roles-file roles.json
```

`roles.json` 是确认后的定义输入（形状见下），使用临时文件或用户指定的位置，不往项目中额外创建业务文件。
`init --help` 会列出每个方案的角色和模型；**只有用户也原样接受预设职责正文**时，才直接运行
`herdr-team init --plan balanced`，或选择另外两个方案。

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
    "args": ["-m", "gpt-6.1-sol"],
    "body": "你负责在当前工作树实现功能、同步接口文档、自测并提交；编排和 Git 分支生命周期交给 lead。完成后运行 herdr-team handoff <id> 交棒，不要自己改任务卡。"
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
- **不要创建 `.herdr/` 之外的任何文件。**

## 一个待用户决定的问题

`.herdr/` 可能包含个人身份信息和内部分工，**是否纳入 Git 由用户决定**。

`init` 不改 `.gitignore`，只提示这个问题。

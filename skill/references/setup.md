# Setup：初始化与调整团队

onboard 是 Skill 对话，不是 CLI 向导。复用已确认的选择与授权，不反复要求用户确认。

## 了解与确认

读 README、AGENTS.md、目录结构、Git 状态、`.herdr/identity.md`、现有角色、任务和队列。
已有团队先用 `role list --json` 检查实际配置，区分新建与调整，保留已有职责和模型偏好。

按 [workflow.md](workflow.md) 选择流程后，用同一张表确认角色的职责、边界、交付要求、harness、模型和启动方式，
不把职责与模型拆成两轮确认。辅助 docs、research/search 按需要提出；模型方案不能决定固定角色名单。
模型配置按需读 [models.md](models.md)。角色名描述职责，不用 agent 类型命名。

## 保存角色与项目约定

Skill 把用户确认的流程写入 `.herdr/workflow.md`；格式和变更规则只见 [workflow.md](workflow.md)。
角色通过 CLI 保存，不手拼 YAML。`body` 只保留角色职责、边界、交付要求和先读 herdr-team Skill 的入口，
不复制命令清单或 claim/handoff/PR 的完整操作流程。新生成的正文使用英文，用户自带正文保留原语言。
可复用职责模板按角色保存在 [assets/roles](../assets/roles)：lead、dev、test、search、docs、review；
每个目录只有 `prompt.md`，通用职责放在 default。按当前职责选择、阅读并调整所需模板，不整套加载。
模型初始目录是 [assets/models.json](../assets/models.json)，init 只在缺失时复制到项目 `.herdr/models.json`。
项目文件优先，用户可在本地修改；已有内容即使 --force 也保留。角色方案在 [assets/plans.json](../assets/plans.json) 中引用 harness/model。
选择与刷新步骤只见 [models.md](models.md)，不在职责模板内复制模型列表。
项目背景模板是 [assets/identity.md](../assets/identity.md)；CLI 仅在项目缺失 identity 时复制，
Skill 结合项目事实填写背景、约定引用与偏好，不放角色指令或工作流步骤，已有内容保留。
CLI 对未提供 body 的新角色按同名模板初始化，未知角色用 default；已有正文不随模板更新自动改写。
例如临时 `roles.json` 的输入形状：

```json
[
  {
    "name": "builder",
    "kind": "codex",
    "model": "gpt-6.1-sol",
    "worktree": true,
    "args": ["--no-daemon", "-m", "gpt-6.1-sol"],
    "body": "Read the installed herdr-team skill before starting. Implement and self-test the assigned change. Stay within the task checkout; lead owns team configuration and branch lifecycle."
  }
]
```

数组应包含已确认的全部角色，而非只复制此示例。PR 方案应明确对应测试、审查职责及谁执行发布/合并。
`name`、`kind` 必填；其余可用 `model`、`worktree`、`cwd`、`args`、`env`、`body`，见 [格式规范](herdr-format.md)。

```sh
herdr-team init --roles-file roles.json
herdr-team role list --json
herdr-team validate
```

只有整套预设职责和模型都已接受时才用 `init --plan cheap|balanced|strong`；它不是流程预设，
不会据流程自动补 review 等角色。`init` 不派活、不启动 agent。

已有角色默认跳过；`init --force` 只改元数据，保留已有 `prompt.md`。
旧角色若复制了整套 CLI 操作流程，由 lead 在明确更新该角色时保留职责并改为 Skill 引导；不批量覆盖用户自定义正文。
更新职责时先读旧正文，再用 `role add NAME --force --body-file F` 整篇替换，保留有效的交付边界。
更新元数据可省略 `--kind`，未提供字段保持原值；省略正文也保持原文。
新增角色后可运行 `up` 纳入管理。`role rm NAME` 拒绝移除仍被活动任务引用的角色。

## 核对后启动

填写真实的 identity，检查角色正文与启动参数；不要把保留旧配置误报为更新成功。
CLI 输出、错误和生成的默认指令保持英文，无需多语言支持。

启动前核对 Herdr、Bun、选定 agent CLI 及对应登录。PR 交付还需要匹配的 GitHub.com origin、已登录的 gh 和测试资源；
只核对选定方案需要的条件，不替用户改权限、登录或数据库。

在 Herdr pane 中按用户意图运行 `herdr-team up`，检查 Console 和每个角色的启动/恢复结果。
只在用户已有业务任务和验收要求时建卡派发；不要编造试运行任务。
派发、任务会话和恢复见 [handoff.md](handoff.md)。改角色文件不会给运行中 agent 自动重发配置，后续派活会携带角色正文。

## 本地文件与 Git

`.herdr/` 整体忽略，包括团队定义、任务、报告和临时产物；不要强制添加这些文件到 Git。
`init` 在根 `.gitignore` 追加 `/.herdr/`，保留已有规则和团队文件。已有项目运行 init 即可补上规则。
已跟踪的目录用 `git rm -r --cached -- .herdr` 取消跟踪，保留磁盘文件；先检查差异，不删除本地配置。

可复用默认模板在插件的 `skill/assets/`，各机器独立初始化、选择模型并登录所选工具。
任务、会话和本机 worktree 不跨机器恢复；只有用户明确要求时才另外安排配置复制。

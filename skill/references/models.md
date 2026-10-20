# Models：目录、选择与刷新

只在选择模型、修改 harness 或刷新目录时读取。角色与流程配置见 [setup.md](setup.md)。

## 初始化模板与项目配置

[assets/models.json](../assets/models.json) 只是初始化模板。`init` 在项目缺少 `.herdr/models.json` 时复制一次，
即使 `--force` 也保留现有项目文件。实际选择优先读取 `.herdr/models.json`；缺失时才使用 Skill 初始版本。

项目文件按 harness 保存可选模型、启动参数、官方来源及 `checked_at` 核对日期，用户可以直接在本地修改；项目 `.herdr/` 整体由 Git 忽略。
可选的 `harnesses.<kind>.preferred` 保存项目优先模型，例如 `harnesses.codex.preferred` 为 `gpt-6.1-sol`，
`harnesses.claude.preferred` 为 `default`。不设置 preferred 时使用角色方案的建议；显式选择某个模型优先于项目默认偏好。
项目 preferred 会覆盖 `--plan` 的模型建议，方案依然决定所选角色集合。
[assets/plans.json](../assets/plans.json) 只保存角色方案，使用 `kind` 和 `model` 引用目录；不再复制一套模型定义。
职责模板与模型目录分别维护，选择模型不会决定团队必须有哪些角色。

- Codex：使用 OpenAI 官方模型 ID，来源为 [官方模型文档](https://learn.chatgpt.com/docs/models)。
- Claude：使用 [Claude Code 官方模型名或别名](https://code.claude.com/docs/en/model-config)。不提供其他厂商后端映射。
- `default`：跟随 harness 自己的本地配置和账号默认设置。模型参数为空，不传 `-m default`、`--model default` 或模型覆盖环境变量。
- harness 的通用启动参数独立保存，例如 Codex 的 `--no-daemon`；默认模型不会移除这些参数。
- 其他 harness 当前只提供 default。加入具名选项前核对该 harness 的官方来源与本机 help，不从别家推导模型名。

目录是已核对的选择集合；账号和客户端最终决定可用性。不要在普通 CLI 操作中联网拉目录。

## 刷新目录

用户要求刷新时，由 Skill 执行；先区分更新 Skill 的初始版本还是当前项目文件：

1. 优先读取 `.herdr/models.json` 及其官方来源，重新核对模型 ID、官方别名和本机 CLI 接受的参数。
2. 明确刷新项目时，更新项目文件的官方模型项和 `checked_at`，保留用户的 preferred、自定义项和无关参数；不要用 Skill 模板整份覆盖客户文件。
   维护插件初始版本时才改 assets/models.json；其中只提供官方模型与 default，不放跨厂商后端映射。
3. 检查 `plans.json` 的每个 kind/model 引用仍存在。需要调整方案时明确修改引用。
4. 项目 JSON 修改后下次选择直接读取，无需重装。Skill 初始版本更新则通过插件 install action 或插件更新分发，不覆盖项目配置。不要手改冻结运行时或已安装 Skill 的副本。

无需增加模型管理 CLI、定时抓取器或单独的后台服务。Skill 负责查来源与更新 JSON，CLI 只展开已确认的配置。

## 应用选择

Skill 从项目目录和 preferred 中取得选择，展开 harness 通用 args 与所选模型 args，生成显式角色定义，再交给 CLI 保存。
新团队用 `init --roles-file F`；更新已有团队可用 `init --roles-file F --force` 保留职责正文并重写启动元数据。

项目 `.herdr/roles/<role>/.role.yaml` 是已选择配置的快照。`model` 用于显示，应与实际 args 一致；目录刷新不会静默重写项目角色。
切换到 default 时清掉上一次的模型参数与模型覆盖变量，保留无关启动配置。Claude 示例：

```sh
herdr-team role add test --force --model default --args "" --env ""
```

此示例适用于没有其他 args/env 的 Claude 角色；有其他启动配置时，通过 roles-file 明确保留它们。
改配置后不强制重启正在执行的任务。下一次新会话使用新配置；已有会话按 harness 自己的恢复行为执行。

---
name: herdr-team
description: 用项目根 TEAM.md 的团队约定和 .herdr/ 的角色卡、任务卡驱动 Herdr agent 团队：初始化骨架、按角色拉起 agent 并按优先级和依赖派活、以任务卡为载体在角色间交接，并复盘执行耗时、重复工作和职责交叉、提出上游反馈与项目改进。适用于需要多 agent 分工或执行复盘的本地开发；不绑定具体项目、仓库名或 agent 类型。
---

# Herdr Team

项目根 `TEAM.md` 只按角色保存简短的中文工作步骤，`.herdr/` 保存本地执行配置和任务，Herdr 承载 agent 会话。
每次运行任何入口，先按派活给出的绝对 root 或 Git 主检出定位团队项目，读取 AGENTS.md 和根目录 TEAM.md。
TEAM.md 不存在时，先按 [setup：团队约定](references/setup.md#团队约定-teammd) 初始化，再继续当前工作；
每次创建或重建都按该节检查旧 identity/workflow，并提示迁移与清理选择。
不要在子目录或任务 worktree 另建一份，也不从父目录其他仓库借用约定。不假设仓库名、角色或 harness。

## 职责边界

- Skill 决定流程、角色分工、任务拆分、验收范围及下一步；TEAM.md 只写各角色做什么；交棒、协作、任务流转与收尾由 Skill 统一指导。
- CLI 标准化输入输出、保存任务/delivery 并执行明确操作，负责引用校验、去重、SHA 一致性和并发锁。
- 任务元数据和历史由 CLI 写；不要手算 ID、手改任务卡或绕过队列发消息。
- 任务已有 role/handoff 是执行依据；CLI 不解释旧 workflow 快照；活动旧格式应由 lead 明确处理，历史记录保留。

## Skill 工作入口

每次收到任务，先读取本 Skill，再按当前工作读取参考；不要直接照 role prompt 或命令模板跳过引导。
这些入口由 agent 理解与执行，不是 CLI 子命令；只读当前需要的参考。

| 入口 | 用途 | 参考 |
| --- | --- | --- |
| setup（onboard） | 初始化、调整角色与本地配置、按用户要求更新插件 | [setup.md](references/setup.md) |
| handoff | 拆任务、领取、协作交付、PR、合并、收尾与会话恢复 | [handoff.md](references/handoff.md) |
| models | 选择模型或修改 harness 启动配置 | [models.md](references/models.md) |
| feedback | 回顾指定时间的执行，分析耗时、重复与职责交叉，生成报告、上游 issue 草稿和仓库改进建议 | [feedback.md](references/feedback.md) |

例如：“使用 herdr-team skill 的 feedback，复盘最近 7 天”。用户询问有哪些入口时列出上表。
用户要求升级插件、CLI 或 Skill 时，读 [setup：更新插件](references/setup.md#更新插件)。
文件布局、字段和约束按需查 [herdr-format.md](references/herdr-format.md)，不作为额外执行模式。

已有授权和偏好直接复用，只问缺失信息。普通任务用简短摘要交棒，验证相关改动和风险，避免每棒重复全量测试或额外生成报告。

任务号和角色名只在当前项目有效。在 worktree 或其他目录操作时，使用派活消息提供的绝对 `--root`；不凭侧栏名称猜 pane 或项目。
`lead` 始终只有一个常驻会话；其他任务可以并行，单个任务内逐棒执行。

用 `herdr-team --help` 查询全部现有命令，`<command> --help` 查参数，`--json` 获取机器可读输出。

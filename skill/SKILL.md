---
name: herdr-team
description: 用项目内 .herdr/ 的身份、角色卡和任务卡驱动 Herdr agent 团队：初始化骨架、按角色拉起 agent 并按优先级和依赖派活、以任务卡为载体在角色间交接。适用于需要多 agent 分工的本地开发；不绑定具体项目、仓库名或 agent 类型。
---

# Herdr Team

用项目 `.herdr/` 管理团队，Herdr 承载原生 agent 会话。先读项目约定和实际任务，不假设仓库名、角色名或 harness。

## 职责边界

- Skill 决定流程、角色分工、任务拆分、验收范围及下一步；项目流程约定放在 `.herdr/workflow.md`。
- CLI 标准化输入输出、保存任务/delivery 并执行明确操作，负责引用校验、去重、SHA 一致性和并发锁。
- 任务元数据和历史由 CLI 写；不要手算 ID、手改任务卡或绕过队列发消息。
- 任务已有 role/handoff 是执行依据；CLI 不解释旧 workflow 快照；活动旧格式应由 lead 明确处理，历史记录保留。

## 按当前工作读取

每次收到任务，先读取本 Skill，再按当前工作读取参考；不要直接照 role prompt 或命令模板跳过引导。
只读当前需要的参考，不默认把全部文件载入上下文。

| 当前工作 | 参考 |
| --- | --- |
| 初始化、重新 onboard、调整角色、本地团队配置 | [setup.md](references/setup.md) |
| 选择/调整流程、拆分新任务、PR 交付、合并和最终收尾 | [workflow.md](references/workflow.md) |
| 收到任务、claim/handoff、反馈缺陷、队列/Console/会话恢复 | [handoff.md](references/handoff.md) |
| 选择模型或修改 harness 启动配置 | [models.md](references/models.md) |
| 查询文件布局、字段和约束 | [herdr-format.md](references/herdr-format.md) |

已有授权和偏好直接复用，只问缺失信息。普通任务用简短摘要交棒，验证相关改动和风险，避免每棒重复全量测试或额外生成报告。

任务号和角色名只在当前项目有效。在 worktree 或其他目录操作时，使用派活消息提供的绝对 `--root`；不凭侧栏名称猜 pane 或项目。
`lead` 始终只有一个常驻会话；其他任务可以并行，单个任务内逐棒执行。

用 `herdr-team --help` 查询全部现有命令，`<command> --help` 查参数，`--json` 获取机器可读输出。

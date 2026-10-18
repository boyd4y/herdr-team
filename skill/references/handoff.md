# Handoff：协作、交付与恢复

处理任务分配、交棒、缺陷、队列或会话问题时读取。PR 创建与自动/手动合并步骤只见 [workflow.md](workflow.md)。

## 归属与权限

lead 创建/调整任务、管理角色和会话、dispatch、处理 queue retry/drain、clean/down，并负责不明确的下一步。
执行角色使用 claim、handoff 和只读查询，不自行建卡或改任务元数据。
已约定的 PR 发布与批准后 merge 是 [workflow.md](workflow.md) 中明确授权的例外；不要据此自行改主分支或分支生命周期。

不同任务各有 worktree/workspace 和角色会话；同一任务所有角色共用 checkout，逐棒执行。
常驻对话不占任务执行槽，lead 是唯一常驻串行编排者。测试/审查接手后，开发者暂停写入。
显示名称可能与内部 agent 名不同，使用任务给出的 delivery ID 和团队 root，不用裸角色名跨项目发送。

## 收到任务

1. 运行消息中的 `herdr-team claim <id> --delivery ID --root <team-root>`。duplicate 表示已经领取，不再启动一份工作。
2. 用 `herdr-team tasks <id> --json --root <team-root>` 读取完整卡片，读交付摘要及其引用的实际产物。
   列表 tasks/status/role list 默认不含 body，tasks <id> 返回含正文的单个对象。
3. 按本棒职责工作，完成后使用同一个 delivery ID 交棒。下游明确时直接交接，不额外增加 lead 中转。
   需要改链或归属不明确时通知 lead；不要猜角色、跳验收或让用户人工转述。

## 交付

普通交付保持简短，CLI 会追加到 task.md；长摘要可从文件读取：

```sh
herdr-team handoff <id> --delivery ID --summary "Results; artifacts; validation; risks" --root <team-root>
herdr-team handoff <id> --delivery ID --summary-file <file> --root <team-root>
```

摘要应足够让下一位继续；报告按需要提供，研究结论附来源。摘要虽非强制字段，也不能把状态推进当成结果完整。
交付以卡片和实际产物为准，不默认读取终端历史；agent read 仅用于诊断或补查旧任务缺失交付。

需要逐棒验收代码时，开发者提交干净版本，下一位针对同一 SHA 接受或拒绝：

```sh
herdr-team handoff <id> --delivery ID --commit SHA --summary "Implemented; ready for validation" --root <team-root>
herdr-team handoff <id> --delivery ID --accept SHA --summary "Validated SHA; results" --root <team-root>
herdr-team handoff <id> --delivery ID --reject --summary "Reproduction and defects" --root <team-root>
```

每次操作使用当前领取的 ID。接受下一棒会重新指派同一 SHA，上一棒的批准不等于最终批准。
拒绝返回提交者并重走已经过的验收角色；新提交使旧结论失效。不要同时写 checkout 或接受移动中的版本。
最后一次版本批准进入合并队列；无版本验收的普通交付在无后续角色时完成。PR 的额外操作见 [workflow.md](workflow.md)。

测试会话提供 HERDR_TEAM_TEST_DATABASE、HERDR_TEAM_REDIS_PREFIX、HERDR_TEAM_PORT/PORT。
用它们配置独立数据库、Redis key 前缀和监听端口；CLI 不创建服务或改 DATABASE_URL。
无法隔离就报告阻塞，不使用共享业务库；独立任务继续。端口绑定失败时处理实际冲突，不假定分配后永久可用。

## 队列与 Console

add 只建卡，dispatch 才入队；handoff 保存结果并自动入队下一棒，无需再 dispatch。
三类状态分别看：卡片 status 是任务进度，delivery 是当前分配投递状态，Herdr agent state 是会话可用性。
idle/done 才可发送输入，但不代替当前任务明确 handoff。

up 在独立 tab 创建或复用 Team Console，不把未入队 todo 自动派发。
Console 只轮询已入队 delivery；不要在 agent 自己的 pane 启动交互 console。agent 用 status/tasks/queue 查状态。
关闭 Console 暂停轮询，队列保留；up 或 console 可恢复。observe/once/line 是只读视图。
显式 dispatch、handoff、queue drain 即使无 Console 也可尝试投递。

接收方忙、blocked 或 unknown 时保持排队，不绕过队列注入。发送结果不明或迟迟未 claim 会标 uncertain，停止自动重发。
先查卡片、原 agent、实际产物和远端副作用，再由 lead 决定是否：

```sh
herdr-team queue --json --root <team-root>
herdr-team queue retry <id> --root <team-root>
herdr-team queue drain --root <team-root>
```

retry 分配新 delivery ID，旧 ID 失效；重复 handoff 不再次推进或追加摘要。不要把 uncertain 当成肯定没收到。
状态/历史持久化由 CLI 负责，不自行改 delivery 或修补 YAML。

## 会话与清理

up 默认恢复已记录的常驻原生会话，运行中会话复用；fresh 只忽略待启动会话记录。
任务会话按项目、任务、角色和 cwd 分开恢复。只使用 Herdr 官方 integration 上报的 agent_session，
不额外装 session 识别 hook、不猜最近会话。恢复失败先读错误，不丢记录重派；恢复不解除 uncertain。

角色正文更新不让运行中 agent 自动重读 Skill；下一次派活携带当前角色正文和 delivery 命令。
旧已发出 delivery 继续原会话，未发出的队列可在投递前切到任务会话。

lead 用 clean 回收终态任务 worktree；CLI 不强制删除脏 checkout，保留现场与分支。
down 停止 agent，默认保留 workspace；不为刷新 CLI 或 Skill 而重启团队。

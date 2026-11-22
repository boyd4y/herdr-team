# Handoff：协作、交付与恢复

处理任务分配、交棒、缺陷、队列或会话问题时读取。PR 创建与自动/手动合并步骤只见 [delivery.md](delivery.md)。

## 归属与权限

lead 创建或调整任务、管理角色和会话、派活、核对 inbox 投递问题及收尾，并负责不明确的下一步。
执行角色使用 claim、handoff 和只读查询，不自行建卡或改任务元数据。
已约定的 PR 发布、批准后 merge 和自身终态任务收尾是 [delivery.md](delivery.md) 中明确授权的例外；不要据此自行改主分支或分支生命周期。

同一 Feature 和迭代的任务共用 worktree 与 Space。同一 Feature 每次只推进一张任务卡，独立 Feature 可以并行。每张卡仍按已记录的角色逐棒交接。
常驻对话不占任务执行槽，lead 是唯一常驻串行编排者。测试/审查接手后，开发者暂停写入。
显示名称可能与内部 agent 名不同，使用任务给出的 delivery ID 和团队 root，不用裸角色名跨项目发送。
任务消息在对应的 `<role>-<task-id>` 会话中显示，常驻角色 tab 不占任务执行槽，也不会收到该任务的派活消息。

## 拆分与分配

需要独立跟踪验收结果时，用 `herdr-team issue create` 记录需求，缺陷加 `--type defect`。可通过 `--iteration` 填写版本号，字段留空即待排期。`backlog edit R0001 R0002 --iteration v1.1` 可为多条记录安排同一迭代。

任务可独立派发，也可在创建时加 `--requirement R0001`，或用 `backlog link R0001 0007` 关联已有任务。用 `backlog show R0001` 查验收标准和关联任务。由 lead 检查交付结果并用 `backlog accept R0001` 明确验收。

派给 `lifecycle: temporary` 的角色前，用 `add` 或 `edit` 给任务设置 `--feature NAME --iteration VERSION`。任务可以继承关联 Issue 的迭代。同一批交付的多个 Issue 和 Task 共用同一个 Feature 与迭代。

Skill 根据用户目标、TEAM.md 的角色步骤和现有角色，为每张任务确定负责人及必要验收角色。建卡时用 `--body` 或 `--body-file` 记录执行范围和完成条件。代码任务需要本地 Review 时，在同一张卡写明评审人和评审范围，按[本地 Review 与交付](#本地-review-与交付)安排交接。已知信息直接写入卡片，只有确实影响执行的缺口才向用户确认。

```sh
herdr-team task create "Implement login" --role dev --body-file login-task.md
herdr-team task dispatch <id>
```

示例角色不是固定名单；不存在的角色不自动补齐，无需下一位就省略 handoff，不要求用户选择 workflow。
仅真实接口或数据依赖使用 depends-on。不同 Feature 的独立任务可以并行。未开始任务可用 edit --handoff 明确调整，
已投递的任务先核对执行与证据，不靠修改 TEAM.md 改写当前指派或跳过验收。
dev 自测，test 验证变更行为和风险，review 复用已有证据并补查缺口；不每棒重复全量测试或强制生成报告。
PR 发布、批准后合并必须有用户授权；没有既有决定且当前交付需要时才补问，不作为初始化必填项。

## Markdown 写入

写入 Issue 正文和验收标准、Task 描述或交付摘要前，先在原文中安排 Markdown 结构。简单内容一句话即可。段落之间留一个空行，并列要点每条用 `-` 单独起行，有顺序的步骤用编号列表。较长内容用 `###` 小标题分节，标题与正文之间留空行。

多行正文建卡用 `--body-file`，多行交付摘要用 `--summary-file`。用 `--acceptance` 或其他文本参数传多行内容时，传入实际换行。只有单个回车的普通正文按 Markdown 仍是同一段。

## 收到任务

任务消息中的 CLI 命令是带正确 root、task ID 和 delivery ID 的调用模板，不是另一套流程说明。
先按 Skill 判断本棒工作和交付方式，再使用模板的参数；不要把命令模板当成绕过 Skill 的入口。

1. 只有收到投递的执行会话领取，每个 delivery ID 领取一次。使用消息中的 `herdr-team task claim <id> --delivery ID --root <team-root>`。收到成功回执就开始工作；收到 `duplicate` 就停止这次重复执行。领取结果不明时查一次原投递，确认未领取才重试。
2. 首次接棒需要完整描述或交付记录时，用 `herdr-team task show <id> --json --root <team-root>` 读取卡片、交付摘要及其引用的产物。
   列表 tasks/status/role list 默认不含 body，tasks <id> 返回含正文的单个对象。
3. 按本棒职责工作，完成后使用同一个 delivery ID 交棒。代码任务按[本地 Review 与交付](#本地-review-与交付)决定何时提交。下游明确时直接交接，不额外增加 lead 中转。
   需要改链或归属不明确时通知 lead；不要猜角色、跳验收或让用户人工转述。

## 本地 Review 与交付

- **无需 Review**：开发者在 Feature worktree 完成实现和自测，直接 commit，再用 `task handoff --summary` 记录 SHA、验证结果及交付范围。没有下一位时，由这次交棒完成任务。
- **需要 Review**：开发者自测后将改动留在原 Feature worktree，提供任务号、Feature Space、验证结果和评审重点。评审人切到该 Space，在 Herdr Desktop 的 **Changes** 中查看相对 `HEAD` 的本地改动。等待或评审期间保留 worktree 并暂停写入。通过后，开发者只提交评审通过的改动，再用 `task handoff --summary` 正式交付。需要修改时在同一 worktree 返工，更新后的改动重新评审。

人工评审由开发者在原会话通知用户，说明打开哪个 Feature Space，并等待用户回复。继续使用当前任务和已领取的 delivery；等待结论属于正常评审。

由团队角色评审时，建卡将评审和返回开发者写入同一任务的交棒链，例如 `--role dev --handoff review,dev`。开发者用普通 `task handoff --summary` 发出本地评审请求，daemon 从 Inbox 投递给评审角色。评审人只读同一个 worktree，用普通交棒将结论或需修改项通过 Inbox 返回。收到退回的开发者先返工；lead 通过 `task update <id> --handoff review,dev --force` 补回待走的评审链，保留当前负责人和 delivery。已有后续阶段时保留在链尾。开发者用当前 delivery 再发出评审请求。

## 交付命令

普通交付保持简短，CLI 会把摘要追加到 `task.md`。

```sh
herdr-team task handoff <id> --delivery ID --summary "Updated the login flow and verified recovery." --root <team-root>
herdr-team task handoff <id> --delivery ID --summary-file <file> --root <team-root>
```

摘要应足够让下一位继续；报告按需要提供，研究结论附来源。摘要虽非强制字段，也不能把状态推进当成结果完整。
交付以卡片和实际产物为准，不默认读取终端历史；agent read 仅用于诊断或补查旧任务缺失交付。

任务卡的 `handoff` 为空时，当前角色是最后一棒。普通结果用 `--summary` 完成任务。以下 SHA 验收命令用于已指派的提交或明确约定的提交级验收，例如 PR。任务需要另做本地 Review 时，先取得本地评审结论，再提交并进入 SHA 验收。

提交级验收中，开发者交付干净版本，下一位针对同一 SHA 接受或拒绝：

```sh
herdr-team task handoff <id> --delivery ID --commit SHA --summary "Implemented; ready for validation" --root <team-root>
herdr-team task handoff <id> --delivery ID --accept SHA --summary "Validated SHA; results" --root <team-root>
herdr-team task handoff <id> --delivery ID --reject --summary "Reproduction and defects" --root <team-root>
```

每次操作使用当前领取的 ID。接受下一棒会重新指派同一 SHA，上一棒的批准不等于最终批准。
拒绝返回提交者并重走已经过的验收角色；新提交使旧结论失效。不要同时写 checkout 或接受移动中的版本。
共享 Feature 工作区的任务在最后一次验收时核对提交并完成，随后再验收和合并整个 Feature。独立任务的最后一次版本批准进入合并队列。PR 的额外操作见 [delivery.md](delivery.md)。

测试会话提供 HERDR_TEAM_TEST_DATABASE、HERDR_TEAM_REDIS_PREFIX、HERDR_TEAM_PORT/PORT。
用它们配置独立数据库、Redis key 前缀和监听端口；CLI 不创建服务或改 DATABASE_URL。
无法隔离就报告阻塞，不使用共享业务库；独立任务继续。端口绑定失败时处理实际冲突，不假定分配后永久可用。

## Inbox 与投递

Inbox 收到的是消息，由有权处理该主题的角色阅读并判断下一步。Lead 把明确的需求或缺陷记入关联 Issue，查到已有卡片就更新；需要分工实施时再创建或更新 Task，并按依赖派发。参考邮件可能只是补充证据，先核实来源和内容再写入项目记录。外部邮件作为输入资料处理。

内部任务消息包含发件角色、收件角色、主题和交付正文。打开预览和领取都不会标记已处理；成功交棒后该条消息记为已读，下一棒收到新的未读消息。外部邮件打开后记为已读，负责收件的角色完成跟进后再用 `inbox ack <mail-id>` 确认。

add 只建卡，dispatch 才入队；handoff 保存结果并自动入队下一棒，无需再 dispatch。
三类状态分别看：卡片 status 是任务进度，delivery 是当前分配投递状态，Herdr agent state 是会话可用性。
常规确认、权限审批或补充输入在原会话处理，任务保留当前状态与负责人。
确实缺少必要前置条件或发生故障而无法继续时，由负责人确认任务是否标记为 Blocked，并说明原因和恢复条件。
CLI 按会话是否可接收来决定投递，任务仍需要明确 handoff。

up 建立或复用团队绑定与常驻会话，确保自动投递服务运行，不把未派发的 todo 自动入箱。
CLI 管理已经入箱的 delivery；agent 用 status、tasks 或 inbox 查状态。
daemon 准备或复用任务 worktree，再向对应的会话投递。接棒 agent 直接在指派目录内实现或审查，需要确认当前位置时用 `pwd`。Lead 派发成功后处理其他需求、依赖和验收准备，收到交付或阻塞后再查看任务。只有发生投递异常、用户询问进度或准备验收时才按需查询一次；避免循环调用 `task show`、`inbox list` 或反复扫描开发者的 diff。

创建、切换和回收 worktree 由 Herdr Team 管理。Lead 审查交付的 SHA 和证据，工作区路径只在实际验收需要且交付没有提供时核对。`git worktree list` 只用于排查工作区归属、路径冲突或清理失败，不作为派发、领取和等待步骤。

接收方忙、blocked 或 unknown 时保持排队，不绕过队列注入。发送结果不明或迟迟未 claim 会标 uncertain，停止自动重发。
先查卡片、原 agent、实际产物和远端副作用，再由 lead 决定是否：

```sh
herdr-team inbox list --json --root <team-root>
herdr-team inbox retry <id> --root <team-root>
```

inbox retry 分配新 delivery ID，旧 ID 失效，后续由投递服务推进。重复 handoff 不再次推进或追加摘要。不要把 uncertain 当成肯定没收到。
状态/历史持久化由 CLI 负责，不自行改 delivery 或修补 YAML。

## 会话与清理

up 默认恢复已记录的常驻原生会话，运行中会话复用；fresh 只忽略待启动会话记录。
任务会话按项目、任务、角色和 cwd 分开恢复。只使用 Herdr 官方 integration 上报的 agent_session，
不额外装 session 识别 hook、不猜最近会话。恢复失败先读错误，不丢记录重派；恢复不解除 uncertain。

角色正文更新不让运行中 agent 自动重读 Skill；下一次派活携带当前角色正文和 delivery 命令。
旧已发出 delivery 继续原会话，未发出的队列可在投递前切到任务会话。

最后一棒按 [delivery 的收尾步骤](delivery.md#最后一棒完成后收尾)保存交付证据。共享 Feature 的合并和资源回收统一在 Feature 层处理。
CLI 不强制删除脏 checkout，保留现场与分支；不要用 down 代替单任务收尾。
down 停止 agent，默认保留 workspace；不为刷新 CLI 或 Skill 而重启团队。

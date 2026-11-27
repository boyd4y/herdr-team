# Handoff：协作、交付与恢复

处理任务分配、交棒、缺陷、队列或会话问题时读取。PR 创建与自动/手动合并步骤只见 [delivery.md](delivery.md)。

## 归属与权限

lead 创建或调整任务、管理角色和会话、派活、核对 inbox 投递问题及收尾，并负责不明确的下一步。
执行角色使用 claim、handoff 和只读查询，不自行建卡或改任务元数据。
已约定的 PR 发布、批准后 merge 和自身终态任务收尾是 [delivery.md](delivery.md) 中明确授权的例外；不要据此自行改主分支或分支生命周期。

同一 Feature 和迭代共用 worktree 与 Space，队列一次放行一张卡。能隔离检出、独立验证和交付的工作可按独立 Feature 并行；共用工作区仍按队列执行。测试或审查接手后，开发者暂停写入。
显示名称可能与内部 agent 名不同，使用任务给出的 delivery ID 和团队 root，不用裸角色名跨项目发送。
任务型角色在任务专属会话中接收投递。常驻角色收到指派时继续使用自己的常驻会话。

## 拆分与分配

先找已有需求或缺陷。需要单独跟踪目标、排期或产品验收时，用 `herdr-team issue create`，缺陷加 `--type defect`。可用 `--iteration` 排期，留空即待排期。小型独立维护只需要一张 Task。

执行任务优先绑定具体 Issue。建卡用 `--requirement R0001`，已有任务用 `herdr-team issue link R0001 0007`。明确属于独立维护、没有对应需求或缺陷的工作可直接建卡。用 `herdr-team issue show R0001` 查验收标准和关联任务。由 lead 检查交付结果并用 `herdr-team issue accept R0001` 明确验收。

派给 `lifecycle: temporary` 的角色前，用 `add` 或 `edit` 给任务设置 `--feature NAME --iteration VERSION`。任务可以继承关联 Issue 的迭代。同一批交付的多个 Issue 和 Task 共用同一个 Feature 与迭代。

按可独立交付的结果拆卡。一个执行者沿用同一会话完成实施、自测、返工和交付。范围小、风险低且项目和用户未要求独立验收时，省略 handoff 链，直接交付；lead 无需中转。需要独立测试或评审时，在原卡记录范围和交接人，优先安排现有角色或用户。只有测试设施、回归套件等有独立产出的工作才另建卡。

建卡前按[卡片描述](#卡片描述)写明执行范围和完成条件。已知信息直接写入卡片，只有确实影响执行的缺口才向用户确认。

```sh
herdr-team task create "Implement login" --role dev --requirement R0001 --body-file login-task.md
herdr-team task dispatch <id>
```

示例角色不是固定名单；不存在的角色不自动补齐，无需下一位就省略 handoff，不要求用户选择 workflow。
仅真实接口或数据依赖使用 depends-on。不同 Feature 的独立任务可以并行。未开始任务可用 edit --handoff 明确调整，
已投递的任务先核对执行与证据，不靠修改 TEAM.md 改写当前指派或跳过验收。
dev 自测，test 验证变更行为和风险，review 复用已有证据并补查缺口；不每棒重复全量测试或强制生成报告。
PR 发布、批准后合并必须有用户授权；没有既有决定且当前交付需要时才补问，不作为初始化必填项。

## 卡片描述

标题和正文沿用用户语言。普通卡片以一句目标和几条要点为默认；一条讲清一个结果，只有影响范围或验收时才展开。

| 卡片 | 正文章节 | 写法 |
| --- | --- | --- |
| 需求 Issue | 目标、范围 | 一句话写用户要达成的结果，通常最多三条范围。可观察的验收结果单独写入 `--acceptance`，通常一到三条。 |
| 缺陷 Issue | 现象、复现 | 写清实际结果和触发条件，有顺序的复现步骤用编号。 |
| 关联 Task | 交付 | 一到三条写本任务负责的交付物。通过关联 Issue 复用目标和验收，只有本卡独有的完成条件才另写。 |
| 独立 Task | 交付、完成条件 | 用一到三条说明交付物及如何确认完成。简单工作可以直接写一段。 |

用 `###` 写必要的小标题。多行正文用 `--body-file`，多项验收用带实际换行的 Markdown 列表。

需求描述只写用户可见的行为和业务约束。接口字段、数据库方案、代码路径清单、测试矩阵和联调记录放在已有设计、契约或验证产物中，用一条路径或链接引用；跨仓契约固定到版本或提交。用户提供的长篇原文保留在原来源或附件供引用。职责、依赖和迭代使用卡片字段，进展和验证用交付摘要记录。

```markdown
### 交付

- 在桌面登录界面提供超时后的重试入口。
```

## 收到任务

复用会话已加载的流程和任务约束，用投递命令中的 root、task ID 和 delivery ID 操作。

1. 只有收到投递的执行会话领取，每个 delivery ID 领取一次。使用消息中的 `herdr-team task claim <id> --delivery ID --root <team-root>`。收到成功回执就开始工作；收到 `duplicate` 就停止这次重复执行。领取结果不明时查一次原投递，确认未领取才重试。
2. 用消息里的 `inbox read` 读本次内容。首次派活显示任务描述，后续交棒只显示摘要或提示本次无摘要。已有任务上下文时按新增信息继续；缺范围、关联 Issue 或证据时再打开任务卡。
3. 按本棒职责工作，完成后使用同一个 delivery ID 交棒。代码任务按[本地 Review 与交付](#本地-review-与交付)决定何时提交。下游明确时直接交接，不额外增加 lead 中转。
   需要改链或归属不明确时通知 lead；不要猜角色、跳验收或让用户人工转述。

## 本地 Review 与交付

- **无需 Review**：开发者在 Feature worktree 完成实现和自测，直接 commit，再用 `task handoff --summary` 记录 SHA、验证结果及交付范围。没有下一位时，由这次交棒完成任务。
- **需要 Review**：开发者自测后将改动留在原 Feature worktree，提供任务号、Feature Space、验证结果和评审重点。评审人切到该 Space，在 Herdr Desktop 的 **Changes** 中查看相对 `HEAD` 的本地改动。等待或评审期间保留 worktree 并暂停写入。通过后，开发者只提交评审通过的改动，再用 `task handoff --summary` 正式交付。需要修改时在同一 worktree 返工，更新后的改动重新评审。

人工评审由开发者在原会话通知用户，说明打开哪个 Feature Space，并等待用户回复。继续使用当前任务和已领取的 delivery；等待结论属于正常评审。

团队评审用普通 `task handoff --summary` 在同一卡片交接。评审人只读同一 worktree，再把结论交回原开发者。
需要复审时，在开发者继续交棒前，lead 用 `task show <id> --json` 核对当前负责人和剩余链。把评审人、开发者加到剩余链前面，用 `task update --handoff` 写入**完整**的新链。一份原链为 `test,lead` 的卡应执行：

```sh
herdr-team task update <id> --handoff review,dev,test,lead --force --root <team-root>
```

`--handoff` 替换整条剩余链。仅在原链为空时写 `review,dev`。保持当前负责人和 delivery，开发者返工后继续用当前 delivery 交棒。

## 交付命令

普通交付保持简短，CLI 会把摘要追加到 `task.md`。

```sh
herdr-team task handoff <id> --delivery ID --summary "Updated the login flow and verified recovery." --root <team-root>
herdr-team task handoff <id> --delivery ID --summary-file <file> --root <team-root>
```

用一到三句交棒，通常 100–200 字符。写结果和关键验证，有阻塞或下一步才补一句。按需附 SHA、报告或证据链接，验证明细和实现过程放在原产物。所有新摘要最多 400 字符，包含链接和换行；`--summary-file` 使用同一上限。超长时压缩后用同一 delivery 重试。
交棒成功后，在对话中用一句话说明任务状态、接手人或剩余阻塞。用户另要详细说明时再补充。
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
任务会话随卡片保留，等待评审和退回修改时仍用原会话。会话异常退出时先核对卡片，再用 Herdr 原生会话能力恢复。恢复失败交给 lead 处理，保留旧交付记录和 uncertain 状态。

角色正文更新不让运行中 agent 自动重读 Skill；下一次派活携带当前角色正文和 delivery 命令。
旧已发出 delivery 继续原会话，未发出的队列可在投递前切到任务会话。

最后一棒按 [delivery 的收尾步骤](delivery.md#最后一棒完成后收尾)保存交付证据。任务完成或归档后，daemon 在该任务的 agent 空闲时回收其会话。共享 Feature 的合并、worktree 和端口仍按 Feature 的生命周期处理。

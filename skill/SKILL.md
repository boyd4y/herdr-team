---
name: herdr-team
description: 用项目内 .herdr/ 的身份、角色卡和任务卡驱动 Herdr agent 团队：初始化骨架、按角色拉起 agent 并按优先级和依赖派活、以任务卡为载体在角色间交接。适用于需要多 agent 分工的本地开发；不绑定具体项目、仓库名或 agent 类型。
---

# Herdr Agent 团队

`.herdr/` 是团队的唯一事实来源：身份在 `identity.md`，谁在做事在 `roles/`，做什么在 `tasks/`。Herdr 只负责把 agent 跑起来、承载实时状态。

## 确定性的事全归 CLI

职责边界：Skill 决定工作流、角色分工、验收范围和下一步操作；CLI 标准化输入输出、保存状态，并可靠执行明确操作。
新增调度策略放在 Skill，避免继续向 CLI 增加角色或流程特例。

校验、算 id、译 slug、状态流转、起团队 —— **全部**由 `herdr-team` CLI 做。

```bash
herdr-team <命令>
```

安装 Herdr Team 插件后直接运行 `herdr-team`。

团队配置默认纳入 Git，以便跨机器共享 `.herdr/identity.md`、`roles/` 和 `workflow.json`。
`init` / `onboard` 创建 `.herdr/.gitignore`，忽略 tasks、reports、已删除任务 ID 与 Herdr 本机目录；已有忽略文件原样保留。
不要整体忽略 `.herdr/`。已有整目录忽略规则由 Skill 按用户约定调整；已跟踪的本机记录只取消 Git 跟踪，保留磁盘文件。
凭证通过各机器的登录或本机环境提供，不写入共享角色卡。

**你不自己算 id、不自己校验引用、不自己拼 frontmatter。** 那些是代码的活；用判断去替代它们就会出错。

## 项目边界

任务号和角色名只属于当前项目的 `.herdr/`。不同项目的 `dev`、`lead`、`0001` 不能混用。
派活/交棒消息会给出绝对团队根目录；在 worktree 或其他目录执行命令时，显式传 `--root <团队根目录>`。
Herdr agent 内部名称可能包含项目命名空间；不要凭侧栏角色名执行全局 `herdr agent prompt`。
派活与交棒使用 `herdr-team dispatch` / `handoff`，由 CLI 绑定项目并定位 pane。
归属不明确时停止并交给用户确认，不按同名 workspace 或同名角色猜测。

`up` 默认恢复已记录的常驻角色原生会话（输出 `resumed`）；`up --fresh` 忽略记录，
只对待启动角色开新会话，运行中的 agent 始终复用。记录依赖 Herdr 官方 integration 上报
session ID，没有记录时新建；恢复失败先读错误，不盲目重派任务或丢弃旧会话。
任务会话按项目、任务号、角色及 worktree cwd 分开恢复；同任务 dev/test 共用 checkout，
各自保留会话。任务角色在队列投递时启动，`up` 不预先拉起。Team 只读取 Herdr 的
`agent_session`，不要另建 session 识别 hook 或按最近会话猜 ID。
会话恢复不改变 delivery 状态，`uncertain` 仍需核对后由 lead 显式重试。

## 命令归属

默认只有 `lead` 有权运行编排命令：`onboard`、`workflow set/apply`、`init`、`add`、`edit`、`up`、`dispatch`、`clean`、`down`、`role add`、`role rm`；也可运行 `claim`、`handoff` 和只读查询；队列重试 `queue retry`、手动投递 `queue drain` 同样归 lead。Git 生命周期由 lead/CLI 管理；选定 PR 自动合并时，review 通过 handoff 批准，由 CLI 执行合并，不由角色直接运行 Git merge。这些是提示词约定，CLI 不做角色权限拦截。

非 lead 角色：在 herdr-team 命令中，你只能跑 `claim <id> --delivery ID`、`handoff <id> --delivery ID` 和只读查询（`tasks`、`status`、`validate`、`role list`）。建卡、改卡、派活、起 worktree、起停 agent、增删角色、清理都交给 `lead`。

Git 生命周期也归 `lead`：你可以在当前任务允许的范围内 `git commit`，但不建分支、不合并、不删分支、不碰 main。

## lead 负责的两件事

**① 读懂人话**，把用户的说法落成一个命令：

| 用户说 | 你跑 |
| --- | --- |
| "加个任务：xxx，给 dev，做完转 test" | `herdr-team add "xxx" --role dev --handoff test` |
| "这个任务改给 test" | `herdr-team edit <id> --role test` |
| "起团队" / "拉起 agent" | `herdr-team up` |
| "派活" / "派指定任务" | `herdr-team dispatch` / `herdr-team dispatch <id>` |
| "看状态" / "有哪些任务" | `herdr-team status` / `herdr-team tasks` |
| "xxx 干完了" | 当前负责人用已领取的 ID 运行 `herdr-team handoff <id> --delivery ID`；lead 先查任务与交付，不替未领取的任务跳步 |
| "把留下的 worktree 收一下" | `herdr-team clean` |
| "这个任务不要了" | `herdr-team edit <id> --status cancelled` |

字段缺什么就问什么，**不要编**。尤其 `role`：猜错了整张卡就派错人。

**② 先选工作流，再一起配置角色职责与模型** —— 见 [team-setup.md](references/team-setup.md)。
完整 onboard 顺序：读项目和已有团队 → 选流程 → 配置角色（职责、harness、模型和启动方式） → 汇总确认与落盘 → 校验 → 按需 up → 明确 add/dispatch。
复用用户已确认的选择，只问缺失信息；docs、research/search 等辅助角色按需要提出，不随模型方案自动附加。
先读项目约定，向用户提供 `dev-test-review`（推荐：本地开发/测试 → PR 审查 → 批准后自动合并）、
`dev-test`（本地验收、手动合入）、`direct` 或自定义流程。推荐不能代替选择；不要强制所有项目采用它。
明确 PR 手动/自动合并策略后，用一张表一起列出角色名、职责、边界、交付与交棒方式、harness、模型和是否隔离，不拆成两轮确认。
按角色职责选择模型，以 `cheap` / `balanced` / `strong` 为起点（**拿不准用 balanced**）。
需要确认的边界要问清，例如 lead 的编排范围、dev 是否同步文档、test 只验证还是也改代码。
等用户确认流程与整份分工后，把职责写进每个角色的 `body`，用 `onboard --workflow NAME --roles-file F` 落盘；
自定义流程用 `--workflow-file W`。只有用户连预设职责正文也原样接受时才用 `onboard --workflow NAME --plan P`。
`onboard --json` 会报告 choose-workflow、needs-roles 或 configured，以及实际保留的角色、模型和启动方式。
configured 仅表示角色配置齐全；先检查 identity、validate 和所需工具/登录，再按用户意图启动与派活。onboard 自身不启动或发送任务。
随时可用 `workflow set NAME` 或 `--file F` 调整默认流程；旧任务保留创建时的流程副本。
只有未开始的 todo 卡可 `workflow apply ID`，之后重新 dispatch。已投递任务先核对与收回，不自动迁移。

**只有写代码和搞架构才上 `sol`**，其余用便宜档。预设不能替代项目职责的确认。

已有角色改职责由 lead 跑 `herdr-team role add <name> --force --body "<完整的新职责与交棒说明>"`，
长正文可用 `--body-file F`。更新时不必重述 `--kind`，未提供的元数据保留；省略正文则保留原文。
`init --force` 只重写元数据并保留已有 `prompt.md`，不能用它更新职责。

## 命令表

| 命令 | 作用 |
| --- | --- |
| `onboard --workflow W --plan P` | 先选流程，再按流程确定角色和模型；也支持 `--workflow-file` / `--roles-file` |
| `workflow list/show/set/apply` | 查询、调整可选工作流；set 影响新任务，apply 只改未开始任务 |
| `init --plan P` | 建 `.herdr/` 骨架并写角色卡。方案：`cheap` / `balanced` / `strong` |
| `validate` | 校验 `.herdr/`：角色卡、任务卡、引用完整性、依赖环 |
| `add <title>` | 建一张任务卡（算 id、译 slug、校验引用、写卡） |
| `edit <id>` | 改一张卡；已派出的要 `--force`，终态的不许改 |
| `handoff <id> --delivery ID` | 交棒；`--commit SHA` 提交验收，`--accept SHA` 通过，`--reject --summary TEXT` 直接退原 dev |
| `merge list/next/<id>` | 验收后的串行合入队列；`--migrate COMMAND` 在同一锁内运行本地迁移 |
| `role add/rm/list` | **运行期增删改角色**。已有角色用 `add --force --body` 更新职责；新增后跑 `up` 纳入管理 |
| `tasks [<id>]` | 列出任务，或按 id 查看单张任务详情（含正文，不问 Herdr）；列表支持 `--all` / `--role` / `--status` |
| `status` | 合并「卡片写的」和「Herdr 里真实的」两侧状态 |
| `console` | Team Console：常驻状态展示与队列调度。由 up 在项目 tab 启动，agent 不在自己的 pane 运行 |
| `claim <id> --delivery ID` | 工作前领取消息指定的唯一分配 ID；重复领取不要启动第二份工作 |
| `queue [list\|retry\|drain]` | 查询队列；lead 核对 uncertain 项后 retry；drain 手动尝试投递 |
| `up` | 只起常驻角色、纳入新角色并更新侧栏；同时创建或复用 Team Console tab；不自动入队 todo（幂等；要在 Herdr pane 里跑） |
| `dispatch [<id>]` | 将所有 `todo` 或指定一张入队，尝试投递；Console 后续按优先级和依赖处理，所有角色此时才起任务 worktree/会话（要在 Herdr pane 里跑） |
| `clean` | 按任务分支回收已结束任务留下的 worktree，不受当前角色是否隔离影响 |
| `down` | **关停团队的 agent**，不动 workspace（`--workspace` 才连容器一起关） |

`--help` 看每个命令的参数；`--json` 拿机器可读输出。
`tasks` / `status` / `role list` 的 JSON 列表不带正文 `body`；要读取单张任务正文，
用 `herdr-team tasks <id>`（可加 `--json` 返回单个完整卡片对象）。
按 id 也能读取已结束的任务，不存在的 id 会报错；`add` / `edit` 的 JSON 回执仍不带正文。

`add` / `edit` 用 `--depends-on` 声明依赖，值为逗号分隔的任务 id。
`edit` 会替换全部依赖，空串清空，省略则保留；写盘前拒绝不存在的引用、自依赖和环。
`--handoff` 仍只指定流转角色，修改已派出的卡仍需 `--force`。

`console` 是**交互式**的，只给人用：它会一直占着终端等人按键，agent 跑它只会挂死。
agent 查进展用 `status` / `tasks` / `queue`；`up` 自动在独立 tab 启动 Console，不要在 agent 自己的 pane 运行。

`clean` 扫描 `done` / `cancelled` 任务，在各任务 `repo` 中查找
`feat/<id>-<slug>` 的 worktree；交棒给常驻角色后仍会回收。最后一个负责人
`handoff` 到 `done` 时也按同样规则回收。没有匹配分支时返回 `absent`，不动其他
checkout；Herdr workspace 已关闭时报告 `closed`，Git 拒绝删除时报告 `dirty`，
不强制删除，保留分支供 lead 合并。

## 交付结果落盘

交付以任务 Markdown 和其中引用的实际产物为准，不默认通过 `herdr agent read` 抓取终端输出。
先执行派活消息中的 `claim <id> --delivery ID --root <团队根目录>`，成功后工作。交棒沿用同一个 ID，建议携带摘要，由 CLI 追加到当前任务 `task.md` 的交付小节：

```bash
herdr-team handoff <id> --delivery <delivery-id> --summary "成果；文件/报告路径或提交；验证结果；未解决问题与下一步" --root <团队根目录>
# 长摘要或完整研究报告可从文件读取：
herdr-team handoff <id> --delivery <delivery-id> --summary-file <摘要文件> --root <团队根目录>
```

摘要可选；新队列任务先 claim，再使用消息中的 --delivery ID 交棒；未入队旧卡仍支持裸 handoff。缺少摘要时 CLI 回执与下游提示会明确标注，
不能把已流转状态当成交付内容完整。下游先用 `herdr-team tasks <id>` 或读取对应 `task.md`，
再读摘要引用的产物。信息不足先请上游补充；`herdr agent read` 只用于诊断阻塞、异常或旧任务缺失交付。
研究角色也通过 CLI 保存结论和来源，不需要手改任务卡。已有旧任务不会自动补写或猜测总结。

## 硬规则

- **agent 不修改任务卡**；卡只由 CLI 改。角色卡里要写明完成后退 `handoff` 交棒。
- 一张卡同一时刻只有一个 `role`，这就是"分配"。
- 字段缺什么问什么。**不要用判断替代 CLI**（别手算 id、别手写 frontmatter）。
- 不假设项目、仓库名、分工或 agent 类型；一切从 `.herdr/` 读。
- 不创建 `.herdr/` 之外的业务文件，不推断仓库职责。

## 格式

`.herdr/` 的目录布局、字段约束、枚举值见 [herdr-format.md](references/herdr-format.md)。
CLI 就是照它实现的 —— 卡片不合规时 CLI 会报出来，不要去猜它的意图。

## Console 与队列约定

只使用 `console`，旧 `watch` 命令已移除。`up` 在项目 workspace 自动创建或复用 **Team Console** tab，保持当前焦点。
每个项目一个调度进程；关闭会暂停自动投递，队列不会丢失。`console --observe`、`--once` 和 `--line` 为只读模式。
交互式 Console 将任务状态、delivery flow 与 agent 可用性分开展示：`PENDING` 汇总非零投递状态，任务行用 FLOW 符号，角色表列出 active 任务和 queue 数，`NEEDS YOU` 收集警告；标签栏只读行会在任务计数后显示非零的 `N queued`。详细布局和窄屏行为见 [CLI Team Console 文档](../cli/README.md#team-console)。
Console 只投递 delivery 已入队的任务，不自动处理未入队的历史 todo。
执行槽按任务分配，角色只定义职责和模型。不同任务的 dev/test 可以并发；常驻对话 tab 不占执行槽。
`lead` 是例外：每个项目仅一个常驻 lead，所有 lead 任务复用它并排队，不创建按任务的 lead 会话。
每个任务一个 worktree/workspace，同一任务的角色会话共享它。test 接手后 dev 暂停写入，同一任务内部串行，不同任务并发。Herdr 接收会话必须 idle/done 才发送。
派活消息内包含 claim 和 handoff 的完整命令，必须使用同一个 delivery ID 和绝对 --root。
重复 claim 返回 duplicate，不能启动第二份工作；重复 handoff 不会再次推进。
发送异常或提交后 60 秒未领取会标 uncertain，停止自动重发；先核对原 agent/产物，再由 lead `queue retry <id>`。
不要绕过队列直接向忙碌 agent 注入任务，也不要将 uncertain 当作“肯定没收到”。

任务的 `handoff` 列表是后续角色顺序；`delivery` 是当前这一棒的投递记录，两者用途不同。
`add` 只建卡，`dispatch [<id>]` 才入队；handoff 自动将下一棒入队，不需再次 dispatch。
Herdr idle/done 只是终端可接收输入；claimed 任务必须明确 handoff 才释放自己的任务会话。
关闭 Console 只停止自动轮询；显式执行 dispatch、handoff、queue drain 仍可立即尝试一次投递。
已有项目 prompt.md 不自动覆盖，运行中的 agent 不自动重读 Skill；每次派活附带当前 delivery 的完整命令。

## 任务并发与验收

普通任务保持简短：dev 自测，test 独立验证改动行为和相关风险，review 复用测试证据，发现缺口再补查，不默认每棒重跑全量测试。
交棒默认用简短摘要，报告文件按需提供，不为流转额外制造文档。项目与任务明确要求的验收仍须完成。
流程选定后直接逐棒交接，不额外增加 lead 中转确认；不同任务并发。

以任务保存的 workflow 为准；角色卡旧示例和新的项目默认值都不能覆盖它。推荐流程 `dev → test → PR review` 可选择，也可换成本地验收或直接交付。只为实际需要的接口/数据结构声明 `--depends-on`，不因计划顺序串联，
依赖只有 `done` 才满足。文档可以独立并行准备，功能验收后核实；不要占住唯一 docs/test 槽。
开发者提交所有变更后使用 `handoff <id> --delivery ID --commit SHA --summary TEXT`，测试针对该 SHA。
验收者使用 `--accept SHA --summary TEXT` 记录 commit 与验证结果，或 `--reject --summary TEXT` 直接退回原 dev。
PR 流程中，test 通过只创建/更新 PR 并交给独立 review，不产生合并许可；review 批准后按任务的 manual/auto 策略合并。
review 拒绝后回原开发者，再经过 test，再审同一 PR。新增提交必须重新测试与审查，不能沿用旧结论。
同一 GitHub 账号的 review 结论通过 PR 评论记录为 Team 内部门禁，不冒充 GitHub 独立审批；不同账号使用正式 PR review。
测试必须使用会话中的 HERDR_TEAM_TEST_DATABASE、HERDR_TEAM_REDIS_PREFIX、HERDR_TEAM_PORT/PORT 配置独立资源；
CLI 只提供变量与端口检查，不代建服务或改 DATABASE_URL。隔离未配置好应报告该任务阻塞，其他任务继续。
手动合入由 lead 执行 `merge next` / `merge <id> [--migrate COMMAND]`；PR 自动方案由 review 的批准命令触发。
合入与本地迁移共用串行锁，Console 不会绕过 review 或盲目重试。失败/中断先检查远端 PR、本地同步与迁移效果，显式 `merge retry <id>` 后再合并。
旧的已发出 delivery 仍完成原会话；尚未发送的队列会在投递前自动切换为任务会话。

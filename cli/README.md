# herdr-team

用项目内 `.herdr/` 的身份、角色卡和任务卡管理 Herdr agent 团队的 CLI，交互式 Console 使用 OpenTUI Core。

需要 Bun 1.3.14 或更新版本；启动团队还需要已安装的 Herdr 和对应角色使用的 agent CLI。

实现按职责划分，先看 [模块导航](ARCHITECTURE.md)；角色模板源在 [skill/assets/roles](../skill/assets/roles)，模型目录在 [models.json](../skill/assets/models.json)，角色方案在 [plans.json](../skill/assets/plans.json) 中引用它。
初始化将模型模板复制到项目 `.herdr/models.json`（只补缺，--force 也不覆盖）。用户可直接修改目录与 preferred，项目文件优先，下一次选择直接生效。
选择和刷新由 Skill 引导；`default` 跟随 harness 本地配置，团队不添加模型覆盖参数。

## 开发验证

先在 `cli/` 运行 `bun install --frozen-lockfile`，再从仓库根目录验证：

```sh
(cd cli && bun test)
node --test tests/*.test.cjs
```

类型检查需要先在 `cli/` 安装开发依赖，再运行 `bun run typecheck`。
`cli/bun.lock` 固定运行时和开发依赖；`node_modules/` 不提交。
测试使用临时项目和 Herdr 替身，不访问真实团队。

## 快速开始

先按 [English installation guide](../README.md#install) 一次安装 CLI、skill 和 sidebar，再直接运行：

```sh
herdr-team --help
```

onboard 时先选择工作流，再用一张表一起配置各角色的职责、边界、交付与交棒方式、harness、模型和是否隔离。
预设是分工的起点；需要定制职责时，把确认过的正文放入每个角色定义的 `body`，
使用 `init --roles-file F`。只有连职责正文也原样接受预设时才直接 `init --plan`。
完整引导见插件内置的 `herdr-team` skill 中的 `references/setup.md`。
`herdr-team --help` 列出全部可用命令，具体参数用 `<command> --help` 查询。
侧栏刷新由插件事件 hook 内部执行，不提供 CLI 命令。

完整顺序：读取项目与已有团队 → 选择流程 → 配置角色（职责与模型一起定） → 保存确认后的配置 → 校验 → 启动 → 明确派活。
Skill 负责对话引导，CLI 负责确定性落盘；不会自行替用户完成选择。
onboard 是 Skill 的对话流程，不是 CLI 命令。Skill 提供工作流候选、确认角色和模型，再用 `init` 保存配置。
读 `.herdr/workflow.md` 并用 `role list --json` 核对实际角色、harness、模型及启动配置，补齐缺失职责并运行 `validate`。
初始化成功只表示文件已保存；Skill 还需核对 identity、工具和登录，再决定是否启动与派活。
角色 prompt 只保留职责与边界，协作步骤由 Skill 引导；派活消息先要求读取 Skill，CLI 命令模板只提供当前任务的准确参数。
已有角色默认保留，因此重新选择模型方案后要检查实际输出，不把保留的角色误报为已换模型或重写职责。
启动用 `up`，业务任务用 `add` / `dispatch`，分别明确执行。

在项目根目录创建团队配置，再填写 `.herdr/identity.md`（以下 roles.json 为已确认的角色定义，格式见团队设置参考）：

```sh
herdr-team init --roles-file roles.json
herdr-team validate
herdr-team add "Implement login" --role dev --handoff test,review
herdr-team tasks
```

默认共享 `.herdr/.gitignore`、`identity.md`、`models.json`、`roles/` 和可选 `workflow.md`，不整体忽略 `.herdr/`。
`init` 创建内部 `.gitignore`，忽略 tasks、reports、.retired-ids、projects、worktrees；
已有忽略文件原样保留，包括 `--force`。CLI 不改项目根 `.gitignore`，旧整目录忽略规则由 Skill 按项目约定调整。
已跟踪的本机文件用 `git rm --cached` 取消跟踪，保留磁盘内容；任务和会话不随配置跨机器恢复。

### 先选工作流，再定角色

工作流是可选建议，不是所有项目必须遵守的固定流程。CLI 不根据模型预设偷偷改变已有项目的流程。

| 选项 | 步骤 | 交付与合并 |
| --- | --- | --- |
| `dev-test-review`（推荐） | dev → test → review | dev/test 共用本地任务 worktree；测试通过后发 PR；独立 review 批准后自动合并 |
| `dev-test` | dev → test | 本地验收，通过后由 lead 手动串行合入 |
| `direct` | dev | 直接交付，适合无需测试和 PR 的任务 |

流程由 Skill 维护在 `.herdr/workflow.md`，用 Markdown 写明职责顺序、PR/本地交付和手动/自动合并即可。
CLI 不提供 workflow 命令、流程预设或默认链。创建任务始终显式提供角色和后续交接：

```sh
herdr-team add "Implement login" --role dev --handoff test,review
```

约定变化只影响后续编排。未开始任务可以用 `edit --handoff` 明确调整；已投递任务先核对执行。
新任务只有 role/handoff 执行链，不再复制一份 workflow.steps。不再执行 task workflow 快照；
旧 `.herdr/workflow.json` 不再影响新任务，也不会因过期内容阻塞 CLI。
活动旧格式先核对并取消，再按新约定建卡，不手改历史元数据。

### 推荐的 PR 流程

这是 Skill 推荐方案，可在 onboard 选择并随时调整；CLI 不强制三个阶段或固定角色名。

1. dev 自测并提交，用 `handoff <id> --delivery ID --commit SHA --summary TEXT` 交给下一位。
2. test 在同一任务 worktree 验证该 SHA。通过后由 Skill 推送任务分支，用 `gh pr list/create` 复用或创建 PR，
   再用 `handoff <id> --delivery ID --accept SHA --pr URL --summary TEXT` 保存测试与 PR 记录并交接。
   `--pr` 不会创建或推送 PR；错误仓库、分支、SHA、draft 或关闭状态都会被拒绝。
3. review 复用测试证据审查同一 SHA，用 `--accept SHA` 批准或 `--reject` 退回原 dev。
   拒绝后重走已经过的验收链；新提交必须重新测试并附上更新后的同一 PR。
4. 最后一位批准后进入合并队列。自动方案由 review 的 Skill 立即调用 `merge <id> --root <team-root>`；
   手动方案由 lead 执行。CLI 不自动根据新任务的流程约定合并。

CLI 保留 SHA 一致性、delivery 去重、PR 身份和合并锁校验。
旧 workflow 引擎、隐式 PR 发布和自动合并分支已移除；历史记录可读，活动旧格式明确报错。

列表与详情分开：`tasks --json`、`status --json`、`role list --json` 的卡片对象不包含
正文 `body`，其余元数据保留，避免批量输出被整篇任务描述或角色职责撑大。
`add --json`、`edit --json` 保持原有简短回执，不返回正文。

需要单张任务的完整内容时，用 `tasks <id>`；人类可读输出包含元数据与正文，
`--json` 返回单个完整卡片对象（含原文 `body`），不是数组。已结束的任务也可直接按 id
读取，无需 `--all`；不存在的 id 会报错并以状态码 2 退出，不输出空数组。
`--all`、`--role`、`--status` 只用于列表筛选，不影响按 id 取详情。

```sh
herdr-team tasks --json
herdr-team status --json
herdr-team role list --json
# 以项目中已有的 0001 号任务为例：
herdr-team tasks 0001
herdr-team tasks 0001 --json
```

已有角色默认跳过。`init --force` 只重写角色元数据，保留已有 `prompt.md`，缺失正文才补齐。
人类可读输出区分元数据写入、正文写入与正文保留；`init --json` 用
`roleMetadataWritten`、`roleBodiesWritten`、`roleBodiesPreserved` 三个文件路径数组替代原来的
`rolesWritten`，不再把只换元数据报告成整张角色已写。保留的正文也列入 `skipped`。
`identity.md` 和 `.gitkeep` 即使加 `--force` 也始终保留。

由 lead 更新已有角色职责：

```sh
herdr-team role add dev --force --body "你负责实现功能和同步接口文档，自测后提交；编排与分支管理交给 lead。完成后运行 herdr-team handoff <id> 交棒，不要自己改任务卡。"
```

长正文可用 `--body-file F`，两者互斥。正文整篇替换，需包含完整的新职责与交棒说明。
已有角色更新必须加 `--force`；`--kind` 和其他未提供的元数据字段保留，所以只改职责无需重述启动配置。
省略正文时逐字保留原文；新角色仍必填 `--kind`。
`init --force` 不更新已有正文，改职责请走 `role add --force --body`。
角色文件的修改不会自动向运行中的 agent 重发设定，后续派活或交棒才会读取新正文。

`add` 和 `edit` 支持 `--depends-on`：逗号分隔任务 id（如 `0001,0002`），
`edit` 时替换全部依赖，空串清空，省略则保留。写盘前校验引用与依赖环，
不存在的 id、自依赖或成环都会报错并保留原文件；`--handoff` 仍只指定流转角色。
修改已派出的卡仍需 `--force`，终态卡不允许修改。

由 `lead` 在 Herdr pane 中启动常驻团队，再将任务入队（`up` 不自动将 todo 卡入队）：

```sh
herdr-team up
herdr-team dispatch
# 只派指定的一张 todo 卡：
 herdr-team dispatch <id>
```

`up` 启动或复用常驻 agent、更新归属和侧栏，并在项目 workspace 中创建或复用 **Team Console** 原生插件 tab，保持当前焦点。它不自动将已有 todo 卡入队；Console 会继续处理先前已入队的任务。
侧栏常驻会话显示角色名（如 `test`），第二行标注 `resident`；任务会话显示 `test-0061`、
`docs-0062` 等角色与任务号，第二行标注 `task`。任务会话的工作不会重复挂在同角色的常驻会话下。
`lead` 始终复用项目内唯一的常驻会话，lead 的任务排队处理，不创建 `lead-任务号` 会话。
项目身份与角色职责随 `dispatch` / `handoff` 的实际任务发送。

常驻角色退出后，再次 `up` 默认用已保存的原生 session ID 恢复，输出 `resumed`。
ID 按规范化的项目路径和角色名分开保存在插件 state 的 `agent-sessions/` 下，不写进
项目 `.herdr/`，也不依赖 workspace/pane ID；角色的 kind 或 cwd 改变后不复用旧会话。
运行中的 agent 始终复用。需要忽略记录、按当前角色卡启动新会话时：

```sh
herdr-team up --fresh
```

`--fresh` 只影响待启动的角色，启动成功后清除它的旧记录；不会重启正在工作的 agent。
角色卡 `args` 显式指定的 resume/session 参数优先，不叠加自动恢复参数。
恢复失败保留记录并输出原因，不自动改成新会话。没有记录时正常新建。

自动记录依赖 Herdr 官方 integration 上报 `agent_session`。例如使用 Codex/Grok 时，
分别运行 `herdr integration install codex` / `herdr integration install grok` 安装或更新集成，
在后续启动或会话事件上报后才能记录；已有会话不会按目录或“最近一次”猜测 ID。
`up`、`down` 关停前、sidebar 刷新以及 agent 状态变化事件会保存当前已上报的 ID。
插件事件只写本地记录，不发送消息、不回写 metadata，无 daemon。
直接强制关闭 pane 前若尚未捕获 ID，就没有可恢复记录。
任务会话按项目、任务号和角色分别保存，并校验对应 worktree 的 cwd；开发和测试即使共用
一个 worktree，也各自恢复自己的原生会话。任务角色仍由队列实际投递时启动，不由 `up`
预先拉起。恢复会话不会重放任务、改变 delivery 状态或绕过 `uncertain` 的人工核对。
Team 只读取 Herdr 的 `agent_session`，无需另装 Team 专用的 CLI hook，也不解析会话文件。
GitHub 安装请通过 Herdr 插件管理器更新或重新安装。更新本地 link 的检出时，在仓库根目录运行 `herdr plugin link .` 以加载更新后的 manifest 和事件钩子，再运行 `herdr plugin action invoke herdr-team.install` 更新内置 CLI、skill 并应用托管配置。`herdr-team.configure` 只应用托管布局/配置并 reload config，不会注册更新后的 hook，也不会更新 CLI 或 skill。

`dispatch [<id>]` 将 todo 卡持久化入队，并尝试立即投递一条符合条件的任务。
未指定 id 时入队全部 todo 卡；指定不存在或非 todo 的 id 会报错。队列按 priority、入队时间和 id 排序，只有显式依赖全部 `done` 后才可投递，取消不代表接口已经交付。不要因计划顺序添加依赖。
并发单位是任务，不是角色：`dev-0046`、`dev-0047` 或 `test-0050`、`test-0052` 可以同时工作。
每个任务一个工作分支和 Herdr workspace，同一任务的各角色使用自己的 tab/会话，默认复用该任务 worktree。
接收会话只有 `idle` / `done` 时才接收；忙碌或异常只阻塞它所属的任务。常驻角色 tab 用于对话，不占任务执行槽。
旧卡片中尚未发送的队列项会在投递前迁移为任务会话；已发出的 delivery 保持原 pane，避免重复执行。

队列直接保存在 `.task.yaml` 的 `delivery` 中，无数据库和独立系统服务：

- `queued`：等待真实依赖或该任务的 agent 可用。
- `sending`：已记录目标 pane，正在提交输入。
- `submitted`：Herdr 已接受输入，等待 agent 领取。
- `claimed`：agent 已运行 `claim`，占用该任务会话直至交棒，不占用整个角色。
- `uncertain`：无法确认送达、提交后 60 秒未领取，或已领取的 agent 丢失/换会话；暂停自动重发。

每次分配带唯一 delivery ID。agent 必须先运行消息中给出的领取命令，完成时使用同一个 ID：

```sh
herdr-team claim <id> --delivery <delivery-id> --root <team-root>
herdr-team handoff <id> --delivery <delivery-id> --summary "Results; artifacts; validation; risks" --root <team-root>
```

重复领取会返回 `duplicate: true`，此时不要启动第二份工作；重复交棒不会再次推进角色或追加摘要。
交棒先保存摘要和下一个角色的队列项，再尝试投递。接收方忙时留在队列，Console 后续自动处理。
重启后发现残留 `sending` 会转为 `uncertain`，不会假定上次没有送达。
消息可能已送到，**先核对 agent 和任务产物**，再由 lead 显式重试：

```sh
herdr-team queue --json
herdr-team queue retry <id>
herdr-team queue drain
```

`retry` 仅接受 uncertain 项，并分配新 ID，使旧领取令牌失效；`drain` 手动尝试投递一条，便于 Console 关闭时使用。
取消、改派角色或强制退回 todo 会清除旧 delivery。尚未入队的旧任务保持原行为；一旦进入新队列，就必须领取并携带 ID 交棒。
任务变更通过项目排他锁串行，历史写入可在重启后补齐。队列避免盲目重复发送，并不保证底层终端消息恰好执行一次。

### 按任务开发、验收与合并

本地 `dev-test` 方案和未选择 PR 工作流的旧任务使用 `dev ⇄ test → merge queue`。
推荐的 PR 方案见上方“推荐的 PR 流程”；其测试通过只进入 PR 审查，不能直接合并。
例如本地方案用 `add "Fix login" --role dev --handoff test`。
开发者提交后交棒，验收者必须核对并记录同一个 commit：

```sh
herdr-team handoff 0046 --delivery <dev-delivery> --commit <sha> --summary "Implemented; ready for review"
herdr-team handoff 0046 --delivery <test-delivery> --reject --summary "Reproduction steps and defects"
# 或者通过验收：
herdr-team handoff 0046 --delivery <test-delivery> --accept <sha> --summary "Tested <sha>; validation results"
```

默认 dev/test 复用同一个任务 worktree，交给 test 后 dev 暂停修改；开始测试和接受结果时都检查 HEAD 和干净状态。
同一任务按 `dev → test` 串行推进，不支持开发和验收同时修改工作区；不同任务可以并行。
拒绝会直接返回提交该版本的 dev，并保留原验收角色和后续交棒链。再次提交后使用新的 commit 验收。
通过验收后的最后一次交棒进入合并队列，保持 `review`，不会提前标记 done 或回收 worktree。
文档可用独立任务提前准备，也可以在提交验收前补齐；验收后继续提交修改需要重新验收该版本。

每个任务/角色会话会注入 `HERDR_TEAM_TASK_ID`、`HERDR_TEAM_NAMESPACE`、`HERDR_TEAM_TEST_DATABASE`、
`HERDR_TEAM_REDIS_PREFIX`、`HERDR_TEAM_PORT` 和 `PORT`。数据库名与 Redis 前缀包含项目、任务和角色，
端口由系统分配并记录，启动前检查占用。测试项目需用这些变量创建独立测试数据库、设置 Redis key 前缀和监听端口；
插件不会猜测或覆盖 `DATABASE_URL`，也不会自动创建数据库/Redis 服务。无法配置隔离时应报告阻塞，不能改用共享库。
端口检查与服务真正启动之间仍有竞争窗口，服务绑定失败时应报告并处理冲突。

合入主分支与显式指定的本地迁移共用独立串行锁，不占 dev/test/对话执行槽：

```sh
herdr-team merge list
herdr-team merge next
herdr-team merge 0046 --migrate 'bun run db:migrate'
```

`merge next` 选择队列中的下一张卡；也可以指定 id。仅在任务 repo 的 `main` / `master` 主检出执行，
工作区除 `.herdr/` 外不能有已跟踪修改。命令只合入验收的 SHA，要求任务分支 tip 仍与其相等，再在同一锁内运行可选迁移。
成功后才标记 `done`；`clean` 可以回收任务 worktree。Console 不自动合并或执行迁移。
失败会标记 `blocked` 并保留冲突/迁移效果，其他独立任务继续开发、验收和入队；其他 queued 项仍可手动合入。
先检查主检出、解决冲突并确认迁移效果，再用 `merge retry <id>` 显式重新入队。
进程中断留下 `running` 时同样必须核对，不自动重试。分支新增提交会阻止合入，需重新验收，不能直接 retry 绕过。
迁移已经部分执行时，重试前需确认其幂等性；CLI 不会自动回滚或猜测是否需要重跑。

`up --json` 返回 workspace、角色结果和 `console`（started / reused / failed）；会话恢复为 `resumed`，记录保存失败附带 `sessionWarning`。

### 多项目边界

角色名和任务号只在本项目的 `.herdr/` 内解释。不同项目可以同时存在 `dev`、`lead`、
`0001`，CLI 会通过项目身份查找 agent，并向具体 pane ID 发送消息。
另一个项目占用同名 agent 时，新 agent 自动使用内部命名空间，显示名仍是角色名。
不要用 Herdr 全局的裸角色名代替 `herdr-team dispatch` / `handoff`。
workspace 复用按项目绑定或可验证的目录判断，不按相同的文件夹名称合并。
归属不明确时拒绝操作；旧团队可在自己的项目目录运行 `up` 补上绑定。
跨目录操作时使用消息中的绝对团队根目录：`herdr-team handoff <id> --root <团队根目录>`。

### Agent 列表

插件把每个 agent 显示为两行：第一行是 workspace 归属编号、角色与 harness，
第二行是模型与当前任务 ID。编号与 spaces 区的 `①`、`②` 一一对应，子 worktree
继承主 workspace 的编号及颜色。编号使用固定的八色循环，颜色与编号绑定。
编号保存在插件 state 中，重命名、排序和恢复不变。
任务完成或交棒后清除旧负责人的 ID；常驻角色同时有多个任务时列出全部 ID。
模型来自角色卡，未配置时显示 `default`，不推测 agent 内部当前选择的模型。

插件事件 hook 自动刷新现有 agent 信息、归属编号和 Git 摘要，不启动或重启 agent。
主 workspace 和普通 workspace 的 spaces 第二行显示一个 `team_git_summary` 文本摘要，包含本地分支、
未提交文件数和 ahead/behind 提交差异，例如 `main · 📄15 ↑10`、`main · 📄0` 或
`main · 📄2 ↑3 ↓1`。只显示非零的 ahead/behind 数；没有 upstream 时仍显示分支和文件数，
但不显示箭头。Detached HEAD 不显示分支名。文件数包含暂存、未暂存和未跟踪文件，
每个文件计一次、重命名计一次，忽略文件不计。Git 不可用时会清除摘要，不会显示 `📄0`。
数据来自本地 Git 和 tracking refs，不会自动 fetch。摘要字段最多 80 个 Unicode 字符；
长分支名只会缩短显示前缀并以 `…` 结尾，完整的文件数和提交差异仍会显示，Git 中的实际分支名不变。

链接 worktree（嵌套和单独显示的 workspace 都适用）只显示第一行名称标签，不显示
文件数、ahead/behind 提交差异或额外的空白第二行。嵌套子 worktree 不重复显示归属编号；
单独显示的链接 worktree 保留稳定编号。workspace 变成链接 worktree 或 Git 不可用时，旧摘要会被清除；
变回主/普通 workspace 后会重新显示 Git 详情。

标签栏定时命令可使用 `HERDR_ENV=1 herdr-team console --line --follow --sync-git`；
`--sync-git` 必须与 `--line` 一起使用，会在输出状态行前刷新 Git 摘要。
`--line` 本身不调度任务。Git 摘要也会由 sidebar 刷新及插件生命周期钩子更新；
刷新频率由 Herdr 该 command 的 `interval_seconds` 控制。
新增 workspace 与 agent 由插件事件钩子自动同步。更新本地链接的事件钩子时按上面的升级步骤操作；
只需重新应用布局时运行 `herdr-team.configure` action，它会保存托管配置并 reload config。

### Team Console

`console` 集中显示任务、角色的当前工作与队列数、领取状态和异常，并驱动自动投递。
`.herdr/tasks` 的任务文件变化触发项目快照更新；Herdr 插件事件通知 agent 状态、会话和 pane 变化。
投递超时按截止时间唤醒，默认每 60 秒做一次兜底同步，空闲时不再每 2 秒全量读取任务和查询 Herdr。
`up` 自动在项目 workspace 中打开这个常驻 tab；也可以在 Herdr 终端中手动运行：

```sh
herdr-team console
```

Console 使用 [OpenTUI Core](https://github.com/anomalyco/opentui) 的列表、输入框、滚动框、flex 布局和 Timeline 动画。
框架负责按键解析、焦点、鼠标滚动、终端绘制、动画帧调度和退出恢复。

- 顶部显示全项目任务、排队、投递中、已领取、需处理和待合并计数；搜索不改变这些数字。
- `TASKS` 默认按 ID 倒序展示任务，最新任务在最上面；优先级与状态显示在标题下方。
- `FLOW` 根据任务的验收记录、当前负责人、剩余交接角色和实际合并记录生成节点，不推测或维护工作流。
  投递光迹通过相邻字符亮度渐变移动，进入执行状态时边框短暂呼吸，随后停止连续绘制；角色退回时显示反向交接。
- `DETAIL` 展示原因、投递时长、agent、模型、分支、提交及 task.md 正文（含交接记录），不另设 Activity 面板。
- `ROLES` 每行一个角色，列出角色名、实时状态、当前任务与排队数；按角色数量分配高度，避免任务列表的空白挤占角色区。
- `NEEDS YOU` 汇总加载失败、Herdr 不可用、状态不一致和校验问题。

宽窗口左侧为任务与角色，右侧流程图与详情上下各占一半。窄于 90 列时，任务与角色并列放在顶部，
流程仍用紧凑纵向节点，与详情等分剩余高度；角色与长流程均可滚动。
`Tab` 在任务、角色、流程、详情间切换焦点，`PgUp`/`PgDn` 滚动当前面板（默认详情），`r` 立即刷新。
动画由 OpenTUI 按需渲染，目标 60fps；只更新光迹和节点颜色，不查询 Herdr 或读取任务文件。
长流程首次显示和改变负责人后会定位当前节点，其余时间允许手动滚动。
小于 40 列或 20 行时显示缩放提示并暂停隐藏动画；恢复大小后继续，选择状态保留。
Detail 会显示合并阻塞的具体原因；已结束任务不计入待投递统计，已删除的历史角色仍可阅读。

`↑↓`（或 `j`/`k`）选任务、`PgUp`/`PgDn` 翻详情正文、`a` 切换是否显示已结束的卡、
`/` 进入搜索，边输入边按 id、标题、角色过滤；`Enter` 保留过滤并退出输入，
`Backspace` 删除一个码点，`Esc` 退出输入并清空过滤（输入外且无过滤时退出看板）。输入时字母快捷键作为查询文本，
`Ctrl-C` 始终退出；输入外 `q` 退出。搜索按子序列匹配，ASCII 大小写不敏感，中文按码点匹配；
结果优先显示靠前、连续的匹配，同分按 ID 倒序排；空查询恢复 ID 倒序。
搜索沿用 `a` / `--all` 的范围，输入框保留查询，TASKS 标题显示命中数/范围内任务数，角色和健康检查仍显示全项目。

`--interval <秒>` 改兜底同步间隔（默认 60，调度时必须大于 0），不影响文件和 Herdr 事件的即时更新。
`--all` 显示已结束的卡。`r` 会强制重新读取，而不只使用缓存。
每个项目只允许一个调度 Console。关闭 tab 或按 q 退出会暂停自动投递，队列仍保存在磁盘；再次 `up` 或运行 `console` 即可继续。
`down` 会先让 Console 退出，再关闭团队 agent。
`console --observe` 是同一 Console 的只读模式，可同时打开多个，适用于 popup；`--interval 0` 关闭定时兜底，仍响应文件和 Herdr 事件。
`console --sample` 是独立的内存演示，不要求 `.herdr/` 或 Herdr 环境，不获取 Console 锁、不启动 agent、不写入项目或运行记录。
每约 5 秒切换一个阶段，循环展示执行、交接、退回、完成；列表也包含排队与阻塞的任务，可正常搜索、选择和滚动。
`console --sample --once` 输出一帧纯文本，`--interval 0` 可停止自动切换。
真实 Console 的空状态提示按 `s` 进入演示；任何时候都可用此键切换，演示期间暂停真实调度，返回后恢复。
只保留 `console` 命令，旧 `watch` 入口已移除。

**这是给人看的，不要放进 agent 的流程里**：它会一直占着终端直到有人按键。
非交互地看状态用 `herdr-team status`（可加 `--json`）。

没有真终端时用 `--once`，只渲染一帧就退出 —— 管道和脚本里都能用，也永远不会把终端
留在半路。非 TTY 又没给 `--once` 时同样只打一帧，并在 stderr 提一句。

## 放进 Herdr

`up` 使用 manifest 中的 `console` pane，在明确的项目 workspace 中直接启动 CLI；不检查 shell、不注入命令。每个项目的 Console 锁和启动票据仍负责避免重复调度。原有活跃 Console 会复用，失效的旧 pane 不会被覆盖。

安装配置提供两个带上下文的 Actions：

| 快捷键 | Action | 行为 |
| --- | --- | --- |
| `prefix+t` | `herdr-team.team-status` | 在项目 workspace 打开只读 Team Status 插件 tab，不获取调度锁、不派活 |
| `prefix+Shift+t` | `herdr-team.open-console` | 打开或聚焦项目唯一的 Team Console tab |

已有用户快捷键优先保留。动作从 `HERDR_PLUGIN_CONTEXT_JSON` 的调用 pane/workspace 定位项目，不使用插件 cwd，也不重新跟随可能变化的 UI 焦点；任务 worktree 使用主检出的 `.herdr/`。缺少配置、pane 已关闭/移动、归属不符时停止并报错。

```sh
herdr plugin action invoke herdr-team.team-status
herdr plugin action invoke herdr-team.open-console
```

插件声明 `console` 和 `status` 两个原生 pane，后者使用 `console --observe`。本机最低支持 Herdr 0.9.3，两种入口均使用 tab，不依赖更新版本的 plugin popup。CLI 和 Bun 必须在 Herdr server 的 PATH 上；退出使用 `q`。

**标签栏一行** —— 永远可见、零布局成本：

```toml
tab_bar_right = [
  { type = "command", command = "HERDR_ENV=1 herdr-team console --line --follow", interval_seconds = 10, timeout_seconds = 5 },
]
```

`--line` 打一行，形状 `team: 1 doing 2 todo · 2 queued · 1 blocked · 1 ✗`：前半段是未结束的卡按
`doing`/`review`/`todo` 计数；非零等待投递数 `N queued` 紧随任务计数、位于 `blocked` 之前；`blocked` 是**卡住、等你处理的卡**（卡片自己写着 blocked，
或 agent 在等你 / agent 掉了 / 干完没交棒，按卡去重）；`✗` 是 `.herdr/` 的校验问题数 ——
坏卡会被静默跳过，不报的话你只会看到数字悄悄变小。**没事就不输出**（和
`herdr-projects` 的 `needs-you --line` 一个规矩），不在团队项目里也什么都不输出。

`--follow` 在标签栏这个场景里是**必需的**：那条命令跑在 Herdr **服务器进程**里，
cwd 是服务器启动时的目录（通常是你家目录），从那儿往上找 `.herdr/` 永远找不到，
这行会一直空白。跟了焦点 pane 之后，它显示的是**你正在看的那个 workspace** 的项目。
在命令行手动跑时不需要它（cwd 就是项目）。

改完记得 `herdr config check`，再 `herdr server reload-config`。

和 `status` 有一处**有意的不同**：`console` 是容错启动的。`.herdr/` 里有坏卡不会拦着
不让你看（看板恰恰是卡坏的时候最想看），坏卡会被跳过、并在帧里的 `NEEDS YOU` 区用 `✗` 报出来 ——
所以卡片总数可能比 `tasks/` 下的目录数少，看到这类提示就是原因。

在 linked worktree 里跑会读**主检出**的 `.herdr/`（`findRoot` 的既有行为，见
`scripts/lib/team/project.ts`）—— 那才是活的卡片，worktree 里那份是切出去时的过期副本。

自动查找项目根时，`.herdr/` 中至少要有 `identity.md`、`roles`、`tasks` 之一；
只有 `projects/`、`worktrees/` 的 Herdr 数据目录不会被当成团队项目。
子目录仍可向上找到项目，只建了一部分配置的项目也能被识别。
找不到时普通命令提示用 `--root` 指定，`console --line` 静默退出；
`init` 则在当前目录创建配置。显式 `--root` 仍允许定位待校验的 `.herdr/`。

默认编排命令（含 `init`、建卡、改卡、派活、起停团队、增删角色、清理）及 Git 分支的创建、合并、删除都归 `lead`。
其他角色用 `claim` 领取、`handoff --delivery ID` 交棒，以及 `tasks`、`status`、`validate`、`role list` 只读查询；允许在任务范围内提交，但不碰 main。
这是提示词约定，CLI 不做角色权限拦截。任务完成后由当前角色交接：

```sh
herdr-team handoff <id> --delivery <delivery-id> --summary "成果；产物路径/提交；验证结果；风险与下一步"
herdr-team handoff <id> --delivery <delivery-id> --summary-file summary.md
```

摘要可选，两个参数互斥；提供后由 CLI 追加到任务 `task.md` 的“交付”小节，再通知下游先读正文和引用产物。
空摘要、文件读取失败在流转前报错；原有描述和历次交付保留。最终 done 或下游未在线时也会保存摘要。
未进入队列的旧卡可裸 `handoff <id>`，回执和下游提示明确标记未提供摘要。JSON 包含 `summarySaved` 和绝对 `taskPath`。
下游通过 `herdr-team tasks <id>`（可加 `--json`）读取交付内容；`herdr agent read` 仅用于排障，不能替代任务产物。

最后一次 `handoff` 到 `done` 时会尝试回收 worktree；`clean` 回收所有
`done` / `cancelled` 任务留下的 worktree。两者都在任务 `repo`（缺省 `.`）中
按 `feat/<id>-<slug>` 查找，不受当前角色是否隔离影响，交棒给常驻角色后仍能回收。
没有匹配分支时返回 `absent`（原常驻角色的 `not-isolated` 结果已移除），不动其他
checkout；Herdr workspace 已关闭时报告 `closed`，Git 拒绝删除时报告 `dirty`。
回收不强制删除，保留分支供 lead 合并。

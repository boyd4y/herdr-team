# `.herdr/` 格式规范

共享约定在**目标项目根目录的 TEAM.md**，本地执行数据在 `.herdr/`。本文件是唯一的格式权威：字段、枚举、约束都以它为准。
`herdr-team` CLI 就是照它实现的。

## 元数据与散文分开

**一个 item 一个目录，元数据放点文件，正文是纯 Markdown。**

```
<project>/
├── TEAM.md                     各角色的简短中文步骤，纳入 Git
├── agents.json                 按 harness 保存完整配置预设，纳入 Git
└── .herdr/                     以下为本地执行数据
    ├── .retired-ids                已删除任务的 id，一行一个，只追加
    ├── roles/
    │   └── <name>/
    │       ├── .role.yaml          元数据
    │       └── prompt.md           散文：角色设定
    ├── issues/
    │   └── <issue-id>/
    │       ├── .issue.yaml         元数据
    │       ├── issue.md            Issue 正文
    │       └── acceptance.md       验收标准
    └── tasks/
        └── <id>-<slug>/
            ├── .task.yaml          元数据
            └── task.md             散文：任务描述 + 流转记录
```

这么摆的理由是**避免「读—改—写」的往返**：

| 内嵌 frontmatter 的问题 | 拆开之后 |
| --- | --- |
| 读要正则切出 YAML 块 | 直接读 `.role.yaml` |
| 写要重排整个文件，会丢注释和空行 | 只重写元数据文件，散文一个字不碰 |
| 手改的人要同时守 Markdown 和 YAML 两套语法 | 各自守一套 |
| `id: 0001` 加不加引号行为微妙 | 元数据独立，规则简单 |

**身份来自路径，元数据里不重复存**。角色名、Issue ID 和任务的 `id`/`slug` 都来自目录名。
没有冗余就没有漂移。

`.retired-ids` 首次 `rm` 时才创建。扫描跳过以 `.` 开头的条目。

`.herdr/` 整体保留在本机，不纳入 Git，包括角色引用、任务和临时产物；根 TEAM.md 与 agents.json 不在忽略范围。
`init` 在项目根 `.gitignore` 追加 `/.herdr/`；已有内部忽略文件保留，不再新建。
可复用默认模板位于插件的 `skill/assets/`，不通过提交项目 `.herdr/` 分享。

## `TEAM.md`

根目录的纯 Markdown，只按实际角色列简短中文编号步骤，提交 Git 共享。
首次处理团队工作或发现更新时读取；缺失时由 Skill 按 [setup](setup.md#团队约定-teammd) 初始化。
CLI init 只复制缺失模板，已有文件即使 force 也保留。CLI 不解析流程或自动生成 handoff。
派活和交棒携带主项目根的 TEAM.md 路径及内容修订标记。同一会话复用该修订的约定。
AGENTS.md 维护工程约束；交棒、协作、PR、队列与收尾属于 Skill，不复制到 TEAM.md。

## 角色 `roles/<name>/`

### `.role.yaml`

| 键 | 必填 | 类型 | 约束 |
| --- | :--: | --- | --- |
| `kind` | ✅ | enum | 见 [kind 枚举](#kind-枚举)。**agent 类型** —— 是属性，不是身份 |
| `preset` | | str | 引用根 agents.json 中 kind 下的预设；与 model/args/env 互斥 |
| `model` | | str | 不使用 preset 时的**显示短名**（`gpt-6.1-sol` / `sonnet` / `default`）。真正的模型由 `args` / `env` 决定 |
| `lifecycle` | | enum | `resident` 随 `up` 启动，`temporary` 派发时启动。见 [隔离与常驻](#隔离与常驻) |
| `worktree` | | bool | 旧版角色启动配置。省略 `lifecycle` 时，`true` 跳过预启动 |
| `cwd` | | str | 相对项目根；**禁止 `..` 逃逸项目根** |
| `args` | | list[str] | 透传给该 agent 的可执行文件 |
| `env` | | map[str,str] | 由 CLI 在启动对应会话时传入环境变量 |

**没有 `name`。** 角色名就是目录名。

推荐使用 `kind + preset`。读取时解析主项目根的 agents.json，得到实际 model/args/env，常驻与任务会话共用。
预设字段与选择、生效规则见 [agents.md](agents.md)。职责和隔离设置仍属于角色，不放入 agent 预设。

不带 preset 的已有角色继续使用显式 args/env，model 仅用于显示；修改这些旧配置时要保持显示与实际启动一致。
升级不会静默改写角色或已有会话。

### `prompt.md`

角色职责、边界和交付要求，会作为该 agent 的 prompt 素材。协作步骤由 Skill 和 TEAM.md 引导，不复制操作流程。
文件可以缺席（视为空）。

### 名字即身份

角色名一个值同时供三处使用：

| 位置 | 取值 | 怎么设 |
| --- | --- | --- |
| 角色目录 | `roles/<name>/` | 建目录时定 |
| tab 标签 | `name` | `tab create --label <name>` |
| agent 逻辑名 | `name` | 空闲名称可直接使用；全局重名时由 CLI 加项目命名空间 |

三者使用同一角色身份；内部 agent 名可能因全局重名而带项目命名空间。
侧栏第一行显示归属编号、角色和 harness，第二行显示模型与任务 ID，隐藏内部名称。

**不要把属性写进角色名：**

- `kind`（`codex` / `kimi`）是 **agent 类型** —— 属性
- `model`（`gpt-6.1-sol`）是**模型** —— 属性
- 「主力开发」这类描述**也不是名字** —— 名字是角色，如 `dev`、`search`

## Issue `issues/<issue-id>/`

`<issue-id>` 形如 `R0001`。每条需求或缺陷单独存储。

| `.issue.yaml` 字段 | 用途 |
| --- | --- |
| `title` | 单行标题 |
| `type` | `requirement` 或 `defect` |
| `priority` | `P0` 到 `P3` |
| `iteration` | 版本号或空字符串 |
| `acceptedAt` | 验收时间或 `null` |

Issue 列表读取元数据，根据关联任务的状态计算进度。详情按 ID 读取 `issue.md` 和 `acceptance.md`。验收后这两份 Markdown 由 CLI 保护。
`herdr-team issue migrate` 可提前转换旧 `requirements.json`，首次新增、编辑或验收 Issue 也会自动转换。
迁移保留编号和原文，将原文件备份到 `issues/.legacy-requirements.json`。迁移前的旧文件仍可通过只读命令查看。

## 任务 `tasks/<id>-<slug>/`

### `.task.yaml`

| 键 | 必填 | 类型 | 约束 |
| --- | :--: | --- | --- |
| `title` | ✅ | str | 单行，≤80 字符。**中文可以** |
| `priority` | ✅ | enum | 见 [priority 枚举](#priority-枚举) |
| `status` | ✅ | enum | 见 [status 枚举](#status-枚举) |
| `role` | ✅ | str | **当前负责人**。必须解析到存在的角色 |
| `handoff` | | list[str] | **剩余流转队列**（有序）。每项必须解析到存在的角色 |
| `depends_on` | | list[str] | 每项必须解析到存在的任务 `id`；**禁止环** |
| `requirement` | | str | 关联的 Issue ID，例如 `R0001` |
| `feature` | | str | 交付批次的 Feature 名，例如 `session-recovery`。临时角色派发需要 Feature 和迭代 |
| `iteration` | | str | 版本号，例如 `v1.2`。可继承关联 Issue 的迭代。Feature 首次准备投递时固定实际版本 |
| `execution` | | str | 新任务为 `task`；未发送的旧队列投递前自动迁移 |
| `delivery` | | object | 当前内部投递。由 CLI 管理，状态供 daemon 调度 |
| `completed_deliveries` | | list[str] | 已完成交棒的投递 ID，用于识别重复请求 |
| `inbox_receipts` | | list[object] | 成功交棒时保存的内部消息回执，供 Inbox 的 Read 视图和执行复盘查询 |
| `review` | | object | commit、developer、当前指定 reviewer；后续验收阶段接手时更新，由 CLI 管理 |
| `acceptance` | | object | 当前阶段验收 commit 与 role；转交后续 test/review 时清空，最终验收后才允许合入；由 CLI 管理 |
| `integration` | | object | 验收 commit 与 queued/running/blocked/done；由 CLI 管理 |
| `repo` | | str | 开 worktree 用的仓库，相对项目根。缺省 `.`（项目根本身） |

**没有 `id`。** 它来自目录名。

当前 `delivery` 用 `id` 标识本次投递，`role` 是收件角色，`queued_at` 是入队时间，新交棒用 `sender` 记录发件角色。`state` 可为 `queued`、`sending`、`submitted`、`claimed` 或 `uncertain`。Inbox 根据该条投递是否已有处理回执显示 Unread 或 Read。

每个 `inbox_receipts` 条目保存投递 `id`、`role`、`subject` 和 `queued_at`，有记录时还保存 `sender`。有交付摘要的投递和回执通过 `summary_ref` 定位 `task.md` 中的交棒记录，用 `summary_length` 保存摘要的 JavaScript 字符串长度。正文在打开消息时从 `task.md` 读取。无摘要引用时读取任务描述。旧记录可能只有 `completed_deliveries` 和 Markdown 历史。

### `task.md`

正文 = 任务描述，末尾可以带一个 `## 流转记录` 小节。文件可以缺席（视为空）。
`handoff --summary TEXT` 或 `--summary-file F` 会在流转记录中追加带时间、上游和下游角色的 `### Delivery` 小节，原文保留。
摘要可选；未提供时不编造内容。下游优先读取任务正文及引用产物，终端回读只作为诊断手段。

`## 流转记录` 是**追加式，只增不改**。每行一次状态变化：

```markdown
## 流转记录
- 2026-10-15 00:30  → dev  (todo → doing)
- 2026-10-15 01:10  → docs  (doing → review)
```

### `role` 与 `handoff` 的关系

`role` 是当前负责人，`handoff` 是**还没走完的后续队列**。队列随流转逐段缩短：

| 事件 | `role` | `handoff` | `status` |
| --- | --- | --- | --- |
| 建卡 | `backend` | `[reviewer]` | `todo` |
| 接手 | `backend` | `[reviewer]` | `doing` |
| 交棒 | `reviewer` | `[]` | `review` |
| 验收通过 | `reviewer` | `[]` | `review`（merge queue） |
| 合入与迁移成功 | `reviewer` | `[]` | `done` |

**`handoff` 空不等于任务完成** —— 它只说明当前这个负责人是最后一个。所以交棒给最后一个角色后
状态是 `review`。有 commit 验收的任务最后交棒进入合并队列，合入成功才变 `done`；
未提交 commit 验收的纯调研/文档任务仍可由最后负责人交棒完成。

`feature finish <name> --iteration <version>` 确认整个批次交付。任务完成或归档后，daemon 自动关闭已空闲且归属明确的任务会话。
旧任务在 Herdr TUI 最后一次 `handoff` 到 `done` 时沿用原来的 worktree 回收流程。`clean <id>` 回收指定终态任务，不带 ID 时扫描所有
终态任务。两者都在任务的 `repo`（缺省 `.`）中按
`feat/<id>-<slug>` 查找 worktree，与卡片当前角色的 `worktree` 配置无关，
因此交棒给常驻角色后仍能回收。没有匹配分支时返回 `absent`，不动其他 checkout。
CLI 会报告阻止清理的原因，包括工作树改动、归属不明和任务仍在使用。回收保留分支，供 lead 后续合并。

## 隔离与常驻

`up` 起常驻对话并登记自动投递，`dispatch` 创建任务执行会话。角色不是独占执行槽。

```text
project workspace
  lead / docs / test conversation tabs
  Team Console
  task 0046 workspace: feat/0046-fix-login
    dev-0046 → test-0046 (same checkout; dev pauses writes during review)
  task 0047 workspace: feat/0047-calendar
    dev-0047 → test-0047 (independent checkout)
```

`lifecycle: resident` 的会话由 `team up` 启动、`team down` 关闭。
`lifecycle: temporary` 的会话按需启动，归属该任务的 Feature 和迭代。同卡不同角色共享分支与 workspace，下一棒返回已参与的角色时复用其任务会话。
同一临时角色可以同时执行多张任务。省略 `lifecycle` 的角色沿用原来的启动和执行方式。
全局名字冲突时使用项目命名空间，侧栏保留职责与任务编号。

`handoff --commit SHA` 固定验收版本，测试前与接受时核对干净 checkout 和 HEAD。
同一任务 dev/test 复用 worktree，按阶段串行，dev 在 test 持有任务时停止写入。
`--reject --summary TEXT` 直接退回原 dev；`--accept SHA --summary TEXT` 通过。
验收后的最后一次交棒进入 integration 队列，只有 `merge next/<id>` 成功才算 done。
合入与可选 `--migrate COMMAND` 共用一个串行锁；执行和对话不占这个锁。
旧的已发送 delivery 不改接收 pane，避免双重执行。

## id 与目录名

任务目录名是 `<id>-<slug>`，例如 `tasks/0001-forgot-password/`。

### `id`

| 规则 | 值 |
| --- | --- |
| 格式 | `^[0-9]{4}$`，即 `0001`–`9999` |
| 分配 | `max(现存 tasks/ 的 id, .retired-ids 的 id) + 1` |
| 起点 | `0001` |
| 永不重编号 | 已分配的 id 永不改变 |
| **永不回收** | `rm` 掉的 id 写进 `.retired-ids`，不再使用 |

`max` 必须**同时**看 `tasks/` 和 `.retired-ids`。只看现存的话，删掉当前最大的 id 之后
下一个又会算出同一个号。

算出超过 `9999` 时报错停下，让人工介入。

### `<slug>`

| 规则 | 值 |
| --- | --- |
| 正则 | `^[a-z0-9]+(-[a-z0-9]+)*$` |
| 长度 | ≤40 字符 |
| 语言 | **必须英文** |
| 来源 | 由 agent 从 `title` **译出**，不是截断字符串 |
| 可改名 | 可以。slug 只是给人看的，`id` 才是身份 |

`title` 是中文时，slug 仍然是英文。例：

- `title: 实现忘记密码接口` → `tasks/0001-forgot-password/`
- `title: 修复登录超时` → `tasks/0002-fix-login-timeout/`

## 枚举

### `kind` 枚举

Herdr Team 对外使用的 agent 类型：

```
claude codex gemini cursor devin opencode copilot grok kimi droid
amp qwen cline kiro pi agy omp mastracode hermes kilo qoder
letta maki muse
```

qoder 由适配层转换为 Herdr 原生 qodercli；配置与 CLI 始终使用 qoder。
支持范围由当前 CLI 与运行适配器校验；预设声明不等于对应工具已具备可用的运行支持。

### `priority` 枚举

| 值 | 含义 |
| --- | --- |
| `P0` | 阻塞级，不做别的 |
| `P1` | 重要 |
| `P2` | 普通 |
| `P3` | 有空再说 |

当前语义：**只决定派活顺序**（数字小的先派）。不抢占、不改并发、不换模型。

### `status` 枚举

| 值 | 含义 |
| --- | --- |
| `todo` | 待办，尚未派出 |
| `doing` | 已派出，agent 进行中 |
| `review` | 已交付，等待下游角色接手 |
| `done` | 终态 |
| `blocked` | 缺少必要前置条件或发生故障，负责人确认任务无法继续 |

注意：`status` 是**任务的**生命周期，与 Herdr 的 agent 状态（`working` / `blocked` /
`done` / `idle` / `unknown`）是两回事，不要混用。
普通确认、权限审批或补充输入属于会话的 **Needs input**。任务保留当前状态与负责人。

完成、存档或移到回收站的任务停止派活。依赖仅在被引用任务为 `done` 时满足，包括已存档或放入回收站的已完成任务。
旧记录中的 `archived`、`deleted` 和 `cancelled` 仍可读取。

## 校验规则

`herdr-team team validate` 按下表全量校验。**任一条不过即拒绝并报出位置。**

| # | 规则 |
| --- | --- |
| 1 | 必填字段齐全、类型正确 |
| 2 | 枚举值合法（`kind` / `priority` / `status`） |
| 3 | 角色目录名合规（`^[a-z][a-z0-9-]{0,31}$`）、唯一，且存在 `.role.yaml` |
| 4 | 任务目录名形如 `<4位id>-<slug>`，`id` 唯一，且存在 `.task.yaml` |
| 4b | slug 合规（`^[a-z0-9]+(-[a-z0-9]+)*$`，≤40 字符，全英文） |
| 5 | `role` / `handoff` 的每一项都能解析到存在的角色 |
| 6 | `depends_on` 的每一项都能解析到存在的任务 `id` |
| 7 | `depends_on` 无环 |
| 8 | `cwd` 不逃逸项目根 |
| 9 | 根 `TEAM.md` 是存在的文件 |

## 存档、删除与恢复

- `herdr-team task archive ID` 将任务移入 Archive，`herdr-team task delete ID` 将任务移入 Trash。任务目录、编号、正文和交接历史仍保存在 `tasks/`。
- Task 和 Issue 通过 `disposition` 独立记录归档，保留推进状态。Task 删除会记录 `disposition: deleted`，Issue 删除会永久移除内容。
- 存档或删除有未完成下游依赖的 Task 会被拒绝。对正在处理的 Task，显式 `--force` 结束当前投递并保留归档时的状态。
- `herdr-team task restore ID` 将已完成任务移回 Done，将未完成任务移回 Todo 等待重新派活。

任务目录和 retired ID 由 CLI 管理，不手动删除。清理 worktree 使用 clean；不等于删除任务历史。

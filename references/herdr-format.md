# `.herdr/` 格式规范

`.herdr/` 位于**目标项目根目录**。本文件是唯一的格式权威：字段、枚举、约束都以它为准。
`herdr-team` CLI 就是照它实现的。

## 元数据与散文分开

**一个 item 一个目录，元数据放点文件，正文是纯 Markdown。**

```
<project>/.herdr/
├── identity.md                 我的身份（纯 Markdown，无元数据）
├── .retired-ids                已删除任务的 id，一行一个，只追加
├── roles/
│   └── <name>/
│       ├── .role.yaml          元数据
│       └── prompt.md           散文：角色设定
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

**身份来自路径，元数据里不重复存** —— 角色名就是目录名，任务的 `id`/`slug` 来自目录名。
没有冗余就没有漂移。

`.retired-ids` 首次 `rm` 时才创建。扫描跳过以 `.` 开头的条目。

## `identity.md`

无元数据，纯 Markdown。描述"我是谁、代码风格、偏好"。

它会被注入**每个** agent 的 prompt，作为行为基线。因此：

- 只写跨角色通用的内容。角色专属的设定属于角色卡，不属于这里。
- 写成给 agent 读的祈使句，不写成给人看的简介。

## 角色 `roles/<name>/`

### `.role.yaml`

| 键 | 必填 | 类型 | 约束 |
| --- | :--: | --- | --- |
| `kind` | ✅ | enum | 见 [kind 枚举](#kind-枚举)。**agent 类型** —— 是属性，不是身份 |
| `model` | | str | **只用于显示的短名**（`sol-6.1` / `ds-flash`）。真正的模型由 `args` / `env` 决定 |
| `worktree` | | bool | `true` = 这个角色**按任务隔离**；缺省 `false` = 常驻。见 [隔离与常驻](#隔离与常驻) |
| `cwd` | | str | 相对项目根；**禁止 `..` 逃逸项目根** |
| `args` | | list[str] | 透传给该 agent 的可执行文件 |
| `env` | | map[str,str] | 起 tab 时用 `herdr tab create --env` 钉死环境变量 |

**没有 `name`。** 角色名就是目录名。

`env` 用来固定 agent 的后端。例：Claude Code 靠 `ANTHROPIC_MODEL` 决定连哪个模型，
**不显式钉住就可能连回默认端点**（费用与预期不符）。见 [role-presets.md](role-presets.md)。

`model` **不参与启动**，只用来拼侧边栏显示名（`dev (sol-6.1)`）。两者写得不一致不会报错，
但会误导人，所以**改启动方式时记得同步改 `model`**。

### `prompt.md`

角色设定，会被作为该 agent 的 prompt 素材。**必须写明完成后如何交棒。**
文件可以缺席（视为空）。

### 名字即身份

角色名一个值同时供三处使用：

| 位置 | 取值 | 怎么设 |
| --- | --- | --- |
| 角色目录 | `roles/<name>/` | 建目录时定 |
| tab 标签 | `name` | `tab create --label <name>` |
| agent 名 | `name` | `agent start <name>` |

三者同源，**不可能出现"agent 一个名字、tab 另一个名字"**。侧边栏显示名是在同一个名字后
附加模型短名（`dev (sol-6.1)`），不写 `kind` —— 模型名已经暗示了 agent 类型。

**不要把属性写进角色名：**

- `kind`（`codex` / `kimi`）是 **agent 类型** —— 属性
- `model`（`gpt-6.1-sol`）是**模型** —— 属性
- 「主力开发」这类描述**也不是名字** —— 名字是角色，如 `dev`、`search`

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
| `repo` | | str | 开 worktree 用的仓库，相对项目根。缺省 `.`（项目根本身） |

**没有 `id`。** 它来自目录名。

### `task.md`

正文 = 任务描述，末尾可以带一个 `## 流转记录` 小节。文件可以缺席（视为空）。

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
| 通过 | `reviewer` | `[]` | `done` |

**`handoff` 空不等于任务完成** —— 它只说明当前这个负责人是最后一个。所以交棒给最后一个角色后
状态是 `review`；**那个角色自己再交一次**才变 `done`。

最后一次 `handoff` 到 `done` 时会尝试回收 worktree；`clean` 则扫描所有
`done` / `cancelled` 任务。两者都在任务的 `repo`（缺省 `.`）中按
`feat/<id>-<slug>` 查找 worktree，与卡片当前角色的 `worktree` 配置无关，
因此交棒给常驻角色后仍能回收。没有匹配分支时返回 `absent`，不动其他 checkout。
匹配的 checkout 若在 Herdr 中已关闭则报告 `closed`；Git 拒绝删除则报告
`dirty`，不强制删除。回收保留分支，供 lead 后续合并。

## 隔离与常驻

`up` 只起常驻角色，`dispatch` 才派任务；角色分成两类，**落在完全不同的地方**：

```
项目 workspace "dev-skills"              ← 家
├── tab lead         agent "lead"         常驻，主分支
└── tab test         agent "test"         常驻

feature workspace "0001 修登录"           ← 挂在上面成组
└── tab dev          agent "dev-0001"      在自己 worktree 里
                     侧边栏自动显示 branch: feat/0001-fix-login
```

| | `worktree` 缺省 / `false` | `worktree: true` |
| --- | --- | --- |
| 起在哪 | 项目 workspace 的一个 tab | **每个任务一个 git worktree**，独立 workspace 挂在项目下成组 |
| 什么时候起 | `up` 时一次起好，常驻 | **`dispatch` 派活时**才起（来活了才出现） |
| agent 名 | 角色名（`lead`） | `<role>-<id>`（`dev-0001`） |
| 侧边栏显示名 | `<角色名> (<模型短名>)` | **只有 agent 名**，不带模型 —— 名字已经够长 |
| workspace 名 | 项目根目录名 | **分支名**（`feat/0001-fix-login`）—— 一眼看出是哪个 feature |
| 分支 | 项目当前分支 | `feat/<id>-<slug>` |
| 适合 | 调度、文档、测试、调研 | **写代码** —— 并行改同一仓库不会互相踩 |

隔离用的是 Herdr 原生的 `worktree create`：它建 git worktree、开成新 workspace、
挂在源 repo workspace 下，**分支名由侧边栏的 `branch` token 自动显示**，不用额外标。

一个 agent 名对应一个任务，所以**同一个角色可以同时在多个任务上**（`dev-0001`
和 `dev-0002` 各在自己的 worktree 里），互不打架。

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

Herdr 支持的 agent 类型：

```
claude codex gemini cursor devin opencode copilot grok kimi droid
amp qwen cline kiro pi agy omp mastracode hermes kilo qodercli
letta maki muse
```

Herdr 更新后这个列表可能变化。**运行时以 `herdr agent start --kind` 实际接受值为准**。

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
| `blocked` | 卡住，等外部输入 |
| `cancelled` | 终态，放弃 |

注意：`status` 是**任务的**生命周期，与 Herdr 的 agent 状态（`working` / `blocked` /
`done` / `idle` / `unknown`）是两回事，不要混用。

**终态是 `done` 和 `cancelled`。** 终态的任务不再被派活，且 `depends_on` 引用终态任务
视为**已满足**。

## 校验规则

`bunx herdr-team validate` 按下表全量校验。**任一条不过即拒绝并报出位置。**

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
| 9 | `identity.md` 存在 |

## 取消与删除

删除分两档。**默认用取消，不删目录。**

### 取消（`cancel`）

把 `status` 改成 `cancelled`，**目录留在 `tasks/`**，追加一条流转记录。

- 是终态，不再被派活。
- 依赖它的任务**视为满足**，可以继续。
- 记录和散文都保留 —— 任务本身就是"谁做过、为什么放弃"的历史。

### 真删（`rm`）

删掉整个任务目录。**必须同时满足三条，否则拒绝并说明原因：**

| # | 条件 | 不满足时 |
| --- | --- | --- |
| 1 | `status` 已是终态（`done` / `cancelled`） | 拒绝：任务还在进行 |
| 2 | **没有任何任务在 `depends_on` 里引用它** | 拒绝，并**列出全部依赖者的 `id`** |
| 3 | 它对应的角色没有存活 agent 仍在处理它 | 拒绝：先处理 agent |

第 2 条是硬约束：校验要求 `depends_on` 每一项都能解析到存在的任务，真删会让它悬空。

**三条都过后，做两步：**

1. 删掉 `tasks/<id>-<slug>/`
2. 把 `id` **追加**一行到 `.herdr/.retired-ids`

第 2 步不能省 —— 少了它，下次算 `max + 1` 就会把这个 id 重新发出去。

### 不做的事

- **不建 `archive/` 目录。** 软删留在原地，真删就删掉。
- **不自动终止 agent。** 取消 `doing` 的任务时，若该角色有存活 agent，只提示用户，
  不擅自关 pane —— 关掉会丢掉未提交的改动。

# herdr-team

用项目内 `.herdr/` 的身份、角色卡和任务卡管理 Herdr agent 团队的 CLI，无运行时 npm 依赖。

需要 Bun 1.2 或更新版本；启动团队还需要已安装的 Herdr 和对应角色使用的 agent CLI。

## 开发验证

在仓库根目录运行离线验证，无需安装 npm 开发依赖：

```sh
make verify
```

类型检查需要先安装开发依赖。从仓库根目录运行：

```sh
cd herdr-team-plugin/cli
bun install
cd ../..
make typecheck
```

也可以在 `herdr-team-plugin/cli/` 内运行 `bun run typecheck`。
提交 `herdr-team-plugin/cli/bun.lock`，固定 TypeScript 和 Bun 类型定义的解析版本，便于复现检查结果；
`node_modules/` 不提交。

`typecheck` 刻意独立于 `make verify`：前者需要 `bun install` 准备开发依赖，首次安装可能联网，
而 `make verify` 必须在没有 `node_modules/`、没有网络和活 workspace 时也能通过。
在 CI 或提交前准备好开发依赖后，单独运行 `make typecheck`。

## 快速开始

先按 [插件安装说明](../README.md#安装) 一次安装 CLI、skill 和 sidebar，再直接运行：

```sh
herdr-team --help
```

onboard 时先逐个确认角色的职责、边界、交付与交棒方式，再确认模型和是否隔离。
预设是分工的起点；需要定制职责时，把确认过的正文放入每个角色定义的 `body`，
使用 `init --roles-file F`。只有连职责正文也原样接受预设时才直接 `init --plan`。
完整引导见插件内置的 `herdr-team` skill 中的 `references/team-setup.md`。

在项目根目录创建团队配置，再填写 `.herdr/identity.md`（以下以原样接受 balanced 为例）：

```sh
herdr-team init --plan balanced
herdr-team validate
herdr-team add "Implement login" --role dev
herdr-team tasks
```

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
角色文件的修改不会自动向运行中的 agent 重发设定，后续启动或派活才会读取新正文。

`add` 和 `edit` 支持 `--depends-on`：逗号分隔任务 id（如 `0001,0002`），
`edit` 时替换全部依赖，空串清空，省略则保留。写盘前校验引用与依赖环，
不存在的 id、自依赖或成环都会报错并保留原文件；`--handoff` 仍只指定流转角色。
修改已派出的卡仍需 `--force`，终态卡不允许修改。

由 `lead` 在 Herdr pane 中启动常驻团队，再派活（`up` 不派任务、不起 worktree）：

```sh
herdr-team up
herdr-team dispatch
# 只派指定的一张 todo 卡：
herdr-team dispatch <id>
```

`dispatch` 按 priority、id 升序处理 `todo` 卡并检查依赖；指定 id 不存在或状态不是 `todo` 时会报错。
隔离角色在派活时才起 worktree/agent；agent 启动失败后再次派活会复用已有的开放 worktree workspace。
派活提交输入后，尽量通过 Herdr 的活动等待确认 agent 已到 `working` 或 `blocked`，再把卡从
`todo` 改成 `doing`，缩短刚启动时 `idle` 被误报为 `maybe-finished` 的窗口。常驻和隔离角色
都走这一步；调用上限为 8 秒，给 Herdr 内置的 5 秒活动窗口留出余量，比原来最坏多等 3 秒。
观察到活动立即返回，不等待整轮任务完成，也不增加重发或状态轮询子进程。
若 Herdr 返回结构化错误码 `agent_prompt_stalled` / `timeout`，仍写 `doing` 和派出记录，
输出 `dispatched` 并注明「未能确认已开工」；`--json` 的对应结果在 `reason` 字段中注明。
输入可能已送达，不应因这条提示重派。未开工、或回到 `idle` / `done` 却未交棒的 `doing` 卡
仍会报 `maybe-finished`。`agent_blocked`（输入被拒）、agent 不存在及其他错误仍会报错，
卡保留 `todo`，不追加派出成功记录；只按返回的 JSON `error.code` 区分，不匹配正文或错误说明。
`up` 的身份说明和 `handoff` 的交棒提示仍只提交输入，不增加等待。
`up --json` 返回 workspace 和角色启动结果，已移除原来的 `dispatched` 字段；派活结果由 `dispatch --json` 单独返回。

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

`herdr-team sidebar` 刷新现有 agent 的信息与归属编号；`--badges-only` 只刷新所有
workspace 和 agent 的编号，不要求当前目录是团队项目。均不启动或重启 agent。
新增 workspace 与 agent 由插件事件钩子自动同步。升级后重新 `herdr plugin link`
加载钩子，再从 Herdr 菜单选择 `reload config` 应用布局。

### 只读团队看板

盯团队进展用 `watch` —— 只读实时看板，把任务卡、Herdr agent 和两者对不上的地方放进
一屏，默认每 2 秒刷新：

```sh
herdr-team watch
```

`↑↓`（或 `j`/`k`）选任务、`PgUp`/`PgDn` 翻详情正文、`a` 切换是否显示已结束的卡、
`/` 进入搜索，边输入边按 id、标题、角色过滤；`Enter` 保留过滤并退出输入，
`Backspace` 删除一个码点，`Esc` 退出输入并清空过滤（输入外且无过滤时退出看板）。输入时字母快捷键作为查询文本，
`Ctrl-C` 始终退出；输入外 `q` 退出。搜索按子序列匹配，ASCII 大小写不敏感，中文按码点匹配；
结果优先显示靠前、连续的匹配，同分按 priority、id 排，空查询恢复原顺序。
搜索沿用 `a` / `--all` 的范围，TASKS 右侧显示查询及命中数/范围内任务数，角色和健康检查仍显示全项目。

`--interval <秒>` 改刷新间隔（`0` = 只手动刷新），
`--all` 一进来就显示已结束的卡。TUI 里不做任何写操作 —— 派活、交棒、收尾仍走各自命令。

**这是给人看的，不要放进 agent 的流程里**：它会一直占着终端直到有人按键。
非交互地看状态用 `herdr-team status`（可加 `--json`）。

没有真终端时用 `--once`，只渲染一帧就退出 —— 管道和脚本里都能用，也永远不会把终端
留在半路。非 TTY 又没给 `--once` 时同样只打一帧，并在 stderr 提一句。

## 放进 Herdr

两个位置都有人用，**两者都不改 pane / tab 拓扑**：

**popup** —— 按一下浮出来，`q` 关掉，不留痕迹（Herdr 管这叫 session-modal）：

```toml
[[keys.command]]
key = "prefix+t"
type = "popup"
command = "herdr-team watch"
width = "90%"
height = "85%"
```

**标签栏一行** —— 永远可见、零布局成本：

```toml
tab_bar_right = [
  { type = "command", command = "herdr-team watch --line --follow", interval_seconds = 10, timeout_seconds = 5 },
]
```

`--line` 打一行，形状 `team: 1 doing 2 todo · 1 blocked · 1 ✗`：前半段是未结束的卡按
`doing`/`review`/`todo` 计数；`blocked` 是**卡住、等你处理的卡**（卡片自己写着 blocked，
或 agent 在等你 / agent 掉了 / 干完没交棒，按卡去重）；`✗` 是 `.herdr/` 的校验问题数 ——
坏卡会被静默跳过，不报的话你只会看到数字悄悄变小。**没事就不输出**（和
`herdr-projects` 的 `needs-you --line` 一个规矩），不在团队项目里也什么都不输出。

`--follow` 在标签栏这个场景里是**必需的**：那条命令跑在 Herdr **服务器进程**里，
cwd 是服务器启动时的目录（通常是你家目录），从那儿往上找 `.herdr/` 永远找不到，
这行会一直空白。跟了焦点 pane 之后，它显示的是**你正在看的那个 workspace** 的项目。
在命令行手动跑时不需要它（cwd 就是项目）。

改完记得 `herdr config check`，再 `herdr server reload-config`。

和 `status` 有一处**有意的不同**：`watch` 是容错启动的。`.herdr/` 里有坏卡不会拦着
不让你看（看板恰恰是卡坏的时候最想看），坏卡会被跳过、并在帧里用 `✗` 横幅报出来 ——
所以卡片总数可能比 `tasks/` 下的目录数少，看到横幅就是原因。

在 linked worktree 里跑会读**主检出**的 `.herdr/`（`findRoot` 的既有行为，见
`scripts/lib/config.ts`）—— 那才是活的卡片，worktree 里那份是切出去时的过期副本。

自动查找项目根时，`.herdr/` 中至少要有 `identity.md`、`roles`、`tasks` 之一；
只有 `projects/`、`worktrees/` 的 Herdr 数据目录不会被当成团队项目。
子目录仍可向上找到项目，只建了一部分配置的项目也能被识别。
找不到时普通命令提示用 `--root` 指定，`watch --line` 静默退出；
`init` 则在当前目录创建配置。显式 `--root` 仍允许定位待校验的 `.herdr/`。

默认编排命令（含 `init`、建卡、改卡、派活、起停团队、增删角色、清理）及 Git 分支的创建、合并、删除都归 `lead`。
其他角色只能用 `handoff` 交棒，以及 `tasks`、`status`、`validate`、`role list` 只读查询；允许在任务范围内提交，但不碰 main。
这是提示词约定，CLI 不做角色权限拦截。任务完成后由当前角色运行 `herdr-team handoff <id>` 交接。

最后一次 `handoff` 到 `done` 时会尝试回收 worktree；`clean` 回收所有
`done` / `cancelled` 任务留下的 worktree。两者都在任务 `repo`（缺省 `.`）中
按 `feat/<id>-<slug>` 查找，不受当前角色是否隔离影响，交棒给常驻角色后仍能回收。
没有匹配分支时返回 `absent`（原常驻角色的 `not-isolated` 结果已移除），不动其他
checkout；Herdr workspace 已关闭时报告 `closed`，Git 拒绝删除时报告 `dirty`。
回收不强制删除，保留分支供 lead 合并。

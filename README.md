# Herdr Team plugin

一次安装 `herdr-team` skill、内置 CLI、Herdr sidebar 配置，并把 `prefix+t` 绑定到 `herdr-team console --observe` popup。安装与同步均为一次性脚本，
无 daemon、无运行时 npm 依赖，不起 agent，也不改项目的 `.herdr/`。

需要 Herdr 0.9.3+、Node 22.20+（含 npm/npx）、Bun 1.2+，支持 macOS / Linux。
CLI、skill 和安装脚本均随插件分发。skill 通过 `npx skills@1.7.2` 安装插件自带的本地目录；
首次获取 Skills CLI 可能需要联网，skill 内容无需从 GitHub 下载。团队 CLI 仍使用内置版本。

## 安装

独立插件的 GitHub 安装源为 **`boyd4y/herdr-team`**，不带 subdir：

```sh
herdr plugin install boyd4y/herdr-team
```

GitHub 安装会运行 `bin/setup.js`，一次装齐 CLI、skill 及 Herdr 配置，
尝试 reload 当前会话。公开仓库为 [boyd4y/herdr-team](https://github.com/boyd4y/herdr-team)。
从这个仓库本地检出开发时，在仓库根目录运行：

```sh
herdr plugin link .
herdr plugin action invoke herdr-team.install
```

`link` 只注册插件，不运行 build hook；`install` action 与 build hook 调用同一个安装入口。
安装前，确保 Bun 在 PATH 上，并把用户 bin 目录（默认 `~/.local/bin`，可用 `$XDG_BIN_HOME`
覆盖）加入 PATH。目录不在 PATH 上时安装报错，明确列出路径，不会放置不可调用的 CLI。
安装器不修改 shell 配置。新 shell 和 Herdr 服务器的 PATH 也需包含此目录和 Bun；
若服务器启动时没有这些 PATH 项，需在正确环境下重新启动会话才能使用 popup。

装好后在新的 shell 中直接运行：

```sh
herdr-team --help
herdr-team status
```

`status` 需在已有 `.herdr/` 团队配置的项目中运行。没有运行中的 Herdr 时安装仍可完成，
启动 Herdr 后调用 `configure` 应用配置。

sidebar 保留 Herdr 自带的状态圆点，并为主 workspace 分配 `①`、`②` 等归属编号。
编号使用固定的八色配色：① 蓝、② 紫、③ 青绿，后续依次分配并循环。workspace 和
所属 agent 的编号同色，切换运行状态不会改变编号颜色。
编号与名称合并为一个字段（如 `① arch`、`④ agrid`），整段使用归属颜色，去掉编号后的分隔点。
agent 第一行显示编号、角色、harness，第二行显示模型和任务 ID（有任务时）。
workspace 名称只在 spaces 区显示；树形子 worktree 不重复显示编号，其中的 agent 沿用主 workspace 的编号。
主 workspace 未打开、worktree 单独显示时仍保留编号。Herdr 原生状态点目前无法只对子节点隐藏。
模型取角色卡的 `model`，未指定时显示 `default`。无需额外字体或环境变量。

spaces 第二行显示分支、`📄N` 未提交文件数和原生 `↑` / `↓` 提交数，例如
`main · 📄15 ↑10`。文件数包含暂存、未暂存和未跟踪文件，同一文件只计一次，
重命名计一个文件；忽略文件不计，干净仓库显示 `📄0`，非 Git 目录不显示。
workspace 生命周期/sidebar 刷新会更新计数。要定时刷新，可在已有 Herdr 标签栏命令
`herdr-team console --line --follow` 后加 `--sync-git`，沿用该命令的刷新间隔。
由 Herdr 服务器运行时使用 `HERDR_ENV=1 herdr-team console --line --follow --sync-git`。
也可手动运行 `herdr-team sidebar --git-only`，它不要求项目存在 `.herdr/`。

CLI 的帮助、输出、错误及默认模板统一使用英文，无语言切换；用户提供的标题、正文和
摘要按原文保留，支持 Unicode。文档可以使用中文或英文。

编号绑定 workspace ID，保存在插件 state 的 `workspace-badges/` 中，按 Herdr socket
区分会话；重命名、排序和恢复已有 workspace 时不变，旧编号不回收，新建继续递增。
超过 50 时用 `[51]` 等形式。删除 state 会重置编号，所以需要稳定编号时请保留它。

启动和 workspace / worktree / agent 生命周期事件会触发一次 metadata 同步，自动发现
会话内各项目，补齐已有 agent 的角色、harness、模型和任务 ID，无后台轮询；metadata 上报不会再次触发这些事件钩子。重新链接插件会加载新增的事件钩子：

```sh
herdr plugin link /path/to/herdr-team
herdr plugin action invoke herdr-team.configure
```

在项目的 Herdr pane 中运行 `herdr-team sidebar`，可同时刷新编号和角色、模型、任务 ID。
`herdr-team sidebar --auto` 可从任意目录自动刷新会话内的团队项目，旧 agent 也会补齐字段。
`herdr-team sidebar --badges-only` 不要求 `.herdr/` 项目，仅刷新所有 workspace 和 agent
的归属编号。从 Herdr 菜单选择 `reload config` 应用 sidebar 布局。
原生圆点仍表达运行状态，插件不会更改它的状态或颜色。

升级安装或运行 `configure` 时，会移除旧版插件添加的终端字体映射，以及内容未修改的
插件字体副本；其他字体和终端配置保留。旧版图标 token 不再显示，并按原 TTL 到期。

## 多项目隔离

不同目录的 `.herdr/` 是不同团队，允许各自使用 `dev`、`lead` 和 `0001` 等相同名称。
团队身份按规范化的项目根路径生成，并绑定到 workspace / agent metadata。
`up` 通过绑定或实际 pane 目录寻找 workspace，不按显示名称猜测；重名的项目目录也可区分。
Herdr 的 agent 名是全局唯一的，若角色名已被另一个项目占用，新 agent 使用项目命名空间，
侧栏仍显示原角色名。派活、交棒通过本项目的具体 pane ID 发送。

`status`、`console`、`sidebar`、`down` 和 worktree 复用/回收也检查项目归属。
旧版 agent 只有在实际目录可验证时才会复用；归属不明或同一角色有多个目标时明确拒绝。
升级后分别在各项目运行一次 `herdr-team up`，可补上绑定；`up` 不向 agent 发送消息。
身份和角色职责随 `dispatch` / `handoff` 的实际任务发送。
在 worktree 或其他目录操作时，用 `--root` 指定派活/交棒消息给出的团队根目录。

常驻角色会自动记录 Herdr 官方 integration 上报的原生 session ID，再次 `up` 时恢复，
输出 `resumed`；`up --fresh` 忽略记录，按角色卡开新会话，运行中的 agent 始终复用。
记录按项目和角色保存在插件 state 的 `agent-sessions/` 中。需要先安装或更新对应集成，
例如 `herdr integration install codex`、`herdr integration install grok`。
没有上报或尚未捕获 ID 时正常新建，恢复失败会报错并保留记录。
升级后重新 link 插件以加载状态事件钩子，并运行 `herdr plugin action invoke herdr-team.install-cli`
更新 CLI。详见 [CLI 会话恢复说明](cli/README.md)。

## Team Console 与任务队列

`herdr-team up` 在项目 workspace 中创建或复用一个 **Team Console** tab，不切走当前焦点。
Console 显示当前任务、角色队列、agent 状态和异常，并自动投递已入队的工作。
关闭 Console 暂停自动投递，队列保存在任务卡中；再次 `up` 或运行 `herdr-team console` 即可继续。
无需独立 daemon、数据库或额外消息服务。旧 `watch` 命令已移除，统一使用 Console。

`dispatch [<id>]` 将 todo 卡入队并尝试投递；同一角色一次处理一个任务。接收方忙碌、阻塞、状态未知或未启动时等待。
消息带唯一 delivery ID，agent 先 `claim <id> --delivery ID`，完成后 `handoff <id> --delivery ID`。
交棒保存交付内容后将下游入队，重复 ID 不会再次推进。投递是否成功不确定时暂停该项，核对后由 lead 用 `queue retry <id>` 重试。
Console 只处理显式入队的卡，不会自动派送历史 todo。

`console --once` 输出一帧，`console --line --follow` 供标签栏使用，`console --observe` 供只读 popup 使用。
这三个模式都不调度任务。命令与恢复规则详见 [CLI 说明](cli/README.md#team-console)。
升级时，若曾自行配置标签栏命令，请将其中的 `herdr-team watch` 改为 `herdr-team console`；托管的 popup 由安装器更新。

## 交棒与交付记录

`handoff` 支持可选的 `--summary TEXT` / `--summary-file FILE`，将成果、产物路径、验证结果、
风险和下一步追加到本项目任务的 `task.md`，再将下游入队，消息提示先读取正文及引用文件。
摘要未提供时仍可交棒，新队列任务必须携带已领取的 delivery ID，并明确提示缺少摘要；不会猜测或补写旧任务的交付。
用 `herdr-team tasks <id>` 读取实际交付，终端回读仅用于排障。

## Actions 和撤销

| Action | 行为 |
| --- | --- |
| `herdr-team.install` | 一次安装 CLI、skill、sidebar 和 popup |
| `herdr-team.install-cli` | 安装内置 CLI 的用户 bin shim；校验 PATH 和 Bun |
| `herdr-team.uninstall-cli` | 按所有权记录移除未修改的 shim |
| `herdr-team.configure` | 校验候选配置，写 sidebar 和 popup 托管块，reload 当前会话 |
| `herdr-team.unconfigure` | 撤掉 Herdr 托管块并 reload |
| `herdr-team.install-skill` | 通过 `npx skills` 安装随插件分发的本地 skill，日志列出状态、路径和 agent |
| `herdr-team.uninstall-skill` | 通过 `npx skills remove herdr-team --global --yes` 撤销 skill |

卸载前先撤 skill、配置和 CLI，再解除本地链接：

```sh
herdr plugin action invoke herdr-team.uninstall-skill
herdr plugin action invoke herdr-team.unconfigure
herdr plugin action invoke herdr-team.uninstall-cli
herdr plugin unlink herdr-team
```

Herdr 自己的插件日志、config/state 目录由 Herdr 管理；skill 的目录与链接由 Skills CLI 管理，配置只用托管块，不写备份。

## CLI 的安装位置与所有权

CLI 源码只维护在 `cli/`，入口为 `cli/scripts/cli.ts`。安装器用 Bun shim 调用它，
CLI 安装不编译二进制、不运行 npm。运行所需的 `package.json` 与
`scripts/` 按内容摘要复制到插件 state 的 `cli-runtime/<内容摘要>/`；不复制测试或
开发依赖。shim 引用稳定缓存路径，Herdr 在 build 后移动检出也不会让它失效。

`cli-paths.json` 记录创建过的 shim 路径、设备号、inode、权限及内容摘要；不是插件创建的
文件、目录和符号链接都跳过，不覆盖、不接管。已安装且未修改的 shim 可以更新；重复安装
不会重写相同内容。卸载只查记录，不依赖当前 PATH、Bun 或 bin 目录设置，只有文件仍属于
原记录且内容、权限未改时才删除。用户修改或替换的文件整份保留，记录也保留。
旧的 npm 入口若与目标同名，需用户自行移走后重跑安装，插件不自动迁移。

安装和撤销共用 `cli.lock` 排他写锁，最长等 15 秒；正常退出和报错都会释放。
强制终止留下锁时，确认没有安装进程后再手动移除它。运行缓存保留在插件 state 中，
供保留下来的 shim 继续使用；仍需这些命令时不要清除 state。
Herdr 没有自动卸载 hook，先运行 `uninstall-cli` 再 unlink / 卸载插件。

## Skill 安装

统一的 `herdr-team.install` action 会调用 Skills CLI，从插件自带的本地 `skill/` 目录安装：

```sh
npx --yes skills@1.7.2 add /path/to/herdr-team/skill --skill herdr-team --global --yes --json --agent codex claude-code pi grok
```

本地开发也可在插件根目录手动执行：

```sh
npx skills add ./skill --skill herdr-team --global --yes --agent codex claude-code pi
npx skills list --global
```

不需要先发布到 GitHub。源文件、`references/` 和 `agents/` 一起安装，正文与相对链接保留。
默认由 Skills CLI 将内容复制到 `~/.agents/skills/herdr-team`，并为需要独立目录的 agent
建立链接；Codex、Pi 使用共享 skills 目录，Claude Code 等使用 Skills CLI 管理的链接。
已安装内容不依赖插件检出的临时路径，移动插件或 Herdr build 检出后仍可读取。
插件按 PATH 选择已安装的 Claude、Codex、Pi、Grok，显式传 `--agent`；不会启动 agent。
目录选择和更新同名 skill 的行为由 Skills CLI 管理。

插件固定使用 `skills@1.7.2`，通过 `--yes` 非交互安装并解析 `--json` 结果。
显式指定 agent 避免上游自动列表包含不支持全局安装的条目。
日志明确输出安装状态、实际目录和 agent；命令失败、返回失败结果或安装文件不可读时，
action 报错。首次下载 Skills CLI 需要 npm 网络访问，之后可使用 npm 缓存。
不再使用自定义的 `HERDR_TEAM_SKILL_DIRS` 安装目录规则。

升级时先完成 npx 安装，再按旧 `skill-paths.json` 清理旧安装器留下的未修改副本。
用户修改、附加文件及替换链接保留；新安装失败时不清理旧副本。
旧引用缓存保留，供仍被保留的旧版 skill 使用。
安装与撤销使用插件 state 的 `skill.lock`，避免同时操作。

撤销命令为：

```sh
npx --yes skills@1.7.2 remove herdr-team --global --yes
```

Herdr 没有自动卸载 hook，解除链接或卸载插件前先执行 `herdr-team.uninstall-skill`。

## 配置边界

Herdr 配置优先用 `HERDR_CONFIG_PATH`，其次 `$XDG_CONFIG_HOME/herdr/config.toml`，
默认 `~/.config/herdr/config.toml`。通过 `HERDR_BIN_PATH`（否则 PATH 上的 `herdr`）
运行 `config check`，候选文件检查通过才写入；reload 失败会报错，已保存的配置保留，
可重跑 action。安装 hook 无可用会话时会提示稍后运行 `configure`。

Herdr 配置修改都在 `# >>> herdr-team:config` / `# <<< herdr-team:config` 托管块内。块外内容、原有换行及末尾空行逐字保留，重复执行不会
叠加块；撤销能还原原文件，包括安装前没有配置文件的情况。普通 dotfile 符号链接
保留，悬空链接和残缺/重复 fence 会报错。

已有常规 `[[keys.command]]` 的 `prefix+t` popup，且 command 同为
`herdr-team console --observe` 时会直接复用，卸载时保留。其他键位冲突、已有
`[ui.sidebar.agents]` 或 `[ui.sidebar.spaces]`（包括 inline / dotted 定义）造成的 TOML 冲突，由 Herdr 的
校验拒绝；用户先自行整理冲突后重跑，不会覆盖别的插件。复杂 TOML 写法的已有
popup 可能无法识别为可复用，仍由 Herdr 校验阻止重复绑定。

## 验证

测试位于本包 `tests/*.test.cjs`，使用 Node 内置测试器。在本包目录运行：

```sh
node --test tests/*.test.cjs
```

CLI 验证在 `cli/` 目录运行 `bun test`，类型检查为 `bun run typecheck`。
测试使用临时 HOME、XDG 目录和假的 Herdr 命令，验证精确回滚、幂等、独立分发、
冲突拒绝，以及旧版图标配置的清理，不依赖网络或活 workspace。

Skill 安装测试使用临时 HOME、插件 state 和 npx 子进程替身，覆盖安装参数、失败传播、
旧版副本迁移、相对引用、检出移动和并发锁，不访问真实 agent 目录或网络。
真实 Skills CLI 的本地安装与撤销另在隔离的临时 HOME 中验证。
CLI 测试还隔离用户 bin，覆盖新 shell 直接调用、检出移动、升级及精确卸载。

# Herdr Team plugin

一次安装 `herdr-team` skill、内置 CLI、Herdr sidebar 配置，并把 `prefix+t` 绑定到 `herdr-team watch` popup。只有一次性安装脚本，
无 daemon、无运行时 npm 依赖，不起 agent，也不改项目的 `.herdr/`。

需要 Herdr 0.9.0+、Node 18+、Bun 1.2+，支持 macOS / Linux。CLI、skill 和安装脚本
均随插件分发，安装 action 不联网，不再通过 npm 分发 CLI。

## 安装

独立插件的 GitHub 安装源为 **`boyd4y/herdr-team`**，不带 subdir：

```sh
herdr plugin install boyd4y/herdr-team
```

GitHub 安装会运行 `bin/setup.js`，一次装齐 CLI、skill 及 Herdr 配置，
尝试 reload 当前会话。此命令用于独立仓库发布后的分发；本私有仓库不在此流程中发布或 push。
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

sidebar 保留 Herdr 自带的状态圆点；agent 第一行显示角色、harness，第二行显示模型和
任务 ID（有任务时）。不再重复 machine、workspace、tab。模型取角色卡的 `model`，
未指定时显示 `default`。无需额外字体或环境变量。
`up`、`dispatch`、`handoff` 和 `edit` 会更新显示；升级后可在项目的 Herdr pane 中运行
`herdr-team sidebar` 刷新现有 agent，不启动或重启 agent。随后在 Herdr 菜单里选择
`reload config` 应用布局。
原生圆点颜色由 Herdr 的运行状态决定；插件不支持按 workspace hash 动态配色。
升级安装或运行 `configure` 时，会移除旧版插件添加的终端字体映射，以及内容未修改的
插件字体副本；其他字体和终端配置保留。旧版图标 token 不再显示，并按原 TTL 到期。

## Actions 和撤销

| Action | 行为 |
| --- | --- |
| `herdr-team.install` | 一次安装 CLI、skill、sidebar 和 popup |
| `herdr-team.install-cli` | 安装内置 CLI 的用户 bin shim；校验 PATH 和 Bun |
| `herdr-team.uninstall-cli` | 按所有权记录移除未修改的 shim |
| `herdr-team.configure` | 校验候选配置，写 sidebar 和 popup 托管块，reload 当前会话 |
| `herdr-team.unconfigure` | 撤掉 Herdr 托管块并 reload |
| `herdr-team.install-skill` | 为 PATH 上已安装的 Claude、Codex、Pi 安装 skill；跳过非本插件拥有的同名目录 |
| `herdr-team.uninstall-skill` | 按所有权记录移除未修改、无额外文件的 skill 目录 |

卸载前先撤 skill、配置和 CLI，再解除本地链接：

```sh
herdr plugin action invoke herdr-team.uninstall-skill
herdr plugin action invoke herdr-team.unconfigure
herdr plugin action invoke herdr-team.uninstall-cli
herdr plugin unlink herdr-team
```

Herdr 自己的插件日志、config/state 目录由 Herdr 管理；skill 安装的所有权记录和引用文档
缓存保存在插件 state 目录中，配置只用托管块，不写备份。

## CLI 的安装位置与所有权

CLI 源码只维护在 `cli/`，入口为 `cli/scripts/cli.ts`。安装器用 Bun shim 调用它，
不编译二进制、不运行 npm。与 skill 引用缓存相同，运行所需的 `package.json` 与
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

## Skill 的安装位置与所有权

只检测 PATH 上的可执行文件，不运行 agent、不根据配置目录猜安装状态。
目前支持与参考实现相同的三个已知 skills 目录；不从 Grok 等程序的 trust 文件路径
推导 skills 目录。

| kind / 可执行文件 | 默认 skills 目录 | 程序目录覆盖 |
| --- | --- | --- |
| `claude` | `~/.claude/skills` | `$CLAUDE_CONFIG_DIR/skills` |
| `codex` | `~/.codex/skills` | `$CODEX_HOME/skills` |
| `pi` | `~/.pi/agent/skills` | `$PI_CODING_AGENT_DIR/skills` |

每个目标中只创建名为 `herdr-team` 的目录及其中的 `SKILL.md`。已有的同名目录、普通文件及符号链接
（包括旧的手动安装链接）都跳过，不接管、不覆盖；输出会列出跳过的路径。
新装 agent 后可重新运行 `install-skill`。如果希望用插件管理旧的手动安装，需先自行
移走原入口，再运行 action；安装器不会替用户迁移它。

内置 skill 独立放在插件的 `skill/` 子目录：正文读取 `skill/SKILL.md`，引用文档和
agent 元数据分别放在 `skill/references/` 和 `skill/agents/`，不改源文件。
插件自身的 `bin/`、`tests/` 和 manifest 留在插件根目录。
只需分发整个插件目录即可安装 CLI、skill 和配置，无需仓库中的其他目录。
根目录 `make validate` 通过 `PACKAGES` 中的 `herdr-team-plugin/skill` 校验独立的
skill 包。

安装正文与源文件的唯一差异：两个 `references/*.md` 链接改成带尖括号的绝对路径。
安装器将完整 `skill/references/` 文档复制到插件 state 下
`skill-references/<内容摘要>/`，使文档间的相对链接仍可用。Herdr 在 build 后会移动检出，
不能把临时 build 路径写进 skill。缓存按内容分版本，保留的旧版或用户修改过的 skill
仍能读取原版引用；移动或移除源码检出也不影响已安装的引用。

state 优先使用 action 注入的 `HERDR_PLUGIN_STATE_DIR`。build hook 没有该变量时，
按 Herdr 的 Unix 约定使用
`${XDG_STATE_HOME:-~/.local/state}/herdr/plugins/herdr-team`。
`skill-paths.json` 记录每个已创建目录的路径、设备号、inode 和正文摘要；每创建一个
目录就先保存记录，再写正文。内容没变时不重写正文、引用文档或记录。

安装和撤销共用 `skill.lock` 排他写锁，最长等 15 秒，超时不进行 skill 写入。
正常完成或报错都会释放锁；进程被强制终止后可能留下锁，此时确认没有安装 action
运行后，手动移除插件 state 中的 `skill.lock` 再重试。

撤销只查记录，不依赖当前 PATH 或目录覆盖；只删除仍是原目录、正文未修改且目录里
只有 `SKILL.md`（或为空）的条目。加过任何文件或子目录、修改过正文、换成符号链接的
条目都会整目录保留，并继续记在记录中，便于用户整理后再撤销。引用缓存保留在插件
自己的 state 中，供这些保留的 skill 使用；不要在仍需它们时清除插件 state。
Herdr 没有自动调用此 action 的卸载 hook，解除链接或卸载插件前应先运行撤销 action。

实现参考 [herdr-projects 的 extras](https://github.com/eliasstravik/herdr-projects/blob/main/crates/flow/src/extras.rs)
和 [agent adapter](https://github.com/eliasstravik/herdr-projects/blob/main/crates/core/src/agents/adapter.rs)。

## 配置边界

Herdr 配置优先用 `HERDR_CONFIG_PATH`，其次 `$XDG_CONFIG_HOME/herdr/config.toml`，
默认 `~/.config/herdr/config.toml`。通过 `HERDR_BIN_PATH`（否则 PATH 上的 `herdr`）
运行 `config check`，候选文件检查通过才写入；reload 失败会报错，已保存的配置保留，
可重跑 action。安装 hook 无可用会话时会提示稍后运行 `configure`。

Herdr 配置修改都在 `# >>> herdr-team:config` / `# <<< herdr-team:config` 托管块内。块外内容、原有换行及末尾空行逐字保留，重复执行不会
叠加块；撤销能还原原文件，包括安装前没有配置文件的情况。普通 dotfile 符号链接
保留，悬空链接和残缺/重复 fence 会报错。

已有常规 `[[keys.command]]` 的 `prefix+t` popup，且 command 同为
`herdr-team watch` 时会直接复用，卸载时保留。其他键位冲突、已有
`[ui.sidebar.agents]`（包括 inline / dotted 定义）造成的 TOML 冲突，由 Herdr 的
校验拒绝；用户先自行整理冲突后重跑，不会覆盖别的插件。复杂 TOML 写法的已有
popup 可能无法识别为可复用，仍由 Herdr 校验阻止重复绑定。

## 验证

测试位于本包 `tests/*.test.cjs`，使用 Node 内置测试器。在本包目录运行：

```sh
node --test tests/*.test.cjs
```

仓库根目录的 `make plugin-test` 运行同一组检查，`make verify` 已包含它。
测试使用临时 HOME、XDG 目录和假的 Herdr 命令，验证精确回滚、幂等、独立分发、
冲突拒绝，以及旧版图标配置的清理，不依赖网络或活 workspace。

skill 测试另外显式设置 `HERDR_TEAM_SKILL_DIRS`，以系统路径分隔符（macOS / Linux
为 `:`）指定临时 skills 根目录列表；该变量完全替代 agent 发现，空值表示禁用安装。
CLI 测试还隔离用户 bin，覆盖新 shell 直接调用、检出移动、升级及精确卸载。
测试同时隔离 agent home 和插件 state，绝不写真实 agent 目录。覆盖所有权四条规则、
用户修改、并发锁、build/action 共用记录和检出移动后的引用可达性。

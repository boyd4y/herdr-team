# Herdr Team plugin

给 Herdr 的 sidebar agent 行加 `$harness_logo`，安装配套字体及 Ghostty / kitty
码点映射，并把 `prefix+t` 绑定到 `bunx herdr-team watch` popup。只有一次性安装脚本，
无 daemon、无运行时 npm 依赖，不起 agent，也不改项目的 `.herdr/`。

需要 Herdr 0.9.0+、Node 18+，支持 macOS / Linux。运行团队和 popup 另需 Bun 1.2+，
CLI 仍是单独的 npm 包。字体和安装脚本均随插件分发，安装 action 不联网；首次
`bunx herdr-team` 可能需要下载 CLI，离线使用前需准备好它。

## 安装

从这个仓库检出，在仓库根目录运行：

```sh
herdr plugin link ./herdr-team-plugin
herdr plugin action invoke linxai.herdr-team.configure
herdr plugin action invoke linxai.herdr-team.install-font
```

`link` 只注册插件，不运行 build hook。GitHub 子目录安装源为
`linxai/dev-skills/herdr-team-plugin`；GitHub 安装会运行 `bin/setup.js`，一次装字体、
终端映射及 Herdr 配置，尝试 reload 当前会话。当前仓库是私有的；此任务不发布、
不 push，也不保证 Herdr 的 GitHub 下载流程有私库访问权限。使用本地 link 即可。
没有运行中的 Herdr 时安装仍可完成，启动 Herdr 后调用 `configure` 应用配置。

在运行 `herdr-team` 的 shell 中启用图标（如需持久化，由用户加入自己的 shell 配置）：

```sh
export HERDR_TEAM_LOGOS=font
```

新开终端窗口，让字体和映射生效；部分终端需要完全退出再打开。安装器不会改
shell 配置或 Herdr 服务器的环境。`lead` 后续正常运行 `up` / `dispatch` 时，CLI
按 agent kind 写图标 token；复用常驻角色也会刷新。已有 token 的 TTL 是 24 小时，
没有后台续期。未启用开关、未知 kind 或没有字形的 kind 不显示厂商图标。

## Actions 和撤销

| Action | 行为 |
| --- | --- |
| `linxai.herdr-team.configure` | 校验候选配置，写 sidebar 和 popup 托管块，reload 当前会话 |
| `linxai.herdr-team.unconfigure` | 撤掉 Herdr 托管块并 reload |
| `linxai.herdr-team.install-font` | 安装用户字体并映射已有 Ghostty / kitty 配置 |
| `linxai.herdr-team.uninstall-font` | 删除本插件的字体副本及终端托管块 |

卸载前先撤配置和字体，再解除本地链接：

```sh
herdr plugin action invoke linxai.herdr-team.unconfigure
herdr plugin action invoke linxai.herdr-team.uninstall-font
herdr plugin unlink linxai.herdr-team
```

Herdr 自己的插件日志、config/state 目录由 Herdr 管理；本插件不写额外的备份或状态。
`unconfigure` 不清除 CLI 的 token；撤掉模板后它们不再显示，并按 CLI 的 TTL 到期。

## 配置边界

Herdr 配置优先用 `HERDR_CONFIG_PATH`，其次 `$XDG_CONFIG_HOME/herdr/config.toml`，
默认 `~/.config/herdr/config.toml`。通过 `HERDR_BIN_PATH`（否则 PATH 上的 `herdr`）
运行 `config check`，候选文件检查通过才写入；reload 失败会报错，已保存的配置保留，
可重跑 action。安装 hook 无可用会话时会提示稍后运行 `configure`。

所有修改都在 `# >>> herdr-team:config` / `# <<< herdr-team:config`，或终端的
`herdr-team:font` fence 内。块外内容、原有换行及末尾空行逐字保留，重复执行不会
叠加块；撤销能还原原文件，包括安装前没有配置文件的情况。普通 dotfile 符号链接
保留，悬空链接和残缺/重复 fence 会报错。

已有常规 `[[keys.command]]` 的 `prefix+t` popup，且 command 同为
`bunx herdr-team watch` 时会直接复用，卸载时保留。其他键位冲突、已有
`[ui.sidebar.agents]`（包括 inline / dotted 定义）造成的 TOML 冲突，由 Herdr 的
校验拒绝；用户先自行整理冲突后重跑，不会覆盖别的插件。复杂 TOML 写法的已有
popup 可能无法识别为可复用，仍由 Herdr 校验阻止重复绑定。

macOS 字体装到 `~/Library/Fonts/HerdrTeamAgentIconsMax-Regular.ttf`；Linux 装到
`${XDG_DATA_HOME:-~/.local/share}/fonts/`，尽力调用 `fc-cache`。本插件使用独立文件名，
不移除手工安装或其他插件的字体副本；同名文件内容不符时拒绝覆盖/删除。

终端只修改已存在的配置文件：

- Ghostty：`$XDG_CONFIG_HOME/ghostty/config`、`config.ghostty`（默认 `~/.config/`）；
  macOS 也检查 `~/Library/Application Support/com.mitchellh.ghostty/` 下的两个文件。
- kitty：`$XDG_CONFIG_HOME/kitty/kitty.conf`（默认 `~/.config/`）。

码点映射来自字体实际 Unicode 字形，按连续范围推导，不写死上界。不更换主字体，
字体族名不加引号。不创建缺失的终端配置；未找到文件时输出范围供用户配置后重跑。
其他终端需自行指定逐码点字体；不支持逐码点映射的终端不在自动安装范围内。

## 字体来源与离线验证

字体原样来自 [hhdebb/herdr-radar 的固定修订](https://github.com/hhdebb/herdr-radar/tree/ae46869a0a40f675a333342510c915dbc155ae6a)
（18,052 bytes），字形设计继承自 MIT 的 `qintmb/herdr-icon-agent-ui`。
assets 包含完整 [SIL OFL 1.1](assets/OFL.txt)、[MIT 通知](assets/ICON-LICENSE.txt)
及 [逐厂商出处表](assets/THIRD_PARTY_NOTICES.md)。厂商商标归各自所有者，不代表关联或背书。

测试位于本包 `tests/*.test.cjs`，使用 Node 内置测试器。在本包目录运行：

```sh
node bin/check-font.js
node --test tests/*.test.cjs
```

仓库根目录的 `make plugin-test` 运行同一组检查，`make verify` 已包含它。
检查直接解析 TTF 的 cmap、post、family 与轮廓索引，将厂商名字和码点逐个与
`herdr-team-cli/scripts/lib/logos.ts` 比较；增减、换位、缺字或字体族名变化都会失败。
跨包一致性检查仅在开发验证时读 CLI 源码，四个安装 action 可独立运行。
测试用临时 HOME、XDG 目录及假的 Herdr / font cache 命令，验证精确回滚、幂等、
独立分发和冲突拒绝，不依赖网络或活 workspace。

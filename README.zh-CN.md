# Herdr Team

[English](README.md) · 简体中文

Herdr Team 是面向项目级 agent 团队协作的公开 Herdr 插件，内置 `herdr-team` CLI 和 agent skill。CLI 读取和更新项目 `.herdr/` 中的身份、角色卡和任务卡；Herdr 运行原生 agent 会话；Team Console 调度已明确入队的工作。无需独立 daemon 或运行时 npm 依赖。

## 安装

Herdr Team 支持 macOS 和 Linux。请安装 [Herdr](https://herdr.dev) 0.9.3 或更新版本、[Node.js](https://nodejs.org) 22.20 或更新版本（含 `npm`/`npx`），以及 [Bun](https://bun.sh) 1.2 或更新版本。CLI 安装需要 Bun 在 `PATH` 中；skill 安装通过 `npx` 使用 Skills CLI，首次下载时可能需要网络。

从公开 GitHub 仓库安装插件：

```sh
herdr plugin install boyd4y/herdr-team
```

安装 hook 会安装内置 CLI 和 skill，并写入 Herdr 托管的侧栏与 popup 配置。它不会初始化项目、启动 agent 或修改项目的 `.herdr/`。CLI 安装到 `$XDG_BIN_HOME/herdr-team`；未设置该变量时为 `~/.local/bin/herdr-team`。请确保该目录和 Bun 同时出现在 shell 与 Herdr server 的 `PATH` 中。安装器不会修改 shell 启动文件。如果安装时没有可 reload 的 Herdr 会话，请在 Herdr 会话中调用 `herdr-team.configure`。

检查安装：

```sh
herdr-team --help
```

## 为项目启动团队

在项目根目录初始化团队。可选预设，或通过 `--roles-file` 提供角色定义；接受预设职责前，请阅读 [CLI 指南](cli/README.md) 和内置 skill 的[团队设置参考](skill/references/team-setup.md)。

```sh
herdr-team init --plan balanced
herdr-team validate
```

检查 `.herdr/identity.md`、`.herdr/roles/<role>/.role.yaml` 中的角色元数据，以及 `.herdr/roles/<role>/prompt.md` 中的角色说明，并按项目需要编辑。

运行 `herdr-team role list` 查看角色；用 `herdr-team role add <name> --kind <kind>` 添加角色；用 `herdr-team role add <name> --force --body <text>` 或 `--body-file <file>` 更新现有角色职责；用 `herdr-team role rm <name>` 移除角色。添加角色后运行 `herdr-team up`，让新角色启动并上报信息。

创建任务时指定负责人和可选的交棒角色顺序：

```sh
herdr-team add "Implement login" --role dev --handoff test
herdr-team tasks
```

在 Herdr pane 中运行团队生命周期命令。启动常驻角色和 Team Console 后，再明确派发任务：

```sh
herdr-team up
herdr-team dispatch
herdr-team status
```

`up` 创建或复用项目 workspace 与常驻 agent，然后打开或复用 Team Console tab，不抢当前焦点。它不会将 todo 任务入队。`dispatch` 将 todo 卡入队并尝试投递；角色空闲后，Console 会自动调度剩余队列。用 `herdr-team tasks <id>` 查看完整任务卡，用 `herdr-team status` 对照卡片进度与 Herdr 实时 agent 状态。

## 工作如何流转

`.herdr/` 任务卡是工作流记录。卡片的 `status` 表示任务进度（`todo`、`doing`、`review` 或终态）；Herdr 的实时 agent 状态表示原生会话是否可用或正在工作；卡片的 `delivery` 记录表示一次分配的排队或投递状态（`queued`、`sending`、`submitted`、`claimed` 或 `uncertain`）。三类状态相关但含义不同。

每次分配都有唯一 delivery ID。接收 agent 必须先领取该 ID，完成时交棒也要传入同一个 ID。接收者忙碌、阻塞、状态未知或不可用时，任务留在队列。交棒会把可选摘要追加到任务 `task.md`，记录下一个负责人，并将下一次分配入队。没有后续角色时，最后负责人完成任务。队列状态和示例见 [CLI 指南](cli/README.md#team-console)。

Console 是自动调度器，在项目的 Team Console tab 中运行。关闭它会暂停自动投递，队列记录仍保存在磁盘；运行 `herdr-team up` 或 `herdr-team console` 可恢复。`console --observe`、`console --once` 和 `console --line` 是只读视图，不调度任务。`uncertain` 表示消息可能已经送达：lead 应先检查 agent 与任务产物，再运行 `herdr-team queue retry <id>`。重试会分配新的 delivery ID。队列用于避免盲目重复发送，但无法保证底层终端或 agent 恰好执行一次。

如果 Herdr 官方 integration 上报了 session ID，常驻角色可以恢复之前的原生会话。请安装或更新对应的 Herdr integration（例如 `herdr integration install codex`），并确保它在关闭前上报 session。`herdr-team up --fresh` 会忽略待启动角色的已保存记录；正在运行的 agent 仍会复用。限制和排查方式见 [CLI 会话恢复说明](cli/README.md#快速开始)。

## 升级、移除与故障排查

GitHub 安装的插件请通过 Herdr 插件管理器更新或重新安装 `boyd4y/herdr-team`。本地 link 的开发检出请在仓库根目录运行 `herdr plugin link .`，以刷新插件 manifest 和事件 hook，然后运行 `herdr plugin action invoke herdr-team.configure`。`configure` action 会应用 Herdr Team 托管的布局与配置并 reload config；它本身不会注册已变更的事件 hook。Herdr 的 `PATH` 中需保留用户 bin 目录和 Bun。

移除插件前，先用对应 action 撤销插件管理的 skill、Herdr 配置和 CLI shim：

```sh
herdr plugin action invoke herdr-team.uninstall-skill
herdr plugin action invoke herdr-team.unconfigure
herdr plugin action invoke herdr-team.uninstall-cli
```

然后通过 Herdr 插件管理器移除插件。本地开发 link 则在上述 action 后运行 `herdr plugin unlink herdr-team`。这些 action 会保留用户修改过的文件，以及 Herdr Team 托管块之外的配置。`herdr-team down` 只停止团队 agent，默认保留项目 workspace；它不是卸载命令。

常见检查：

- 找不到 `herdr-team`：将设置的用户 bin 目录和 Bun 加入 `PATH`，打开新 shell，并确认 Herdr server 的环境也包含它们。
- `No team project found`：在含 `.herdr/` 的项目中运行；或在支持该选项的命令中传入 `--root <project-directory>`。
- `up` 或 `dispatch` 提示需要 Herdr pane：请在 Herdr 管理的 pane 中运行，而非普通终端。
- 没有恢复 agent session：恢复依赖受支持的 Herdr integration 上报 session ID；检查错误后再决定是否使用 `up --fresh`。
- 投递状态为 uncertain：明确重试前先检查任务记录、接收 agent 和产物。

完整命令参考、队列细节、原生 session 行为和配置边界见 [CLI 指南](cli/README.md)。开发与 Pull Request 说明见[中文贡献指南](CONTRIBUTING.zh-CN.md)。

## 参与贡献

欢迎提交 issue 和 pull request。请提供涉及的 Herdr、Node、Bun 和 agent integration 版本、准确命令、预期与实际行为，以及最小复现。请勿包含凭证、私有任务正文或 session ID。目录结构、本地插件测试和检查命令见[中文贡献指南](CONTRIBUTING.zh-CN.md)。

# Herdr Team

[English](README.md)

Herdr Team 支持 **Herdr 桌面版**和 **Herdr 终端版**。桌面版的终端与 agent 运行在 **herdr-core（`hc`）**。

`desktop/` 放桌面版原生模块、布局与热加载脚本，`tui/` 放终端版 Herdr 插件与侧栏配置。两端共用 `cli/` 的 `herdr-team` 和 `skill/` 的 Agent Skill。CLI 操作和独立安装见[团队运行指南](docs/team-runtime.md)。

在准备好的演示项目对应的 Desktop Space 中运行 `herdr-team team up`。右侧任务看板和 Agents 列表会随模拟 Codex、Claude、Grok 的任务和状态更新。加 `--fast` 可快速验证。

未初始化项目的本地 Space 显示居中的设置页。点 **Initialize now** 使用当前终端目录初始化并注册项目，取不到时使用 Space 的目录。也可以直接选择本机已安装的 agent，用共享 Skill 配置团队。点击 **View demo** 可查看示例数据。初始化成功后，项目视图中央显示 **Up**，用于启动当前 Space 的团队。面板通过 daemon 状态判断团队是否已运行。
本地 Core 的 dispatch、claim、handoff 和 inbox 重试复用共享投递逻辑，任务会话使用隔离 Git checkout。用 `herdr-team task clean` 回收已结束任务的工作树和 Desktop 资源。

## 当前可以做什么

- `desktop/layouts/herdr-team.json`：复用原生 Spaces、Tabs、终端、Files 和 Changes，右侧加入 Team Console；Agents 使用独立命名的原生扩展。
- `desktop/mods/herdr-team-agents/`：保留原生 harness 图标、Priority／Grouped by space、固定与子 agent 树；列表压成 30px 单行，在 logo 前用细短色条关联所属 space，显示角色、淡色会话标题、可选任务号和状态。完整会话信息与职责收进悬停提示。本地角色变更通过可取消的文件监听更新，监听不可用时使用 Refresh；跳过远程角色读取。不会修改出厂 Agents。
- Agents 分组模式把已通过 CLI 归属校验的任务 Space 合并到父 Space 标题下，使用父 Space 色条；固定与 Priority 模式沿用原生行为。点击任务 agent 仍打开实际 worktree 面板，不移动终端。
- `desktop/mods/herdr-team/`：任务按 ID 倒序、当前及后续负责人、紧凑的角色/harness/model 展示；状态脉冲使用原生动画。
- Board 按任务记录的状态分列，卡片显示当前负责人。窄面板中的非空列会换行，空状态只显示计数。悬停 Team 图标可查看绑定路径、机器和 Space。
- 常规确认和补充输入会在当前任务及 Agents 中显示 **Needs input**。点击 Agents 列表中的会话可回到原终端处理。
- 本机任务详情的 **Archive** 将任务移入存档，**Delete** 经确认后移入回收站。两个位置都可 **Restore**，以前取消的任务统一显示在 Archive。
- List 面向窄侧栏，显示标题、任务号、负责人和记录状态。状态筛选默认选 All，按任务号倒序显示。Open 按阻塞、待审、执行中、待办排序。任务详情分为 Description 和 History，关联需求或缺陷可直接打开。
- 内置明确标注的 Sample，无需项目数据，不启动 agent、不创建任务。
- Inbox 分为 **Email** 和 **Internal messages**，两类消息都能查看发件人、收件人、标题和正文。
- 显式绑定 root＋machine＋space 后，可通过现有 CLI 读取项目角色与任务，展示匹配标签的 Core 终端；这是只读预览。

## 本地验证与试用

研究基线：2026-11-18，本机 Herdr App **0.1.16**、Core **0.1.21**。

### 开发时注册与热加载

安装 Herdr Desktop、Node.js 22+ 和 Bun 1.3.14+ 后，在本仓库根目录一次安装 CLI、Skill 并注册桌面开发布局：

```sh
npm run setup:desktop
```

Windows x64 使用 Git for Windows，并将原生 `bun.exe` 和 agent CLI 加入用户 PATH。安装器把 `herdr-team.cmd` 放在 Bun 的 `bin` 目录（默认 `%USERPROFILE%\.bun\bin`）。设置了 `XDG_BIN_HOME` 时使用指定目录，该目录须已在 PATH 中。PowerShell 可用 `npm.cmd run setup:desktop` 安装。

在 Herdr 里选择 `herdr-team` 布局。随后在项目终端中运行 `herdr-team team up` 建立 Space 绑定并启动常驻角色。隔离角色在接到任务时启动。

需要 Node.js 22 或更新版本。在仓库目录运行：

```sh
npm run dev
```

脚本首次把 `herdr-team` 布局、Team 模块和 Agents 模块同步到 `${HERDR_APP_HOME:-~/.config/herdr-app}`，之后监听源码保存、新增和删除，由 App 热加载。脚本不打开 App、不启动 agent，也不切换当前布局。

在已打开的桌面 App 中选择该布局，或手动执行：

```sh
herdr-app do layout.switch --name herdr-team
```

只注册一次、不持续监听：

```sh
npm run dev:register
```

`Ctrl+C` 停止监听，已注册的文件保留。修改 `desktop/mods/` 和 `desktop/layouts/herdr-team.json`；生成的类型、`jsconfig.json`、隐藏文件及 `node_modules` 不会同步。开发布局通过当前 Space 的 CLI 绑定读取项目数据。固定视图的 props 也应改在源码布局中。

脚本用 app home 下的 `.herdr-team.json` 记录此检出的同步文件；遇到已有同名个人文件、其他检出的注册或安装副本被外部修改会报错保留，先移走冲突文件再重试。不要直接编辑生成的开发副本。可通过 `HERDR_APP_HOME=/absolute/app-home npm run dev` 指定另一配置目录，查看或切换时也使用同一环境变量。

标签栏右侧的 **Team** 按钮像 Files 一样切换面板显示。如需键盘切换，可在 `keys.json` 中绑定快捷键（改动后该文件归你所有，Herdr 不再自动补充新的默认快捷键）：

```json
"layout:herdr-team": { "cmd-shift-e": "layout.toggle:team-console" }
```

### 验证

```sh
npm test
npm run check
(cd cli && bun install --frozen-lockfile)
npm run test:cli
npm run test:install
npm run typecheck
```

无 npm 依赖。`check` 使用桌面版自带检查器，只验证初始加载和渲染，不会安装、切换当前布局，也不等同于完整视觉验收。

Agents 没有明确排序偏好时默认按 Space 分组，仍可从原生排序菜单切换。

Team Panel 跟随所选 Space 的机器，显示该机器上已绑定项目的 Tasks、Issues 和 Inbox。远程机器需要安装同版 `herdr-team`。在该远程 Space 的项目终端内运行一次 `herdr-team space bind --core`，然后切回该 Space 或点 **Refresh**。远程任务和 Issue 视图为只读，切换 Space 或点击 **Refresh** 时重新读取。在远程 Inbox 打开邮件会在对应机器上记录已读。本地项目继续监听 `.herdr/`，两端的终端状态都由 Core 实时提供。

手动固定面板见 [英文 README 的 props 示例](README.md#try-the-preview)。`root` 指向主检出，`space` 与 `machine` 使用 `herdr-app ls` 返回的标识。远程 `space` 使用 `机器名/Space ID`。

终端匹配使用 `team.project`、`herdr.space`、`team.role` 等标签；旧版 metadata 不会自动变成 Core 标签。尚无匹配时显示 unknown，不把空闲、退出或恢复后的 shell 伪报为任务完成。

每个任务 checkout 使用一个原生 Space，同一任务的后续角色共用该 Space。原生 Spaces 自己按 Git worktree 关系缩进展示，不修改或扩展左侧面板。CLI 用任务 Space ID 显式关联主团队；在主项目和任务 Space 间切换时，右侧 Team 保留同一团队的数据、筛选、选中任务与监听，切到其他项目才更换绑定。现有任务可通过 `herdr-team space sync [任务号] --root 主项目` 原地接入，不重启 agent、不发送输入、不改任务或 delivery。

## Herdr 终端版

安装 Herdr 0.9.3+、Node.js 22+ 和 Bun 1.3.14+ 后，在仓库根目录链接本地插件，再安装共享 CLI、Skill 和 TUI 侧栏配置：

```sh
herdr plugin link ./tui
npm run setup:tui
```

在 Herdr TUI 会话内也可运行 `herdr plugin action invoke herdr-team.install` 应用配置并重载。GitHub 安装使用 `herdr plugin install boyd4y/herdr-team/tui --ref main`。Windows 的本地安装和 GitHub 安装均使用 `tui` 目录。macOS 和 Linux 上已有从仓库根路径安装的插件可以沿用原来源更新。

## 接下来如何迁移

保留现有 `TEAM.md`、`agents.json`、角色职责和任务/delivery 规则；重做运行适配：旧 `herdr` 的 workspace/pane API 改为桌面版布局命令与 Core 的 terminal API。

具体能力、限制和来源见 [研究记录](docs/research.zh-CN.md)，实施顺序见 [迁移计划](docs/plan.zh-CN.md)。交棒、协作顺序仍由 Skill 指导，mod 不增加一套 workflow。

贡献前阅读 [AGENTS.md](AGENTS.md)。界面使用英文，用户标题、任务正文等保留原始语言。
## Team 面板中的需求和缺陷

Team 面板有 **Tasks**、**Issues** 和 **Inbox**。Issues 默认显示全部需求和缺陷，也可以分别按类型和迭代筛选。需求和缺陷共用一套卡片和编号。

Tasks 和 Issues 共用右上角的迭代筛选器。Task 可以设置自己的迭代，留空时沿用关联 Issue 的迭代。切换 Tasks、Issues 或 List / Board 时保留所选版本。

任务可以独立存在，也可以关联一张 Issue。一张 Issue 可以关联多个任务，两个详情页可以互相跳转。创建任务时可加 `--requirement R0001`，已有任务可用 `herdr-team backlog link R0001 0001` 关联。

Inbox 左侧用 **Active / Trash** 切换文件夹，右侧用 **All / Unread / Read** 筛选。外部邮件打开后记为已读，Trash 中的邮件详情会显示路由原因。内部消息在接棒人成功交棒后记为已读，消息详情可以跳转到关联任务。Agent 按职责处理邮件和内部消息，需要时创建或更新 Issue、Task。见 [Inbox 与交棒流程](skill/references/handoff.md#inbox-与投递)。

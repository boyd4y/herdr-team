# Herdr Desktop Team

[English](README.md)

面向 **Herdr 桌面版**的 layout＋原生 mod 插件，底层终端与 agent 运行在 **herdr-core（`hc`）**。

这是独立于旧版 [herdr-team](https://github.com/boyd4y/herdr-team) 的新仓库。目前完成接口研究与原生面板雏形，**尚未实现桌面版团队派活与交棒**。

## 当前可以做什么

- `layouts/team.json`：复用原生 Spaces、Agents、Tabs、终端、Files 和 Changes，右侧加入 Team Console。
- `mods/team-console/`：任务按 ID 倒序、当前及后续负责人、紧凑的角色/harness/model 展示；状态脉冲使用原生动画。
- 内置明确标注的 Sample，无需项目数据，不启动 agent、不创建任务。
- 显式绑定 root＋machine＋space 后，可通过现有 CLI 读取项目角色与任务，展示匹配标签的 Core 终端；这是只读预览。

## 本地验证与试用

研究基线：2026-11-18，本机 Herdr App **0.1.16**、Core **0.1.21**。

```sh
npm test
npm run check
```

无 npm 依赖。`check` 使用桌面版自带检查器，只验证初始加载和渲染，不会安装、切换当前布局，也不等同于完整视觉验收。

试用时将 `mods/team-console/` 与 `layouts/team.json` 放入 Herdr app home 的对应目录，通常为 `~/.config/herdr-app/`。保留已有同名个人文件，再手动选择 `team` 布局。默认显示 Sample。

真实项目绑定方式见 [英文 README 的 props 示例](README.md#try-the-preview)。root 必须指向主检出，space 使用 `herdr-app ls` 返回的真实 ID；远程项目同时指定机器名。不要靠项目名或当前焦点推断归属。

只读数据使用目标机器上的 `herdr-team tasks --json` 与 `role list --json`；本地监听 `.herdr/`，远程或监听不可用时手动 Refresh。Core 状态由桌面版响应式模型提供，不轮询。

终端匹配使用 `team.project`、`herdr.space`、`team.role` 等标签；旧版 metadata 不会自动变成 Core 标签。尚无匹配时显示 unknown，不把空闲、退出或恢复后的 shell 伪报为任务完成。

## 接下来如何迁移

保留现有 `TEAM.md`、`agents.json`、角色职责和任务/delivery 规则；重做运行适配：旧 `herdr` 的 workspace/pane API 改为桌面版布局命令与 Core 的 terminal API。

具体能力、限制和来源见 [研究记录](docs/research.zh-CN.md)，实施顺序见 [迁移计划](docs/plan.zh-CN.md)。交棒、协作顺序仍由 Skill 指导，mod 不增加一套 workflow。

贡献前阅读 [AGENTS.md](AGENTS.md)。界面使用英文，用户标题、任务正文等保留原始语言。

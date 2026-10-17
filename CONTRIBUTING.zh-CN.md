# 参与贡献

[English](CONTRIBUTING.md) · 简体中文

感谢帮助改进 Herdr Team。Issue 和 Pull Request 请描述具体的用户问题或改进，并保持改动聚焦。

## 获取代码

Fork [boyd4y/herdr-team](https://github.com/boyd4y/herdr-team) 后克隆自己的 fork，或基于本地检出提交补丁：

```sh
git clone https://github.com/<your-account>/herdr-team.git
cd herdr-team
```

仓库按职责组织：

- `bin/`：插件 setup、配置以及安装/卸载脚本。
- `cli/`：Bun/TypeScript CLI 源码、package manifest、锁文件和 CLI 测试。
- `skill/`：内置 agent skill 和参考文档。
- `tests/`：使用 Node 内置测试器运行的插件脚本与打包测试。
- `herdr-plugin.toml`：Herdr 插件元数据、setup hook、actions 和事件 hook。
- `README.md` / `README.zh-CN.md`：英文和简体中文用户指南。

## 开发与验证

安装 Bun 1.2 或更新版本，以及 Node.js 22.20 或更新版本。CLI 没有运行时 npm 依赖；TypeScript 和 Bun 类型定义属于开发依赖。在 `cli/` 安装依赖并运行检查：

```sh
cd cli
bun install
bun test
bun run typecheck
```

在仓库根目录运行插件和打包测试：

```sh
node --test tests/*.test.cjs
```

自动化测试使用临时项目目录和离线 Herdr 可执行文件，无需连接正在运行的 Herdr。手动集成测试请使用一次性 Herdr profile/session 和临时项目，不要使用个人 workspace 或全局配置。在该环境中 link 本检出并调用 setup：

```sh
herdr plugin link .
herdr plugin action invoke herdr-team.install
```

link 只注册插件；install action 会运行 setup 入口。测试后按[主 README](README.md#upgrade-remove-and-troubleshoot) 所述运行卸载 actions，再解除本地 link。不要用集成测试覆盖无关的 Herdr 配置或用户文件。

## 修改约定

- CLI 帮助、输出、错误、TUI 标签和生成的默认说明必须使用英文。不要增加本地化、locale 检测、翻译目录或语言参数。
- 文档可使用中文或英文。公开行为改变时同步英文和中文入口。
- 保留用户提供的标题、描述、角色提示、摘要及其他 Unicode 数据。
- `.herdr/` 任务卡是工作流记录。使用 CLI 修改任务元数据并领取/交付任务。
- 除非产品需求变更，不引入运行时依赖或系统服务。
- 不要提交凭证、个人绝对路径、真实 delivery ID 或私有任务内容。

## 提交 Issue 或 Pull Request

报告问题时请提供相关 Herdr、Node、Bun 和 agent integration 版本、准确命令、预期与实际结果，以及最小复现。删除密钥和私有 workspace 数据。Pull Request 请说明用户可见的变化、涉及的文档或命令、已运行的检查，以及无法验证的平台或版本组合。公开行为变化时同步更新命令示例和双语 README。

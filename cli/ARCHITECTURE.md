# CLI 模块导航

`cli/scripts/cli.ts` 是命令入口：解析参数，调用业务操作，格式化输出和错误。
它不决定工作流，也不保存角色职责文本。新增代码按职责进入下面的模块，不在 lib 根目录继续堆文件。

## 目录职责

| 目录 | 负责什么 | 从哪里看起 |
| --- | --- | --- |
| `scripts/lib/team/` | 项目配置、初始化、角色维护、模板/模型方案读取、校验 | `project.ts` 读取 .herdr；`init.ts` 建配置；`roles.ts` 改角色；`templates.ts` / `plans.ts` 读职责、模型目录与方案资产；`validate.ts` 校验引用 |
| `scripts/lib/tasks/` | 任务卡、交付历史、交棒、版本验收 | `cards.ts` 建卡/修改；`handoff.ts` 记录结果并交接；`verification.ts` 管提交记录、checkout 校验和测试资源；`records.ts` 写历史 |
| `scripts/lib/dispatch/` | 排队投递、任务会话启动、团队起停与清理、项目归属 | `queue.ts` 驱动投递；`delivery.ts` 定义投递记录；`assignment.ts` 组装输入；`task-agent.ts` 定位任务会话；`launch.ts` 起停团队；`team-scope.ts` 防跨项目误用；`cleanup.ts` 回收 worktree |
| `scripts/lib/runtime/` | Herdr 适配、持久化锁与本机状态、原生会话、Console 所有权 | `herdr.ts` 是可替换 API 边界；`state.ts` 管状态目录与锁；`sessions.ts` 管原生会话记录；`console.ts` 保证一个调度 Console |
| `scripts/lib/integration/` | 已有 PR 的核对、决定记录、显式合并 | `pull-request.ts` 对接 GitHub；`merge.ts` 校验批准并串行合并/同步 |
| `scripts/lib/ui/` | 只读状态、终端画面、侧栏与 workspace 元数据 | `status.ts` 生成状态；`console-model.ts` 生成数据及本地筛选；`console-view.ts` 组装 OpenTUI 组件；`sidebar.ts`、`workspace-badges.ts`、`workspace-git.ts` 更新展示数据 |
| `scripts/lib/shared/` | 通用数据类型、YAML、终端文字排版 | `types.ts`；`yaml.ts` 薄封装 Bun.YAML 的字段排序与映射校验；`text.ts` 格式化纯文本；不放角色或工作流策略 |

## 模板在哪

职责正文的唯一源是 `skill/assets/roles/<role>/prompt.md`。
lead、dev、test、search、docs、review 各有一个目录；default 是自定义角色的通用起点。
模型初始目录在 `skill/assets/models.json`；init 在缺失时复制为 `.herdr/models.json`，后者优先读取且可由用户修改，角色方案在 `skill/assets/plans.json` 引用 harness/model，项目背景模板在 `skill/assets/identity.md`，均不嵌在 TypeScript 中。
初始化只在项目 identity 缺失时复制该模板；Skill 按项目事实填写，已有内容不会被更新模板覆盖。

修改角色正文直接改对应 Markdown。Skill 在 onboard 时按需读取并调整；CLI 对未提供正文的新角色读取同名模板，
未知角色使用 default。更新资产不会覆盖项目里已经自定义的 prompt.md。

`bin/install-cli.js` 冻结 CLI 源码、锁文件和所需资产，安装缓存保留 `cli/` 与 `skill/assets/` 的相对结构。
CLI 不依赖原始 checkout 或 agent 已安装的 Skill 路径；Skill 安装包也带同一份资产。
安装副本由源资产生成，不手改缓存，不另建第二套模板。

## 操作怎样经过模块

- 建任务：命令入口 → team 读取/校验项目 → tasks 保存明确的负责人和交棒链。
- 派任务：命令入口 → dispatch 入队/投递 → runtime 调 Herdr；任务事实与精确参数由 assignment 组装，Skill 指导操作。
- 交棒：tasks 保存摘要/验收结果 → dispatch 投递下一棒。CLI 不自动创建 PR 或决定合并。
- 合并：Skill 明确请求 → integration 核对 PR、证据和 SHA → 串行操作 → tasks 保存结果。
- Console：ui 负责画面和按键；调度操作仍调用 dispatch，底层会话与锁由 runtime 管理。

模块互相使用明确的函数和类型，不导入 CLI 命令入口。不要增加旧路径 re-export、兼容 workflow 引擎或通用 helpers 桶。
项目目录归属核对和失败恢复属于现行可靠性机制，不是可因清理旧格式而移除的逻辑。

## 当前 TUI 实现

Console 使用 [`@opentui/core`](https://github.com/anomalyco/opentui) 的 Box、Text、Select、Input 和 ScrollBox。
布局、终端宽度与换行、按键解析、焦点、鼠标、滚动、备屏及终端恢复交给框架；项目代码只组装组件、绑定业务快捷键、刷新任务数据和调用调度。
`console-model.ts` 将任务和会话事实投影为展示数据；`console-view.ts` 负责页面布局、详情和业务按键。
`console-roles.ts` 按角色名复用原生表格行，派单和角色排序变化只更新已有组件，删除角色时销毁对应行。
`console-flow.ts` 组装节点与连接线，集中管理 OpenTUI Timeline 的启动、暂停和清理；动画帧不查询 Herdr。
各视图共用 `console-theme.ts` 中的颜色，不通过其他组件取得主题，也不引入通用组件框架。
`console-sample.ts` 提供内存中的循环演示，不读取真实团队、不写记录、不获取调度锁。
不引入 React 或第二套终端渲染循环。`--once` / `--line` 使用只读文本输出，不启动交互渲染器。

安装器用 `bun install --production --frozen-lockfile --ignore-scripts` 在冻结缓存中安装生产依赖，
由 Bun 选择当前平台的 OpenTUI 原生库，验证加载成功后才更新 CLI 入口。需要 Bun 1.3.14+，无需 Zig 编译器。
测试使用 OpenTUI 自带的内存渲染器验证真实组件的输入、滚动和退出；不维护自制终端模拟器。Herdr 仍承载 tab/pane 和 agent API。

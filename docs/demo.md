# 本地演示控制

Demo 由本地隐藏设置启用，不出现在普通 `up --help` 中。只在独立演示项目中使用。

在空目录初始化：

```sh
HERDR_TEAM_DEMO=1 herdr-team team init
herdr-team team up
```

Windows PowerShell 中可以这样初始化并启动。

```powershell
$env:HERDR_TEAM_DEMO = '1'
herdr-team team init
Remove-Item Env:HERDR_TEAM_DEMO
herdr-team team up
```

初始化会在忽略的 `.herdr/demo.json` 中保存设置。已有 `"kind": "herdr-team-demo"` 的项目默认启用，可用 `"enabled": false` 暂停自动启动。正常启动使用 `herdr-team team up`，角色显示为 `dev`、`test` 和 `review`。

```json
{
  "kind": "herdr-team-demo",
  "enabled": true,
  "speed": 1,
  "concurrency": 3,
  "paused": false
}
```

也可以先创建 `.herdr/demo.json`，写入 `{"enabled":true,"speed":0.5}`，再运行普通 `herdr-team team init`。初始化保留已有节奏设置。

- `speed`：默认 1；0.5 为半速，2 为双速，范围 0.1–100。
- `concurrency`：默认 3，范围 1–9；调低后等待已有任务结束再补充任务。
- `paused`：改为 true 后暂停后续演示步骤、派发和合并；改回 false 继续。已经发出的 CLI 操作会完成。
- 运行中保存该文件即可改变速度、并发和暂停状态。使用编辑器原子保存，避免运行器读到写入一半的 JSON。

环境变量 `HERDR_TEAM_DEMO=1` / `0` 覆盖启用设置；`HERDR_TEAM_DEMO_SPEED` 和 `HERDR_TEAM_DEMO_CONCURRENCY` 覆盖同名文件设置。需要运行中调速时，使用文件设置，不要设置速度环境变量。

默认每隔约 8 秒安排一个任务，最多同时推进 3 个，每个角色阶段约 20 秒；实际总时长受 Git、派发和依赖影响。18 个任务包含需求、缺陷、优先级、依赖，以及两次故意失败后返工的路径。每张任务卡包含背景、实施范围、验收输入输出和交接说明；mock agent 执行去重、优先级、依赖、恢复和筛选函数的检查，提交并验证固定 SHA。

这是明确标记的 mock 演示，不会实现任务标题所描述的完整生产控制台。旧 `-demo` / `--demo` 和 `--fast` 仍兼容内部回归用途；`--fast` 跳过讲解等待和暂停。新设置只作用于新一轮演示，不补写历史任务。

演示仍要求在 Herdr Desktop 的项目主 Space 第一个终端中运行，并使用干净的 main checkout。运行结束沿用原有验收、合并和临时会话回收流程。

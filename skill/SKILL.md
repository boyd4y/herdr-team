---
name: herdr-team
description: 用项目内 .herdr/ 的身份、角色卡和任务卡驱动 Herdr agent 团队：初始化骨架、按角色拉起 agent 并按优先级和依赖派活、以任务卡为载体在角色间交接。适用于需要多 agent 分工的本地开发；不绑定具体项目、仓库名或 agent 类型。
---

# Herdr Agent 团队

`.herdr/` 是团队的唯一事实来源：身份在 `identity.md`，谁在做事在 `roles/`，做什么在 `tasks/`。Herdr 只负责把 agent 跑起来、承载实时状态。

## 确定性的事全归 CLI

校验、算 id、译 slug、状态流转、起团队 —— **全部**由 `herdr-team` CLI 做。

```bash
herdr-team <命令>
```

安装 Herdr Team 插件后直接运行 `herdr-team`。

**你不自己算 id、不自己校验引用、不自己拼 frontmatter。** 那些是代码的活；用判断去替代它们就会出错。

## 项目边界

任务号和角色名只属于当前项目的 `.herdr/`。不同项目的 `dev`、`lead`、`0001` 不能混用。
启动/派活消息会给出绝对团队根目录；在 worktree 或其他目录执行命令时，显式传 `--root <团队根目录>`。
Herdr agent 内部名称可能包含项目命名空间；不要凭侧栏角色名执行全局 `herdr agent prompt`。
派活与交棒使用 `herdr-team dispatch` / `handoff`，由 CLI 绑定项目并定位 pane。
归属不明确时停止并交给用户确认，不按同名 workspace 或同名角色猜测。

## 命令归属

默认只有 `lead` 有权运行编排命令：`init`、`add`、`edit`、`up`、`dispatch`、`clean`、`down`、`role add`、`role rm`；也可运行 `handoff` 和只读查询。Git 生命周期（建 `feat/*` 分支、合并、删分支）同样只归 `lead`。这些是提示词约定，CLI 不做角色权限拦截。

非 lead 角色：在 herdr-team 命令中，你只能跑 `handoff <id>` 和只读查询（`tasks`、`status`、`validate`、`role list`）。建卡、改卡、派活、起 worktree、起停 agent、增删角色、清理都交给 `lead`。

Git 生命周期也归 `lead`：你可以在当前任务允许的范围内 `git commit`，但不建分支、不合并、不删分支、不碰 main。

## lead 负责的两件事

**① 读懂人话**，把用户的说法落成一个命令：

| 用户说 | 你跑 |
| --- | --- |
| "加个任务：xxx，给 dev，做完转 test" | `herdr-team add "xxx" --role dev --handoff test` |
| "这个任务改给 test" | `herdr-team edit <id> --role test` |
| "起团队" / "拉起 agent" | `herdr-team up` |
| "派活" / "派指定任务" | `herdr-team dispatch` / `herdr-team dispatch <id>` |
| "看状态" / "有哪些任务" | `herdr-team status` / `herdr-team tasks` |
| "xxx 干完了" | `herdr-team handoff <id>` |
| "把留下的 worktree 收一下" | `herdr-team clean` |
| "这个任务不要了" | `herdr-team edit <id> --status cancelled` |

字段缺什么就问什么，**不要编**。尤其 `role`：猜错了整张卡就派错人。

**② 和用户逐个确认谁负责什么** —— 见 [team-setup.md](references/team-setup.md)。
先读项目约定，以 `cheap` / `balanced` / `strong` 为起点（**拿不准用 balanced**），
逐个列出角色在本项目里的职责、职责边界、交付与交棒方式，再列模型和是否隔离。
需要确认的边界要问清，例如 lead 的编排范围、dev 是否同步文档、test 只验证还是也改代码。
等用户确认整份分工后，把确认的职责写进每个角色的 `body`，用 `init --roles-file F` 落盘；
只有用户连预设职责正文也原样接受时才直接 `init --plan <方案>`。

**只有写代码和搞架构才上 `sol`**，其余用便宜档。预设不能替代项目职责的确认。

已有角色改职责由 lead 跑 `herdr-team role add <name> --force --body "<完整的新职责与交棒说明>"`，
长正文可用 `--body-file F`。更新时不必重述 `--kind`，未提供的元数据保留；省略正文则保留原文。
`init --force` 只重写元数据并保留已有 `prompt.md`，不能用它更新职责。

## 命令表

| 命令 | 作用 |
| --- | --- |
| `init --plan P` | 建 `.herdr/` 骨架并写角色卡。方案：`cheap` / `balanced` / `strong` |
| `validate` | 校验 `.herdr/`：角色卡、任务卡、引用完整性、依赖环 |
| `add <title>` | 建一张任务卡（算 id、译 slug、校验引用、写卡） |
| `edit <id>` | 改一张卡；已派出的要 `--force`，终态的不许改 |
| `handoff <id>` | 推进流转 —— 交给下一个角色，或最后一个角色收尾（顺带回收 worktree） |
| `role add/rm/list` | **运行期增删改角色**。已有角色用 `add --force --body` 更新职责；新增后跑 `up` 纳入管理 |
| `tasks [<id>]` | 列出任务，或按 id 查看单张任务详情（含正文，不问 Herdr）；列表支持 `--all` / `--role` / `--status` |
| `status` | 合并「卡片写的」和「Herdr 里真实的」两侧状态 |
| `watch` | **只读实时看板**（交互式）。给人用的，agent 不要跑 |
| `up` | 只起常驻角色、纳入新角色，不派活（幂等；要在 Herdr pane 里跑） |
| `dispatch [<id>]` | 派所有 `todo` 任务，或只派指定的一张；按优先级和依赖处理，隔离角色此时才起 worktree/agent（要在 Herdr pane 里跑） |
| `clean` | 按任务分支回收已结束任务留下的 worktree，不受当前角色是否隔离影响 |
| `down` | **关停团队的 agent**，不动 workspace（`--workspace` 才连容器一起关） |

`--help` 看每个命令的参数；`--json` 拿机器可读输出。
`tasks` / `status` / `role list` 的 JSON 列表不带正文 `body`；要读取单张任务正文，
用 `herdr-team tasks <id>`（可加 `--json` 返回单个完整卡片对象）。
按 id 也能读取已结束的任务，不存在的 id 会报错；`add` / `edit` 的 JSON 回执仍不带正文。

`add` / `edit` 用 `--depends-on` 声明依赖，值为逗号分隔的任务 id。
`edit` 会替换全部依赖，空串清空，省略则保留；写盘前拒绝不存在的引用、自依赖和环。
`--handoff` 仍只指定流转角色，修改已派出的卡仍需 `--force`。

`watch` 是**交互式**的，只给人用：它会一直占着终端等人按键，agent 跑它只会挂死。
你想看进展就用 `status` / `tasks`；用户想盯着看，让他自己在终端里跑 `watch`。

`clean` 扫描 `done` / `cancelled` 任务，在各任务 `repo` 中查找
`feat/<id>-<slug>` 的 worktree；交棒给常驻角色后仍会回收。最后一个负责人
`handoff` 到 `done` 时也按同样规则回收。没有匹配分支时返回 `absent`，不动其他
checkout；Herdr workspace 已关闭时报告 `closed`，Git 拒绝删除时报告 `dirty`，
不强制删除，保留分支供 lead 合并。

## 硬规则

- **agent 不修改任务卡**；卡只由 CLI 改。角色卡里要写明完成后退 `handoff` 交棒。
- 一张卡同一时刻只有一个 `role`，这就是"分配"。
- 字段缺什么问什么。**不要用判断替代 CLI**（别手算 id、别手写 frontmatter）。
- 不假设项目、仓库名、分工或 agent 类型；一切从 `.herdr/` 读。
- 不创建 `.herdr/` 之外的业务文件，不推断仓库职责。

## 格式

`.herdr/` 的目录布局、字段约束、枚举值见 [herdr-format.md](references/herdr-format.md)。
CLI 就是照它实现的 —— 卡片不合规时 CLI 会报出来，不要去猜它的意图。

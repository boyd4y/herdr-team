# Setup：初始化与调整团队

onboard 是 Skill 对话，不是 CLI 向导。复用已确认的选择与授权，不反复要求用户确认。

## 了解与确认

读 README、AGENTS.md、目录结构、Git 状态、根 `TEAM.md`、现有角色、任务和队列。
已有团队先用 `role list --json` 检查实际配置，区分新建与调整，保留已有职责和模型偏好。

直接用同一张表确认实际角色的核心工作步骤、harness、模型和启动方式，不增加 workflow 选择环节，
不把职责与模型拆成两轮确认。辅助 docs、research/search 按需要提出；模型方案不能决定固定角色名单。
模型配置按需读 [agents.md](agents.md)。角色名描述职责，不用 agent 类型命名。

## 团队约定 TEAM.md

所有 Skill 入口先检查并读取团队项目根的 `TEAM.md`；它是可提交 Git 的角色工作清单。
缺失时由 Skill 用 [TEAM.md 模板](../assets/TEAM.md) 结合 README、AGENTS.md、已有角色和用户已确认的约定初始化，
按实际角色各写简短的中文编号步骤，通常 1、2、3 条；模板中的 dev/review 仅为示例，不自动新增角色。
不添加背景、偏好、Workflow 或 Completion 章节，不复制交棒、CLI、协作、队列或 worktree 规则。
这些通用操作由本 Skill 的 [handoff](handoff.md) 和按需读取的 [delivery](delivery.md) 指导；不要求用户另写 workflow。
每次创建或按用户要求重建 TEAM.md，检查 `.herdr/identity.md` 与 `.herdr/workflow.md` 是否仍存在。
发现旧文件时先阅读，展示拟迁入的有效内容和确切旧文件路径，再提示用户选择：迁移并清理、仅迁移保留旧文件、暂不迁移。
用户未选择前不迁移或删除，不把默认选项当作同意；本次请求已明确要求迁移/清理时直接执行已授权的选择，不重复询问。
确认迁移后先将有效角色步骤合入 TEAM.md；其他有效项目规则归已有项目文档，通用协作规则按 Skill 执行。
重新读取并核对需保留内容已迁妥，未获授权丢弃的内容保留原文件，再仅删除用户同意清理的旧文件；
内容有冲突、写入失败或旧文件在确认后发生变化时保留它们，说明待处理项，不删除整个 .herdr/ 或任务历史。
选择保留或暂不迁移时，旧文件不作为日常执行依据。没有旧文件时直接初始化；普通读取 TEAM.md 不反复弹迁移询问。
公开文件不迁入凭证、私人路径或本机环境值。已有 TEAM.md 保留用户正文，只按本次请求定向调整，不随升级覆盖。
TEAM.md 在主检出维护；任务会话优先读取派活 root 指向的文件，避免分支副本过期。更改约定不改写活动任务的指派或历史。
AGENTS.md 维护工程约束，TEAM.md 只写各角色的核心工作步骤；两者不复制通用 Skill 操作流程。

## 保存角色与项目约定

Skill 按已确认角色维护 TEAM.md 中对应的简短步骤，不写跨角色流程配置。
角色通过 CLI 保存，不手拼 YAML。`body` 只保留角色职责、边界、交付要求和先读 herdr-team Skill 的入口，
不复制 TEAM.md 已有步骤或命令清单、claim/handoff/PR 操作流程。角色 prompt 默认英文，TEAM.md 模板及生成内容使用中文；用户自带正文保留原语言。
可复用职责模板按角色保存在 [assets/roles](../assets/roles)：lead、dev、test、search、docs、review；
每个目录只有 `prompt.md`，通用职责放在 default。按当前职责选择、阅读并调整所需模板，不整套加载。
agent 预设模板是 [assets/agents.json](../assets/agents.json)，init 仅在项目根 agents.json 缺失时复制。
项目预设纳入 Git，用户可手动修改；已有内容即使 --force 也保留。角色方案在 [assets/plans.json](../assets/plans.json) 引用 kind/preset。
角色优先选择一套完整预设，模型、推理强度、alias 等在预设中维护；选择、更新和旧配置迁移只见 [agents.md](agents.md)。
CLI init 只在根 TEAM.md 缺失时复制模板，不解释角色步骤；已有旧文件的项目先由 Skill 完成上述选择和必要迁移，再初始化本地执行配置；CLI 不迁移或删除旧文件。
CLI 对未提供 body 的新角色按同名模板初始化，未知角色用 default；已有正文不随模板更新自动改写。
例如临时 `roles.json` 的输入形状：

```json
[
  {
    "name": "builder",
    "kind": "codex",
    "preset": "dev",
    "lifecycle": "temporary",
    "body": "Read the installed herdr-team skill before starting. Implement and self-test the assigned change. Stay within the task checkout; lead owns team configuration and branch lifecycle."
  }
]
```

数组应包含已确认的全部角色，而非只复制此示例。PR 方案应明确对应测试、审查职责及谁执行发布/合并。
`name`、`kind` 必填；其余可用 `preset`、`lifecycle`、`cwd`、`body`；引用预设时不再写 model/args/env，见 [格式规范](herdr-format.md)。
`resident` 由 `up` 启动，`temporary` 随任务派发启动。给临时角色派活前确定任务的 Feature 和迭代。

```sh
herdr-team team init --roles-file roles.json
herdr-team role list --json
herdr-team team validate
```

只有整套预设职责和模型都已接受时才用 `init --plan cheap|balanced|strong`；它不是流程预设，
不会据流程自动补 review 等角色。`init` 不派活、不启动 agent。

已有角色默认跳过；`init --force` 只改元数据，保留已有 `prompt.md`。
旧角色若复制了整套 CLI 操作流程，由 lead 在明确更新该角色时保留职责并改为 Skill 引导；不批量覆盖用户自定义正文。
更新职责时先读旧正文，再用 `role add NAME --force --body-file F` 整篇替换，保留有效的交付边界。
更新元数据可省略 `--kind`，未提供字段保持原值；省略正文也保持原文。
新增角色后可运行 `up` 纳入管理。`role rm NAME` 拒绝移除仍被活动任务引用的角色。

## Feature 开发服务

初始化或用户提出管理开发服务时，先读 repo 已有的 `herdr-services.json`、README、仓库根和 workspace 的 `package.json`、
包管理器 lockfile 及相关 Next.js、Storybook 等启动配置。只核对声明和脚本，保持初始化时的服务停止状态。
列出候选服务、相对目录、启动命令、端口传入方式和所需的本地依赖，指出脚本中需要替换的固定端口。
按用户确认写入或更新项目根 `herdr-services.json`。用户也可以直接提供完整声明、只纳入部分服务或跳过。
已有声明原样读取，只有用户确认需要调整的服务才修改，配置随项目纳入 Git。

```json
{
  "ports": { "start": 6100, "end": 6199 },
  "services": {
    "web": { "cwd": "app", "argv": ["bunx", "next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"] },
    "storybook": { "cwd": "app", "argv": ["bunx", "storybook", "dev", "--host", "127.0.0.1", "--port", "{port}", "--exact-port"] }
  }
}
```

示例命令按实际 repo 和包管理器改写，优先使用已有的脚本与本地依赖。服务以单个前台进程提供本机 HTTP 入口；
`argv` 按参数数组直传，`{port}` 替换为分配的端口，也可让程序读取 `PORT` 环境变量。
`cwd` 默认为 Feature checkout 根目录。端口范围可省略，由操作系统分配。
确认服务显式监听 `127.0.0.1` 并使用指定端口。需要固定端口或额外本机依赖时，先和用户确定如何适配。
在本机 Desktop 打开 Feature Space 后，可在 Team 面板底部查看服务、启停并打开地址。
命令行使用 `herdr-team service list --space ID` 和 `herdr-team service start|stop|restart NAME --space ID`。

## 核对后启动

核对 TEAM.md 的角色步骤，检查角色正文与启动参数；不要把保留旧配置误报为更新成功。
CLI 输出、错误和生成的默认指令保持英文，无需多语言支持。

启动前核对 Herdr、Bun、选定 agent CLI 及对应登录。PR 交付还需要匹配的 GitHub.com origin、已登录的 gh 和测试资源；
只核对选定方案需要的条件，不替用户改权限、登录或数据库。

按用户意图运行 `herdr-team team up`，检查返回的项目绑定和每个角色的启动/复用结果。
只在用户已有业务任务和验收要求时建卡派发；不要编造试运行任务。
派发、任务会话和恢复见 [handoff.md](handoff.md)。改角色文件不会给运行中 agent 自动重发配置，后续派活会携带角色正文。

## Workspace 归属与复用

项目工作区由 `herdr-team team up --root <team-root>` 统一绑定、定位或创建；不要在 up 前后额外创建工作区，
也不要因启动或显示失败就另建一个“补救”工作区。
任务 worktree/workspace 交给 dispatch/handoff 创建和复用，不手工再按角色各建一份。
在其他目录或任务 worktree 中始终使用派活给出的主项目绝对 root，不把当前 `$PWD` 当作团队 root。

同一项目一个主 workspace，任务各有工作区；以项目 root、归属 token、checkout 身份和返回的 workspace ID 为准，
侧栏名称相同不代表同一个项目。CLI 串行执行同项目 up，复用已有主 workspace 和运行中的角色。
归属冲突、重复候选或启动结果不明时先查看实际 workspace/pane 与原命令结果；保留现场，不重复创建或自行合并/关闭工作区。
从任务 worktree 打开 Console 也必须落在主 workspace；主 workspace 不存在时先由协调会话 up，不把任务工作区临时改成主工作区。

## 本地文件与 Git

根 `TEAM.md` 与 `agents.json` 应纳入 Git，跨机器共享角色工作步骤与 agent 预设。`.herdr/` 整体忽略，包括本地角色配置、任务、报告和临时产物；不要强制添加这些文件到 Git。
`init` 在根 `.gitignore` 追加 `/.herdr/`，保留已有规则和团队文件。已有项目运行 init 即可补上规则。
已跟踪的目录用 `git rm -r --cached -- .herdr` 取消跟踪，保留磁盘文件；先检查差异，不删除本地配置。

可复用默认模板在插件的 `skill/assets/`，各机器读取已共享的 TEAM.md 和 agents.json，再独立初始化角色引用并登录所选工具。
任务、会话和本机 worktree 不跨机器恢复；只有用户明确要求时才另外安排配置复制。

## 更新共享 Skill 与 CLI

仅在用户要求更新时执行；普通初始化、派活和 feedback 不自动更新。
共享源码位于 Herdr Team 仓库的 `cli/` 和 `skill/`。先定位实际安装来源与用户指定版本，检查源码 Git 状态；
保留本地修改，按已有跟踪分支安全更新，不从业务项目的 origin 猜安装源。
在合并后的 Herdr Team 仓库根目录运行：

```sh
npm run install:team
herdr-team --version
```

安装器分别核对 CLI 与 Skill 的结果；部分失败不能报告为全部成功。界面扩展有各自的安装入口，
更新共享包不修改项目、界面布局或快捷键。安装版 Skill 的自定义内容在更新前保留副本。

更新后重新读取 Skill；当前会话已加载的说明不会自动替换。运行中的 agent 不随安装器重启，
不为了刷新说明而停止团队。`herdr-team team init --force` 只用于项目角色元数据，不是软件升级。

# Agents：预设、选择与更新

选择或调整 agent 启动配置时读取。项目根 `agents.json` 按 harness 保存完整预设，纳入 Git，用户可手动维护。
[assets/agents.json](../assets/agents.json) 只提供初始化版本；`init` 仅复制缺失文件，即使 `--force` 也不覆盖项目预设。

## 查询预设

```sh
herdr-team agents list
herdr-team agents list --kind codex
herdr-team agents list --json
```

列表读取主项目根 agents.json，按 harness、预设名排序；无需启动 Herdr 或初始化本地任务。
每项包含 kind、preset、config，JSON 保留结构化配置。--root 可显式指定项目；未知 harness、缺失或损坏文件明确报错，不退回模板。
查询后通过 role add --preset 选择，直接编辑 agents.json 维护内容。

## 本机 CLI 检测

```sh
herdr-team agents check
herdr-team agents check codex/dev
herdr-team agents check --kind claude --json
```

check 按项目预设检测本机可执行文件路径、版本和原生登录状态，不发送模型请求、不登录、不抓取模型或修改配置。
沿用预设 env（包括 PATH、工具配置目录等）；相同 harness 和环境只检测一次，结果按预设列出。
默认每条原生命令超时 5000 毫秒，可用 --timeout-ms 调整；Ctrl+C 取消并回收子进程。
Codex 使用 login status，Claude 使用 auth status --json，Qoder 使用 status --output json；其他工具尚无适配的只读登录查询时显示 unknown，
不根据配置文件存在或 API key 变量推断登录成功。工具不存在、命令超时、输出无法识别和明确未登录会返回非零；
单纯缺少登录检测适配不算失败。JSON 包含 kind、preset、installed、executable、version、auth、issues。
登录输出仅提取状态，不输出或保存凭证、账号详情。原生状态显示已登录也不保证凭证未过期或模型可用，实际响应用 test 验证。
list 仍只读取预设，不隐式执行这些检测；插件不会在每次 CLI 运行时检查更新。

## 启动与响应测试

```sh
herdr-team agents run codex/dev
herdr-team agents test codex/dev
herdr-team agents test --all
herdr-team agents test --all --kind claude --timeout-ms 30000 --json
```

run 在当前终端交互启动预设，使用项目根为工作目录，保留原生登录与交互；需要真实终端，不接受 JSON 输出。
这是独立的预设调试，不绑定角色、不创建团队任务或 workspace，也不保存 team resume 引用。

响应测试会真实调用所选模型，按预设串行询问使用的模型，要求一行回复确认标记及模型名称；不知道时允许回答 unknown。
MODEL 列保留预设选择，DETAIL 显示 Self-reported model；JSON 另有 reportedModel 字段。模型自报仅供参考，不作为实际后端身份验证。
在临时目录运行，保留本机原生认证和预设环境；测试结束或超时回收子进程和临时文件，不改项目配置或任务记录。
默认每项超时 60000 毫秒，Ctrl+C 取消当前项及后续测试。原生工具仍可能按自己的行为保存用户级会话日志。

当前 codex、claude、grok、kimi、qoder、acp 支持响应测试。无响应测试适配的工具标为 skipped，不能当作通过。
输出汇总 passed/failed/skipped、耗时和失败原因；JSON 为结果数组。
有失败返回 1，参数/配置错误或全部跳过返回 2，取消返回 130。
帮助页 Agents 与 Team、Tasks 并列；这是本地 agent 配置操作，不是团队任务调度。

## 配置与引用

每个预设是一套启动设置，模型只是一个字段。不为同一个 harness 另起 local-codex 等名称，
不在预设中拼接 args。示例项目文件：

```json
{
  "codex": {
    "default": { "model": "default", "daemon": false },
    "dev": { "model": "gpt-6.1-sol", "reasoning_effort": "high", "daemon": false },
    "fast": { "model": "gpt-6-luna", "daemon": false }
  },
  "claude": {
    "default": { "model": "default" },
    "review": { "model": "sonnet", "reasoning_effort": "high" }
  },
  "acp": {
    "remote": { "command": "cc-remote", "args": [], "model": "default" }
  }
}
```

角色只引用 `kind` 与 `preset`，职责、worktree 和 cwd 仍是角色配置：

```sh
herdr-team role add dev --kind codex --preset dev --worktree
herdr-team role add test --kind claude --preset review
```

`init --roles-file F` 的 JSON 角色对象同样支持 `preset`；[plans.json](../assets/plans.json) 只引用预设，不复制设置。
新增预设直接编辑项目 JSON，再为角色选择它，无需重装插件，也不需要新增管理命令。

## 字段与原生支持

| 字段 | 适用 harness | 含义 |
| --- | --- | --- |
| `model` | codex、claude、qoder、acp 支持具名模型；其他暂仅 default | 模型 ID 或原生别名；省略或 default 不传模型覆盖参数；ACP 由 server 声明可用模型 |
| `reasoning_effort` | codex、claude | 原生推理强度；取值与可用性取决于对应客户端和模型 |
| `daemon` | codex | false 时使用 --no-daemon；省略时跟随客户端 |
| `sandbox`、`approval_policy` | codex | 原生沙箱、审批设置；省略时跟随客户端 |
| `permission_mode` | claude、acp | 原生权限模式；ACP 取 approve-reads、approve-all 或 deny-all |
| `trust` | grok | true 时使用 --trust |
| `command`、`args` | acp | ACP server 可执行文件和参数数组 |
| `env` | 全部 | 非敏感环境变量字符串映射；凭证留在本机工具配置或外部环境，不提交 Git |

CLI 校验配置并转换原生参数，不抓取模型，不推导工作流。拼错字段、错误类型或不存在的引用明确报错。
不要同时在引用预设的角色上设置 model、args、env，以免出现两份启动配置。

模型由用户维护，不硬编码允许列表。刷新模板或项目预设时，Skill 先核对对应官方来源与本机 help：
[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)、
[Claude Code 模型](https://code.claude.com/docs/en/model-config)、
[Qoder CLI](https://docs.qoder.com/cli/cli-reference)。Codex/Claude 种子只使用各自官方模型 ID 或别名，不混入第三方后端映射。
default 跟随工具本身的账号与本机设置；不要添加模型覆盖变量来假装默认模型。

预设存在不代表本机已安装、登录或 Herdr 已支持该工具，不要伪装成 codex 或绕过 Herdr 向 shell 注入命令。
项目配置与命令统一使用 qoder，例如 `agents run qoder/default`。Herdr 适配层转换为其原生 kind qodercli，原生 session 来源保持不变。
旧 qodercli 配置与选择器可继续读取，但列表统一显示 qoder；若新旧键中存在同名预设，需合并为一份，CLI 不覆盖用户定义。
启动时优先查找 qoder，也兼容旧可执行文件名。

## ACP 与 cc-remote

团队通过 `acp` 类型直接接入 ACP agent，使用随插件打包的 acpx 运行时，无需全局安装 acpx，也不需要修改 Herdr。
ACPC 仅供用户独立手动使用，不属于团队预设或角色类型。已有项目如包含 acpc 预设，按用户意图替换为明确的 ACP server command/args；不自动将 alias 转成命令，也不读取或修改 ACPC 配置。
项目 agents.json 添加结构化预设，再注册角色：

```json
{
  "acp": {
    "remote": {
      "command": "cc-remote",
      "args": ["--host", "your-ssh-alias"]
    }
  }
}
```

```sh
herdr-team agents check acp/remote
herdr-team agents test acp/remote
herdr-team role add story --kind acp --preset remote --worktree
herdr-team up
```

command 是可执行文件名或路径，args 中每项是独立参数，不在 command 中拼 shell 命令；env 沿用一般预设约定。
省略 host 参数时跟随 cc-remote 的 CC_REMOTE_HOST 或 ~/.config/cc-remote/host，不能根据预设名猜测目标。
CLI 预设校验不连接 SSH；check 检查 ACP server 的安装和版本，登录显示 unknown；test 才实际发起 ACP 请求。
model 可选，default 不覆盖；具名模型由 agent 广告的模型能力校验，不硬编码列表。
cc-remote 支持通过 ACP 选择模型，例如在预设设置 `"model": "sonnet"`；使用 server 实际返回的模型 ID。
修改预设用于下次启动，不自动切换正在运行的角色；团队 runner 当前未提供会话内 `/model` 交互命令。

每个 resident 或任务角色会话由自己的 Herdr pane 承载，进入原生 agents 列表，显示角色、acp 和所选模型。
派活复用团队任务和 delivery 去重，通过经过认证的本机 IPC 提交给 ACP，不用 Herdr 原生 agent prompt 或终端按键模拟。
pane 展示回答及工具事件，也可直接输入消息；/cancel 取消当前请求，/quit 退出实例。
permission_mode 可选 approve-reads（默认）、approve-all、deny-all；默认模式中需要决策的权限会显示 blocked，
在该 pane 输入选项编号后继续，未选择不会自动批准。未支持的认证或交互形式会明确失败，不能伪装成任务完成。

启动确认超时为 30 秒，不把这个期限用于长时间任务。仅保存 ACP server 已确认的会话 ID，并按项目、角色、任务、cwd 和启动预设隔离。
server 声明支持 load/resume 时恢复精确 ID；失败保留原记录并停止，不改成新会话。确认需要丢弃上下文后由用户明确 fresh 启动；
`up --fresh` 只影响尚未运行的 resident 实例。server 未声明恢复能力时，后续启动明确创建新会话。
实例退出会取消本实例的活动请求、回收其协议连接并释放 Herdr 身份；任务是否交棒、结束、清理仍由 Skill 和既有 CLI 操作决定。
恢复状态及本机 IPC 记录属于机器本地运行数据，不提交 Git；不与其他 ACP 客户端的会话记录互通。

## 生效与已有项目

每次读取角色都解析当前项目 agents.json，常驻启动与任务启动共用结果。文件变化通过 Console 的原生文件监听刷新，
不增加轮询。运行中的会话不自动重启，也不因此改派任务；配置用于后续新进程，恢复会话仍受客户端自己的恢复行为约束。
在任务 worktree 中使用派活给出的主项目 root，保持同一份预设来源。

已有不带 preset 的角色保留原有显式 model/args/env 和自定义 prompt；升级不批量改写它们。
用户要求迁移某个角色时先读取实际配置，在 agents.json 建立等价预设，再运行：

```sh
herdr-team role add dev --force --preset dev
```

显式选择预设会清除该角色旧 model/args/env，保留职责正文、cwd、隔离设置与任务记录。
确需返回显式配置时用 `--preset ""`，同时提供完整设置。
旧 `.herdr/models.json` 不再初始化或参与选择；需要保留的偏好和自定义设置由 Skill 按实际用途迁成预设，
迁移核对前保留旧文件，避免用模板覆盖用户内容。项目 JSON 是实际配置，更新插件只更新 seed，不覆盖它。

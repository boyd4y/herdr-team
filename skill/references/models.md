# Models：模型选择与启动配置

只在选择或调整 harness/model 时读取；角色职责与 onboard 见 [setup.md](setup.md)，协作步骤不在这里重复。
下表是本仓库已使用的配置候选，保留用户已有偏好，使用时核对已安装 CLI 的 help 和登录。

编码与架构可用强模型，编排、常规验证和文档优先便宜档。拿不准从 balanced 的预算起点讨论，
不要用模型方案决定固定角色名单或替代职责确认。
CLI 的 cheap/balanced/strong 只是旧角色配置集合；需要自定义分工时优先用 roles-file。

### 已验证的 harness 配置

下面的 `.role.yaml` 形状与 `cli/scripts/lib/plans.ts` 的内置模型映射一致。这里的 `model` 是侧栏显示用短名，实际模型 id 在 `args` 或 `env` 中。

| kind | `.role.yaml` 字段 | 配置说明 |
| --- | --- | --- |
| `claude` | `kind: claude`<br>`model: ds-flash`<br>`env: { ANTHROPIC_MODEL: deepseek-flash }` | 用 `ANTHROPIC_MODEL` 指定后端；Claude Code 的 `--model` 不接受这里的后端自定义名称。 |
| `codex` | `kind: codex`<br>`model: sol-6.1`<br>`args: ["--no-daemon", "-m", "gpt-6.1-sol"]` | 共享 daemon 的 feature 设置可能冲突；`--no-daemon` 让会话独立运行。`plans.ts` 为通过内置 plan 生成的每个 Codex 角色自动加上该参数。 |
| `kimi` | `kind: kimi`<br>`model: k3`<br>`args: ["-m", "kimi-code/k3"]` | 默认模型来自 `~/.kimi-code/config.toml`，可能随配置变化；要固定模型时显式指定。 |
| `grok` | `kind: grok`<br>`model: grok-4.7`<br>`args: ["--trust", "-m", "grok-4.7"]` | `--trust` 授权当前工作目录。使用它，不要为此修改全局 trusted folders。 |

### 按职责选能力

以下是建议，不是硬性规则；仍按项目目标和用户确认选择方案。

| 职责 | 建议模型 | 说明 |
| --- | --- | --- |
| 总控 / `lead` | 便宜档 `ds-flash` | 协调复杂时再升级 |
| 实现 / 架构 | 最强档 `sol-6.1` | 最强模型优先用于写代码和架构 |
| 验证 / `test` | 默认便宜档 | 关键或细微变更时可升级 |
| 文档 | 中档或便宜档 `luna` / `ds-flash` | 依任务复杂度选择 |
| 研究 | `grok-4.7` | 研究与 web |

添加角色时可用 CLI help 中列出的参数，例如 `herdr-team role add <name> --kind K --model SHORT --args a,b --env K=V`；`--args` 接收逗号分隔值，`--env` 接收 `KEY=VALUE`。更新已有角色时加 `--force`。也可编辑角色的 `.role.yaml`，再运行 `herdr-team up` 应用更新。新增自定义模型时，`--model` 是显示短名，实际 id 仍要放在经过验证的 `args` 或 `env` 中。

## 修改与核对

`model` 是显示短名，真正模型 ID 在 args/env；保留可辨认的版本号，不把短名当启动参数。
Codex 的 luna 候选为 `gpt-6-luna`，不能据 sol 名称类推出 `gpt-6.1-luna`。

新增配置先查该 agent CLI 自带 help，确认参数或环境变量；必要时按已授权范围做一次真实启动验证。
不要从其他 harness 猜 flag，也不要因界面显示短名就认定模型已切换。

已有角色更新使用 `role add NAME --force`，未提供字段保留；切模型时显式核对 args/env。
模型改动不强制重启正在执行的任务。harness 枚举与字段细节见 [herdr-format.md](herdr-format.md)。

# Workflow：流程约定与 PR 交付

本文件供选择流程、创建/调整任务链、执行 PR 交付或最终收尾时读取。通用领取与交棒只见 [handoff.md](handoff.md)。

## 选择与保存

先读根 TEAM.md 的已有项目约定，推荐方案不能代替用户选择。流程名是对话中的简称，不是 CLI 预设：

| 方案 | 职责与交付 |
| --- | --- |
| dev-test-review（推荐） | 同一任务 checkout 开发、测试；通过后发布 PR，独立审查；批准后按约定自动或手动合并 |
| dev-test | 本地开发、验收，之后由 lead 显式合入 |
| direct | 一位负责人直接交付，适用于不需要交接验收的工作 |
| 自定义 | 按实际职责决定顺序、角色名与交付方式，无固定阶段数 |

明确谁执行 PR 发布，以及审查批准后自动还是手动合并。Skill 将约定保存到根 `TEAM.md` 的 Workflow 部分，保留其中背景与偏好；用简短 Markdown 即可，例如：

```markdown
## Workflow

- Lead: one resident coordinator.
- Feature work: dev → test → review in one task checkout.
- Test publishes the tested SHA as a PR and records its URL during handoff.
- Review checks the tested PR head; rejected work repeats testing and review.
- After approval, the reviewer's skill invokes herdr-team merge <id>.
- After delivery and any required merge are done, the final owner ensures task cleanup with herdr-team clean <id> from the main workspace; lead coordinates cleanup when the final owner is inside the task workspace.
- Docs/research: select the required owners for each task.
```

手动方案写明由 lead 执行 merge。流程随时可以调整；更改 Markdown 不会改变已有任务。
CLI 不读取 workflow.json，也不执行旧快照。已有历史文件保留；若活动任务仍依赖旧格式，
先核对实际执行，由 lead 取消旧卡并用明确的 role/handoff 重建，不手改历史或静默转换。

## 建卡与调整

Skill 决定每张任务需要哪些角色，并明确传入 CLI：

```sh
herdr-team add "Implement login" --role dev --handoff test,review
herdr-team dispatch <id>
```

不需要下一位就省略 handoff。仅实际接口/数据依赖使用 `--depends-on`；只有依赖任务 done 才满足，
取消不算完成。不因计划顺序串行，docs 可以独立准备，功能完成后核实。

未开始的任务可用 `edit --handoff` 明确调整；已投递的改派先核对当前执行和已有证据，不能靠 --force 跳过验收。
旧格式任务不能继续推进，先核对并取消，再按新约定建卡。

dev 自测，test 重点验证变更行为和风险；review 复用测试证据，有缺口再补查。
不要每一棒都重跑全量测试，也不要为流转强制生成报告。明确的项目验收要求仍须完成。

## PR：Skill 请求、CLI 记录

只在已选 PR 交付时执行；复用已有授权，无需每张卡重新确认。

1. test 按 [handoff.md](handoff.md) 核对干净 checkout 和指派 SHA，使用隔离资源完成验收；失败直接 reject。
2. Skill 在任务 checkout 核对 origin 和目标仓库，将该 SHA 推送到任务分支。
   用 `gh pr list --head <branch> --state all` 检查是否已有 PR；有则复用，确认 open、非 draft、base/head 正确。
   没有则 `gh pr create --head <branch> --base <base> --title <title> --body-file <file>`。
   body 用临时文件写实际换行，包含 SHA 与测试摘要。结果不明确先查远端，不盲目重复创建。
3. test 明确记录已有 PR：

   ```sh
   herdr-team handoff <id> --delivery ID --accept SHA --pr <URL> --summary "Tested SHA; results" --root <team-root>
   ```

   CLI 核对本地 SHA、远端 PR 身份和 head，保存测试结果、URL，交给任务已有的下一位；不推送或创建 PR。
4. review 审查同一 SHA，用 `handoff --accept SHA --summary TEXT` 批准，或 `--reject --summary TEXT` 返回原开发者。
   拒绝会重走已经过的验收链；新 SHA 必须重测，并重新附上更新后的同一 PR。
5. 自动方案：review 的 Skill 在批准成功后直接 `herdr-team merge <id> --root <team-root>`，不再问用户或等 lead 中转。
   手动方案：保留队列，lead 明确调用 merge。CLI 串行检查最终批准、测试、PR head 与 SHA，再执行合并。

同一 GitHub 账号不能正式批准自己创建的 PR，CLI 明确记录 Team 决定为评论；不同账号提交绑定 SHA 的正式 review。
评论不能代替仓库保护要求的独立 Approve。审批不会绕过保护规则；Console 不决定合并。

交棒重复或操作失败先查任务和 PR；已合并不重跑。检查远端、本地同步和迁移效果后，才决定是否
`merge retry <id>` 再 `merge <id>`。本地集成可显式带 `--migrate COMMAND`，在同一串行锁内执行。

## 最后一棒：完成后收尾

最后一棒负责让任务完成并释放其 worktree 和执行会话；不能只报告“完成”而把关闭操作留给用户。
需要合并的任务，批准或进入合并队列还不算结束；必须等实际合并、本地同步及约定验证成功，任务为 done 后才收尾。
手动合并方案由实际执行合并的 lead/协调会话负责这一步，无需再建收尾任务或增加验收角色。

1. 先保存交付摘要、SHA、验证结果及需要保留的产物。摘要通过 handoff 留在主检出的任务卡；
   持久证据放主检出的 `.herdr/reports/<id>/`，不能只留在即将删除的 worktree 或终端里。
2. 用 `tasks <id> --json` 确认任务已 done，合并流程还需确认 integration 为 done。
   普通最后一次 handoff 已尝试回收，检查返回的 cleanup 结果；未确认回收时执行：

   ```sh
   herdr-team clean <id> --root <team-root> --json
   ```

3. 从主 workspace 的 lead/协调会话执行清理，避免删除执行清理命令本身所在的工作区。
   最后一棒在任务 workspace 内时，交付摘要明确注明待收尾任务号，由协调会话直接完成，不让用户手动关闭。
   `removed` / `absent` 才表示当前任务没有遗留 checkout；Herdr 删除 worktree 会关闭对应 workspace、tabs 和其中的 agent。
4. `dirty`、`closed`、`foreign`、`failed` 或 `not-terminal` 表示尚未完成清理，保留现场并说明原因；
   不使用 force，不关闭常驻 lead、主 workspace、Console 或其他任务。分支和任务历史保留。

收尾是 Skill 的交付要求；CLI 只执行显式 clean，不因读取 workflow、review 批准或 Console 刷新自行关闭工作区。

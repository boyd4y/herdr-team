# Delivery：PR、合并与收尾

按用户授权处理 PR、合并或最终收尾时读取；任务分配与交棒见 [handoff.md](handoff.md)。
这些是 Skill 的执行规则，不要求用户选择 workflow 或把规则复制到 TEAM.md。

## PR：Skill 请求、CLI 记录

只在用户已授权 PR 交付时执行；复用已有授权，无需每张卡重新确认。

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
5. 已授权批准后自动合并时，review 的 Skill 在批准成功后直接 `herdr-team merge <id> --root <team-root>`，不再问用户或等 lead 中转。
   未授权自动合并时保留队列，由协调会话按用户授权明确调用 merge。CLI 串行检查最终批准、测试、PR head 与 SHA，再执行合并。

同一 GitHub 账号不能正式批准自己创建的 PR，CLI 明确记录 Team 决定为评论；不同账号提交绑定 SHA 的正式 review。
评论不能代替仓库保护要求的独立 Approve。审批不会绕过保护规则；Console 不决定合并。

交棒重复或操作失败先查任务和 PR；已合并不重跑。检查远端、本地同步和迁移效果后，才决定是否
`merge retry <id>` 再 `merge <id>`。本地集成可显式带 `--migrate COMMAND`，在同一串行锁内执行。

## 最后一棒：完成后收尾

最后一棒负责让任务完成并释放其 worktree 和执行会话；不能只报告“完成”而把关闭操作留给用户。
需要合并的任务，批准或进入合并队列还不算结束；必须等实际合并、本地同步及约定验证成功，任务为 done 后才收尾。
由实际执行合并的 lead/协调会话负责这一步，无需再建收尾任务或增加验收角色。

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

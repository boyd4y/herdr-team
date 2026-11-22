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
   herdr-team task handoff <id> --delivery ID --accept SHA --pr <URL> --summary "Tested SHA; results" --root <team-root>
   ```

   CLI 核对本地 SHA、远端 PR 身份和 head，保存测试结果、URL，交给任务已有的下一位；不推送或创建 PR。
4. review 审查同一 SHA，用 `handoff --accept SHA --summary TEXT` 批准，或 `--reject --summary TEXT` 返回原开发者。
   拒绝会重走已经过的验收链；新 SHA 必须重测，并重新附上更新后的同一 PR。
5. 已授权批准后自动合并时，review 的 Skill 在批准成功后直接 `herdr-team task merge <id> --root <team-root>`，不再问用户或等 lead 中转。
   未授权自动合并时保留队列，由协调会话按用户授权明确调用 merge。CLI 串行检查最终批准、测试、PR head 与 SHA，再执行合并。

同一 GitHub 账号不能正式批准自己创建的 PR，CLI 明确记录 Team 决定为评论；不同账号提交绑定 SHA 的正式 review。
评论不能代替仓库保护要求的独立 Approve。审批不会绕过保护规则；Console 不决定合并。

交棒重复或操作失败先查任务和 PR；已合并不重跑。检查远端、本地同步和迁移效果后，才决定是否
`merge retry <id>` 再 `merge <id>`。本地集成可显式带 `--migrate COMMAND`，在同一串行锁内执行。

## 最后一棒：完成后收尾

共享工作区的 Feature 先完成组内任务，再在该 Space 验证整条分支。验证可使用 Team 面板的 Preview。得到该 Feature 的合并授权后，协调会话从项目的目标分支检出目录执行：

```sh
herdr-team feature merge NAME --iteration VERSION --base develop --commit SHA
```

`SHA` 是已验证的 Feature 分支头，`--base` 使用项目约定的目标分支。冲突在 Feature 工作区解决，重新验证新提交。成功后 daemon 按 Feature 停止受管预览、关闭临时会话并回收干净的 worktree。用 daemon 日志核对保留原因，必要时用 `feature clean NAME --iteration VERSION` 重试。

此前已派发并拥有各自 worktree 的 Feature 继续用 `feature finish NAME --iteration VERSION` 确认交付，再按该范围执行 `feature clean`。

独立任务使用下面的单任务清理流程。

最后一棒负责让任务完成并释放其 worktree 和执行会话；不能只报告“完成”而把关闭操作留给用户。
需要合并的任务，批准或进入合并队列还不算结束；必须等实际合并、本地同步及约定验证成功，任务为 done 后才收尾。
由实际执行合并的 lead/协调会话负责这一步，无需再建收尾任务或增加验收角色。

1. 先保存交付摘要、SHA、验证结果及需要保留的产物。摘要通过 handoff 留在主检出的任务卡；
   持久证据放主检出的 `.herdr/reports/<id>/`，不能只留在即将删除的 worktree 或终端里。
2. 用 `tasks <id> --json` 确认任务已 done，合并流程还需确认 integration 为 done。
   在项目主工作区提交清理请求，由 daemon 回收资源：

   ```sh
   herdr-team task clean <id> --root <team-root> --json
   ```

3. 最后一棒在任务 workspace 内时，由协调会话请求清理。用 `removed` / `absent` 确认没有遗留 checkout。
4. `dirty`、`closed`、`foreign`、`retained`、`failed` 或 `not-terminal` 表示尚未完成清理。说明 CLI 返回的原因，条件满足后重试；
   不使用 force，不关闭常驻 lead、主 workspace、Console 或其他任务。分支和任务历史保留。

显式 `clean` 用于工作树清理。Feature 交付确认用于结束有关联的临时会话。

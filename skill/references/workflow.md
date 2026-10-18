# Workflow：流程约定与 PR 交付

本文件供选择流程、创建/调整任务链或执行 PR 交付时读取。通用领取与交棒只见 [handoff.md](handoff.md)。

## 选择与保存

先读已有项目约定，推荐方案不能代替用户选择。流程名是对话中的简称，不是 CLI 预设：

| 方案 | 职责与交付 |
| --- | --- |
| dev-test-review（推荐） | 同一任务 checkout 开发、测试；通过后发布 PR，独立审查；批准后按约定自动或手动合并 |
| dev-test | 本地开发、验收，之后由 lead 显式合入 |
| direct | 一位负责人直接交付，适用于不需要交接验收的工作 |
| 自定义 | 按实际职责决定顺序、角色名与交付方式，无固定阶段数 |

明确谁执行 PR 发布，以及审查批准后自动还是手动合并。Skill 将约定保存到 `.herdr/workflow.md`，
用简短 Markdown 即可，例如：

```markdown
# Team workflow

- Lead: one resident coordinator.
- Feature work: dev → test → review in one task checkout.
- Test publishes the tested SHA as a PR and records its URL during handoff.
- Review checks the tested PR head; rejected work repeats testing and review.
- After approval, the reviewer's skill invokes herdr-team merge <id>.
- Docs/research: select the required owners for each task.
```

手动方案写明由 lead 执行 merge。流程随时可以调整；更改 Markdown 不会改变已有任务。
旧 workflow.json 可由 Skill 参考后整理为约定，CLI 不再解析项目默认值。
实际任务带旧 workflow 快照时继续原行为，不手改快照，也不重复执行新方案的自动操作。

## 建卡与调整

Skill 决定每张任务需要哪些角色，并明确传入 CLI：

```sh
herdr-team add "Implement login" --role dev --handoff test,review
herdr-team dispatch <id>
```

不需要下一位就省略 handoff。仅实际接口/数据依赖使用 `--depends-on`；只有依赖任务 done 才满足，
取消不算完成。不因计划顺序串行，docs 可以独立准备，功能完成后核实。

未开始的任务可用 `edit --handoff` 明确调整；已投递的改派先核对当前执行和已有证据，不能靠 --force 跳过验收。
旧快照任务先完成或取消，再按新约定建卡；普通 edit 不改变旧职责链。

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

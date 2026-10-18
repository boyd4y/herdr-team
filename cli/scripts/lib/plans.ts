import type { RoleSpec } from "./init.ts";

export type PlanName = "cheap" | "balanced" | "strong";

export const PLAN_NAMES: readonly PlanName[] = ["cheap", "balanced", "strong"];

/**
 * 模型短名 → 怎么启动它。
 *
 * 这是**唯一**一处把显示短名和真实启动参数绑在一起的地方 —— 分散在各处就会漂移。
 * 参数都经实跑验证过；改之前先按 references/models.md 的方法验一遍。
 */
const MODELS = {
  "sol-6.1": { kind: "codex", args: ["-m", "gpt-6.1-sol"] },
  luna: { kind: "codex", args: ["-m", "gpt-6-luna"] },
  k3: { kind: "kimi", args: ["-m", "kimi-code/k3"] },
  "ds-flash": { kind: "claude", env: { ANTHROPIC_MODEL: "deepseek-flash" } },
  // grok 在**没信任过的目录**里启动时会弹一个 "是否信任" 的交互提示，
  // 把 agent 卡在菜单上。--trust 是 grok 自己的开关（`/hooks-trust` 的命令行版本），
  // 授予的是**当前目录** —— 也就是 agent 真正要工作的那个目录。
  // 别用去改 ~/.grok/trusted_folders.toml 的办法：那是动用户的全局配置。
  "grok-4.7": { kind: "grok", args: ["--trust", "-m", "grok-4.7"] },
} as const;

type ModelName = keyof typeof MODELS;

interface Blueprint {
  name: string;
  model: ModelName;
  /** Skip the optional resident conversation tab. */
  worktree?: boolean;
  body: string;
}

const DISPATCHER_BODY = [
  "You are lead, the team's resident coordinator. Own the user's objective, acceptance criteria, task decomposition, role coordination, and delivery tracking.",
  "Delegate implementation and verification to the assigned roles. Do not write application code or modify application files yourself.",
].join("\n\n");

const DEVELOPER_BODY = [
  "You are the developer. Implement the assigned change in its task checkout, update relevant documentation, self-test, and commit your work.",
  "Stay within the task's scope. Leave team configuration and branch lifecycle to lead; do not modify the primary checkout or task records.",
].join("\n\n");

const TEST_BODY = [
  "You are the tester. Independently validate the assigned version against the acceptance criteria and relevant risks, and report reproducible defects with evidence.",
  "You may write task-relevant tests. Review implementation and documentation without modifying them; leave fixes to the developer.",
].join("\n\n");

const RESEARCHER_BODY = [
  "You are the researcher. Investigate the assigned question and provide findings supported by sources, distinguishing evidence from inference and unresolved questions.",
  "Do not modify project files or invent facts or sources.",
].join("\n\n");

/**
 * 三个方案。**只有写代码和搞架构才上 `sol`**，其余用便宜档。
 *
 * 和 references/models.md 是同一套东西 —— 那边是给人读的说明，这里是给 CLI 用的数据。
 */
const PLANS: Record<PlanName, Blueprint[]> = {
  cheap: [
    { name: "lead", model: "ds-flash", body: DISPATCHER_BODY },
    { name: "dev", model: "ds-flash", worktree: true, body: DEVELOPER_BODY },
    { name: "test", model: "ds-flash", body: TEST_BODY },
    { name: "search", model: "grok-4.7", body: RESEARCHER_BODY },
  ],
  balanced: [
    { name: "lead", model: "ds-flash", body: DISPATCHER_BODY },
    { name: "dev", model: "sol-6.1", worktree: true, body: DEVELOPER_BODY },
    { name: "test", model: "ds-flash", body: TEST_BODY },
    { name: "search", model: "grok-4.7", body: RESEARCHER_BODY },
  ],
  strong: [
    { name: "lead", model: "sol-6.1", body: DISPATCHER_BODY },
    { name: "dev", model: "sol-6.1", worktree: true, body: DEVELOPER_BODY },
    { name: "test", model: "sol-6.1", body: TEST_BODY },
    { name: "search", model: "grok-4.7", body: RESEARCHER_BODY },
  ],
};

export function isPlanName(value: string): value is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(value);
}

/** 把方案展开成 `init` 要的角色定义。 */
export function planRoles(plan: PlanName): RoleSpec[] {
  const blueprints = PLANS[plan];
  return blueprints.map((bp) => {
    const model = MODELS[bp.model];
    const args: string[] = "args" in model ? [...model.args] : [];

    // codex 有个**共享的后台 daemon**，它的 feature 设置是跨客户端共享的状态。
    // 新会话要的 feature 和 daemon 现用的不一致时，codex 会弹一个交互提示
    // （"Background server has incompatible feature settings"）把 agent 卡在那儿。
    // --no-daemon 让它每次独立跑，不碰那份共享状态。
    // 按 kind 统一加，免得以后新增 codex 模型时漏掉。
    if (model.kind === "codex") args.unshift("--no-daemon");

    const spec: RoleSpec = {
      name: bp.name,
      kind: model.kind,
      model: bp.model,
      body: `Use the installed herdr-team skill before coordinating or executing team work. Read its SKILL.md first, then only the references relevant to the current assignment.

${bp.body}`,
    };
    if (args.length > 0) spec.args = args;
    if ("env" in model) spec.env = { ...model.env };
    if (bp.worktree === true) spec.worktree = true;
    return spec;
  });
}

/** 给人看的一行摘要，`init --plan` 时回显。 */
export function describePlan(plan: PlanName): string {
  return PLANS[plan]
    .map((bp) => `${bp.name}=${bp.model}${bp.worktree === true ? "(isolated)" : ""}`)
    .join("  ");
}

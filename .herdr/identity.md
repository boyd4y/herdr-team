# Project identity

We maintain Herdr Team (boyd4y/herdr-team), a public Herdr plugin, Bun/TypeScript CLI, and bundled agent skill for project-scoped team coordination.

## Conventions

- Follow AGENTS.md: English CLI and generated instructions; Chinese or English documentation; preserve user-provided Unicode.
- Keep the implementation simple, with no runtime npm dependencies or separate system daemon. Team Console owns automatic queue scheduling.
- Treat .herdr task cards as the workflow source of truth. Use the CLI for task metadata and unique delivery claims/handoffs.
- Respect project ownership, user workspaces, existing configuration, uncommitted changes, and native sessions.

## Validation

- From cli/: bun test and bun run typecheck.
- From the repository root: node --test tests/*.test.cjs.
- Automated tests use temporary projects and offline Herdr executables; never mutate real user agents or global state.

## Delivery

- Synchronize documentation and the bundled skill with public command behavior.
- Save results, artifact paths or commits, validation, and remaining risks with handoff --summary or --summary-file.
- Lead coordinates Git lifecycle and publishing within the user's authorization.

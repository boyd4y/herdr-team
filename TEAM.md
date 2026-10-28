# Team agreement

## Project identity

We maintain Herdr Team (boyd4y/herdr-team), a public Herdr plugin, Bun/TypeScript CLI, and bundled agent skill for project-scoped team coordination.

### Conventions

Follow AGENTS.md for language, responsibilities, implementation boundaries, and validation requirements. It is the maintained source of project rules.

### Preferences

Keep collaboration lightweight and task scopes small. Prefer existing runtime APIs and established libraries. Keep delivery summaries concise, with relevant verification and any unresolved issues.

### Project references

- README.md and README.zh-CN.md: public usage and installation.
- CONTRIBUTING.md and CONTRIBUTING.zh-CN.md: contribution and validation guidance.
- cli/ARCHITECTURE.md: implementation modules and asset locations.

## Workflow

- Roles: dev implements changes, test independently validates the assigned version, and doc maintains public and skill documentation.
- The coordinating conversation routes tasks and owns team configuration and branch lifecycle; there is no separate lead or review role.
- Feature work follows dev → test. Documentation-only work can go directly to doc; relevant documentation may be prepared independently or included in the feature checkout before final validation.
- Each task owns its worktree. Roles working on the same task reuse that checkout one stage at a time. Independent tasks may run concurrently.
- Test validates a pinned commit. If doc adds commits to that checkout after validation, the new version requires testing before integration.
- The recorded task owner and handoff chain determine the actual assignment. Only real interface or data dependencies should block independent work.
- Final acceptance queues integration. The coordinating conversation explicitly merges within the user's authorization; Console does not decide when to merge.

- Final delivery includes cleanup. After integration and agreed validation succeed and the task is done, the coordinating conversation runs herdr-team clean <id> --root <team-root> from the main workspace. This closes that task worktree and its agents; preserve resident sessions, other tasks, branches, and task history. Report blocked cleanup and keep unfinished work.

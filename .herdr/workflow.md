# Team workflow

- Roles: dev implements changes, test independently validates the assigned version, and doc maintains public and skill documentation.
- The coordinating conversation routes tasks and owns team configuration and branch lifecycle; there is no separate lead or review role.
- Feature work follows dev → test. Documentation-only work can go directly to doc; relevant documentation may be prepared independently or included in the feature checkout before final validation.
- Each task owns its worktree. Roles working on the same task reuse that checkout one stage at a time. Independent tasks may run concurrently.
- Test validates a pinned commit. If doc adds commits to that checkout after validation, the new version requires testing before integration.
- The recorded task owner and handoff chain determine the actual assignment. Only real interface or data dependencies should block independent work.
- Final acceptance queues integration. The coordinating conversation explicitly merges within the user's authorization; Console does not decide when to merge.

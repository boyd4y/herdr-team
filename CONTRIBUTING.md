# Contributing

[简体中文](CONTRIBUTING.zh-CN.md) · English

Thanks for helping improve Herdr Team. Issues and pull requests should describe a concrete user problem or improvement and keep changes focused.

## Get the source

Fork [boyd4y/herdr-team](https://github.com/boyd4y/herdr-team) and clone your fork, or use a local checkout for a patch:

```sh
git clone https://github.com/<your-account>/herdr-team.git
cd herdr-team
```

The repository is organized by purpose:

- `bin/`: plugin setup, configuration, and install/uninstall scripts.
- `cli/`: Bun/TypeScript CLI source, package manifest, lockfile, and CLI tests.
- `skill/`: bundled agent skill and its reference documents.
- `tests/`: Node built-in tests for plugin scripts and packaging.
- `herdr-plugin.toml`: Herdr plugin metadata, setup hook, actions, and event hooks.
- `README.md` / `README.zh-CN.md`: public user guides in English and Simplified Chinese.

## Develop and validate

Install Bun 1.2 or later and Node.js 22.20 or later. The CLI has no runtime npm dependencies; TypeScript and Bun type definitions are development dependencies. Install them from `cli/`:

```sh
cd cli
bun install
bun test
bun run typecheck
cd ..
```

Run plugin/package tests from the repository root:

```sh
node --test tests/*.test.cjs
```

Automated tests use temporary project directories and offline Herdr executables. They do not need a live Herdr session. Manual integration setup installs user-level CLI and skill files and writes Herdr user configuration. A separate named Herdr session does not isolate those files. Use a disposable environment with its own home, config, and bin directories (for example, a separate development user or container), or knowingly test against your personal installation. Use a temporary project in that environment. From the repository root, link this checkout and invoke setup:

```sh
herdr plugin link .
herdr plugin action invoke herdr-team.install
```

The link registers the plugin; the install action runs its setup entry point. After testing, run the uninstall actions described in the [README](README.md#upgrade-remove-and-troubleshoot), then unlink the local plugin. Do not use integration tests to overwrite unrelated Herdr configuration or user-owned files.

## Change conventions

- Keep CLI help, output, errors, TUI labels, and generated default instructions in English. Do not add localization, locale detection, translation catalogs, or language flags.
- Documentation can be English or Chinese. Keep the English and Chinese user entry points aligned when public behavior changes.
- Preserve user-provided titles, descriptions, role prompts, summaries, and other Unicode data.
- Treat `.herdr/` task cards as the workflow record. Use the CLI for task metadata and delivery claims/handoffs.
- Keep runtime dependencies and system services out of the project unless the product requirements change.
- Do not commit credentials, personal absolute paths, live delivery IDs, or private task contents.

## Open an issue or pull request

For a bug report, include the relevant Herdr, Node, Bun, and agent integration versions, exact commands, expected and actual results, and a minimal reproduction. Remove secrets and private workspace data. For a pull request, explain the user-facing change, list affected documentation or commands, and report the checks you ran and any platform or version combinations you could not verify. Update command examples and both READMEs when public behavior changes.

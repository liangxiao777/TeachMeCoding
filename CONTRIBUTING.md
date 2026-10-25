# Contributing

English · [简体中文](CONTRIBUTING.zh.md)

Thank you for helping improve TeachMeCoding. This guide explains how to report issues and submit changes.

## Reporting issues

- **Bugs and suggestions**: open an [issue](https://github.com/liangxiao777/TeachMeCoding/issues). For bugs, include your operating system, Node version, steps to reproduce, and the expected and actual results. Remove API keys, tokens, and private paths before attaching logs.
- **Security vulnerabilities**: do not open a public issue. Report them privately as described in [SECURITY.md](SECURITY.md).

## Before making changes

- You can submit a pull request directly for bug fixes and small documentation changes.
- For new features, large refactors, or changes to data formats, first open an issue describing the problem and your proposed approach so that the work does not go in the wrong direction.
- Read the design conventions in [AGENTS.md](AGENTS.md). They apply to both people and AI coding assistants:
  - Keep things simple and effective; every constraint must serve a practical purpose.
  - The model expresses business content only; the server owns internal IDs, revisions, transactions, and storage.
  - Guide content quality through tool descriptions and prompts, not fixed checklists or formatting checks in place of judgment.
  - Confirm that new UI copy, buttons, or settings entry points are necessary for completing the task before adding them.

See the [development guide](docs/development.md) for the development environment, tests, and project structure.

## Pull requests

1. Create a branch from the latest `main`, named `<type>/<short-description>`, for example `fix/terminal-reconnect`.
2. Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`. Use an actual module name for the scope and an English verb phrase describing the change, for example `fix(projects): reject symlink traversal`. Avoid vague descriptions such as `update` or `finish implementation`.
3. Keep each PR focused on one thing. Submit unrelated changes in separate PRs.
4. Include tests for behavior changes. Test behavior, not implementation details.
5. For UI changes:
   - Include before-and-after screenshots.
   - When adding or changing copy, update both the `en` and `zh-CN` translation resources. See [UI translation](docs/translating.md).
6. Pin new dependencies to exact versions and explain why they are needed in the PR.
7. Describe what changed, why, and how you verified it in the PR description.

Before submitting, make sure these checks pass:

```sh
pnpm check
pnpm build
pnpm test
pnpm test:browser --workers=1   # For UI or interaction changes
pnpm check:i18n                 # For UI copy changes
```

Do not commit `.env`, files from the data directory, or debug snapshots from `agent-debug/`.

## License

Contributions to this repository are licensed under the [Apache License 2.0](LICENSE), the same license as the project.

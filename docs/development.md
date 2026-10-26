# Development guide

English · [简体中文](development.zh.md)

This guide explains how to set up a development environment and run tests. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution process and conventions, and [Architecture](architecture.md) for the internal design.

## Requirements

- [Node.js](https://nodejs.org/) 24.15.0 (see `.node-version`)
- [pnpm](https://pnpm.io/) 11.1.0
- Git and Bash on `PATH`.
- The [OS prerequisites in the README](../README.md#requirements): Python 3 and native compiler tools (Xcode Command Line Tools on macOS, `build-essential` on Ubuntu/Debian) when native dependencies need compiling.
- `pnpm test` also requires Python 3 and `rustc` for language execution tests, and `pdftotext` ([Poppler](https://poppler.freedesktop.org/)) for library document parsing tests. Install these yourself and make them available on `PATH`. Missing dependencies cause test failures; the tests are not skipped automatically.
- Browser tests use a locally installed Google Chrome; see [Browser tests](#browser-tests) for platform limits.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds `packages/contracts` first, then starts the server and Vite together (frontend <http://127.0.0.1:5173>, API <http://127.0.0.1:4310>).

For development, set `TMC_DATA_DIR` in the project-root `.env` file to keep your everyday learning data separate:

```dotenv
TMC_DATA_DIR="/absolute/path/to/teach-me-coding-dev"
```

Replace the example with an absolute path. See [Configuration](configuration.md) for all startup options.

## Project structure

```text
apps/
  server/            Node server
    src/agents/      Agent runtime, scenarios, tools, and prompts (prompts/)
    src/config/      Startup options and .env loading
    src/extensions/  Search, web fetching, MCP, Skills
    src/http/        Hono routes and access control
    src/models/      Model selection and credential storage
    src/modules/     Learning features, library, execution proposals
    src/runtime/     PTY terminals, Bash, command execution
    src/storage/     Data directory, SQLite, and conversation storage
  web/               React + Vite frontend
    src/i18n/        UI translation resources
packages/
  contracts/         Shared schemas and types for the frontend and server
tests/               Integration tests, Playwright browser tests, and fixtures
patches/             pnpm dependency patches
```

## Common commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Development mode with frontend hot reload |
| `pnpm build` | Build all packages |
| `pnpm release:pack` | Package the built application and SHA-256 checksum in `.amp/in/artifacts/release/` (build first) |
| `pnpm start` | Production mode: a single server serves the UI and API at `http://127.0.0.1:4310` (build first) |
| `pnpm check` | Type-check, including tests and scripts |
| `pnpm check:i18n` | Check translation resources; see [UI translation](translating.md) |
| `pnpm test` | Unit and integration tests (build first) |
| `pnpm test:browser` | Playwright browser tests |
| `pnpm test:native` | SQLite and PTY native dependency checks |
| `pnpm test:provider` | Real-model smoke test; **incurs charges** |

## Testing

All tests use temporary data directories and do not read or write your learning data. Agent responses use a deterministic test Provider rather than paid models.

The CI matrix targets only `ubuntu-latest` and `macos-latest`, covering a frozen-lockfile install, `pnpm check`, `pnpm build`, `pnpm test`, `pnpm test:native`, and browser execution/PTY checks, including POSIX permission assertions (see [Security](../SECURITY.md)).

Before timed execution tests, CI compiles and runs a temporary Rust program to load the hosted image's compiler and linker. This setup step has a separate one-minute limit; assessment execution limits and test assertions are unchanged.

The production tests also unpack the release archive, install its dependencies from the local pnpm cache without source-tree links, and verify startup, UI assets, SQLite, teaching prompts, and a real PTY. Version tags must match the root package version; their GitHub Release is published only after both platform jobs succeed.

### Unit and integration tests

```sh
pnpm build
pnpm test
```

These cover domain rules, transactions and idempotent writes, project path boundaries, database migrations, repeated startup, and real-process recovery. Process integration tests start real servers and occupy fixed local ports defined in `tests/*.test.mjs`.

### Browser tests

Linux browser checks are **x86_64-only**: Playwright's installer for the configured Google Chrome channel rejects Linux arm64. Linux arm64 has backend/native verification only, in a non-root Debian 12 Docker environment. Local browser verification covers macOS 26 / arm64; Intel Macs remain unverified.

```sh
pnpm build
pnpm test:browser --workers=1
```

Each test case runs in both development mode (Vite proxy) and production mode (single server), using ports 14320, 14321, and 15173. You can run a single file, for example: `pnpm test:browser tests/browser/execution.spec.ts --workers=1`.

Teaching scenarios use a separate configuration but share ports with the regular browser tests, so the two suites cannot run at the same time:

```sh
pnpm exec playwright test -c tests/agents.config.ts --workers=1
```

### Native dependencies

`pnpm test:native` uses a temporary directory to verify SQLite writes and reopening, along with PTY input, output, exit codes, and process cleanup. Run it after upgrading Node, `better-sqlite3`, or `node-pty`.

### Real-model checks

The following checks call real Providers and **incur charges**. They run only when explicitly invoked:

- `pnpm test:provider`: Sends two short requests to verify streaming responses and cancellation.
- `pnpm exec tsx tests/teaching-provider-smoke.ts`: Uses a temporary database and synthetic files to exercise the full teaching flow (requirements → roadmap → lesson → tutoring → question generation → evaluation), without executing submitted code.

Both use the model configuration saved in `TMC_DATA_DIR` (default: `~/.teach-me-coding/`). Stop any application instance using that data directory before running them. Model outputs are not guaranteed to be identical across runs.

## Dependency patches

pnpm automatically applies the patches in `patches/` during installation. When upgrading a patched dependency, check whether upstream has fixed the issue and remove patches that are no longer needed.

| Patch | Purpose |
| --- | --- |
| `node-pty@1.1.0.patch` | The prebuilt macOS `spawn-helper` lacks execute permission ([microsoft/node-pty#850](https://github.com/microsoft/node-pty/issues/850)); always compile from source on macOS, retaining prebuilt binaries on Linux when available |
| `@base-ui__utils@0.2.9.patch` | Backports [mui/base-ui#4866](https://github.com/mui/base-ui/pull/4866) to fix incorrect menu `aria-expanded` state in React 19 production mode ([#4956](https://github.com/mui/base-ui/issues/4956)) |
| `@earendil-works__pi-coding-agent@1.0.0.patch` | Allows the server to supply authentication context and Provider definitions; adds a private output directory, POSIX file modes of `0600`, and propagation of write failures to the Bash tool |
| `@earendil-works__pi-ai@1.0.0.patch` | Uses only the explicitly supplied environment without falling back to `process.env`, ensuring credentials come only from the data directory |

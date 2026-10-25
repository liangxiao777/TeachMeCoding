# Security policy

English · [简体中文](SECURITY.zh.md)

## Supported versions

The project has not yet had an official release. Security fixes target only the `main` branch.

## Reporting a vulnerability

Do not disclose vulnerability details in public issues. On the repository's Security page, click **Report a vulnerability** to submit a private report. Include the scope of the impact, steps to reproduce, and affected commits.

## Security model

TeachMeCoding is a local, single-user application. The AI Agent reads files, executes commands, and accesses the network with the permissions of the system account running the server. Use it only in an environment where you trust the model, tools, and reference materials. The following behaviors are intentional design trade-offs and are not considered vulnerabilities:

- **This is not a sandbox.** The Agent's `bash` and `read`/`ls`/`find`/`grep` tools, the local terminal, approved file modifications, and coding assessments all use the server account's permissions. Project directories, the reference library directory, and working directories are not permission boundaries. The Agent may read private files such as credentials and send them to the model provider.
- **Agent Bash runs autonomously by default**, without confirming each command. Stopping the Agent cancels commands but cannot undo side effects that have already occurred.
- **YOLO mode**, once enabled, automatically accepts roadmap adjustments, lesson changes, file modifications, and learning conclusions in that conversation.
- **Enabled MCP tools can be called directly by the Agent**, without per-call confirmation. Add only servers you trust.
- **Network mode (`HOST=0.0.0.0`) has no login authentication or user isolation.** Anyone who can connect to the ports can read and write learning data, call models, and use the Agent and local terminal. Use it only on trusted networks; do not expose it to the public internet.

Protections provided by the application:

- Request tokens, Host/Origin allowlists, and Fetch Metadata checks are used to prevent external web pages from abusing local interfaces. They are not a login system and cannot defend against processes with local permissions.
- Model, search, and MCP credentials are saved only through the Settings page in the data directory (file permissions 600) and are not sent back to the browser. The application does not read credentials from `.env`, environment variables, or other applications' sign-in files. Do not put secrets in `VITE_*` variables, URLs, or command arguments.
- Agent subprocesses inherit only allowlisted environment variables; web fetching rejects local and private-network addresses.
- `TMC_AGENT_DEBUG_SNAPSHOTS=1` writes complete model requests to `agent-debug/` in the data directory. These may contain source code, paths, and private grading rubrics. Do not commit or make these files public.

See [Architecture](docs/architecture.md) and [Configuration](docs/configuration.md) for details of these mechanisms.

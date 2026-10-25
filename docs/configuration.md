# Configuration

English · [简体中文](configuration.zh.md)

TeachMeCoding has two types of configuration:

- **Startup options**: ports, listen address, data directory, and more. Set these through environment variables or a `.env` file in the project root. Changes require a restart.
- **Application settings**: models, search, MCP, and Skills. Manage these on the application's **Settings** page. They are saved in the data directory and apply to Agent runs started afterward.

Credentials can only be saved through the Settings page. The application does not read credentials from `.env`, environment variables, or other applications' sign-in files.

## Startup options

Precedence is **startup environment > root `.env` > defaults**. Copy [`.env.example`](../.env.example) to `.env` and adjust it as needed. If you already have a `.env` file, merge the settings manually.

| Variable | Default | Description |
| --- | --- | --- |
| `TMC_DATA_DIR` | `~/.teach-me-coding/` | Data directory; must be an absolute path |
| `HOST` | `127.0.0.1` | Listen address: either `127.0.0.1` or `0.0.0.0`; see [Local network access](#local-network-access) |
| `PORT` | `4310` | API port; also serves the interface in production mode |
| `TMC_WEB_PORT` | `5173` | Frontend port in development mode |
| `TMC_PREVIEW_ORIGIN` | Not set | Editor preview origin allowed to embed the interface; see [Embedded editor previews](#embedded-editor-previews) |
| `TMC_AGENT_DEBUG_SNAPSHOTS` | `0` | Set to `1` to write complete model requests to `agent-debug/` in the data directory |

- Only the six entries in the table above are read. Other keys are ignored and are not injected into the process environment.
- Values in `.env` are read literally; `~`, `${VAR}`, and commands are not expanded. Quote paths containing spaces, for example, `TMC_DATA_DIR="/Users/me/TMC Data"`.
- Explicitly set empty values also take effect; the server refuses to start if a port, the data directory, or the preview origin is empty.
- The startup command determines the mode: `pnpm dev` uses development mode, and `pnpm start` uses production mode.
- `.env` is located relative to the code, so you can run `node /path/to/apps/server/dist/index.js` from any directory.

> [!CAUTION]
> Debug snapshots may contain source code, file paths, and private grading rubrics. Do not commit or make files in `agent-debug/` public. Disabling snapshots does not delete existing files; stop the server before cleaning them up manually.

## Models

In **Settings → Model configuration**, choose a provider, model, reasoning effort, and sign-in method (API Key or OAuth).

- New selections apply to runs started afterward; ongoing runs continue using their original model.
- Credentials are saved in `credentials.json` in the data directory (permissions 600) and are not sent back to the browser.
- Authentication methods that depend on external cloud identity files are not supported: Amazon Bedrock is not currently available; Google Vertex AI supports only saved API Keys and does not read Google ADC or service account files.
- Without a configured model, you can still browse existing data and use the terminal. The Settings page indicates which configuration is missing.

## Data directory

| Path | Contents |
| --- | --- |
| `app.db` | SQLite database: learning spaces, requirements, roadmaps, lessons, conversations, assessments, and Agent run records |
| `projects/<space-id>/` | Project files for each learning space; the contents on disk are authoritative |
| `library/` | Original files uploaded to the reference library |
| `skills/` | Skills installed through the application |
| `credentials.json`, `search.json`, `mcp.json` | Model credentials, search configuration, and MCP configuration (permissions 600) |
| `bash-output/` | Temporary Agent Bash output, cleaned up when the run ends or the server restarts |
| `agent-debug/` | Created only when debug snapshots are enabled |
| `app.lock` | Instance lock |

- Only one instance can use a data directory at a time, including development and production instances. Do not delete `app.lock` to start a second instance; to run instances in parallel, set a different `TMC_DATA_DIR` for the other instance.
- An empty directory is initialized automatically on first startup, and the database is migrated by version after upgrades. If migration fails, the database version is newer than the current application, or the database cannot be opened, the server exits with an error message. It does not delete and recreate the data.
- When the server restarts, unfinished Agent runs, commands, and code executions are marked as interrupted and are not replayed automatically.

### Backup and restore

1. Shut down the server normally.
2. Copy the entire data directory, including any `-wal` and `-shm` files SQLite may have created.
3. To restore, stop the server, then point `TMC_DATA_DIR` to the backup copy or replace the original directory with the backup.

Do not copy only `app.db` while the server is running, and do not edit the database files directly.

## Local network access

By default, the server listens only on `127.0.0.1`. To allow access from other devices on the same trusted network, set `HOST=0.0.0.0`:

```sh
HOST=0.0.0.0 pnpm start   # Run pnpm build first; open http://<local IPv4>:4310
HOST=0.0.0.0 pnpm dev     # Open http://<local IPv4>:5173
```

At startup, the server adds the IPv4 addresses of the machine's network interfaces to the Host/Origin allowlist. Restart the server if those addresses change.

> [!WARNING]
> Network mode has **no login authentication or user isolation**. Anyone who can connect to the ports can read and write learning data, call models, use the Agent, operate the local terminal, and run code. Use it only on trusted networks; do not expose it to the public internet.

## Embedded editor previews

Editors such as Devin Desktop proxy preview pages through another local port. The default access protections reject this origin and prevent the page from being embedded in an iframe. To use an embedded preview, set `TMC_PREVIEW_ORIGIN` to the actual preview address provided by the editor, then restart the server:

```sh
TMC_PREVIEW_ORIGIN=http://127.0.0.1:54492 pnpm dev   # Replace the port with the one actually used by the editor
```

- Only one exact local HTTP origin is accepted (`127.0.0.1` or `localhost`, with an optional port). Other hosts, paths, and wildcards are not accepted; `localhost` and `127.0.0.1` are not interchangeable.
- Once enabled, same-origin pages, that preview origin, and VS Code-based editor webviews can embed the interface. API and terminal requests still require a request token, and CORS remains disabled.
- If the preview port changes, update the configuration and restart. Remove the setting and restart to restore the default policy.

## Search services

In **Settings → Search services**, choose a provider and turn on the master switch (off by default). Once enabled, all teaching scenarios can search through the `web_search` tool; the teaching model does not need native search support.

There are 14 supported providers: Brave Search, Tavily, Exa, Firecrawl, Parallel, Perplexity Search, MiniMax Search, Gemini, Grok, Kimi, Codex Hosted Search, DuckDuckGo, Firecrawl Free, and Ollama Web Search.

- **No API Key required**: DuckDuckGo and Firecrawl Free. Anonymous searches may encounter rate limits or CAPTCHAs.
- **Codex Hosted Search**: uses the ChatGPT account signed in under **Settings → Model configuration**. It runs a pinned version of Codex app-server in a private temporary directory with a minimal environment, with command execution, file modification, and MCP disabled, for search only. These are capability restrictions, not operating-system-level isolation. Windows is not supported. Signing out of that account also affects any teaching model that uses it.
- **Other providers**: use their own API Keys. Gemini, Grok, and Kimi allow a separate search model to be specified; MiniMax and Kimi offer Global or China regions; MiniMax Search requires a Coding Plan that supports the search API; Ollama Web Search calls the hosted service at `ollama.com`, not a local Ollama instance.

Usage notes:

- The configuration is saved in `search.json` in the data directory (permissions 600). Switching providers does not overwrite other providers' settings.
- **Test search** calls the current provider directly, without going through the teaching model. Both tests and Agent searches may incur charges, and query content is sent to the provider.
- Turning off the master switch blocks subsequent searches and cancels in-flight requests, but does not affect other ways of accessing the network, such as web fetching or MCP.
- Provider failures are reported directly; there is no automatic fallback to another provider.
- Standard searches return result snippets with titles and links (5 by default, up to 10); Gemini, Grok, Kimi, and Codex return answers with sources. Search does not fetch full page content.

## Web fetching

The `web_fetch` tool is always available, requires no API Key, and is not controlled by the search switch. Use it to read public web pages or links from search results.

- Sends only HTTP(S) GET requests, without cookies or any credentials.
- Extracts the main content from HTML with Readability, then converts it to Markdown or plain text. Markdown, plain text, and JSON are also supported. It does not execute JavaScript or support pages requiring sign-in or PDFs.
- Downloads at most 750,000 bytes and follows at most 3 redirects per request, with an overall time limit of 30 seconds.
- Rejects local, private-network, cloud metadata, and reserved addresses, and pins the validated DNS result when connecting to prevent DNS rebinding.
- Connects directly to the destination without using the system proxy. Fetching may fail on networks that depend on proxies or fake-IP.

## MCP

Add MCP servers in **Settings → MCP**, either through the form or by pasting JSON:

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <your-token>" },
      "enabled": false
    }
  }
}
```

| Field | Applies to | Description |
| --- | --- | --- |
| `command`, `args` | stdio | Executable name and arguments, not a shell command string |
| `cwd` | stdio | Working directory; relative paths are resolved against the data directory |
| `env` | stdio | Additional environment variables |
| `url`, `headers` | Streamable HTTP | Server address and request headers |
| `enabled` | All | The server does not start when set to `false` |
| `timeout` | All | In seconds; defaults to 60 |

- `env` and `headers` accept only literal values; `${VAR}` references and command expansion are not supported. Put authentication information in these fields, not in URLs or startup arguments.
- The configuration is saved in `mcp.json` in the data directory (permissions 600). The Settings page hides the values of `env` and `headers`; saving an unchanged mask preserves the original value.
- The list of available tools is fixed at the start of each Agent run. Configuration changes apply to subsequent runs.
- Legacy SSE transport, remote OAuth sign-in, and MCP resources and prompts are not currently supported.

> [!WARNING]
> Enabled MCP tools can be called directly by the Agent without per-call confirmation. They may read learning materials or cause external side effects. stdio servers run with the local account's permissions. Add only servers you trust.

## Skills

Manage skills in **Settings → Skills**:

- **Skill marketplace**: browse the All Time, Trending, and Hot leaderboards on [skills.sh](https://skills.sh), or search all skills.
- **Install from link**: supports skills.sh skill pages, HTTPS repositories or publishing sites, and `owner/repo` shorthand. Specify the skill name when a source contains multiple skills.
- **Import local directory**: reference a local skill directory or a single Markdown file (using an absolute path or a path starting with `~/`).
- **Installed**: view details, enable or disable, check for updates, and uninstall.

Installation uses a pinned version of the [Skills CLI](https://github.com/vercel-labs/skills) to fetch files in a separate temporary directory, without passing through model credentials, SSH agent access, or Git configuration. Files are validated before being placed in `skills/` in the data directory. Installation does not run scripts in the package or install dependencies, but fetching still runs with local account permissions. Local modifications detected during an update check are not overwritten. Removing a local reference only hides the skill; it does not delete the original files.

Enabled skills are listed by name and description in the system prompt, and the model uses the `read` tool to read their full content when needed. Skills declaring `disable-model-invocation: true` are not listed automatically. Any enabled skill can be invoked explicitly by starting a message with `/skill:name your request`. Skill changes apply to runs started afterward.

# Architecture

English · [简体中文](architecture.zh.md)

This guide describes TeachMeCoding's components, how its Agents run, and the boundaries of local execution. It is intended for contributors who want to understand or modify the internals. See [SECURITY.md](../SECURITY.md) for a summary of the security model and [Configuration](configuration.md) for configuration options.

## Overview

```text
Browser (React + Vite)
   │  HTTP API · SSE event stream · terminal WebSocket (all require a request token)
   ▼
Node server (Hono)
   ├─ Learning features  Spaces, requirements, roadmaps, lessons, conversations, assessments, proposals
   ├─ Agent runtime      Pi AgentSession, six teaching scenarios
   ├─ Local execution    PTY terminals, Agent Bash, code assessments
   ├─ Extensions         Search, web fetching, MCP, Skills
   └─ Storage            SQLite (app.db), project directories, library
```

- **Frontend** (`apps/web`): React 19, Vite, Tailwind CSS, and Base UI. Agent conversations use [AI Elements](https://ai-sdk.dev/elements) components; the editor uses CodeMirror, and the terminal uses xterm. Fonts and icons ship with the build, with no requests to online font or analytics services.
- **Server** (`apps/server`): A single Node process provides the API, SSE, and terminal WebSocket. In production, it also serves the frontend's static assets.
- **Contracts** (`packages/contracts`): Shared zod schemas and types for the frontend and server.
- **Agents**: Built on [Pi](https://github.com/earendil-works/pi)'s Agent Core, AI, and Coding Agent SDK (pinned to 1.0.0). Model requests use Pi's own Provider adapters, not the Vercel AI SDK protocol.

By design, the model is responsible only for expressing domain content. The server handles internal IDs, reference associations, revision numbers, transactions, and storage. Tool parameters do not ask the model to supply this information.

## Learning flow

```text
Requirements clarification ──confirm──▶ Roadmap planning ──▶ Unit learning (lesson · tutoring · practice) ──▶ Assessment ──▶ Evaluation feedback
```

Units unlock in roadmap order: the first unit is always accessible, and later units unlock once every preceding unit has a published lesson. Passing an assessment is not required to unlock units. Units where learning has already started remain accessible.

## Agent scenarios

| Scenario | Trigger | Scenario-specific tools | Outputs |
| --- | --- | --- | --- |
| `intake` | Requirements clarification conversation | `ask_user_question`, `write_research_document`, `submit_requirement_draft` | Clarifying questions, research documents, and a requirements draft. Roadmap planning starts automatically after the user confirms the requirements |
| `roadmap` | Roadmap conversation | Initial plan: `submit_route`; adjustments: `add_route_stage`, `add_route_unit`, `update_route_stage`, `update_route_unit`, `remove_route_unit`, `remove_route_stage`, `submit_route_proposal` | The initial roadmap takes effect directly; adjustments produce a roadmap proposal |
| `tutor` | Unit conversation | `read_current_lesson`, `propose_lesson_change`, `propose_file_change`, `submit_learning_conclusion` | Lesson change proposals, file change proposals, and learning conclusions awaiting adoption |
| `lesson` | Background task | `read_learning_route`, `read_reference_lesson`, `submit_lesson` | The first lesson is published directly; regeneration produces a lesson proposal |
| `assessment` | Background task | `submit_assessment` | Public questions and private grading criteria; coding questions include an execution plan |
| `evaluation` | Background task after an assessment submission | `submit_evaluation` | Evaluation results tied to that submission and its execution evidence |

All scenarios also receive these shared tools:

- `read`, `ls`, `find`, `grep`: Read files with the current space's project directory as the working directory.
- `bash`: Pi's Bash tool, with the library directory as its working directory. Commands run autonomously, without per-command confirmation.
- `list_library_files`: List library files for on-demand consultation with the read tools.
- `web_fetch`: Read public web pages; `web_search` is also available when a search service is enabled.
- Enabled MCP tools, named in the form `mcp__<server>__<tool>`.

Enabled Skills are not tools. Instead, they are listed as a catalog in the system prompt, and the model loads their contents with `read`. A tool name conflict causes the run to fail immediately rather than allowing tools to overwrite one another.

## Proposals and confirmation

Roadmap adjustments, lesson rewrites, file changes, and learning conclusions are saved as proposals first and take effect only after user confirmation:

- While a space has a pending roadmap or lesson proposal, new Agent input is paused until the user applies or rejects it. Rejection can include feedback; the server then continues for another turn in the original conversation with that feedback.
- Requirements, roadmap, and lesson versions are revalidated before a proposal is applied. A proposal cannot be applied if its source has changed.
- A roadmap adjustment cannot remove a unit where learning has already started or change that unit's learning goals.
- File change proposals expire after 30 minutes. Confirmation requires the editor's autosave to finish and the file version to be validated.

**YOLO mode** is enabled per conversation. When enabled, proposals produced by normally completed runs in that conversation are accepted automatically; any proposals already pending when it is enabled are also accepted immediately. In a requirements clarification conversation, requirements are automatically confirmed when ready, and roadmap planning begins. YOLO does not answer clarifying questions on the user's behalf or bypass version, ownership, or write validation.

## Run lifecycle

Each conversation message starts a run; lesson generation, question generation, and evaluation run as background tasks. Both share the same runtime:

1. **Pin context**: At the start of a run, the relevant requirements, roadmap, and lesson versions are pinned and injected as teaching context. System instructions and application-controlled context are authored as XML resources.
2. **Execute**: A Pi `AgentSession` executes tools sequentially. If a tool fails, the error is returned to the model as a result so it can correct the parameters, try another approach, or explain the limitation. A single tool error does not fail the whole turn.
3. **Commit**: Scenario tools only stage outputs. After a run ends normally, the server validates versions and publishes the outputs in a single database transaction. No outputs are saved if the run is cancelled, output is truncated, versions are stale, or required outputs are missing.
4. **Conversation history**: After a successful run, new entries from the Pi session are saved as a checkpoint in SQLite. The next run in the same conversation resumes from that checkpoint. Pi's automatic context compaction is enabled by default; the UI displays context usage and compaction status. New conversations automatically include only confirmed requirements, valid assessments, and user-adopted learning conclusions from the same space.

Other behavior:

- **Message queueing**: New messages sent during a run enter that run's queue and are processed one at a time in order. They can be withdrawn before processing starts. The queue pauses if the run fails or is stopped.
- **Event stream**: Reasoning, response text, tool status, and public tool parameters are saved as ordered events. After an SSE disconnection, streaming resumes from the event cursor without making another model request.
- **Model calls**: The server imposes no token budget, overall duration limit, or call count limit. Individual model requests time out after 300 seconds by default. HTTP adapters that support a custom fetch also have a 300-second idle timeout. Transient errors are retried automatically up to 3 times, with backoffs of 2, 4, and 8 seconds. Authentication, quota, and context overflow errors are not retried.
- **Stopping and restarting**: Stopping a run cancels model requests and executing commands, but does not roll back side effects that have already occurred. On server restart, unfinished runs are marked as interrupted and are not replayed automatically.

## Local execution

### Terminals

Terminals in both the regular and fullscreen IDE use xterm connected to a real PTY, with the current space's project directory as the working directory. Each space reuses one shell. Refreshing the page or reconnecting does not replay input or terminate the shell. Terminal input waits for the editor's autosave to finish so commands use the latest file contents.

### Agent Bash

- There is no default per-command timeout. The model can supply an optional `timeout`; stopping the Agent cancels the command.
- The model sees the last 2,000 lines or 50 KiB of output. Full output is written to `bash-output/` in the data directory for further reading during the current run, then cleaned up when the run ends.
- Raw output is capped at 32 MiB per command. Commands exceeding that limit are terminated to protect disk space.
- Child processes inherit only allowlisted environment variables.

### Project files

The browser's project file API can access only application-managed project directories. It supports reading, creating, renaming, and saving, but not deletion. Each file must be UTF-8 text no larger than 1 MB. Path traversal, symbolic links, hard links, and non-regular files are rejected. The editor autosaves after each input and retries version conflicts using the current editor contents.

### Code assessments

- Coding questions include an execution plan with the language, command-line arguments, and expected standard output. Supported languages are Python, JavaScript, TypeScript, Rust, and Bash, using locally installed `python3`, `node`, `rustc`, or `/bin/bash`.
- Each run uses a code snapshot and a disposable temporary directory. The entire execution is limited to 30 seconds and 256 KiB of output.
- A coding question passes only if all test cases complete, their output matches expectations, and the model's evaluation also passes. Missing toolchains, errors, timeouts, and cancellations never count as a pass.
- Evaluation results identify the evidence type: `execution-verified` (real execution evidence), `unverified` (a coding question without valid execution evidence), or `non-execution` (an analysis-only question).
- Private grading criteria are stored separately from public questions. They are not sent to the browser or included in the tutor Agent's default context. This is application-level isolation: the Agent's read tools and Bash run with local permissions and can still read database files directly.

## Data retention

- Saved content includes user messages and quotes, displayable model responses, domain outputs, proposals' before-and-after contents, confirmation results, assessment submissions, and execution evidence.
- The bodies of automatically read tool results are used only during the current run. Persistence retains only call relationships and content hashes, without making additional copies of source code or web content.
- Each model request records a manifest with source versions, hashes, the tool list, actual usage, and transport diagnostics. The manifest does not retain raw Provider error bodies or credentials.

## Local API access control

- The server listens only on `127.0.0.1` by default. Host and Origin must be allowlisted; CORS is not enabled, and forwarded headers are not trusted.
- On startup, the page obtains a request token through `GET /api/access`. All subsequent `/api` requests must include the `X-TMC-Token` header. The token is randomly generated on each server start and kept only in page memory, never in files, logs, or URLs.
- The terminal WebSocket (`/api/terminal/socket`) passes the token through the `tmc-terminal` and `tmc-token.<token>` subprotocols. Query parameters are not accepted.
- These measures prevent external web pages from abusing the local API. They are not a login system and do not defend against processes with local permissions.

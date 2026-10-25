# 配置

[English](configuration.md) · 简体中文

TeachMeCoding 的配置分为两类：

- **启动参数**：端口、监听地址、数据目录等，通过环境变量或项目根目录的 `.env` 设置，修改后需重启。
- **应用设置**：模型、搜索、MCP 和 Skills，在应用的「设置」页面管理，保存在数据目录中，对之后开始的 Agent 运行生效。

凭据只能通过设置页保存。应用不会从 `.env`、环境变量或其他应用的登录文件读取凭据。

## 启动参数

优先级为 **启动环境 > 根目录 `.env` > 默认值**。可以把 [`.env.example`](../.env.example) 复制为 `.env` 再按需修改；如果已有 `.env`，请手动合并。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TMC_DATA_DIR` | `~/.teach-me-coding/` | 数据目录，必须是绝对路径 |
| `HOST` | `127.0.0.1` | 监听地址，可选 `127.0.0.1` 或 `0.0.0.0`，见[局域网访问](#局域网访问) |
| `PORT` | `4310` | API 端口；生产模式下同时提供界面 |
| `TMC_WEB_PORT` | `5173` | 开发模式的前端端口 |
| `TMC_PREVIEW_ORIGIN` | 未设置 | 允许嵌入的编辑器预览来源，见[编辑器内置预览](#编辑器内置预览) |
| `TMC_AGENT_DEBUG_SNAPSHOTS` | `0` | 设为 `1` 时把完整模型请求写入数据目录的 `agent-debug/` |

- 只读取上表六项，其他键会被忽略，也不会注入进程环境。
- `.env` 中的值按字面量读取，不展开 `~`、`${VAR}` 或命令。路径含空格时加引号，例如 `TMC_DATA_DIR="/Users/me/TMC Data"`，Windows 可用 `TMC_DATA_DIR="C:/Users/me/TMC Data"`。Windows 使用原生盘符路径，不要使用 Git Bash 的 `/c/Users/...` 或 WSL 路径。
- 显式设置的空值同样生效；端口、数据目录和预览来源为空时服务会拒绝启动。
- 运行模式由启动命令决定：`pnpm dev` 是开发模式，`pnpm start` 是生产模式。
- 下文的行内环境变量示例使用 Bash 语法（macOS/Linux 或 Git Bash）。从 PowerShell 或 cmd 启动时，把相同设置写入 `.env` 即可；pnpm 启动/构建命令本身适用于这些 shell。
- `.env` 相对代码位置定位，因此可以从任意目录运行 `node /path/to/apps/server/dist/index.js`。

> [!CAUTION]
> 调试快照可能包含源码、文件路径和私有评分标准。不要提交或公开 `agent-debug/` 中的文件。关闭快照不会删除已有文件，请在停止服务后手动清理。

## 模型

在「设置 → 模型配置」中选择 Provider、模型、推理强度和登录方式（API Key 或 OAuth）。

- 新的选择用于之后开始的运行，进行中的运行继续使用原来的模型。
- 凭据保存在数据目录的 `credentials.json`（Unix 上为 `0600`），不会返回浏览器。
- 不支持依赖外部云身份文件的认证方式：暂不提供 Amazon Bedrock；Google Vertex AI 只支持保存的 API Key，不读取 Google ADC 或 service account 文件。
- 未配置模型时仍可浏览已有数据和使用终端，设置页会提示缺少哪项配置。

## 数据目录

macOS/Linux 默认使用 `~/.teach-me-coding/`，Windows 默认使用 `%USERPROFILE%\.teach-me-coding\`。请把学习数据保存在源码目录之外。

| 路径 | 内容 |
| --- | --- |
| `app.db` | SQLite 数据库：空间、需求、路线、课件、会话、测评与 Agent 运行记录 |
| `projects/<space-id>/` | 每个学习空间的项目文件，以磁盘内容为准 |
| `library/` | 资料库中上传的原始文件 |
| `skills/` | 通过应用安装的 Skills |
| `credentials.json`、`search.json`、`mcp.json` | 模型凭据、搜索配置和 MCP 配置（Unix 上为 `0600`） |
| `bash-output/` | Agent Bash 的临时输出，运行结束或重启时清理 |
| `agent-debug/` | 仅在开启调试快照时生成 |
| `app.lock` | 实例锁 |

- Unix 上新建数据目录时请求 `0700` 模式。Windows 上的 `0600`/`0700` 模式位不构成 ACL 保护：请把数据放在用户配置文件目录下，通过 Windows 账号 ACL 限制访问，避免共享目录或其他用户可读的目录。备份也应采用同样的保护。
- 一个数据目录同一时间只能被一个实例使用，开发和生产实例也不能共用。不要通过删除 `app.lock` 启动第二个实例；需要并行运行时，为另一个实例设置不同的 `TMC_DATA_DIR`。
- 空目录首次启动时自动初始化，升级后按版本迁移数据库。迁移失败、数据库版本高于当前程序或数据库无法打开时，服务会退出并提示，不会删除数据重建。
- 服务重启时，未完成的 Agent 运行、命令和代码执行会标记为中断，不会自动重放。

### 备份与恢复

1. 正常停止服务。
2. 复制整个数据目录，包括 SQLite 可能生成的 `-wal`、`-shm` 文件。
3. 恢复时，停止服务后把 `TMC_DATA_DIR` 指向备份副本，或用备份替换原目录。

不要在服务运行时只复制 `app.db`，也不要直接修改数据库文件。

## 局域网访问

默认只监听 `127.0.0.1`。要让同一可信网络中的其他设备访问，设置 `HOST=0.0.0.0`：

```sh
HOST=0.0.0.0 pnpm start   # 需先 pnpm build；访问 http://<本机 IPv4>:4310
HOST=0.0.0.0 pnpm dev     # 访问 http://<本机 IPv4>:5173
```

服务启动时会把本机网卡的 IPv4 地址加入 Host/Origin 白名单；网卡地址变化后需要重启。

> [!WARNING]
> 网络模式**没有登录鉴权和用户隔离**。任何能连接到端口的人都可以读写学习数据、调用模型、使用 Agent、操作本机终端和运行代码。只在可信网络中使用，不要暴露到公网。

## 编辑器内置预览

Devin Desktop 等编辑器会通过另一个本机端口代理预览页面。默认的访问保护会拒绝这个来源，并阻止页面被嵌入 iframe。需要内置预览时，把 `TMC_PREVIEW_ORIGIN` 设为编辑器实际给出的预览地址后重启服务：

```sh
TMC_PREVIEW_ORIGIN=http://127.0.0.1:54492 pnpm dev   # 端口替换为编辑器实际使用的端口
```

- 只接受一个准确的 HTTP 本机来源（`127.0.0.1` 或 `localhost`，可带端口），不接受其他主机、路径或通配符；`localhost` 与 `127.0.0.1` 不能互相替代。
- 启用后，同源页面、该预览来源和 VS Code 系编辑器的 webview 可以嵌入界面。API 和终端仍需要请求令牌，也不会开放 CORS。
- 预览端口变化后需要更新配置并重启；移除配置并重启即恢复默认策略。

## 搜索服务

在「设置 → 搜索服务」中选择服务商并打开总开关（默认关闭）。启用后，所有教学场景都可以通过 `web_search` 工具搜索，教学模型本身不需要支持原生搜索。

支持 14 个服务商：Brave Search、Tavily、Exa、Firecrawl、Parallel、Perplexity Search、MiniMax Search、Gemini、Grok、Kimi、Codex Hosted Search、DuckDuckGo、Firecrawl Free、Ollama Web Search。

- **无需 API Key**：DuckDuckGo 和 Firecrawl Free。匿名搜索可能遇到限流或验证码。
- **Codex Hosted Search**：使用「设置 → 模型配置」中登录的 ChatGPT 账号，以独立临时目录和最小环境运行固定版本的 Codex app-server，并禁用命令执行、文件修改和 MCP，只做搜索。Windows 使用原生进程树清理。这是能力限制，不是操作系统级隔离。退出该账号也会影响使用它的教学模型。
- **其他服务商**：使用各自的 API Key。Gemini、Grok、Kimi 可单独指定搜索模型；MiniMax、Kimi 可选择全球或中国区域；MiniMax Search 需要支持搜索接口的 Coding Plan；Ollama Web Search 调用 `ollama.com` 的托管服务，不使用本地 Ollama。

使用说明：

- 配置保存在数据目录的 `search.json`（Unix 上为 `0600`），切换服务商不会覆盖其他服务商的配置。
- 「测试搜索」直接调用当前服务商，不经过教学模型。测试和 Agent 搜索都可能产生费用，查询内容会发送给服务商。
- 关闭总开关会阻止后续搜索并取消进行中的请求，但不影响网页抓取、MCP 等其他联网方式。
- 服务商失败时直接报错，不会自动切换到其他服务商。
- 普通搜索返回带标题和链接的结果摘要（默认 5 条，最多 10 条）；Gemini、Grok、Kimi、Codex 返回带来源的回答。搜索不抓取全文。

## 网页抓取

`web_fetch` 工具始终可用，不需要 API Key，也不受搜索开关控制，用于读取公开网页或搜索结果中的链接。

- 只发送 HTTP(S) GET 请求，不携带 Cookie 或任何凭据。
- HTML 用 Readability 提取正文后转为 Markdown 或纯文本，也支持 Markdown、纯文本和 JSON。不执行 JavaScript，不支持登录页面或 PDF。
- 单次最多下载 750,000 字节、跟随 3 次重定向，整体时限 30 秒。
- 拒绝本机、内网、云元数据和保留地址，并在连接时固定已校验的 DNS 结果，防止 DNS 重绑定。
- 直接连接目标地址，不使用系统代理。依赖代理或 fake-IP 的网络环境可能无法抓取。

## MCP

在「设置 → MCP」中添加 MCP 服务器，可以用表单填写，也可以粘贴 JSON：

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

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `command`、`args` | stdio | 可执行程序名和参数，不是 shell 命令串 |
| `cwd` | stdio | 工作目录；相对路径基于数据目录 |
| `env` | stdio | 额外环境变量 |
| `url`、`headers` | Streamable HTTP | 服务地址和请求头 |
| `enabled` | 全部 | 设为 `false` 时不启动 |
| `timeout` | 全部 | 单位为秒，默认 60 |

- `env` 和 `headers` 只接受字面值，不支持 `${VAR}` 引用或命令展开。认证信息请放在这两个字段中，不要写进 URL 或启动参数。
- 配置保存在数据目录的 `mcp.json`（Unix 上为 `0600`）。设置页会隐藏 `env` 和 `headers` 的值，保存未修改的掩码会保留原值。
- 每次 Agent 运行开始时固定当时可用的工具列表，配置变更对之后的运行生效。
- 暂不支持 legacy SSE 传输、远端 OAuth 登录，以及 MCP resources 和 prompts。

> [!WARNING]
> 启用的 MCP 工具可被 Agent 直接调用，不经过逐次确认，可能读取学习资料或产生外部副作用。stdio 服务以本机账号权限运行。只添加你信任的服务器。

## Skills

在「设置 → Skills」中管理技能：

- **技能市场**：浏览 [skills.sh](https://skills.sh) 的 All Time、Trending 和 Hot 榜单，或搜索全部技能。
- **从链接安装**：支持 skills.sh 技能页、HTTPS 仓库或发布网站，以及 `owner/repo` 形式；来源包含多个技能时需要指定名称。
- **导入本地目录**：引用本机的技能目录或单个 Markdown 文件（绝对路径或 `~/` 开头）。
- **已安装**：查看详情、启用或停用、检查更新、卸载。

安装使用固定版本的 [Skills CLI](https://github.com/vercel-labs/skills)，在独立的临时目录中获取文件，不传递模型凭据、SSH agent 或 Git 配置，校验后放入数据目录的 `skills/`。安装不会执行包内的脚本或安装依赖，但获取过程仍以本机权限运行。检查更新时如果发现本地修改，不会覆盖。移除本地引用只会隐藏技能，不删除原文件。

启用的技能会以名称和描述列在系统提示中，模型需要时用 `read` 工具读取完整内容；声明了 `disable-model-invocation: true` 的技能不会自动列出。任何启用的技能都可以通过以 `/skill:名称 你的请求` 开头的消息显式调用。技能变更对之后开始的运行生效。

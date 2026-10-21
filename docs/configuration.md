# 配置指南

本文汇总模型、端口、数据目录、网络访问和外部服务的配置方式。快速上手见 [README](../README.md#快速开始)。

## 模型

在全屏「设置 → 模型配置」中选择 pi-ai 提供的 Provider、模型、推理强度及登录方式；保存的选择用于新运行，进行中的运行继续使用创建时的模型。API Key / OAuth 凭据只保存在服务端数据目录的 `credentials.json`（600），不返回浏览器。原有 `.env` 的 `OPENROUTER_API_KEY` 和 `OPENROUTER_MODEL=stealth/space-bunny-alpha` 可继续作为初始配置；服务端环境变量优先，保存模型选择后不再使用模型回退值。缺少配置时仍可查看数据和使用终端；设置页说明缺少哪项配置。实际模型检查见[模型兼容性检查](development.md#模型兼容性检查)。

## 端口与启动

`Ctrl+C` 停止服务。API 端口可通过 `PORT` 设置，开发前端可通过 `TMC_WEB_PORT` 设置；`pnpm dev` 将相同配置用于代理和本地访问白名单。编译产物可从任意工作目录用 `node /绝对路径/apps/server/dist/index.js` 启动，静态资源和默认数据目录不依赖当前目录。

## 数据目录与恢复

默认数据根目录为 `~/.teach-me-coding/`，独立于源码。也可显式选择另一个绝对路径：

```sh
TMC_DATA_DIR="$HOME/teach-me-coding-dev" pnpm dev
# 生产启动使用同一配置方式；同一目录不能同时启动开发和生产实例。
TMC_DATA_DIR="$HOME/teach-me-coding-data" pnpm start
```

- `app.db`：共享 SQLite 数据库，按空间保存需求、路线、单元、课件、会话、消息/引用、测评草稿与固定提交、评估结果、Agent 运行事件、文件／命令提案及代码执行记录。
- `projects/<space-id>/`：真实项目目录；项目源码以磁盘文件为准，数据库不保存编辑器工作副本。消息引用、已发布文件提案和测评提交中的代码是对应操作的固定快照，不与项目文件自动同步。
- `library/<file-id>/`：全局共享的原始资料及上传元数据，备份时应一起保存。
- `bash-output/run-<run-id>/`：当前 Agent 运行的私有临时输出，不是持久资料；运行结束或重启后清理。
- `app.lock`：实例锁文件；服务退出或崩溃后锁自动释放。**不要为启动第二个实例而删除或替换它**。SQLite 的 `-wal`、`-shm` 等文件由数据库管理。

会话中尚未发送的文字、引用和路线调整想法只保留在当前页面内存中，不自动保存，也没有手动保存按钮。页面内切换空间、单元和会话会保留各自输入；刷新或重新打开页面后输入框为空，也不恢复旧版本已保存的会话草稿。发送成功的消息及 Agent 回复自动持久化；发送失败或迟到的响应不会清空后来编辑的新内容。

需求修改和测评答案草稿仍需手动保存；IDE 文件每次输入立即触发自动保存，不等待失焦、停顿或定时器。同一文件串行写入，请求期间继续输入时只接着保存最新内容；带入 IDE 的代码同样自动保存。保存中或失败的文件仍有离开页面警告，失败保留编辑并提供重试；页面内切换和关闭标签不取消保存。提交测评只保存该次作答，不清空后来编辑的新答案。刷新/重启恢复已保存的业务内容，正式空间不会用演示内容填补模型失败。

项目 API 仅访问应用管理的目录，支持多层目录、读取、创建、重命名和保存，不提供删除或任意外部目录接入。编辑器支持最大 1 MB 的 UTF-8 文本；路径穿越、符号链接、硬链接和非普通文件会被拒绝。外部改动可用「刷新目录」发现；自动保存遇到版本冲突时读取最新版本并重试，以当前编辑器输入为准覆盖磁盘内容，不自动合并、不显示比较面板。连续冲突最多重试三次，其他写入失败直接提示；服务端仍执行版本检查和原子替换。重命名会先等待自动保存，并暂时禁止编辑受影响的文件。路径检查不是针对同权限恶意进程竞态的沙箱。

空目录首次启动时初始化数据库；后续启动按版本事务迁移。迁移失败、高于当前程序的数据库版本或打不开数据库时，服务退出并提示，不删除数据重建。重复启动同一数据目录会被拒绝；应停止原实例或选择独立目录。重启时未完成的 Agent 任务、运行、命令操作和代码执行标记为中断，待确认提案失效，不自动调用模型、恢复 shell 或重放操作。切页或断开事件订阅不会取消后台运行；主动停止才取消，停止不代表回滚已有副作用。

不要在服务运行时只复制 `app.db` 或修改数据库文件。需要保留数据时先正常停止服务，再复制整个数据根目录，连同项目文件及可能存在的 SQLite 辅助文件一起保存；保留原目录，勿用空目录覆盖。更换源码或重新构建不会迁移内存演示数据，也不应替换数据目录。完整备份恢复验收仍属于后续整体交付。

## 网络访问

默认只监听 `127.0.0.1`。需要从可信网络访问时，在启动命令中设置 `HOST`（支持 `127.0.0.1` 或 `0.0.0.0`）：

```sh
HOST=0.0.0.0 PORT=5173 pnpm start # 先 pnpm build；单服务提供 UI 和 API
HOST=0.0.0.0 pnpm dev            # 前端 5173、API 4310 均监听所有 IPv4 接口
```

其他设备访问 `http://<运行机器的 IPv4 地址>:5173`，而不是 `0.0.0.0`。服务启动时把本机 IPv4 地址及对应端口加入 Host/Origin 白名单，保留令牌和跨站请求保护，不允许任意域名；网卡地址改变后需重启。网络模式回归可运行 `HOST=0.0.0.0 pnpm exec playwright test tests/browser/startup.spec.ts --workers=1`，使用独立测试数据，覆盖开发/生产实际 IP 访问、提交和重试。

**网络模式没有登录鉴权，也没有用户隔离。能连接端口的人可以读取和修改学习数据、调用模型、使用 Agent 文件读取能力、管理全局资料库并开启自主 Bash、操作本机终端、确认执行提案及运行测评代码；请求令牌只防跨站请求，不是登录密码。仅用于可信网络，不要将端口暴露到公网。**终端、Bash、确认后的命令及测评代码均使用服务账号的本机权限，不是沙箱；确认界面不构成用户身份鉴权。这里不提供公网部署或任意反向代理配置。

## Devin Desktop 内置预览

Devin 的预览地址与项目服务地址使用不同端口。默认访问保护会拒绝这个额外来源，页面脚本可能返回 403；默认的防嵌入策略也会阻止编辑器中的 iframe。需要内置预览时，显式设置 `TMC_PREVIEW_ORIGIN` 为 Devin 实际生成的预览地址（不是项目端口）。

先启动项目并让 Devin 创建预览，记下预览地址；保留预览代理，正常停止项目服务，再在原启动命令中添加该变量，例如：

```sh
# 示例预览端口 54492 必须替换为 Devin 实际给出的端口。
TMC_PREVIEW_ORIGIN=http://127.0.0.1:54492 pnpm dev
# 已构建的单服务也支持；PORT、HOST、TMC_DATA_DIR 沿用所需配置。
TMC_PREVIEW_ORIGIN=http://127.0.0.1:54492 pnpm start
```

该配置仅接受一个准确的 HTTP `127.0.0.1` 或 `localhost` 来源，可带端口及末尾斜杠，不接受其他主机、路径、凭据或通配符；`localhost` 与 `127.0.0.1` 不互相替代。重新创建预览导致端口改变时，需更新变量并重启项目服务。变量由启动环境读取，不从模型配置 `.env` 自动加载。

启用后允许指定代理来源，嵌入范围限定为同源、该预览来源及 Devin／VS Code 编辑器 webview。API 和终端仍需原有令牌，外部 Origin、其他未配置端口及跨站 API 请求仍被拒绝，不开放 CORS；仅非 API 的 GET/HEAD iframe 导航可通过嵌入所需的 Fetch Metadata 检查。取消变量并重启即恢复默认策略。不要将其作为公网嵌入或登录鉴权方案。

## 搜索服务

在「设置 → 搜索服务」中选择服务商并开启独立总开关，默认关闭。现支持 14 个服务：Brave Search、Tavily、Exa、Firecrawl、Parallel、Perplexity Search、MiniMax Search、Gemini、Grok、Kimi、Codex Hosted Search、DuckDuckGo、Firecrawl Free、Ollama Web Search。所有服务都通过普通 `web_search` 工具提供给教学 Agent，DeepSeek 等支持工具调用的教学模型无需更换。不自动选择其他服务或在失败后回退。

- DuckDuckGo、Firecrawl Free 无需 API Key；Free 模式不会发送付费 Firecrawl 凭据。匿名搜索仍可能限流、遇到验证码或受上游可用性影响。
- Codex Hosted Search 使用「登录 Codex」的 ChatGPT OAuth，复用模型设置中的同一账号，不改变教学模型选择。退出会移除该账号凭据，也会影响使用该账号的 Codex 教学模型。
- 其他服务使用各自的 API Key。Gemini、Grok、Kimi 可独立配置搜索模型；MiniMax、Kimi 可选择全球或中国服务区域。Ollama 使用 `ollama.com/api/web_search` 托管服务，不调用本地 Ollama 模型或守护进程。MiniMax Search 需要支持搜索接口的 Coding Plan 凭据。
- 服务端环境变量为 `BRAVE_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY`、`FIRECRAWL_API_KEY`、`PARALLEL_API_KEY`、`PERPLEXITY_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`、`OLLAMA_API_KEY`。MiniMax 按顺序读取 `MINIMAX_CODE_PLAN_KEY`、`MINIMAX_CODING_API_KEY`、`MINIMAX_OAUTH_TOKEN`、`MINIMAX_API_KEY`；Kimi 优先 `KIMI_API_KEY`，其次 `MOONSHOT_API_KEY`。设置页保存的密钥优先；不借用教学模型的凭据，也不自动读取本机 Codex 登录文件。

开关直接保存，关闭时保留配置，阻止后续内置搜索调用并取消正在执行的搜索请求；不保证服务商撤销已接收的请求或费用，也不关闭 MCP、Skills 或其他联网路径。服务商、搜索模型、区域和 API Key 在每次 Agent 运行开始时固定，修改用于新运行；Codex OAuth 在调用时检查。API Key 及搜索配置原子保存在数据目录的 `search.json`（600），OAuth 使用已有服务端凭据存储。读取设置只返回配置状态，不返回密钥；输入留空保留当前服务的凭据，切换服务不会覆盖其他服务的配置。损坏配置不会自动重建，也不阻止其他设置和学习数据读取。

「保存配置」不调用服务商。「测试搜索」使用已保存配置查询「Rust 官方文档」，直接调用同一搜索适配器、显示结果链接与耗时，不调用教学模型；即使 Agent 搜索关闭也可手动测试。测试与 Agent 搜索都可能产生服务费用，查询会发送给所选服务商；请勿在查询中包含凭据或不宜发送的私人信息。搜索不是全文抓取：默认返回 5 条、最多 10 条带标题和 URL 的结果片段，按上游顺序保留；Gemini、Grok、Kimi、Codex 返回有搜索依据的回答及可用来源。回答和片段作为不可信外部材料提供给 Agent，设置页只显示文本，不执行 HTML 或 Markdown 中的图片。工具正文仅保留在当前运行，后续请求清单记录来源 URL、标题、时间与正文 hash，不额外持久化整份检索正文。

适配参考 [OpenClaw 的普通搜索工具](https://github.com/openclaw/openclaw/blob/6693bb9665ced2a4fea3e286f62acfd0116e2c72/src/agents/tools/web-search.ts)：固定 HTTPS 服务端点、禁止 HTTP 重定向、30 秒总期限、1 MiB 响应／协议输出限制、取消传播和安全错误。Kimi 的工具重放最多三轮，共用一个期限。不复用 OpenClaw 插件宿主，不注入当前教学模型的原生搜索，不自动重试或缓存结果。

Codex 通过固定版本 `@openai/codex@0.160.0` 的 app-server 执行独立 hosted-search 任务，使用私有临时 HOME、最小环境和无本地执行环境的只读线程；禁用命令、文件修改、MCP、插件及额外 Agent，检查实际搜索完成后才接受回答，调用结束清理进程组及临时目录。这些是能力限制，不是完整操作系统隔离；当前不支持 Windows。协议和取消流程由离线 fixture 覆盖，并验证了真实二进制的初始化及受限线程创建；付费服务和真实 OAuth 搜索仍需用有效账号实测。

## 网页抓取

Agent 默认提供模型无关的 `web_fetch`，用于读取已知公开网址或进一步读取搜索结果。与 [OpenClaw 的网页抓取工具](https://github.com/openclaw/openclaw/blob/6693bb9665ced2a4fea3e286f62acfd0116e2c72/src/agents/tools/web-fetch.ts) 一样，直接抓取不需要搜索 API Key，不受 `web_search` 开关约束。参数为 `url`、`extractMode`（`markdown` 或 `text`，默认 Markdown）和 `maxChars`（100–20,000，默认 20,000，包含不可信内容边界标记）。本次没有新增设置项。

只执行 HTTP(S) GET，不传递模型凭据、应用凭据或 Cookie。HTML 使用 Readability 提取正文，失败时读取本地清理后的 HTML，保留代码块与安全来源链接；也支持 Markdown、纯文本及 JSON。返回原始／最终 URL、标题、状态、格式、时间、截断标记和有界正文。下载最多 750,000 字节，超过时只提取前缀并明确警告；最多 3 次重定向，每一跳重新验证地址。30 秒网络期限覆盖 DNS、连接、重定向与正文读取；停止 Agent 或关闭应用会取消请求，不返回取消后的成功结果。不执行 JavaScript、登录或 PDF 提取，不调用付费抓取服务，不自动重试、缓存或写入正文临时文件。

拒绝本机、内网、元数据、保留地址及 IPv6 转换／隧道地址；DNS 的全部结果均须通过校验，再固定到 Undici 连接的 lookup 中，避免连接时重新解析导致 DNS 重绑定。使用直接连接，不委托环境代理解析目标地址；依赖代理或 fake-IP 网络的部署可能无法抓取。网页及其元数据是不可信外部资料，不能改变 Agent 指令或确认规则；工具正文只用于当前运行，持久化沿用正文省略规则，仅在来源清单记录 URL、标题、时间与 hash。不要把私人资料或凭据放进 URL／查询参数。

## MCP 与 Skills

全屏设置提供真实 MCP / Skills 配置，切换类别或返回学习不会丢失编辑器、会话输入或终端连接。不自动加载其他应用的配置或安装 MCP 服务；Skill 安装由用户在设置中主动发起。

**MCP：**默认展示服务器列表，每行右侧开关直接保存启用状态，连接是否成功另行显示；仅在连接成功后显示工具数量。点击「添加 MCP Server」打开表单，选择本地进程（stdio）或远程地址（HTTP）；每行菜单可编辑、重连或删除该服务器，不重连其他服务器。弹窗也支持 JSON：粘贴单个服务器配置，或仅包含一个服务器的 `mcpServers` 配置；取消不会保存草稿。

支持本地 stdio 的 `command`、`args`、`cwd`、`env`，以及远程 Streamable HTTP 的 `url`、`headers`；`enabled: false` 不启动服务，`timeout` 的单位是秒，默认 60。表单中的启动参数每行一个，工作目录、环境变量和超时位于高级配置。相对 `cwd` 基于应用数据目录，不是源代码目录。`env` / `headers` 支持 `${变量名}`，从私有服务端环境查询；不执行 `!command`。命令是可执行程序名，不是 shell 命令串。

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "enabled": false
    }
  }
}
```

配置保存在数据目录的 `mcp.json`（600）。读取设置时隐藏 `env` / `headers` 中的字面值，保存未改动的掩码会保留原值，重命名也保留；认证信息应放在这些字段，不放进 URL 或命令参数。设置页显示连接状态、实际工具名称和描述；删除配置条目会关闭对应连接。修改或重连正在使用的服务器可能使该调用失败，不自动重放调用。

使用 `@earendil-works/pi-mcp@1.0.0` 的客户端、stdio / HTTP transport 和结果转换，将远端动态 JSON Schema 适配为现有 Agent 的原生工具，保留结构化结果、错误状态、取消和工具列表变更通知。工具使用稳定的独立名称，不覆盖教学工具；每次运行固定当时的工具集合，后续配置和工具列表更新供新运行使用。关闭应用会关闭连接并清理其拥有的 stdio 进程。单次取消会发送 MCP 取消通知，但不保证远端撤销已发生的操作。

**启用服务器即信任其工具可被 Agent 直接调用。**MCP 不受第一方文件/命令提案的逐次确认机制约束，可能发送学习资料或产生外部副作用；仅配置信任的服务。stdio 使用本机账号权限，继承基础环境及明确配置的 `env`，不直接继承整个服务端环境。当前接入 MCP 工具能力；不包含 legacy SSE、远端 OAuth 登录界面、MCP resources / prompts 管理或 codemode。

**Skills：**默认打开「已安装」列表，每行菜单提供详情、检查更新及卸载／移除，最右侧开关保存启用状态。「技能市场」无需搜索即可浏览 skills.sh 的 All Time（累计安装）、Trending（近 24 小时安装）和 Hot（近一小时安装及较昨日同小时的变化）榜单，保留上游排序，支持加载更多和全市场搜索。列表显示排名、技能／来源、安装量及安装状态；网络失败可重试，加载更多失败保留已加载条目。「从链接安装」和「导入本地目录」位于页面右上方，手机上换行排列。链接支持 skills.sh 具体技能页、HTTPS 仓库／发布网站或 `owner/repo`；来源包含多个技能时需指定名称。本地引用支持目录或单个 Markdown 文件的绝对路径，也支持 `~/`。详情可预览 `SKILL.md` 与支持文件，不要求用户操作 CLI。

使用固定的 `skills@1.7.0` 公开 CLI，以独立 cwd、HOME、XDG 与临时目录执行非交互 Pi/copy 安装，关闭遥测，不向获取进程传递模型凭据、SSH agent 或用户 Git 配置。CLI 在临时项目的 `.pi/skills/` 获取文件；应用校验后完整移入 `<TMC_DATA_DIR>/skills/`（默认 `~/.teach-me-coding/skills/`），不安装到其他 Agent 的目录。安装不执行包中的脚本或安装其依赖。网络来源用于公开仓库／下载，不提供私有 Git 登录流程；该进程仍使用本机权限，并非沙箱。

榜单中的网站来源按 HTTPS 发布地址获取，不误当成 GitHub 仓库。该版本 CLI 的 well-known 获取不支持 JSON 输出，因此只对网站发布源省略 `--json`；必须同时取得单个 Pi 技能目录及匹配的 `skills-lock.json` 来源记录，独立校验 CLI 文件摘要后才安装。保留发布包摘要和来源 URL，不把它们当成 Git 提交号。

应用安装的目录附带 `.tmc-install.json`，记录来源、请求的 ref、CLI 来源哈希及独立计算的文件内容／执行权限哈希。来源哈希不等于 Git 提交号，未解析 ref 时不声称固定了远端提交。检查更新只在临时目录获取和比较；确认更新后才替换整包，检测到本地修改时拒绝覆盖。启停状态在更新后保留；中断的目录替换在启动时恢复。卸载只删除应用管理的安装目录，本地引用的「移除」仅隐藏对应技能，保留原文件及同目录中的其他技能；再次添加路径可恢复引用。

默认扫描应用技能目录，额外路径按配置顺序加载，应用目录优先；同名冲突和无效 frontmatter 使用 Pi 的诊断。启停、路径及被移除的本地引用保存在 SQLite 的 `app_settings`。新安装默认启用，对后续 Agent 运行生效，不重启服务或向进行中的运行主动追加上下文。搜索使用官方 CLI 的匿名 `https://skills.sh/api/search`，榜单使用 `https://skills.sh/api/skills/{view}/{page}`，不要求 Vercel 登录；两者均为未版本化兼容接口，上游失败或格式改变会明确报错，不伪装为空结果或拿搜索结果替代榜单。榜单接口的 `total` 不代表 skills.sh 全站技能总量，页面不据此宣传市场规模。

复用 `@earendil-works/pi-coding-agent@1.0.0` 的 `loadSkills` / `formatSkillsForPrompt`，不创建 `AgentSession`、加载默认 coding tools 或改变现有 SQLite 会话格式。系统 XML 只增加 Skill 名称、描述和路径；模型匹配任务时通过原生 `read` 工具读取正文及参考文件。所有教学场景均可使用已启用的 Skills；每次运行重新发现文件，再固定本次元数据。`disable-model-invocation: true` 不进入自动发现提示，仍可用 `/skill:名称 你的请求` 显式调用；停用后不再广告或展开该命令，但它不是文件读取权限封锁。Skill 不改变场景任务、工具集合或原有执行确认规则。

实现依据：[Pi Skills 1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/skills.md)、[Skills CLI 1.7.0](https://github.com/vercel-labs/skills/tree/v1.7.0)、[Pi MCP 1.0.0](https://github.com/earendil-works/pi/tree/v1.0.0/packages/mcp)、[裸 Agent MCP 示例](https://github.com/earendil-works/pi/tree/v1.0.0/packages/agent/examples/mcp-codemode)。

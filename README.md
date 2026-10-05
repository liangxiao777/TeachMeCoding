# TeachMeCoding

本地单用户 AI 编程教学应用。默认入口已接入 SQLite 持久化、真实项目文件、教学 Agent、本机终端、用户确认后的文件修改与命令执行，以及基于真实执行证据的代码测评。学习流程为：创建空间 → 澄清并确认需求 → 生成路线 → 学习课件与编程实践 → 测评反馈与继续学习。

当前已完成 M1–M5，并集成到本地 `main`；M6 整体交付验收尚未开始。完整学习主流程、干净环境启动、备份恢复和最终回归仍需按 [ROADMAP](docs/ROADMAP.md) 验收，不能将已有专项验证视为整体交付完成。工程与 Agent 设计分别见[实施计划](docs/implementation-plan.md)和[上下文设计](docs/agent-context-design.md)。原型保留在 `.worktrees/prototype`，不作为正式启动入口；运行诊断页为 `/diagnostics`。

正式入口与 `/preview` 复用原型迁入的同一套页面和组件树；`AppModel` 分别连接真实持久化数据和隔离内存夹具，不维护另一套仿制页面。保留 Tailwind 样式、空间卡片、需求摘要、路线、会话菜单、项目树、课件、普通／全屏 IDE 和测评组件；正式入口提供手动保存、磁盘冲突处理、真实终端和能力不可用时的提示，不以模拟内容填补真实数据。

所有 Agent 会话及学习需求入口使用通过 shadcn 官方 registry 导入的 AI Elements：Conversation、Message、PromptInput、Reasoning、Tool 和 ChainOfThought。源码在 `apps/web/src/components/ai-elements`，配置在 `apps/web/components.json`；仅对新组件做 Base UI 组合、事件及状态适配，不覆盖已有基础组件。模型与传输仍使用 Pi 和现有 SSE，不使用 Vercel AI SDK 的 `useChat` 或服务端协议。流式 Markdown 支持表格、代码、数学公式；代码块保留「带入 IDE」，行内代码没有该操作。

正式生成页按真实事件区分分析、生成内容、校验和保存，保留 Agent 内容、工具状态、停止操作和真实失败反馈；不显示等待秒数、参数字符数、重连提示或装饰性骨架条。工具准备不等于已执行或产物已保存。SSE 静默断线后在后台通过持久事件游标恢复，不会自动重发模型请求。请求诊断清单记录响应 ID、HTTP 状态、接收事件数及时间、结束原因和错误指纹，不保留原始 Provider 错误正文或凭据。

Geist、Geist Mono 和中文 Noto Sans SC 后备字体通过固定版本 Fontsource 包随构建分发，中文优先使用原型已有的系统字体；Lucide 图标编入应用，站点图标随静态资源提供。不需要 Next.js，也不请求在线字体或 Analytics。

## 界面演示与开发夹具

显式访问 `/preview` 进入演示。开发和生产构建均可演示；底部会明确标注模拟状态。所有回复、课件、测评和终端结果均来自 `apps/web/src/fixtures`，仅在浏览器内存中运行，刷新重置；不会调用模型、写入项目文件或执行本机命令。原型控制台没有迁入默认入口，也不作为产品功能。演示数据不会迁入正式空间，正式 API 请求失败也不会回落到演示。

回归可直接访问 `/preview?scene=spaces`（两个空间）、`?scene=route`（Rust 路线）、`?scene=unit`（Rust 单元）；`&fault=reply` 或 `&fault=lesson` 让下一次模拟回复或课件生成失败。参数只在显式预览路径生效，不作为真实 API 失败后的回退。

## 本地运行

要求 Node **24.15.0（24 LTS）**、pnpm **11.1.0**。依赖版本通过清单和 `pnpm-lock.yaml` 固定。

在全屏「设置 → 模型配置」中选择 pi-ai 提供的 Provider、模型、推理强度及登录方式；保存的选择用于新运行，进行中的运行继续使用创建时的模型。API Key / OAuth 凭据只保存在服务端数据目录的 `credentials.json`（600），不返回浏览器。原有 `.env` 的 `OPENROUTER_API_KEY` 和 `OPENROUTER_MODEL=stealth/space-bunny-alpha` 可继续作为初始配置；服务端环境变量优先，保存模型选择后不再使用模型回退值。缺少配置时仍可查看数据和使用终端；设置页说明缺少哪项配置。实际模型检查见[模型兼容性检查](#模型兼容性检查)。

月亮／太阳按钮是全局主题入口，首页、空间列表、需求确认、路线规划、学习与测评、全屏 IDE 和设置页均可直接切换。首次使用跟随系统，手动选择后保存在当前浏览器，刷新后保留并在同源标签页间同步；不会改变模型配置或重新加载学习页面。

```sh
pnpm install --frozen-lockfile
pnpm dev          # 同时启动 127.0.0.1:5173 前端和 127.0.0.1:4310 API
pnpm check
pnpm build
pnpm test         # 需要先 build；含生产启动、正常重启和崩溃恢复检查
pnpm test:browser # 使用本机 Google Chrome；确保 14320、14321、15173 端口空闲
pnpm start        # 一个 Node 服务在 http://127.0.0.1:4310 提供 UI 和 API
```

`Ctrl+C` 停止服务。API 端口可通过 `PORT` 设置，开发前端可通过 `TMC_WEB_PORT` 设置；`pnpm dev` 将相同配置用于代理和本地访问白名单。编译产物可从任意工作目录用 `node /绝对路径/apps/server/dist/index.js` 启动，静态资源和默认数据目录不依赖当前目录。

## MCP 与 Skills

全屏设置提供真实 MCP / Skills 配置，切换类别或返回学习不会丢失编辑器、会话输入或终端连接。不自动加载其他应用的 MCP 配置，也不自动安装 MCP 服务或 Skill 包。

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

**Skills：**默认扫描 `<TMC_DATA_DIR>/skills/`（默认 `~/.teach-me-coding/skills/`），每个 Skill 放在包含 `SKILL.md` 的目录中。可在设置中添加已有目录或单个 Markdown 文件的绝对路径，也支持 `~/`，例如 `~/.pi/agent/skills` 和 `~/.agents/skills`。启停与额外路径保存在 SQLite 的 `app_settings`，不复制或改写原 Skill 文件。应用目录优先，额外路径按配置顺序加载；同名冲突和无效 frontmatter 显示 Pi 的诊断。

复用 `@earendil-works/pi-coding-agent@1.0.0` 的 `loadSkills` / `formatSkillsForPrompt`，不创建 `AgentSession`、加载默认 coding tools 或改变现有 SQLite 会话格式。系统 XML 只增加 Skill 名称、描述和路径；模型匹配任务时通过原生 `read` 工具读取正文及参考文件。所有教学场景均可使用已启用的 Skills；每次运行重新发现文件，再固定本次元数据。`disable-model-invocation: true` 不进入自动发现提示，仍可用 `/skill:名称 你的请求` 显式调用；停用后不再广告或展开该命令，但它不是文件读取权限封锁。Skill 不改变场景任务、工具集合或原有执行确认规则。

实现依据：[Pi Skills 1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/skills.md)、[Pi MCP 1.0.0](https://github.com/earendil-works/pi/tree/v1.0.0/packages/mcp)、[裸 Agent MCP 示例](https://github.com/earendil-works/pi/tree/v1.0.0/packages/agent/examples/mcp-codemode)。

## 网络访问

默认只监听 `127.0.0.1`。需要从可信网络访问时，在启动命令中设置 `HOST`（支持 `127.0.0.1` 或 `0.0.0.0`）：

```sh
HOST=0.0.0.0 PORT=5173 pnpm start # 先 pnpm build；单服务提供 UI 和 API
HOST=0.0.0.0 pnpm dev            # 前端 5173、API 4310 均监听所有 IPv4 接口
```

其他设备访问 `http://<运行机器的 IPv4 地址>:5173`，而不是 `0.0.0.0`。服务启动时把本机 IPv4 地址及对应端口加入 Host/Origin 白名单，保留令牌和跨站请求保护，不允许任意域名；网卡地址改变后需重启。网络模式回归可运行 `HOST=0.0.0.0 pnpm exec playwright test tests/browser/startup.spec.ts --workers=1`，使用独立测试数据，覆盖开发/生产实际 IP 访问、提交和重试。

**网络模式没有登录鉴权，也没有用户隔离。能连接端口的人可以读取和修改学习数据、调用模型、使用 Agent 文件读取能力、操作本机终端、确认执行提案及运行测评代码；请求令牌只防跨站请求，不是登录密码。仅用于可信网络，不要将端口暴露到公网。**终端、确认后的命令及测评代码均使用服务账号的本机权限，不是沙箱；确认界面不构成用户身份鉴权。这里不提供公网部署或任意反向代理配置。

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

## 本机终端与确认执行

正式工作台的普通／全屏 IDE 使用 xterm 和真实 PTY，打开 IDE 时自动连接当前空间的项目目录。终端按空间复用，浏览器刷新或断线重连不会重放输入，也不会仅因连接断开而结束 shell；终端退出后可显式新建。停止终端或关闭服务会清理应用管理的进程，服务重启不恢复旧 shell 或自动执行历史命令。刻意脱离进程树的守护进程不保证被清理。

终端执行磁盘中的文件。当前空间有未保存文件时，界面暂停终端输入并提供「保存全部文件」，Ctrl+C 和停止仍可使用；被阻止的输入不会缓存或自动重放。保存冲突需先处理，终端修改或生成的文件可通过「刷新目录」发现；刷新保留未保存编辑。终端输出可以选中后引用到会话。

辅导 Agent 的 `propose_file_change`、`propose_command` 只生成提案。模型成功结束后，界面展示待确认卡片，包含目标路径、完整修改前后内容，或命令与工作目录；用户确认后才执行。提案 30 分钟后失效，确认时校验提案摘要和文件／项目版本；编辑器有未保存文件时不能确认。同一空间的确认操作互斥，拒绝、过期、重复确认及服务重启均不会重新执行；结果保存在原会话，供后续辅导读取。

确认后的命令最多运行 30 秒、收集 256 KiB 输出，交互式终端不使用这一命令时限。shell 不加载用户启动脚本，子进程只继承白名单环境变量，不直接继承服务端模型凭据；这不阻止程序按本机权限读取文件。缺少工具链时显示实际错误，应用不会自动安装。停止或取消不回滚已经产生的文件修改或其他副作用。

## 真实代码测评

代码题带有版本化执行方案，定义语言、命令行参数和预期标准输出。当前支持 Python、JavaScript、TypeScript、Rust 和 Bash，分别使用本机的 `python3`、`node`、`rustc` 或 `/bin/bash`，依赖已有工具链。界面显示执行命令与预期输出；点击「运行」或「提交测评」会执行当次固定的代码快照，每个用例使用一次性目录，不依赖空间项目文件。整次执行共用 30 秒和 256 KiB 输出限制；临时目录不是沙箱。

执行记录保存代码、题目版本、命令、输出、退出状态和预期匹配结果。提交测评时，评估绑定该次不可变答案、私有评分标准版本及对应的真实执行证据；单独试运行的记录不代替提交时的证据。运行与评估期间可以继续编辑新草稿，新内容不会覆盖已提交答案。

只有全部用例完成、标准输出匹配预期且模型评估通过，代码题才可能判为通过；输出不符判为需加强。缺少工具链、报错、超时、取消或缺少执行证据时，代码题不会判为通过，页面提供对应原因和下一步建议。纯分析题使用非执行评分。旧代码题缺少执行方案、或旧题目缺少私有评分标准时，需要重新出题。当前检查覆盖题目列出的用例，不代表任意输入都正确。

## 数据目录与恢复

默认数据根目录为 `~/.teach-me-coding/`，独立于源码。也可显式选择另一个绝对路径：

```sh
TMC_DATA_DIR="$HOME/teach-me-coding-dev" pnpm dev
# 生产启动使用同一配置方式；同一目录不能同时启动开发和生产实例。
TMC_DATA_DIR="$HOME/teach-me-coding-data" pnpm start
```

- `app.db`：共享 SQLite 数据库，按空间保存需求、路线、单元、课件、会话、消息/引用、测评草稿与固定提交、评估结果、Agent 运行事件、文件／命令提案及代码执行记录。
- `projects/<space-id>/`：真实项目目录；项目源码以磁盘文件为准，数据库不保存编辑器工作副本。消息引用、已发布文件提案和测评提交中的代码是对应操作的固定快照，不与项目文件自动同步。
- `app.lock`：实例锁文件；服务退出或崩溃后锁自动释放。**不要为启动第二个实例而删除或替换它**。SQLite 的 `-wal`、`-shm` 等文件由数据库管理。

会话中尚未发送的文字、引用和路线调整想法只保留在当前页面内存中，不自动保存，也没有手动保存按钮。页面内切换空间、单元和会话会保留各自输入；刷新或重新打开页面后输入框为空，也不恢复旧版本已保存的会话草稿。发送成功的消息及 Agent 回复自动持久化；发送失败或迟到的响应不会清空后来编辑的新内容。

需求修改、测评答案草稿和文件仍需手动保存；这些内容有未保存状态和离开页面警告。提交测评只保存该次作答，不清空后来编辑的新答案。刷新/重启恢复已保存的业务内容，正式空间不会用演示内容填补模型失败。

项目 API 仅访问应用管理的目录，支持多层目录、读取、创建、重命名和保存，不提供删除或任意外部目录接入。编辑器支持最大 1 MB 的 UTF-8 文本；路径穿越、符号链接、硬链接和非普通文件会被拒绝。外部改动可用「刷新目录」和「读取磁盘版本」发现；保存遇到版本冲突时保留编辑内容，用户比较后显式选择基线或磁盘内容。重命名前需保存受影响的编辑。路径检查不是针对同权限恶意进程竞态的沙箱。

空目录首次启动时初始化数据库；后续启动按版本事务迁移。迁移失败、高于当前程序的数据库版本或打不开数据库时，服务退出并提示，不删除数据重建。重复启动同一数据目录会被拒绝；应停止原实例或选择独立目录。重启时未完成的 Agent 任务、运行、命令操作和代码执行标记为中断，待确认提案失效，不自动调用模型、恢复 shell 或重放操作。切页或断开事件订阅不会取消后台运行；主动停止才取消，停止不代表回滚已有副作用。

不要在服务运行时只复制 `app.db` 或修改数据库文件。需要保留数据时先正常停止服务，再复制整个数据根目录，连同项目文件及可能存在的 SQLite 辅助文件一起保存；保留原目录，勿用空目录覆盖。更换源码或重新构建不会迁移内存演示数据，也不应替换数据目录。完整备份恢复验收仍属于后续整体交付。

## 界面回归

`pnpm test` 包含会话归属、事务/幂等写入、项目路径边界、迁移故障、重复启动和真实进程恢复测试；进程集成测试使用 14310、14340、14341 端口及可丢弃目录。`pnpm check` 同时检查浏览器测试及截图脚本的类型。`pnpm test:browser --workers=1` 在开发代理和生产单服务两种模式验证交互与截图，保留原有访问保护检查，不复用已运行的用户服务。正式持久化检查由 `tests/serve-browser.ts` 创建并清理临时数据目录，内部业务入口写入明确标注的验收课件和路线；`/preview` 回归仍使用内存夹具。不需要模型密钥，不读写已有学习数据。

本机执行专项使用真实 PTY 和可丢弃文件；Agent 回复使用确定性测试 Provider，不调用收费模型。先执行 `pnpm build`，再分别运行以下命令（两组共用测试端口，不能同时运行）：

```sh
pnpm test:browser tests/browser/execution.spec.ts --workers=1
pnpm exec playwright test -c tests/agents.config.ts --workers=1 -g 'local proposals|real code assessment'
```

第一组覆盖终端连接、重连、退出和保存一致性；第二组覆盖提案确认、冲突与取消，以及真实代码运行、测评证据和新草稿保留。命令默认验证开发和生产两种模式。真实 Provider 评分的既有验证及平台限制记录在 [ROADMAP](docs/ROADMAP.md)，不以确定性回复代替真实模型文案质量验收。

视觉场景固定为 1440×1000、浅色系统主题、减少动画、确定日期；全屏 IDE 自身仍为深色。12 个状态覆盖首页、空间列表、需求确认、路线与 Agent、普通/全屏 IDE、课件抽屉、测评作答、通过/需加强及课件/回复失败。两种服务模式共用 `tests/browser/__screenshots__/darwin` 中的基线；当前仅在 macOS arm64、本机 Google Chrome 验证，浏览器或系统字体变化需要重新检查，不能直接认定为产品回归。

原型仍在本机运行时，可执行 `pnpm exec tsx tests/capture-prototype.ts`（默认 3000 端口，可用 `PROTOTYPE_URL` 指定本机地址）。脚本与 Vite 测试共用 `tests/visual-scenes.ts` 操作序列，只隐藏 Next 开发浮层和原型控制按钮；不修改参考源码，不掩盖业务内容。原型截图保存到 `.amp/in/artifacts/reference/`，浏览器失败截图和差异图保存到 `.amp/in/artifacts/browser/`。首次在新 checkout 运行前，用 `git rev-parse --git-path info/exclude` 找到本地排除文件，保留已有规则并加入 `/.amp/in/`，避免提交评审临时文件。

组件迁移另用 `pnpm exec tsx tests/compare-components.ts <未修改参考版本的 apps/web 目录> <当前 Vite 地址>` 对照。参考目录须包含同版本依赖和 contracts，并可独立启动；脚本占用 15174，结束后关闭参考服务。它在相同输入下检查 15 个状态（上述 12 个状态另加需求编辑、会话菜单、独立路线规划页），逐组件比较 DOM、类名、文本、图标和计算样式；只忽略新增的「切换会话」无障碍标签。规划页冻结原型时钟后单独验收，不能只检查最终路线页。截图和签名保存在 `.amp/in/artifacts/component-parity/`。该检查验证展示组件没有偏移，不能替代正式入口的真实 API、保存、重试、刷新和文件冲突测试，两类检查必须分别通过。

Base UI 仍固定为 1.5.0。其 React 19 生产模式存在菜单可见但 `aria-expanded=false` 的[已知问题 #4956](https://github.com/mui/base-ui/issues/4956)；`patches/@base-ui__utils@0.2.9.patch` 仅回移[上游 #4866 的 store selector 修复](https://github.com/mui/base-ui/pull/4866)，通过 pnpm 自动应用，不升级组件或修改样式。浏览器回归检查异步保存期间新建会话、菜单重新打开时的无障碍状态及 Escape 关闭。将来升级包含该修复的版本时，应删除补丁并重跑这些检查。

有意调整视觉后，先运行 `pnpm test:browser tests/browser/visual.spec.ts --project=production --update-snapshots`，**实际打开基线并与原型/旧截图对照**，再运行不带更新参数的 `pnpm test:browser`。不能用自动更新截图来掩盖失败。最初迁移允许的差异为本地字体替换和独立 24px 夹具页脚；随后用户授权用 AI Elements 替换会话、输入和思考/执行过程展示，这些区域不再与旧原型逐像素相同。其他布局及课件抽屉的左侧深色样式仍保留。截图不证明真实教学或执行已接通。

## 原生依赖检查

`pnpm test:native` 使用系统临时目录验证 SQLite 写入后关闭复开，以及 PTY 输入、输出、非零退出码和强制关闭后的 PID 消失；测试后删除数据。不读写已有学习数据库。

已实际验证 **macOS 26.6.2 / arm64、Node 24.15.0、better-sqlite3 13.0.3、node-pty 1.1.0**。未验证 Linux、Windows 或 Intel Mac，不据此宣称支持。

本机安装使用 Python 3.14.6、Xcode Command Line Tools、Apple clang 21.0.0。原生构建需要 Python、C/C++ 编译器和 make；缺失时由用户安装工具链，应用不会自动安装或申请管理员权限。

`node-pty 1.1.0` 的 macOS 预编译 helper 缺少执行位（[上游问题 #850](https://github.com/microsoft/node-pty/issues/850)）。仓库通过 `patches/node-pty@1.1.0.patch` 在 macOS 固定走包自身的源码编译分支，随 `pnpm install --frozen-lockfile` 自动应用，不手工修改已安装文件。这样也避免 pnpm 11 过滤 `npm_config_*` 导致强制源码编译变量失效。`pnpm-workspace.yaml` 显式允许所需构建脚本；安装成功后仍须运行原生检查。

## 模型兼容性检查

Pi Core 与 AI 包固定为 `@earendil-works/pi-agent-core@1.0.0`、`@earendil-works/pi-ai@1.0.0`，不加载 Pi Extension 宿主。`pnpm test` 的模型部分使用确定性流，不访问 Provider。

真实测试使用 `pnpm test:provider`，会发送两次短请求（正常流式响应、收到文字后取消），可能产生 Provider 费用。在根目录 `.env` 配置 `OPENROUTER_API_KEY` 与准确的 `OPENROUTER_MODEL`；没有 `.env` 时可参考 `.env.example` 新建，权限设为 `600`，不要覆盖已有配置或把密钥写进命令行。服务端环境变量优先于文件；缺失配置或 Provider 错误会返回失败，不切换模型。`.env` 路径相对代码定位，不依赖启动目录；读取不会把凭据注入全局环境或终端子进程。

当前教学模型为用户确认的 `stealth/space-bunny-alpha`，推理为 `high`。应用不设置输入或输出 token 上限，不估算输入 token、不按长度裁剪上下文，也不累计输出 token 来终止运行。兼容性冒烟和教学运行共用 Pi 的 Provider-native `stream`，不使用会估算上下文并填入默认输出上限的 `streamSimple`；实际 OpenRouter 请求不含 `max_tokens` 或 `max_completion_tokens`。模型能力元数据仅用于描述，Provider 自身的上下文窗口、输出限制仍存在。逐个构建路线不再受原先 6 个请求/12 次工具调用的限制；保留主动停止和每运行 300 秒超时。高推理可能增加延迟和费用；Provider 错误或明确的 `length` 截断仍返回失败。请求清单保留实际 usage、原始结束原因和传输诊断。

教学确定性测试使用 `pnpm exec playwright test -c tests/agents.config.ts --project=production --workers=1`（开发模式换为 `development`），需先构建，占用与普通浏览器测试相同端口，不同时运行。该套件包含真实本机执行与提案确认场景，模型回复仍为确定性流。`pnpm exec tsx tests/teaching-provider-smoke.ts` 是显式收费真实模型检查：只使用可丢弃数据库和合成文件，串联需求→路线→课件→只读辅导→出题→评估；不上传用户项目，不执行提交的代码，因此不能替代真实执行验收。Provider 失败会使脚本失败；真实和确定性结果见 [ROADMAP](docs/ROADMAP.md)，不保证模型每次输出相同。

## 教学上下文与留存

系统指令及应用控制的上下文使用独立 XML 资源；Pi 原生消息与工具协议不改成 XML。SQLite 保留业务记录、消息及每请求来源/版本/hash、选择和预算清单，不引入 coding-agent 的 JSONL SessionManager。新会话仅自动共享同空间已确认需求、有效测评和用户采纳的有效结论，不继承所有旧聊天。需求、路线、课件来源变化会使相关证据失效；结论可撤销采纳。

辅导 Agent 提供 `read/ls/find/grep` 读取工具，以及 `propose_file_change`、`propose_command` 提案工具；文件修改和命令执行遵循上文的用户确认流程，模型不能直接执行提案。**读取无需逐次授权，没有敏感文件名过滤或项目围栏；cwd 不是沙箱。**绝对路径、父目录、home 和链接目标按服务账号 OS 权限访问。因此 Agent 可能读取凭据等私人文件并将其发送给 Provider；XML/提示词不是安全边界。浏览器项目文件 API 和文件修改提案仍使用应用管理的项目边界，命令执行使用本机权限。服务端配置不会主动加入上下文或日志。

默认保留用户主动消息、引用、可展示模型回复和合法产物；自动读取的 toolResult 正文仅用于当前运行，持久化时省略正文、保留调用/结果关系及 hash，不因自动读取额外永久复制源码。已发布文件提案的修改前后内容、确认操作结果、测评固定提交及代码执行证据会持久化。模型可能在可展示回复中引用材料；该策略不是内容防泄漏器。仅凭清单和 hash 不能逐字重放历史请求。公开题目与私有 rubric 分离，后者不进入浏览器 API、任务文字事件或 tutor 默认上下文；自主 OS 读取不构成数据库隔离。

真实推理、正文、工具状态和公开调用参数按模型轮次/内容段/调用 ID 保存为有序事件，刷新或重连不会重复追加。展开工具显示模型传入的 JSON，包括失败参数；生成中的参数按增量展示，停止后保留已收到部分。旧事件不含参数时不从私有消息补写。Pi 原生 thinking/signature 留在内部消息中供后续请求使用，浏览器不接收签名或被 Provider 隐去的内容。出题/评分不发送推理正文，工具参数仅公开题目字段和面向学生的评估字段，私有 rubric 不进入事件。规划和课件页的正式执行进度由真实事件推进，定时演示仅存在于 `/preview`。

路线工具按阶段/单元拆分：`add_route_stage`、`add_route_unit` 添加内容并返回服务端生成的 ID；`update_route_stage`、`update_route_unit` 调整内容和顺序；`remove_route_unit` 仅撤销本轮新单元，`remove_route_stage` 仅移除空阶段。最后调用 `submit_route_proposal({note})` 校验和提交组装后的路线，不再传整份路线或生成 UUID。所有编辑暂存于本轮；后续编辑使提交失效，必须重新提交。运行正常结束并通过版本校验才保存，首次路线自动应用，调整仍待用户确认。模型可根据工具错误修正参数，单次错误不会永久锁死后续有效提交。

必要时显式设置 `TMC_AGENT_DEBUG_SNAPSHOTS=1`，服务会在所选数据目录的 `agent-debug/` 写入完整请求快照（新目录 700、文件 600）。**快照可能含源码、路径、引用和私有评分标准**；不要提交、上传或公开它们。取消该环境变量并重启即停止新增；停止服务后，可检查并删除该目录中的快照文件，不要删除 `app.db` 或项目文件。关闭快照不自动删除已有文件。

评估绑定不可变提交、题目/rubric 版本及证据；重试原任务不会增加提交尝试或评估新草稿。真实执行证据必须与提交、代码摘要、题目版本和执行方案匹配；完成运行的代码题标记为 `execution-verified`，是否通过还取决于输出匹配和模型评估。执行未完成或失败、仅有静态反馈或模拟执行夹具时，代码题结果为 `unverified`；纯分析题可产生有效的 `non-execution` 评分。需求、路线或课件变化后，旧记录保留为历史，其有效性按来源版本判定。

## 本地接口访问边界

Node 服务默认监听 `127.0.0.1`，可显式通过 `HOST=0.0.0.0` 开启可信网络访问。Host/Origin 白名单包含 `localhost`、`127.0.0.1`，网络模式下额外包含启动时本机网卡的 IPv4 地址；生产模式允许配置的服务端口，开发模式额外允许前端端口（默认 5173，可用 `TMC_WEB_PORT` 调整）。API 端口通过 `PORT` 配置，Vite 保留原始 Host/Origin 代理 HTTP 与 WebSocket 升级请求。`pnpm dev` 显式启用开发模式，`pnpm start` 强制生产模式；不开放 CORS，不信任转发头，默认不接受额外代理来源；内置预览仅可通过上述显式配置增加准确的本机来源，不接受任意域名。可信网络访问仍是同一单用户实例，具有上文所述权限。

除健康检查和令牌初始化外，所有 `/api` 请求需要 `X-TMC-Token`。本机页面用 `X-TMC-Client: browser` 请求 `GET /api/access`，在内存中保存响应令牌，然后携带令牌请求 API；当前 `POST /api/access/check` 只返回 `{ "ok": true }`，无业务副作用。初始化端点同样校验 Host/Origin 和 Fetch Metadata，跨域预检被拒绝；同源 GET 缺少 Origin 是浏览器正常行为，允许通过。令牌每次服务启动随机生成，不写入文件、日志、URL 或浏览器持久存储，API 响应禁止缓存。

`/api/terminal/socket?space=<space-id>` 提供真实终端 WebSocket 连接，要求合法 Host、明确 Origin，以及子协议 `tmc-terminal` 和 `tmc-token.<请求令牌>`；令牌不接受查询参数传递。通过访问检查并验证空间存在后，创建或连接该空间的 PTY，支持输入、输出、尺寸调整、停止和新建终端。访问检查失败返回 401/403，无效空间返回 400；连接断开不会重放输入或自动结束 shell。

这些措施用于防止外部网页滥用本地接口，不是登录系统，也不能防御拥有本机权限的恶意进程、同源脚本攻击或把本机执行变成沙箱。模型密钥只能配置在服务端，不要放入 `VITE_*` 变量。测试覆盖同源访问、开发代理、非法 Host/Origin、缺失及错误令牌、实际升级请求，以及 Vite/生产静态资源不能读取根 `.env`。

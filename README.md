# TeachMeCoding

本地单用户教学应用。默认入口已接入持久化、真实项目文件及教学 Agent：需求整理、路线提案、课程辅导、课件、出题和固定提交评估。实际终端与代码执行尚未接入；代码题只能静态反馈，不能算运行通过。原型保留在 `.worktrees/prototype`，不作为正式启动入口。运行环境检查页保留在 `/diagnostics`，不把服务健康检查视为教学 Agent 接通。

正式入口与 `/preview` 复用原型迁入的同一套页面和组件树；`AppModel` 分别连接真实持久化数据和隔离内存夹具，不维护另一套仿制页面。保留 Tailwind 样式、空间卡片、需求摘要、路线、会话菜单、项目树、课件、普通／全屏 IDE 和测评组件；正式入口增加手动保存、磁盘冲突处理和未接通能力提示，不以模拟内容填补真实数据。

所有 Agent 会话及学习需求入口使用通过 shadcn 官方 registry 导入的 AI Elements：Conversation、Message、PromptInput、Reasoning、Tool 和 ChainOfThought。源码在 `apps/web/src/components/ai-elements`，配置在 `apps/web/components.json`；仅对新组件做 Base UI 组合、事件及状态适配，不覆盖已有基础组件。模型与传输仍使用 Pi 和现有 SSE，不使用 Vercel AI SDK 的 `useChat` 或服务端协议。流式 Markdown 支持表格、代码、数学公式；代码块保留「带入 IDE」，行内代码没有该操作。

Geist、Geist Mono 和中文 Noto Sans SC 后备字体通过固定版本 Fontsource 包随构建分发，中文优先使用原型已有的系统字体；Lucide 图标编入应用，站点图标随静态资源提供。不需要 Next.js，也不请求在线字体或 Analytics。

## 界面演示与开发夹具

显式访问 `/preview` 进入演示。开发和生产构建均可演示；底部会明确标注模拟状态。所有回复、课件、测评和终端结果均来自 `apps/web/src/fixtures`，仅在浏览器内存中运行，刷新重置；不会调用模型、写入项目文件或执行本机命令。原型控制台没有迁入默认入口，也不作为产品功能。演示数据不会迁入正式空间，正式 API 请求失败也不会回落到演示。

回归可直接访问 `/preview?scene=spaces`（两个空间）、`?scene=route`（Rust 路线）、`?scene=unit`（Rust 单元）；`&fault=reply` 或 `&fault=lesson` 让下一次模拟回复或课件生成失败。参数只在显式预览路径生效，不作为真实 API 失败后的回退。

## 本地运行

要求 Node **24.15.0（24 LTS）**、pnpm **11.1.0**。依赖版本通过清单和 `pnpm-lock.yaml` 固定。

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

默认只监听 `127.0.0.1`。需要从可信网络访问时，在启动命令中设置 `HOST`（支持 `127.0.0.1` 或 `0.0.0.0`）：

```sh
HOST=0.0.0.0 PORT=5173 pnpm start # 先 pnpm build；单服务提供 UI 和 API
HOST=0.0.0.0 pnpm dev            # 前端 5173、API 4310 均监听所有 IPv4 接口
```

其他设备访问 `http://<运行机器的 IPv4 地址>:5173`，而不是 `0.0.0.0`。服务启动时把本机 IPv4 地址及对应端口加入 Host/Origin 白名单，保留令牌和跨站请求保护，不允许任意域名；网卡地址改变后需重启。网络模式回归可运行 `HOST=0.0.0.0 pnpm exec playwright test tests/browser/startup.spec.ts --workers=1`，使用独立测试数据，覆盖开发/生产实际 IP 访问、提交和重试。

**网络模式没有登录鉴权，也没有用户隔离。能连接端口的人可以读取和修改学习数据、使用模型及 Agent 文件读取能力；请求令牌只防跨站请求，不是登录密码。仅用于可信网络，不要将端口暴露到公网。**未来的代码执行直接使用本机权限，不是沙箱。当前不开放命令执行接口；这里不提供公网部署或反向代理配置。

## 数据目录与恢复

默认数据根目录为 `~/.teach-me-coding/`，独立于源码。也可显式选择另一个绝对路径：

```sh
TMC_DATA_DIR="$HOME/teach-me-coding-dev" pnpm dev
# 生产启动使用同一配置方式；同一目录不能同时启动开发和生产实例。
TMC_DATA_DIR="$HOME/teach-me-coding-data" pnpm start
```

- `app.db`：共享 SQLite 数据库，按空间保存需求、路线、单元、课件、会话、消息/引用、测评草稿/记录、提案及任务状态。
- `projects/<space-id>/`：真实项目目录；源码只存磁盘文件，数据库不存另一份编辑器副本。会话中的代码引用是用户保存的引用快照，不是文件同步。
- `app.lock`：实例锁文件；服务退出或崩溃后锁自动释放。**不要为启动第二个实例而删除或替换它**。SQLite 的 `-wal`、`-shm` 等文件由数据库管理。

会话中尚未发送的文字、引用和路线调整想法只保留在当前页面内存中，不自动保存，也没有手动保存按钮。页面内切换空间、单元和会话会保留各自输入；刷新或重新打开页面后输入框为空，也不恢复旧版本已保存的会话草稿。发送成功的消息及 Agent 回复自动持久化；发送失败或迟到的响应不会清空后来编辑的新内容。

需求修改、测评答案草稿和文件仍需手动保存；这些内容有未保存状态和离开页面警告。提交测评只保存该次作答，不清空后来编辑的新答案。刷新/重启恢复已保存的业务内容，正式空间不会用演示内容填补模型失败。

项目 API 仅访问应用管理的目录，支持多层目录、读取、创建、重命名和保存，不提供删除或任意外部目录接入。编辑器支持最大 1 MB 的 UTF-8 文本；路径穿越、符号链接、硬链接和非普通文件会被拒绝。外部改动可用「刷新目录」和「读取磁盘版本」发现；保存遇到版本冲突时保留编辑内容，用户比较后显式选择基线或磁盘内容。重命名前需保存受影响的编辑。路径检查不是针对同权限恶意进程竞态的沙箱。

空目录首次启动时初始化数据库；后续启动按版本事务迁移。迁移失败、高于当前程序的数据库版本或打不开数据库时，服务退出并提示，不删除数据重建。重复启动同一数据目录会被拒绝；应停止原实例或选择独立目录。重启时已保存的未完成任务/运行标记为中断，不自动重新调用模型或重放操作。切页或断开事件订阅不会取消后台运行；主动停止才取消。

不要在服务运行时只复制 `app.db` 或修改数据库文件。需要保留数据时先正常停止服务，再复制整个数据根目录，连同项目文件及可能存在的 SQLite 辅助文件一起保存；保留原目录，勿用空目录覆盖。更换源码或重新构建不会迁移内存演示数据，也不应替换数据目录。完整备份恢复验收仍属于后续整体交付。

## 界面回归

`pnpm test` 包含会话归属、事务/幂等写入、项目路径边界、迁移故障、重复启动和真实进程恢复测试；进程集成测试使用 14310、14340、14341 端口及可丢弃目录。`pnpm check` 同时检查浏览器测试及截图脚本的类型。`pnpm test:browser --workers=1` 在开发代理和生产单服务两种模式验证交互与截图，保留原有访问保护检查，不复用已运行的用户服务。正式持久化检查由 `tests/serve-browser.ts` 创建并清理临时数据目录，内部业务入口写入明确标注的验收课件和路线；`/preview` 回归仍使用内存夹具。不需要模型密钥，不读写已有学习数据。

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

兼容性冒烟使用 256 输出 token 上限和 8192 测试上下文元数据。教学运行独立使用 `deepseek/deepseek-v4.1-flash` 的能力元数据，开启 `high` 推理；测试检查实际发出的 OpenRouter 参数。应用不设置输入上下文大小上限，不估算输入 token，也不因长度裁剪同会话历史、当前问题、引用或工具调用/结果；模型自身的上下文窗口仍由 Provider 限制。每请求输出上限 4096（包含推理）；每次运行最多 6 个请求、12 次顺序工具调用、12288 输出 token 和 300 秒。高推理可能增加延迟和费用；这些运行限制、Provider 错误或 `length` 截断仍返回失败。请求清单保留实际 usage 和运行限制，不记录输入预算估算。

教学确定性测试使用 `pnpm exec playwright test -c tests/agents.config.ts --project=production --workers=1`（开发模式换为 `development`），需先构建，占用与普通浏览器测试相同端口，不同时运行。`pnpm exec tsx tests/teaching-provider-smoke.ts` 是显式收费真实模型检查：只使用可丢弃数据库和合成文件，串联需求→路线→课件→只读辅导→出题→评估；不上传用户项目，不执行提交的代码。Provider 失败会使脚本失败；真实和确定性结果见 ROADMAP，不保证模型每次输出相同。

## 教学上下文与留存

系统指令及应用控制的上下文使用独立 XML 资源；Pi 原生消息与工具协议不改成 XML。SQLite 保留业务记录、消息及每请求来源/版本/hash、选择和预算清单，不引入 coding-agent 的 JSONL SessionManager。新会话仅自动共享同空间已确认需求、有效测评和用户采纳的有效结论，不继承所有旧聊天。需求、路线、课件来源变化会使相关证据失效；结论可撤销采纳。

辅导 Agent 提供 `read/ls/find/grep`，没有 write/edit/bash 或命令执行工具。**读取无需逐次授权，没有敏感文件名过滤或项目围栏；cwd 不是沙箱。**绝对路径、父目录、home 和链接目标按服务账号 OS 权限访问。因此 Agent 可能读取凭据等私人文件并将其发送给 Provider；XML/提示词不是安全边界。浏览器项目文件 API 仍使用上文的项目边界。服务端配置不会主动加入上下文或日志。

默认保留用户主动消息、引用、可展示模型回复和合法产物；自动读取的 toolResult 正文仅用于当前运行，持久化时省略正文、保留调用/结果关系及 hash，不额外永久复制源码。模型可能在可展示回复中引用材料；该策略不是内容防泄漏器。仅凭清单和 hash 不能逐字重放历史请求。公开题目与私有 rubric 分离，后者不进入浏览器 API、任务文字事件或 tutor 默认上下文；自主 OS 读取不构成数据库隔离。

真实推理、正文和工具状态按模型轮次/内容段/调用 ID 保存为有序事件，刷新或重连不会重复追加；停止会保留已返回的内容并标记未完成步骤。Pi 原生 thinking/signature 留在内部消息中供后续请求使用，浏览器仅接收可展示推理文字，不接收签名或被 Provider 隐去的内容。出题/评分任务会接触私有答案，故仅展示推理阶段与工具状态，不发送推理正文。规划和课件页的正式执行进度由真实事件推进，定时演示仅存在于 `/preview`。

必要时显式设置 `TMC_AGENT_DEBUG_SNAPSHOTS=1`，服务会在所选数据目录的 `agent-debug/` 写入完整请求快照（新目录 700、文件 600）。**快照可能含源码、路径、引用和私有评分标准**；不要提交、上传或公开它们。取消该环境变量并重启即停止新增；停止服务后，可检查并删除该目录中的快照文件，不要删除 `app.db` 或项目文件。关闭快照不自动删除已有文件。

评估绑定不可变提交、题目/rubric 版本及证据；重试原任务不会增加提交尝试或评估新草稿。失败没有通过记录，代码题（包括执行夹具）统一标为未验证；纯分析题可产生有效非执行评分。旧题目没有私有 rubric 时需重新出题。真实代码测评与 Agent 有副作用工具仍等待后续获批实施。

## 本地接口访问边界

Node 服务固定监听 `127.0.0.1`，不能用 `HOST` 改成公开监听。生产模式只接受配置端口上的 `localhost`、`127.0.0.1` Host 与 HTTP Origin；开发模式额外允许同样主机的前端端口（默认 5173，可用 `TMC_WEB_PORT` 调整），Vite 保留原始 Host/Origin 代理 HTTP 与升级请求。开发 API 端口同样可用环境变量 `PORT` 调整。`pnpm dev` 显式启用开发模式，`pnpm start` 强制生产模式；不开放 CORS，不信任转发头，也不支持任意反向代理或跨设备访问。

除健康检查和令牌初始化外，所有 `/api` 请求需要 `X-TMC-Token`。本机页面用 `X-TMC-Client: browser` 请求 `GET /api/access`，在内存中保存响应令牌，然后携带令牌请求 API；当前 `POST /api/access/check` 只返回 `{ "ok": true }`，无业务副作用。初始化端点同样校验 Host/Origin 和 Fetch Metadata，跨域预检被拒绝；同源 GET 缺少 Origin 是浏览器正常行为，允许通过。令牌每次服务启动随机生成，不写入文件、日志、URL 或浏览器持久存储，API 响应禁止缓存。

`/api/terminal/socket` 只实现升级访问检查：要求合法 Host、明确 Origin，以及 WebSocket 子协议 `tmc-terminal` 和 `tmc-token.<请求令牌>`；不接受查询参数代替令牌。拒绝请求返回 401/403，合法请求目前返回 501，不创建 WebSocket 会话或 PTY。真实终端接入属于后续里程碑。

这些措施用于防止外部网页滥用本地接口，不是登录系统，也不能防御拥有本机权限的恶意进程、同源脚本攻击或把本机执行变成沙箱。模型密钥只能配置在服务端，不要放入 `VITE_*` 变量。测试覆盖同源访问、开发代理、非法 Host/Origin、缺失及错误令牌、实际升级请求，以及 Vite/生产静态资源不能读取根 `.env`。

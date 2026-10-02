# TeachMeCoding

本地单用户教学应用。默认入口已接入空间、需求、会话、学习记录和真实项目文件的持久化；教学 Agent、出题评估与实际终端尚未接入。原型保留在 `.worktrees/prototype`，不作为正式启动入口。运行环境检查页保留在 `/diagnostics`，不把服务健康检查视为教学 Agent 接通。

正式入口与 `/preview` 复用原型迁入的同一套页面和组件树；`AppModel` 分别连接真实持久化数据和隔离内存夹具，不维护另一套仿制页面。保留 Tailwind 样式、空间卡片、需求摘要、路线、会话菜单、项目树、课件、普通／全屏 IDE 和测评组件；正式入口增加手动保存、磁盘冲突处理和未接通能力提示，不以模拟内容填补真实数据。

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

未来的代码执行直接使用本机权限，不是沙箱。当前开放受保护的业务与项目文件接口，不开放 Agent 生成或命令执行接口，也不提供远程部署模式。

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

需求、会话草稿、测评草稿和文件均需手动保存；页面明确区分未保存、保存中和失败。刷新/重启恢复的是已保存内容，不承诺恢复尚未保存的输入。页面内切换空间、单元、历史会话或关闭编辑器标签会保留未保存编辑；离开页面有未保存警告。正式空间不会凭空生成路线、回复或通过记录；生成能力接入前，可创建空间、确认需求、记录问题和编辑项目文件。

项目 API 仅访问应用管理的目录，支持多层目录、读取、创建、重命名和保存，不提供删除或任意外部目录接入。编辑器支持最大 1 MB 的 UTF-8 文本；路径穿越、符号链接、硬链接和非普通文件会被拒绝。外部改动可用「刷新目录」和「读取磁盘版本」发现；保存遇到版本冲突时保留编辑内容，用户比较后显式选择基线或磁盘内容。重命名前需保存受影响的编辑。路径检查不是针对同权限恶意进程竞态的沙箱。

空目录首次启动时初始化数据库；后续启动按版本事务迁移。迁移失败、高于当前程序的数据库版本或打不开数据库时，服务退出并提示，不删除数据重建。重复启动同一数据目录会被拒绝；应停止原实例或选择独立目录。重启时已保存的未完成任务/运行标记为中断，不自动重放操作；目前没有实际 Agent 或终端运行。

不要在服务运行时只复制 `app.db` 或修改数据库文件。需要保留数据时先正常停止服务，再复制整个数据根目录，连同项目文件及可能存在的 SQLite 辅助文件一起保存；保留原目录，勿用空目录覆盖。更换源码或重新构建不会迁移内存演示数据，也不应替换数据目录。完整备份恢复验收仍属于后续整体交付。

## 界面回归

`pnpm test` 包含会话归属、事务/幂等写入、项目路径边界、迁移故障、重复启动和真实进程恢复测试；进程集成测试使用 14310、14340、14341 端口及可丢弃目录。`pnpm check` 同时检查浏览器测试及截图脚本的类型。`pnpm test:browser --workers=1` 在开发代理和生产单服务两种模式验证交互与截图，保留原有访问保护检查，不复用已运行的用户服务。正式持久化检查由 `tests/serve-browser.ts` 创建并清理临时数据目录，内部业务入口写入明确标注的验收课件和路线；`/preview` 回归仍使用内存夹具。不需要模型密钥，不读写已有学习数据。

视觉场景固定为 1440×1000、浅色系统主题、减少动画、确定日期；全屏 IDE 自身仍为深色。12 个状态覆盖首页、空间列表、需求确认、路线与 Agent、普通/全屏 IDE、课件抽屉、测评作答、通过/需加强及课件/回复失败。两种服务模式共用 `tests/browser/__screenshots__/darwin` 中的基线；当前仅在 macOS arm64、本机 Google Chrome 验证，浏览器或系统字体变化需要重新检查，不能直接认定为产品回归。

原型仍在本机运行时，可执行 `pnpm exec tsx tests/capture-prototype.ts`（默认 3000 端口，可用 `PROTOTYPE_URL` 指定本机地址）。脚本与 Vite 测试共用 `tests/visual-scenes.ts` 操作序列，只隐藏 Next 开发浮层和原型控制按钮；不修改参考源码，不掩盖业务内容。原型截图保存到 `.amp/in/artifacts/reference/`，浏览器失败截图和差异图保存到 `.amp/in/artifacts/browser/`。首次在新 checkout 运行前，用 `git rev-parse --git-path info/exclude` 找到本地排除文件，保留已有规则并加入 `/.amp/in/`，避免提交评审临时文件。

组件迁移另用 `pnpm exec tsx tests/compare-components.ts <未修改参考版本的 apps/web 目录> <当前 Vite 地址>` 对照。参考目录须包含同版本依赖和 contracts，并可独立启动；脚本占用 15174，结束后关闭参考服务。它在相同输入下检查 14 个状态（上述 12 个状态另加需求编辑、会话菜单），逐组件比较 DOM、类名、文本、图标和计算样式；只忽略新增的「切换会话」无障碍标签。截图和签名保存在 `.amp/in/artifacts/component-parity/`。该检查验证展示组件没有偏移，不能替代正式入口的真实 API、保存、重试、刷新和文件冲突测试，两类检查必须分别通过。

Base UI 仍固定为 1.5.0。其 React 19 生产模式存在菜单可见但 `aria-expanded=false` 的[已知问题 #4956](https://github.com/mui/base-ui/issues/4956)；`patches/@base-ui__utils@0.2.9.patch` 仅回移[上游 #4866 的 store selector 修复](https://github.com/mui/base-ui/pull/4866)，通过 pnpm 自动应用，不升级组件或修改样式。浏览器回归检查异步保存期间新建会话、菜单重新打开时的无障碍状态及 Escape 关闭。将来升级包含该修复的版本时，应删除补丁并重跑这些检查。

有意调整视觉后，先运行 `pnpm test:browser tests/browser/visual.spec.ts --project=production --update-snapshots`，**实际打开基线并与原型/旧截图对照**，再运行不带更新参数的 `pnpm test:browser`。不能用自动更新截图来掩盖失败。迁移允许的差异为本地字体替换和独立 24px 夹具页脚；课件抽屉维持原型的左侧深色样式。截图不证明真实教学或执行已接通。

## 原生依赖检查

`pnpm test:native` 使用系统临时目录验证 SQLite 写入后关闭复开，以及 PTY 输入、输出、非零退出码和强制关闭后的 PID 消失；测试后删除数据。不读写已有学习数据库。

已实际验证 **macOS 26.6.2 / arm64、Node 24.15.0、better-sqlite3 13.0.3、node-pty 1.1.0**。未验证 Linux、Windows 或 Intel Mac，不据此宣称支持。

本机安装使用 Python 3.14.6、Xcode Command Line Tools、Apple clang 21.0.0。原生构建需要 Python、C/C++ 编译器和 make；缺失时由用户安装工具链，应用不会自动安装或申请管理员权限。

`node-pty 1.1.0` 的 macOS 预编译 helper 缺少执行位（[上游问题 #850](https://github.com/microsoft/node-pty/issues/850)）。仓库通过 `patches/node-pty@1.1.0.patch` 在 macOS 固定走包自身的源码编译分支，随 `pnpm install --frozen-lockfile` 自动应用，不手工修改已安装文件。这样也避免 pnpm 11 过滤 `npm_config_*` 导致强制源码编译变量失效。`pnpm-workspace.yaml` 显式允许所需构建脚本；安装成功后仍须运行原生检查。

## 模型兼容性检查

Pi Core 与 AI 包固定为 `@earendil-works/pi-agent-core@1.0.0`、`@earendil-works/pi-ai@1.0.0`，不加载 Pi Extension 宿主。`pnpm test` 的模型部分使用确定性流，不访问 Provider。

真实测试使用 `pnpm test:provider`，会发送两次短请求（正常流式响应、收到文字后取消），可能产生 Provider 费用。在根目录 `.env` 配置 `OPENROUTER_API_KEY` 与准确的 `OPENROUTER_MODEL`；没有 `.env` 时可参考 `.env.example` 新建，权限设为 `600`，不要覆盖已有配置或把密钥写进命令行。服务端环境变量优先于文件；缺失配置或 Provider 错误会返回失败，不切换模型。`.env` 路径相对代码定位，不依赖启动目录；读取不会把凭据注入全局环境或终端子进程。

已按用户选择用 `deepseek/deepseek-v4.1-flash` 完成真实响应流与取消检查。当前模型装配仅服务兼容性测试，显式关闭推理，采用 256 输出 token 上限和 8192 测试上下文元数据（留出 Pi 的 4096-token 安全预留），不是教学场景或计费实现。不向模型开放文件修改或命令执行工具。

## 本地接口访问边界

Node 服务固定监听 `127.0.0.1`，不能用 `HOST` 改成公开监听。生产模式只接受配置端口上的 `localhost`、`127.0.0.1` Host 与 HTTP Origin；开发模式额外允许同样主机的前端端口（默认 5173，可用 `TMC_WEB_PORT` 调整），Vite 保留原始 Host/Origin 代理 HTTP 与升级请求。开发 API 端口同样可用环境变量 `PORT` 调整。`pnpm dev` 显式启用开发模式，`pnpm start` 强制生产模式；不开放 CORS，不信任转发头，也不支持任意反向代理或跨设备访问。

除健康检查和令牌初始化外，所有 `/api` 请求需要 `X-TMC-Token`。本机页面用 `X-TMC-Client: browser` 请求 `GET /api/access`，在内存中保存响应令牌，然后携带令牌请求 API；当前 `POST /api/access/check` 只返回 `{ "ok": true }`，无业务副作用。初始化端点同样校验 Host/Origin 和 Fetch Metadata，跨域预检被拒绝；同源 GET 缺少 Origin 是浏览器正常行为，允许通过。令牌每次服务启动随机生成，不写入文件、日志、URL 或浏览器持久存储，API 响应禁止缓存。

`/api/terminal/socket` 只实现升级访问检查：要求合法 Host、明确 Origin，以及 WebSocket 子协议 `tmc-terminal` 和 `tmc-token.<请求令牌>`；不接受查询参数代替令牌。拒绝请求返回 401/403，合法请求目前返回 501，不创建 WebSocket 会话或 PTY。真实终端接入属于后续里程碑。

这些措施用于防止外部网页滥用本地接口，不是登录系统，也不能防御拥有本机权限的恶意进程、同源脚本攻击或把本机执行变成沙箱。模型密钥只能配置在服务端，不要放入 `VITE_*` 变量。测试覆盖同源访问、开发代理、非法 Host/Origin、缺失及错误令牌、实际升级请求，以及 Vite/生产静态资源不能读取根 `.env`。

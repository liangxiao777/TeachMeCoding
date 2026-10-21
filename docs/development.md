# 开发与测试

本文介绍本地开发命令、演示夹具、回归测试与兼容性检查。

## 常用命令

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

## 界面演示与开发夹具

显式访问 `/preview` 进入演示。开发和生产构建均可演示；底部会明确标注模拟状态。所有回复、课件、测评和终端结果均来自 `apps/web/src/fixtures`，仅在浏览器内存中运行，刷新重置；不会调用模型、写入项目文件或执行本机命令。原型控制台没有迁入默认入口，也不作为产品功能。演示数据不会迁入正式空间，正式 API 请求失败也不会回落到演示。

回归可直接访问 `/preview?scene=spaces`（两个空间）、`?scene=route`（Rust 路线）、`?scene=unit`（Rust 单元）；`&fault=reply` 或 `&fault=lesson` 让下一次模拟回复或课件生成失败。参数只在显式预览路径生效，不作为真实 API 失败后的回退。

## 界面回归

`pnpm test` 包含会话归属、事务/幂等写入、项目路径边界、迁移故障、重复启动和真实进程恢复测试；进程集成测试使用 14310、14340、14341 端口及可丢弃目录。`pnpm check` 同时检查浏览器测试及截图脚本的类型。`pnpm test:browser --workers=1` 在开发代理和生产单服务两种模式验证交互与截图，保留原有访问保护检查，不复用已运行的用户服务。正式持久化检查由 `tests/serve-browser.ts` 创建并清理临时数据目录，内部业务入口写入明确标注的验收课件和路线；`/preview` 回归仍使用内存夹具。不需要模型密钥，不读写已有学习数据。

资料库文档回归使用 `tests/fixtures/library-reference.docx`、双页 `library-reference.pdf` 和纯图片 `library-scanned.pdf`，验证上传后通过 Agent 原生工具提取中文、英文、XML 转义、表格及第二页正文，以及文字层为空和解析工具缺失的反馈。DOCX 命令只使用 Python 3 标准库，PDF 命令使用本机 `pdftotext`（Poppler）；运行 `pnpm test` 需要这两个命令，缺失时测试失败，不自动安装或跳过。模型工具选择仍是确定性流，实际文件、Bash 和解析进程均为真实执行；不代表真实模型已通过自主解析或 OCR 验收。

本机执行专项使用真实 PTY 和可丢弃文件；Agent 回复使用确定性测试 Provider，不调用收费模型。先执行 `pnpm build`，再分别运行以下命令（两组共用测试端口，不能同时运行）：

```sh
pnpm test:browser tests/browser/execution.spec.ts --workers=1
pnpm exec playwright test -c tests/agents.config.ts --workers=1 -g 'local proposals|real code assessment'
```

第一组覆盖终端连接、重连、退出和保存一致性；第二组覆盖提案确认、冲突与取消，以及真实代码运行、测评证据和新草稿保留。命令默认验证开发和生产两种模式。真实 Provider 评分的既有验证及平台限制记录在 [ROADMAP](ROADMAP.md)，不以确定性回复代替真实模型文案质量验收。

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

真实测试使用 `pnpm test:provider`，会发送两次短请求（正常流式响应、收到文字后取消），可能产生 Provider 费用。先在待测实例的「设置 → 模型配置」中保存模型选择并配置 API Key 或 OAuth 登录；脚本使用 `TMC_DATA_DIR` 指定的数据目录（默认 `~/.teach-me-coding/`）中的已保存配置。目录与应用一样从启动环境或项目根 `.env` 读取，启动环境优先；模型和凭据不从 `.env` 或环境变量读取。缺失配置或 Provider 错误会返回失败，不切换模型；不要把密钥写进命令行。

运行收费检查前先停止使用该数据目录的应用实例；脚本持有同一实例锁，只读模型选择，不迁移数据库或执行业务恢复。OAuth 续期仍写回该实例的凭据文件。

教学确定性测试使用 `pnpm exec playwright test -c tests/agents.config.ts --project=production --workers=1`（开发模式换为 `development`），需先构建，占用与普通浏览器测试相同端口，不同时运行。该套件包含真实本机执行与提案确认场景，模型回复仍为确定性流。`pnpm exec tsx tests/teaching-provider-smoke.ts` 是显式收费真实模型检查：使用上述已保存模型配置，学习流程只使用可丢弃数据库和合成文件，串联需求→路线→课件→只读辅导→出题→评估；不上传用户项目，不执行提交的代码，因此不能替代真实执行验收。Provider 失败会使脚本失败；真实和确定性结果见 [ROADMAP](ROADMAP.md)，不保证模型每次输出相同。

这些收费检查仅在显式执行对应命令时运行，不属于默认离线测试，也不会在保存配置后自动运行。

# TeachMeCoding

本地单用户教学应用，当前只有运行环境检查页。教学界面和业务尚未接入；原型保留在 `.worktrees/prototype`，不作为正式启动入口。

## 本地运行

要求 Node **24.15.0（24 LTS）**、pnpm **11.1.0**。依赖版本通过清单和 `pnpm-lock.yaml` 固定。

```sh
pnpm install --frozen-lockfile
pnpm dev          # 同时启动 127.0.0.1:5173 前端和 127.0.0.1:4310 API
pnpm check
pnpm build
pnpm test         # 需要先 build；包括跨工作目录的生产服务检查
pnpm test:browser # 使用本机 Google Chrome；确保 4310、4311、5173 端口空闲
pnpm start        # 一个 Node 服务在 http://127.0.0.1:4310 提供 UI 和 API
```

`Ctrl+C` 停止服务。生产 API 端口可通过 `PORT` 设置。编译产物可从任意工作目录用 `node /绝对路径/apps/server/dist/index.js` 启动，静态资源不依赖当前目录。

未来的代码执行直接使用本机权限，不是沙箱。当前没有文件、Agent 或终端业务接口，也不提供远程部署模式。

## 原生依赖检查

`pnpm test:native` 使用系统临时目录验证 SQLite 写入后关闭复开，以及 PTY 输入、输出、非零退出码和强制关闭后的 PID 消失；测试后删除数据。不读写已有学习数据库。

已实际验证 **macOS 26.6.2 / arm64、Node 24.15.0、better-sqlite3 13.0.3、node-pty 1.1.0**。未验证 Linux、Windows 或 Intel Mac，不据此宣称支持。

本机安装使用 Python 3.14.6、Xcode Command Line Tools、Apple clang 21.0.0。原生构建需要 Python、C/C++ 编译器和 make；缺失时由用户安装工具链，应用不会自动安装或申请管理员权限。

`node-pty 1.1.0` 的 macOS 预编译 helper 缺少执行位（[上游问题 #850](https://github.com/microsoft/node-pty/issues/850)）。仓库通过 `patches/node-pty@1.1.0.patch` 在 macOS 固定走包自身的源码编译分支，随 `pnpm install --frozen-lockfile` 自动应用，不手工修改已安装文件。这样也避免 pnpm 11 过滤 `npm_config_*` 导致强制源码编译变量失效。`pnpm-workspace.yaml` 显式允许所需构建脚本；安装成功后仍须运行原生检查。

## 模型兼容性检查

Pi Core 与 AI 包固定为 `@earendil-works/pi-agent-core@1.0.0`、`@earendil-works/pi-ai@1.0.0`，不加载 Pi Extension 宿主。`pnpm test` 的模型部分使用确定性流，不访问 Provider。

真实测试使用 `pnpm test:provider`，会发送两次短请求（正常流式响应、收到文字后取消），可能产生 Provider 费用。在根目录 `.env` 配置 `OPENROUTER_API_KEY` 与准确的 `OPENROUTER_MODEL`；没有 `.env` 时可参考 `.env.example` 新建，权限设为 `600`，不要覆盖已有配置或把密钥写进命令行。服务端环境变量优先于文件；缺失配置或 Provider 错误会返回失败，不切换模型。`.env` 路径相对代码定位，不依赖启动目录；读取不会把凭据注入全局环境或终端子进程。

已按用户选择用 `deepseek/deepseek-v4.1-flash` 完成真实响应流与取消检查。当前模型装配仅服务兼容性测试，显式关闭推理，采用 256 输出 token 上限和 8192 测试上下文元数据（留出 Pi 的 4096-token 安全预留），不是教学场景或计费实现。不开放教学、文件或命令执行接口。

## 本地接口访问边界

Node 服务固定监听 `127.0.0.1`，不能用 `HOST` 改成公开监听。生产模式只接受配置端口上的 `localhost`、`127.0.0.1` Host 与 HTTP Origin；开发模式额外允许同样主机的 5173 端口，Vite 保留原始 Host/Origin 代理 HTTP 与升级请求。开发 API 端口同样可用环境变量 `PORT` 调整。`pnpm dev` 显式启用开发模式，`pnpm start` 强制生产模式；不开放 CORS，不信任转发头，也不支持任意反向代理或跨设备访问。

除健康检查和令牌初始化外，所有 `/api` 请求需要 `X-TMC-Token`。本机页面用 `X-TMC-Client: browser` 请求 `GET /api/access`，在内存中保存响应令牌，然后携带令牌请求 API；当前 `POST /api/access/check` 只返回 `{ "ok": true }`，无业务副作用。初始化端点同样校验 Host/Origin 和 Fetch Metadata，跨域预检被拒绝；同源 GET 缺少 Origin 是浏览器正常行为，允许通过。令牌每次服务启动随机生成，不写入文件、日志、URL 或浏览器持久存储，API 响应禁止缓存。

`/api/terminal/socket` 只实现升级访问检查：要求合法 Host、明确 Origin，以及 WebSocket 子协议 `tmc-terminal` 和 `tmc-token.<请求令牌>`；不接受查询参数代替令牌。拒绝请求返回 401/403，合法请求目前返回 501，不创建 WebSocket 会话或 PTY。真实终端接入属于后续里程碑。

这些措施用于防止外部网页滥用本地接口，不是登录系统，也不能防御拥有本机权限的恶意进程、同源脚本攻击或把本机执行变成沙箱。模型密钥只能配置在服务端，不要放入 `VITE_*` 变量。测试覆盖同源访问、开发代理、非法 Host/Origin、缺失及错误令牌、实际升级请求，以及 Vite/生产静态资源不能读取根 `.env`。

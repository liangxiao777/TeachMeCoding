# 开发指南

[English](development.md) · 简体中文

本文介绍如何搭建开发环境和运行测试。提交流程和约定见 [CONTRIBUTING.md](../CONTRIBUTING.zh.md)，内部设计见[架构](architecture.zh.md)。

## 环境要求

- [Node.js](https://nodejs.org/) 24.15.0（见 `.node-version`）
- [pnpm](https://pnpm.io/) 11.1.0
- `PATH` 中的 Git 和 Bash。
- [README 中的系统依赖](../README.zh.md#环境要求)：原生依赖需要编译时，需准备 Python 3 和本机编译工具（macOS 的 Xcode Command Line Tools、Ubuntu/Debian 的 `build-essential`）。
- `pnpm test` 额外需要 Python 3 和 `rustc` 来运行语言执行测试，以及 `pdftotext`（[Poppler](https://poppler.freedesktop.org/)）来运行资料库文档解析测试。请自行安装并加入 `PATH`；缺少时测试会失败，不会自动跳过。
- 浏览器测试使用本机安装的 Google Chrome，平台限制见[浏览器测试](#浏览器测试)。

## 快速开始

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 会先构建 `packages/contracts`，再同时启动服务端和 Vite（前端 <http://127.0.0.1:5173>，API <http://127.0.0.1:4310>）。

开发时，在项目根目录的 `.env` 中设置 `TMC_DATA_DIR`，使用独立的数据目录，避免影响日常学习数据：

```dotenv
TMC_DATA_DIR="/absolute/path/to/teach-me-coding-dev"
```

请把示例替换为绝对路径。全部启动参数见[配置](configuration.zh.md)。

## 项目结构

```text
apps/
  server/            Node 服务
    src/agents/      Agent 运行层、场景、工具与提示词（prompts/）
    src/config/      启动参数与 .env 读取
    src/extensions/  搜索、网页抓取、MCP、Skills
    src/http/        Hono 路由与访问控制
    src/models/      模型选择与凭据存储
    src/modules/     学习业务、资料库、执行提案
    src/runtime/     PTY 终端、Bash、命令执行
    src/storage/     数据目录、SQLite 与会话存储
  web/               React + Vite 前端
    src/i18n/        界面翻译资源
packages/
  contracts/         前后端共享的 schema 与类型
tests/               集成测试、Playwright 浏览器测试与测试夹具
patches/             pnpm 依赖补丁
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式，前端热更新 |
| `pnpm build` | 构建全部包 |
| `pnpm start` | 生产模式，单个服务在 `http://127.0.0.1:4310` 提供界面和 API（需先 build） |
| `pnpm check` | 类型检查，包括测试和脚本 |
| `pnpm check:i18n` | 检查翻译资源，见[界面翻译](translating.zh.md) |
| `pnpm test` | 单元与集成测试（需先 build） |
| `pnpm test:browser` | Playwright 浏览器测试 |
| `pnpm test:native` | SQLite 与 PTY 原生依赖检查 |
| `pnpm test:provider` | 真实模型冒烟测试，**会产生费用** |

## 测试

所有测试都使用临时数据目录，不读写你的学习数据；Agent 回复使用确定性的测试 Provider，不调用收费模型。

CI 矩阵仅使用 `ubuntu-latest` 和 `macos-latest`，覆盖冻结锁文件安装、`pnpm check`、`pnpm build`、`pnpm test`、`pnpm test:native` 以及浏览器执行/PTY 检查，包括 POSIX 权限断言（见[安全策略](../SECURITY.zh.md)）。

### 单元与集成测试

```sh
pnpm build
pnpm test
```

覆盖业务规则、事务与幂等写入、项目路径边界、数据库迁移、重复启动和真实进程恢复。进程集成测试会启动真实服务并占用固定的本地端口（定义在 `tests/*.test.mjs` 中）。

### 浏览器测试

Linux 浏览器检查**仅限 x86_64**：当前配置使用 Google Chrome，其 Playwright 安装器明确拒绝 Linux arm64。Linux arm64 仅在非 root 的 Debian 12 Docker 环境中完成后端/原生依赖验证。本地浏览器验证覆盖 macOS 26 / arm64，Intel Mac 尚未验证。

```sh
pnpm build
pnpm test:browser --workers=1
```

每个用例分别在开发模式（Vite 代理）和生产模式（单服务）下运行，占用 14320、14321 和 15173 端口。可以只运行单个文件，例如 `pnpm test:browser tests/browser/execution.spec.ts --workers=1`。

教学场景使用单独的配置，与普通浏览器测试共用端口，不能同时运行：

```sh
pnpm exec playwright test -c tests/agents.config.ts --workers=1
```

### 原生依赖

`pnpm test:native` 在临时目录中验证 SQLite 的写入与重新打开，以及 PTY 的输入、输出、退出码和进程清理。升级 Node、`better-sqlite3` 或 `node-pty` 后应运行一次。

### 真实模型检查

以下检查会调用真实 Provider 并**产生费用**，只在显式运行时执行：

- `pnpm test:provider`：发送两次短请求，验证流式响应和取消。
- `pnpm exec tsx tests/teaching-provider-smoke.ts`：用临时数据库和合成文件串联完整教学流程（需求 → 路线 → 课件 → 辅导 → 出题 → 评估），不执行提交的代码。

两者都使用 `TMC_DATA_DIR`（默认 `~/.teach-me-coding/`）中已保存的模型配置。运行前先停止使用该数据目录的应用实例。模型输出不保证每次相同。

## 依赖补丁

`patches/` 中的补丁由 pnpm 在安装时自动应用。升级对应依赖时，请确认上游是否已修复，并删除不再需要的补丁。

| 补丁 | 用途 |
| --- | --- |
| `node-pty@1.1.0.patch` | macOS 预编译的 `spawn-helper` 缺少执行权限（[microsoft/node-pty#850](https://github.com/microsoft/node-pty/issues/850)），macOS 始终从源码编译，Linux 有可用预编译二进制时仍使用预编译版本 |
| `@base-ui__utils@0.2.9.patch` | 回移 [mui/base-ui#4866](https://github.com/mui/base-ui/pull/4866)，修复 React 19 生产模式下菜单 `aria-expanded` 状态错误（[#4956](https://github.com/mui/base-ui/issues/4956)） |
| `@earendil-works__pi-coding-agent@1.0.0.patch` | 允许服务端提供鉴权上下文和 Provider 定义；为 Bash 工具增加私有输出目录、POSIX `0600` 文件模式和写入失败传播 |
| `@earendil-works__pi-ai@1.0.0.patch` | 显式传入环境时只使用该环境，不回退读取 `process.env`，确保凭据只来自数据目录 |

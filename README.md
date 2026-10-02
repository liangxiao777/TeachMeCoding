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
pnpm test:browser # 使用本机 Google Chrome；确保 4310、5173 端口空闲
pnpm start        # 一个 Node 服务在 http://127.0.0.1:4310 提供 UI 和 API
```

`Ctrl+C` 停止服务。生产 API 端口可通过 `PORT` 设置。编译产物可从任意工作目录用 `node /绝对路径/apps/server/dist/index.js` 启动，静态资源不依赖当前目录。

未来的代码执行直接使用本机权限，不是沙箱。当前没有文件、Agent 或终端业务接口，也不提供远程部署模式。

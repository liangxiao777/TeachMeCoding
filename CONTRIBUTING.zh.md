# 参与贡献

[English](CONTRIBUTING.md) · 简体中文

感谢你愿意改进 TeachMeCoding。本文说明如何反馈问题和提交改动。

## 反馈问题

- **Bug 和建议**：在 [Issues](https://github.com/liangxiao777/TeachMeCoding/issues) 中提交。报告 Bug 时请写明操作系统、Node 版本、复现步骤，以及预期和实际的结果。附带日志前请先删除 API Key、令牌和私人路径。
- **安全漏洞**：不要公开提交 issue，请按 [SECURITY.zh.md](SECURITY.zh.md) 私下报告。

## 提交改动之前

- 修复 Bug 和小范围的文档改动可以直接提交 Pull Request。
- 新功能、较大的重构或会改变数据格式的改动，请先开 issue 说明要解决的问题和大致方案，避免做完之后方向不合适。
- 阅读 [AGENTS.zh.md](AGENTS.zh.md) 中的设计约定。它同时约束人和 AI 编码助手，核心是：
  - 每个约束都要有实际用途，保持简单有效。
  - 模型只表达业务内容；内部 ID、修订号、事务和存储由服务端负责。
  - 内容质量靠工具说明和提示词引导，不用固定清单或格式检查代替判断。
  - 新增界面文案、按钮或设置入口前，先确认它对完成任务确有必要。

开发环境、测试和项目结构见[开发指南](docs/development.zh.md)。

## Pull Request

1. 从最新的 `main` 新建分支，命名为 `<type>/<short-description>`，例如 `fix/terminal-reconnect`。
2. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`<type>(<scope>): <description>`。scope 使用真实的模块名，description 用英文动词短语描述实际改动，例如 `fix(projects): reject symlink traversal`。不要使用 `update`、`finish implementation` 这类不说明内容的描述。
3. 每个 PR 只做一件事，无关的修改另开 PR。
4. 行为变更需要附带测试，测试行为而不是实现细节。
5. 涉及界面的改动：
   - 附上修改前后的截图。
   - 新增或修改文案时，同时更新 `en` 和 `zh-CN` 的翻译资源，见[界面翻译](docs/translating.zh.md)。
6. 新增依赖时使用精确版本号，并在 PR 中说明为什么需要它。
7. 在 PR 描述中说明改了什么、为什么改，以及如何验证。

提交前请确认以下检查通过：

```sh
pnpm check
pnpm build
pnpm test
pnpm test:browser --workers=1   # 涉及界面或交互时
pnpm check:i18n                 # 涉及界面文案时
```

不要提交 `.env`、数据目录中的文件或 `agent-debug/` 中的调试快照。

## 许可

提交到本仓库的贡献，按 [Apache License 2.0](LICENSE) 授权，与项目本身的许可证一致。

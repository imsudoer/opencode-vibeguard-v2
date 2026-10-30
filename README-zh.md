# opencode-vibeguard-v2

> 本仓库是 [`inkdust2021/opencode-vibeguard`](https://github.com/inkdust2021/opencode-vibeguard)
> 的 V2 分支。上游中文 README 已不适用于当前代码，请阅读英文版
> [README.md](README.md)。

主要变化：

- 适配 OpenCode V2 的默认导出（`{ id, setup }`）。
- 使用 V2 `context` 钩子在请求前脱敏，使用 `execute.before` 在工具执行前还原参数。
- 可选 `restore_response`，支持跨 SSE 事件拼接占位符。
- 默认短占位符（`test@example.com`），避免模型复制长哈希时出错。
- 修复 `ReadableStream is locked`：只读取 `response.clone()`。

安装、配置和限制请见 [README.md](README.md)。
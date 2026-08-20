# 路由验证日志

| 日期 | 用例 | 候选 provider/model | 版本/网关 | 真路由证据 | 质量门 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-11 | 初始化 | 未选择 | 未实施 | 不适用 | 不适用 | 未开始 | 此表为 Phase 0 模板 |
| 2026-08-20 | Orchestrator-first 只读架构复查 | GPT 前台 + Direct DeepSeek 后台（设计） | Draft PR #1 `aa96a13` | 代码/文档只读对照；未发 API | 未运行 | 计划完成 | 发现 tuple、endpoint、只读、checkpoint、幂等、隐私和前台接入差距；不构成运行验证 |
| 2026-08-20 | 外部建议证据对照 | 同上（设计） | OpenAI Docs 2026-08-20 + Draft PR | 官方配置/MCP/CLI/App Server/SDK 文档与 PR 源码对照 | 未运行 | 部分采纳并形成阶段计划 | worktree 不等于 sandbox；隐私改双维；RouteBinding 分层；成本真值分离；Workflow/Attempt 分层 |
| 2026-08-20 | S0–S10 计划与交接 | 同上（设计） | `docs/16`、`docs/17` | 文档审查；未发 API | 未运行 | 待实施 | S0–S9 均为零费用阶段；旧 live benchmark 不证明新架构通过 |

## 记录规则

“通过”需要记录 provider/model、请求 ID（可脱敏）、服务端或网关证据、任务包版本、测试命令与退出码。只写“模型回答正常”不算通过。

架构评审、文档完成或 mock 测试不得记录为“真实路由通过”。`AMBIGUOUS` 调用必须单独记录，不得用客户端重试后的成功覆盖原 attempt。

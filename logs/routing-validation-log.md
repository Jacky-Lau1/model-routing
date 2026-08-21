# 路由验证日志

| 日期 | 用例 | 候选 provider/model | 版本/网关 | 真路由证据 | 质量门 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-11 | 初始化 | 未选择 | 未实施 | 不适用 | 不适用 | 未开始 | 此表为 Phase 0 模板 |
| 2026-08-20 | Orchestrator-first 只读架构复查 | GPT 前台 + Direct DeepSeek 后台（设计） | Draft PR #1 `aa96a13` | 代码/文档只读对照；未发 API | 未运行 | 计划完成 | 发现 tuple、endpoint、只读、checkpoint、幂等、隐私和前台接入差距；不构成运行验证 |
| 2026-08-20 | 外部建议证据对照 | 同上（设计） | OpenAI Docs 2026-08-20 + Draft PR | 官方配置/MCP/CLI/App Server/SDK 文档与 PR 源码对照 | 未运行 | 部分采纳并形成阶段计划 | worktree 不等于 sandbox；隐私改双维；RouteBinding 分层；成本真值分离；Workflow/Attempt 分层 |
| 2026-08-20 | S0–S10 计划与交接 | 同上（设计） | `docs/16`、`docs/17` | 文档审查；未发 API | 未运行 | 待实施 | S0–S9 均为零费用阶段；旧 live benchmark 不证明新架构通过 |
| 2026-08-21 | S0 默认入口退役 | Orchestrator-only（离线） | `codex/s0-orchestrator-first` working tree | 默认脚本静态调用链、mock shortcut manifest、CLI/Terminal help；未发 API | PowerShell syntax；TypeScript `--noEmit`；Vitest 28/28 | 通过 | 临时目录实际生成 + dry-run 均只含 Orchestrator；未读取真实 config/auth/DPAPI/env 值，未安装，未运行 `live-benchmark` |
| 2026-08-21 | S1 合同、隐私与 schema | DeepSeek binding（仅合成数据构造） | `codex/s1-contracts-privacy-schema` working tree | Task/route/context/policy/approval hash 绑定；未发 API | JSON Schema 解析与约束；TypeScript `--noEmit`；Vitest 42/42 | 通过 | 字段顺序稳定；route/scope/policy/budget 变化失效；private/未分类/无授权默认 deny；未知字段、空 scope、危险路径和 secret-like context 拒绝；glob 无法证明收窄时拒绝；未读真实配置/env/凭据 |
| 2026-08-21 | S2 Workflow/Attempt、crash 与并发幂等 | 全部为内存 mock provider | `codex/s2-attempt-persistence-idempotency` working tree | PREPARED/SENDING/SUCCEEDED 磁盘记录、稳定 attempt ID、task/approval lock；未发 API | TypeScript `--noEmit`；Vitest 67/67 | 通过 | 三 checkpoint 崩溃、十种 Stage 异常、并发 approve 单调用、AMBIGUOUS 重启不重发、repair 历史、原子写中断和脱敏通过；未读 config/env/credential，未联网、未建 worktree、未实现 MCP |

## 记录规则

“通过”需要记录 provider/model、请求 ID（可脱敏）、服务端或网关证据、任务包版本、测试命令与退出码。只写“模型回答正常”不算通过。

架构评审、文档完成或 mock 测试不得记录为“真实路由通过”。`AMBIGUOUS` 调用必须单独记录，不得用客户端重试后的成功覆盖原 attempt。

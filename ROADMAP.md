# 路线图

历史路线见 [docs/06-implementation-roadmap.md](docs/06-implementation-roadmap.md)。当前执行基线以 [Orchestrator-first 最终实施计划](docs/16-orchestrator-first-implementation-plan.md) 和 [分阶段新对话交接](docs/17-orchestrator-first-stage-handoffs.md) 为准。

| 阶段 | 状态 | 目标 |
| --- | --- | --- |
| S0 | 已通过（2026-08-21） | 默认入口只保留 Orchestrator；旧 native 脚本移入 deprecated experimental |
| S1 | 已通过（2026-08-21） | 六类独立合同、双维隐私、policy 收窄、规范化 hash 与严格 schema |
| S2 | 已通过（2026-08-21） | 分离 Workflow/Attempt，持久化副作用前检查点、幂等锁和 ambiguous 语义 |
| S3 | 已通过（2026-08-21） | run-scoped isolated Git worktree、external roots、dirty evidence、可恢复生命周期/归属校验及 apply 前冲突检测 |
| S4 | 已通过（2026-08-21） | Direct DeepSeek manifest-only read、独立 write scope、single structured patch、最小 env/command/tool-network surface |
| S5 | 可开始 | endpoint/auth/model/protocol preflight 与多源 RouteEvidence |
| S6 | 未开始 | Local Quality Gate、secret scan、最终 diff 和 EvidenceBundle |
| S7 | 未开始 | Core CLI、STDIO MCP 和 thin Codex skill 前台接入 |
| S8 | 未开始 | GPT 三态 Final Review、一次 repair 和受控 apply |
| S9 | 未开始 | 全 mock、临时 repo 的零费用端到端认证 |
| S10 | 禁止运行 | 经明确“运行”授权后的公开/合成任务有限 Pilot |

每个阶段必须通过自己的阶段门并维护日志后才能进入下一阶段。S0–S9 不允许真实 API 调用。

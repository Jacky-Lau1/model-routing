# 路线图

历史路线见 [docs/06-implementation-roadmap.md](docs/06-implementation-roadmap.md)。架构与安全基线以 [Orchestrator-first 最终实施计划](docs/16-orchestrator-first-implementation-plan.md) 为准；当前执行只使用 [三部分 Agent Team 闭环交接](docs/17-orchestrator-first-stage-handoffs.md)。

| 阶段 | 状态 | 目标 |
| --- | --- | --- |
| S0 | 已通过（2026-08-21） | 默认入口只保留 Orchestrator；旧 native 脚本移入 deprecated experimental |
| S1 | 已通过（2026-08-21） | 六类独立合同、双维隐私、policy 收窄、规范化 hash 与严格 schema |
| S2 | 已通过（2026-08-21） | 分离 Workflow/Attempt，持久化副作用前检查点、幂等锁和 ambiguous 语义 |
| S3 | 已通过（2026-08-21） | run-scoped isolated Git worktree、external roots、dirty evidence、可恢复生命周期/归属校验及 apply 前冲突检测 |
| S4 | 已通过（2026-08-21） | Direct DeepSeek manifest-only read、独立 write scope、single structured patch、最小 env/command/tool-network surface |
| S5 | 已通过（2026-08-21） | immutable legacy RouteBinding、Direct mock transport 逐轮 RouteEvidence、redirect/request-ID fail-closed；Codex CLI bound transport 不可观测时发送前停止 |
| S6 | 已通过（2026-08-23） | 顺序化 Local Quality Gate、baseline-aware secret scan、只读 Git/diff freeze、完整 QualityGateReport 与 EvidenceBundle v2 |
| S7 | 已通过（2026-08-24） | Canonical core、结构化 CLI、六工具 thin STDIO MCP 和 repo thin skill；单会话 mock + sentinel 不变证据 |
| S8 | 已通过（2026-08-24） | GPT 三态 Final Review、一次新 attempt 的 controlled repair、APPLY_PENDING、snapshot/preimage/dirty 保护与幂等显式 apply |
| S9 | 已通过（2026-08-24） | 全 mock、临时 repo/state/worktree/MCP 的完整控制链矩阵；26/26 定向、25 files 368/368 全量 |
| S10 preflight | 已整改 / BLOCKED（2026-08-24） | EvidenceBundle v3、逐轮成本/预算、Pilot report 和临时 MCP discovery 已离线通过；真实 tool discovery、credential 与公平 GPT-only telemetry 未满足 |
| S10 | BLOCKED / 未授权 | 仅在 blocker 解除并经当次 exact hash-bound 授权后，才可考虑公开/合成有限 smoke/Pilot |
| Part 1 | 下一步 | 接通真实质量命令、完整批准摘要、Pilot report、编译分发、doctor 与临时安装/回滚；全程离线 |
| Part 2 | 等待 Part 1 | 真实 MCP/credential、单任务 smoke、隔离 GPT-only 基线与 20–50 对 Pilot；总可审计成本下降至少 30% |
| Part 3 | 等待 Part 2 `expand` | 多文件/私有 capability、Windows 隔离、事务恢复、fault injection 与 release-candidate 验收 |

每个部分必须通过自己的阶段门并维护日志后才能进入下一部分。Part 2 的质量不降、违规/ambiguity/duplicate 为零及总成本下降至少 30% 是硬门；缺少可靠 GPT-only telemetry 时不得进入 Part 3。

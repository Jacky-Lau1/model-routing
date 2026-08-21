# 变更日志

本项目采用 Keep a Changelog 的记录方式；日期为北京时间。

## [Unreleased]

### Added

- S4 `SafeExecutor` capability boundary：exact public read manifest、独立 write scope、physical path/reparse、大小/UTF-8/secret-content、内容 hash 与 preimage 校验。
- Direct DeepSeek 工具面收敛为 `list_manifest`、`read_file`、内存 `propose_patch`；Orchestrator 只在 isolated worktree 的 S2 response validation 内应用一个原子 replacement/create。
- credential helper 使用合成可注入依赖、最小 child environment 和由验证后 `SystemRoot` 派生的绝对 PowerShell 路径；auth 只进入 transport header，不进入模型 body。
- S4 临时目录/mock fetch/synthetic credential 攻击矩阵，覆盖 Windows path/ADS/device/case、junction、scope/classification、敏感路径/内容、encoding/size/CRLF、tool/byte budget、preimage 和 private text fail-closed。
- S4 专项实现与交接文档 `docs/21-s4-safe-executor.md`。
- S3 `GitWorktreeManager`：批准 base commit、主 workspace dirty evidence/snapshot、run-scoped lifecycle、clean detached 创建恢复、归属验证、默认保留和带 `REMOVING` intent 的可恢复保守 cleanup。
- 默认 Router state root 外置，并拒绝位于目标 repo/common Git dir 内或与 managed root 重叠的隔离根目录。
- approval-to-worktree handoff 使用绑定 approval/PID/nonce 的 filesystem lock，覆盖 bind、prepare、`WORKTREE_READY` 与 legacy `EXECUTING` 持久化；归属匹配的 dead-owner、ownerless lock 可恢复，release 先原子移入 quarantine 再清理。
- S3 synthetic Git repo 测试矩阵，覆盖 clean/modified/added/untracked/renamed/deleted、同步并发审批、创建/清理检查点中断、主目录漂移、scope 双状态、build 产物隔离、junction 篡改和 cleanup 负例。
- S3 专项实现与交接文档 `docs/20-s3-isolated-worktree.md`。
- S2 durable attempt executor：PREPARED/SENDING/SUCCEEDED 原子检查点、AMBIGUOUS/BLOCKED 恢复、task/approval 锁和稳定 attempt ID。
- S2 crash/concurrency/provider-stage/atomic-write/redaction 离线测试矩阵，以及状态转换表和 crash matrix 文档。
- S1 `TaskPackage`、`RouteBinding`、`ExecutionContext`、`ApprovalRecord`、`AttemptRecord` 和 `EvidenceBundle` 独立线协议类型。
- 规范化 JSON 序列化、稳定 SHA-256、严格运行时解析器、独立 JSON Schema 入口和 hash-valid 合成示例。
- `data_classification + egress_policy` 双维隐私、user/project policy 交集和 DeepSeek binding 默认拒绝规则。
- S1 合同/schema 合成测试，覆盖字段顺序、审批失效、未知字段、危险路径、secret-like context 和 policy 收窄。
- S0 默认快捷方式安装器的 `-DryRun`、临时目录和 mock shortcut backend 回归测试。
- deprecated experimental native Codex 区域及其风险说明。
- Orchestrator-first 最终实施计划：S0–S10 阶段门、双层状态、RouteBinding、worktree、安全执行器、EvidenceBundle、GPT 前台和 Pilot。
- 分阶段新对话交接文档，包含每阶段可复制 Prompt、依赖、测试和维护要求。
- 18 项可评估 TODO，记录当前默认、替代方案、风险、所需证据和改变条件。
- ADR-005 至 ADR-011，固定 provider 切换退役、双维隐私、ambiguous 调用、分层 binding、MCP 接入和 Direct Adapter 方向。

- TypeScript 确定性路由、审批哈希、状态机和低写入检查点。
- Codex ephemeral、DeepSeek Responses 与本地验证适配器。
- Microsoft Store Codex CLI 安装同步脚本与隔离的 Router Home。
- Windows DPAPI DeepSeek 凭据存储和受限实机质量/费用基准。
- Auto/DeepSeek/Codex 终端入口面板、Windows 快捷方式安装器和混合路由测评方案。
- DeepSeek Responses 原生 Codex Flash/Pro profiles，使用 DPAPI 命令式认证。
- `route auto/approve/revise/status/resume/abort/benchmark/live-benchmark/cleanup` CLI。
- 离线路由、审批失效、持久化和端到端状态测试。

### Changed

- legacy plan 现在分别审批 `readFiles`、`writeFiles` 和 `dataClassification`；`allowedFiles` 仅由 `writeFiles` 派生用于兼容/post-hoc 检查，三者变化都会使审批失效。
- broad `list_files` 和 generic `write_file` 已从 Direct DeepSeek Adapter 删除；代码 capability 只在 `EXECUTE/REPAIR` 开启，非 public 或非代码注入 filesystem grant 均在 credential/fetch 前失败。
- S4 MVP 明确拒绝 rename、delete、多文件 batch、binary、CRLF、问号 glob 和超限文件，不以扩大 writer 权限绕过 TODO-01。
- 当前 Orchestrator 的 EXECUTE/VALIDATE/REVIEW/REPAIR/SOL_DIAGNOSIS 工作目录统一为批准的 detached isolated worktree；主 workspace 仅用于捕获和复核基线。
- legacy approval 与 S2 execution approval hash 增加 isolation hash 绑定，并在 provider attempt 前经过 `APPROVED → WORKTREE_READY → EXECUTING`。
- worktree 证据不足、主 workspace snapshot 漂移、非 owned/dirty cleanup 均失败关闭并保留诊断区；不使用 force cleanup、自动 stash 或 reset。
- 当前 Orchestrator 的 planning/execution/validation/review/repair/diagnosis adapter 调用统一接入 S2 attempt executor；重复或并发 approve 不再重复调用 provider。
- provider 响应原文、reasoning、绝对用户路径和 credential-shaped 错误不再进入长期状态；持久化错误只暴露脱敏逻辑操作。
- read scope 与 write scope 在 S1 合同中彻底分离；旧 `allowedFiles` 只作为 Phase 0 兼容字段保留。
- `task-packet.schema.json` 和 `run-report.schema.json` 降为新 TaskPackage/EvidenceBundle schema 的兼容别名。
- S0 默认安装、Router Terminal、CLI help 和快捷方式只宣传 Orchestrator；`live-benchmark` 仍仅保留为显式命令。
- native provider switch 与 DeepSeek profile 安装脚本移至 `scripts/deprecated-experimental/native-codex/`，不再位于默认脚本区或默认调用链。
- 项目主路线从 Desktop/native provider 切换收敛为 Orchestrator-first：GPT 常驻前台，DeepSeek 只做后台受控执行。
- README 和 Roadmap 改为以 `docs/16` 的 S0–S10 为当前执行基线。
- 明确 worktree 只是变更隔离边界，真实权限安全还需要 capability/sandbox。
- 明确不能绝对保证供应商未重复计费；未知发送结果进入 `AMBIGUOUS/BLOCKED`。

### Deprecated

- Desktop provider hot switch、native DeepSeek menu/profile 和 Restore OpenAI 已从默认方案退役。保留的实验脚本不受支持，不得用于 S0-S9 验证。

## [0.1.0] - 2026-08-11

### Added

- 初始方案归档：架构、路由策略、上下文治理、质量门与实施路线图。
- 验证、事件、决策与成本基线模板。
- 不含密钥的配置和数据格式示例。

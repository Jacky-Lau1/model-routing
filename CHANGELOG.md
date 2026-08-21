# 变更日志

本项目采用 Keep a Changelog 的记录方式；日期为北京时间。

## [Unreleased]

### Added

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

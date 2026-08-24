# 变更日志

本项目采用 Keep a Changelog 的记录方式；日期为北京时间。

## [Unreleased]

### Added

- Part 1 离线工程闭环：canonical quality gate 运行时加载严格 schema 校验、hash-bound `QualityGatePolicy` 与 trusted command catalog，executable/argv/cwd/timeout/output/wall limits 与 catalog hash 进入 `QualityGateApprovalBoundary`；visible tests、本地 hidden acceptance、scope/secret/diff/freeze 结果并入 self-hashed `QualityAcceptanceProjection`。
- 本地 hidden acceptance（`src/hidden-acceptance.ts`）：hidden tests/reference answer 位于模型不可读、不可外发的本地 root，只返回 bounded/redacted counts 与 opaque diagnostic hash；policy/catalog/command/fixture/base commit 变化使旧批准失效；默认空质量门不得用于真实 Pilot。
- exact informed approval（`RouterApprovalSummary`）：prepare 摘要显式绑定 task/goal/TaskPackage hash、provider/adapter/model/endpoint/protocol/auth alias/reasoning、pricing version/hash/validity、classification/read-write scope、egress paths/content hashes/authorization/expiry、attempt/request/token/tool/wall/cost ceilings、roots、base commit/snapshot/isolation、hidden-data exclusion、redirect/escalation/retry/apply/commit/push 限制、stop conditions 与 approval expiry；任何字段变化生成新 hash 并在 provider side effect 前要求重新批准。
- `PilotRunRecord`（`src/pilot-report.ts` + `materializePilotRecord`/`pilotReport` + MCP `router.pilot_report` + CLI `route router pilot-report`）：从 persisted state、AttemptRecord、EvidenceBundle、quality acceptance 与 Final Review 自动派生，调用者不得自由声明 success/usage/cost/violation/recommendation；原子持久化、self-hashed、绑定当前 EvidenceBundle，拒绝 tamper/replay；GPT telemetry 不可得时保留 null 与 `core_metrics_unavailable`，不写零或猜测。
- 可安装离线候选：MCP 从编译产物启动、不依赖仓库 cwd 下的 tsx/devDependencies；`src/distribution.ts`、`src/installation.ts`、`src/doctor.ts` 与 `distribution_root` 消除用户名/OneDrive/AppData/bundled runtime 硬编码；提供 `config-preview`、`install --dry-run`、`uninstall --dry-run`、`doctor`、`pricing-verify`、`credential-status`；doctor 验证 build hash、roots、schema/policy/catalog、pricing expiry、credential alias availability、MCP block、enabled tools、state 可写性与 main workspace snapshot；uninstall 只删除 exact hash-matched block、配置漂移拒绝覆盖。
- Part 1 测试（`test/part1-quality-gate.test.ts`、`test/part1-installation.test.ts`）：覆盖 visible/hidden pass/fail、hidden 泄漏、policy/catalog/executable/argv/hash 篡改、timeout、overflow、进程树、gate 修改 worktree、fixture/base commit 变化、roots 重叠、config/state 损坏、main workspace 不变，以及临时 Codex home 中 install → discovery → doctor → rollback。
- 三部分 Agent Team 闭环入口与独立可复制 Prompt：离线工程闭环、真实链路/降费证明、日常能力硬化/发布验收；Part 2 固定以同质量下总可审计成本下降至少 30% 为硬门。
- 当前阅读路径收敛为 README → ROADMAP → docs/16 → docs/17 → 当前 Part Prompt；S1–S9 文档保留为技术规格/证据，不再要求每个新 agent 重复全读。

- S10 前置整改：EvidenceBundle v3 与 per-transport-round usage/cache/request/wall/cost 证据，versioned peak/off-peak pricing catalog 及 RouteBinding approval 绑定，逐轮 pre-send/response 后累计预算失败关闭。
- 版本化 Pilot run/pair schema、human intervention taxonomy、30% cost/quality/safety 固定决策门与 tamper/replay 测试；foreground GPT 核心 telemetry 不可得时明确 `null` 并停止扩展。
- 无真实配置写入的 Codex STDIO MCP 注册预览、进程环境 allowlist、临时 Codex-home `tools/list` discovery 测试、exact S10a TaskPackage/RouteBinding/policy 模板与 GPT-only ADR。

- S9 零费用端到端认证套件：临时 synthetic repo/state/worktree/MCP、mock auth/fetch/provider/reviewer/local command，覆盖 privacy、Flash/Pro 与 route mismatch、provider/crash/ambiguous、duplicate、scope/budget、secret/quality、repair/apply、redaction 和 cleanup；26/26 定向、25 files 368/368 全量通过。
- S9 专项证据文档 `docs/26-s9-zero-cost-e2e-certification.md`；S0–S9 完成后状态仅提升为 `eligible for limited live Pilot`，S10 真实运行仍需当次明确授权。

- S8 foreground Final Review 严格三态 `PASS | REPAIR_REQUIRED | BLOCKED`；PASS 只进入 `APPLY_PENDING`，不自动写主 workspace。
- 一次 controlled repair：复用原 TaskPackage、RouteBinding、ApprovalRecord、provider/model、预算、scope 与 content-hash egress，持久化独立 round/attempt 并生成新 EvidenceBundle；任何 binding 变化失败关闭并要求新审批。
- 显式 `router.apply` CLI/MCP：apply 前复核 main snapshot、dirty overlap、当前 bundle/worktree snapshot、目标 TaskPackage preimage 与 reviewed postimage；成功只留下未提交 workspace edit，不 commit、merge 或 push，重复 apply 幂等返回。
- S8 mock reviewer/synthetic repo 测试覆盖 review unavailable、repair 成功/失败、scope/approval 变化、main workspace 漂移、预存 dirty target 与 duplicate apply；专项文档 `docs/25-s8-final-review-repair-apply.md`。

- S7 canonical `RouterCoreService` 与外置原子状态：最小 TaskPackage 经 user/project policy 交集生成 immutable RouteBinding、ExecutionContext、ApprovalRecord，批准绑定 compact summary hash。
- 结构化 `route router prepare/execute/status/abort/review-evidence/finalize` CLI、同核心的六工具 newline-delimited JSON-RPC STDIO MCP，以及只说明调用顺序、不复制安全判断的 `.agents/skills/codex-router/SKILL.md`。
- S7 canonical provider/request evidence provenance、EvidenceBundle 引用与前台 final review hash 绑定；finalize 只记录 `PASS/BLOCKED`，保留隔离 worktree，不 apply 主 workspace。
- S7 mock/synthetic 测试覆盖单 GPT 前台会话全流程、exact approval/evidence hash、幂等单发送/finalize、终态保护、abort、private capability fail-closed、chat-shaped extra field 拒绝、legacy fingerprint 兼容、结构化 CLI 持久状态等价和 provider/config/auth sentinel 不变；全量 23/23 files、335/335 tests。
- S7 专项证据文档 `docs/24-s7-foreground-interface.md` 与不含密钥的 user/project policy、route profile 示例。

- S6 固定命令目录与顺序化 Local Quality Gate：物理 scope/forbidden path、baseline-aware secret scan、raw diff sanity、check-only 命令和最终 freeze。
- 外置 content-addressed diff artifact、完整 request-bound/self-hashed QualityGateReport，以及带 attempt/route/gate/usage/cost/risk 摘要的 EvidenceBundle v2。
- S6 synthetic 攻击与生产 runner 回归，覆盖 symlink 越界、Git index flags/lazy-fetch、baseline secret、raw-size redaction bypass、artifact mutation/oversize/final forbidden refresh、report replay/tamper、总 wall budget、production timeout/overflow 进程树终止和 usage unavailable。
- S6 专项证据文档 `docs/23-s6-quality-evidence.md`。
- S5 canonical/legacy RouteBinding 深度 clone/freeze 与 exact cross-field preflight，固定 provider、adapter ID、model family、origin/path、protocol、auth alias、reasoning、budget 和 capability scopes。
- Direct DeepSeek 逐轮 transport observation：分别记录 body response ID 与 allowlisted header request ID，核对 exact response URL/model/status，manual redirect 一律拒绝；observable route tuple 与不可观测 DNS peer/proxy 明确分层。
- S5 synthetic/mock 攻击矩阵与专项交接文档 `docs/22-s5-route-preflight.md`，覆盖 tuple、endpoint/path、redirect、request-ID、多轮工具、approval、registry 和 Codex CLI 证据负例。
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

- canonical EXECUTE 与 REPAIR 现在都在任何 structured patch apply 前核对累计 provider-reported input/output usage 和 attempt budget；首次执行超预算进入 `response_invalid → AMBIGUOUS/BLOCKED`，不会写 worktree 或自动重发。

- provider request fingerprint 与 route evidence 断言收敛为 core/legacy 共用实现；route preflight 显式区分 `canonical` 与 `legacy_bridge` provenance，旧路径预算语义保持不变。
- Attempt executor 增加共享执行锁保护的 awaiting-approval 初始化、foreground final review 与 abort primitive，供 canonical core 使用且不复制发送/恢复安全逻辑。
- 质量门 Git 证据改为只读 `git ls-files --stage -z`，不再使用会写共享 object store 的 `git write-tree`；raw diff 在脱敏前执行 byte ceiling。
- 命令证据增加 bounded/redacted diagnostics 与 timeout/overflow 标记；未变化的 baseline secret 不再阻断可审查的脱敏 diff，新出现或重复增加的 finding 仍失败关闭。
- EvidenceBundle 从 S1 合成基线 v1 明确升级为 v2；usage 不可得使用 `null`，不再伪装为数值零。
- legacy plan、approval 与 request fingerprint 现在绑定 immutable RouteBinding；hash-valid route mismatch 在 S2 `PREPARED` 的 local preflight 中持久化为 `FAILED_BEFORE_SEND`，credential resolver/fetch 均为零。
- DeepSeek endpoint 不再接受 invoke-time base URL；credential 只按 approved alias 解析且不在 env/DPAPI 间自动回退。同一冻结请求的有效 credential 在 prepare/invoke 防御性预检链中只解析一次。
- Provider registry 要求稳定 adapter ID。Direct response 缺失/冲突证据保持 request ID 为 `null` 并进入 `response_invalid → AMBIGUOUS/BLOCKED`；Codex CLI 不再把通用 event/item ID 或批准 model 伪造成实际证据，bound transport 不可观测时 spawn 前停止。
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

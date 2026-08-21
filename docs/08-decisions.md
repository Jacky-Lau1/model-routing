# 08｜架构决策记录（ADR）

## ADR-001：保留 Codex Desktop 作为主工作台

- 日期：2026-08-11
- 状态：接受
- 决策：用户在 Codex Desktop 中发起和掌握任务；GPT-5.6 Sol 负责高价值规划与最终验收。
- 原因：保留现有工作方式和强模型判断；不把整个工作流迁移到独立代理运行时。
- 后果：需要额外验证 Desktop 与外部执行桥接的组合兼容性。

## ADR-002：关键路由使用确定性控制层

- 日期：2026-08-11
- 状态：接受
- 决策：不把原生自动委派是否调用指定模型作为唯一控制机制。
- 原因：运行时角色选择、模型版本和自定义提供商兼容性可能变化；必须可审计、可失败关闭。
- 后果：未来需实现/选择一个小型控制层，并承担其维护成本。

## ADR-003：默认失败关闭，不静默回退

- 日期：2026-08-11
- 状态：接受
- 决策：无法证明目标模型、调用失败或测试失败时，停止或显式升级至 Sol。
- 原因：否则成本、质量和“谁做了工作”都不可审计。
- 后果：可用性会低于无约束自动回退，但更可控。

## ADR-004：跨模型传递任务包而非全量对话

- 日期：2026-08-11
- 状态：接受
- 决策：以结构化任务包、摘要和持久状态作为交接媒介。
- 原因：各模型上下文能力不同；最小上下文可降低成本、泄露面和幻觉。
- 后果：任务包和摘要质量成为核心工程资产。

## ADR-005：Orchestrator-first 取代 Desktop provider 切换

- 日期：2026-08-20
- 状态：接受
- 决策：Codex/GPT 始终保持用户前台；DeepSeek 只通过独立 Direct Adapter 在后台执行。Desktop provider hot switch、原生 DeepSeek 菜单和 Restore OpenAI 不再属于默认路径。
- 原因：模型、provider、auth 和线程状态无法由外部脚本可靠原子绑定；项目级 Codex 配置也不能覆盖机器本地 provider。
- 后果：S0 必须退役旧入口；GPT 前台改由窄 CLI/MCP 工具连接 Orchestrator。

## ADR-006：worktree 负责变更隔离，capability/sandbox 负责权限安全

- 日期：2026-08-20
- 状态：接受
- 决策：DeepSeek 和质量门只在每个 run 独立 worktree 或等价 checkout 中工作；不直接写主 working tree。worktree 不被描述为完整安全 sandbox。
- 原因：worktree 可以隔离变更、验证和 apply，但共享 Git object store，不能阻止拥有任意文件权限的进程访问其它目录。
- 后果：还必须实现 read/write/network/environment/command scope、最小子进程环境和可验证的 OS/capability 边界。

## ADR-007：隐私采用数据分类与外发授权双维模型

- 日期：2026-08-20
- 状态：接受
- 决策：数据分类至少区分 public、private、secret/restricted；egress policy 独立记录是否允许向特定 provider 发送特定路径/内容。默认禁止第三方。
- 原因：`PRIVATE_THIRD_PARTY_ALLOWED` 等单一枚举会把数据固有敏感度和一次性授权混在一起，难以表达 provider、任务、内容和有效期范围。
- 后果：项目 policy 只能作为权限上限；private repo 可在明确授权后发送最小片段，但分类仍为 private。

## ADR-008：可能已经计费的未知调用进入 AMBIGUOUS/BLOCKED

- 日期：2026-08-20
- 状态：接受
- 决策：任何外部调用前持久化 attempt。timeout、reset、stream interruption 或 response lost 等无法证明服务端未执行的情况标记 AMBIGUOUS，并禁止自动重发。
- 原因：客户端无法绝对证明供应商没有执行或计费，不能承诺 exactly once。
- 后果：用户可能需要显式决定重新执行；本地重复 approve 仍必须幂等。

## ADR-009：RouteBinding 与执行、审批、attempt 分层

- 日期：2026-08-20
- 状态：接受
- 决策：RouteBinding 冻结 provider、adapter、model、endpoint、auth、protocol、reasoning、budget 和 scope；base/workspace 放 ExecutionContext；审批和 attempt 使用独立记录并通过 hash 关联。
- 原因：把 approval hash、workspace snapshot 和 route 身份混进同一个 tuple 会造成生命周期混乱和循环哈希。
- 后果：任一被审批对象变化都会使批准失效；route evidence 不能仅由 adapter 自报。

## ADR-010：核心 service/CLI 先稳定，MCP 和 skill 做薄接入

- 日期：2026-08-20
- 状态：接受
- 决策：先稳定可测试的 Orchestrator core 和结构化 CLI，再在同一核心上增加 STDIO MCP 和 thin skill。App Server/SDK 暂不进入 MVP。
- 原因：目标是保留当前 Codex GPT 主会话并增加窄工具，而不是开发新的 Codex 客户端或复制状态机。
- 后果：MCP/skill 不能承载安全逻辑；配置注册需要单独授权且不得修改 provider。

## ADR-011：Direct Adapter 是首个 DeepSeek Executor

- 日期：2026-08-20
- 状态：接受
- 决策：MVP 使用 Direct DeepSeek API Adapter；Aider、native DeepSeek Codex profile、多 agent 和并行 worker留到 P2。
- 原因：Direct Adapter 最容易验证实际 payload、endpoint、request ID、用量和工具范围。
- 后果：第一版能力会更保守；是否采用 patch proposal 或受限 writer 按 `docs/16` TODO-01 的实测结果调整。

## ADR-012：旧 native Codex 脚本移入 deprecated experimental

- 日期：2026-08-21
- 状态：接受
- 决策：按 `docs/16` TODO-07 当前默认，保留 native provider switch 与 DeepSeek profile 安装代码，但移入 `scripts/deprecated-experimental/native-codex/`。默认安装器、Router Terminal、CLI help 和快捷方式不得引用它们，也不提供 Restore OpenAI。
- 原因：这些脚本仍可用于协议兼容性考古，但会改写共享 Codex 配置或 profile/catalog，误用风险高；现阶段直接删除会丢失已知故障的可复现材料。
- 后果：实验脚本不进入正常测试和支持路径；只做 PowerShell 语法解析，不执行。Direct Adapter 完成必要协议验证且不再有复现价值后，按 TODO-07 删除。

## ADR-013：S1 合同使用严格 snake_case 线协议和规范化哈希

- 日期：2026-08-21
- 状态：接受
- 决策：TaskPackage、RouteBinding、ExecutionContext、ApprovalRecord、AttemptRecord、EvidenceBundle、UserPolicy 和 ProjectPolicy 使用独立的 snake_case 线协议；对象拒绝未知字段，并以 locale 无关的 UTF-16 code-unit 键顺序、保留数组顺序的规范化 JSON 计算 SHA-256。自身 hash 字段不参加自身哈希。
- 原因：现有 `PlanPacket + RouteDecision + allowedFiles` 混合了任务、路由、权限和预算，且旧 canonical 使用 locale 排序，无法给跨组件审批提供足够稳定、完整的绑定。
- 隐私后果：未分类、无显式 user egress allow、过期授权和 `secret_restricted` 均不能构造 DeepSeek binding；`PRIVATE_THIRD_PARTY_ALLOWED` 只能作为便利输入规范化为 private + 独立 allow policy。
- Policy 后果：project policy 只做 user policy 的 scope/egress 交集和更低预算；user deny 不能被仓库 policy 覆盖。无法保守证明 glob 子集时失败关闭。
- 兼容后果：Phase 0 `PlanPacket`、`RouteDecision`、`LegacyApprovalRecord` 和 provider 调用暂不迁移；S1 不改变真实执行路径，后续阶段必须显式接入新合同。

## ADR-014：S2 使用稳定 attempt ID、task/approval 文件锁与保守崩溃恢复

- 日期：2026-08-21
- 状态：接受
- 决策：attempt ID 由 task、approval hash、stage、round 稳定派生；同一 task/approval 使用原子目录锁。`PREPARED` 和 `SENDING` 必须在调用前原子落盘，完整响应验证后才写 `SUCCEEDED`。重启发现 `SENDING` 一律改为 `AMBIGUOUS/BLOCKED`，不自动重发。
- 原因：本地无法证明 timeout、reset、response lost 或崩溃边界之后供应商没有执行；稳定 ID 和锁可以防止本地重复副作用，但不能承诺供应商 exactly-once。
- repair：round 至少为 1，因此创建新 attempt 并保留历史；幂等键相同但 request fingerprint 不同则失败关闭。
- 持久化：同目录临时文件同步后 rename；Windows 短暂共享冲突只允许有限重试本地 rename，永不因此重试 provider。状态和错误统一脱敏，不保存 response body、raw payload 或 reasoning。
- 兼容：S1 AttemptRecord 字段和 schema 未修改；Phase 0 工作流重命名为 `LegacyWorkflowState`，当前 Orchestrator 调用接入 S2 executor，完整 core/CLI 合同迁移仍属于 S7。

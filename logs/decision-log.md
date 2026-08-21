# 决策日志

## 2026-08-11｜初始化方案归档

- 决策：优先选择“Codex Desktop + Sol 规划/审查 + 确定性外部执行桥接”的路线。
- 证据：原生自动委派与自定义模型组合仍需逐版本实测；因此不能作为唯一的成本/质量控制机制。
- 当前状态：未实施，未选择任何国内提供商或执行模型，未保存任何凭据。
- 下一步：未来从 Phase 0 兼容性实验室开始。
- 影响：所有关于成本、兼容性和自动化程度的结论均为待验证假设。

## 2026-08-20｜收敛为 Orchestrator-first

- 决策：用户始终使用常驻 GPT 模型的 Codex 主会话；DeepSeek 只通过 Direct Adapter 做后台受控执行；Desktop provider hot switch、native menu 和 Restore OpenAI 从默认路线退役。
- 证据：Draft PR 的 switcher 会改写共用 Codex provider/config；已发生过 DeepSeek model 请求进入 OpenAI endpoint 的真实错配。OpenAI 当前配置文档说明 provider 是机器本地配置，项目配置不能覆盖 `model_provider` / `model_providers`。
- 当前状态：架构决定已接受，S0 代码退役尚未实施。
- 影响：旧 native profile/switch 只能删除或标记 deprecated experimental，不继续修补为主入口。

## 2026-08-20｜采纳外部架构评审并修正五处表述

- 采纳：isolated worktree、真实 capability scope、ambiguous paid-call、强化 RouteBinding、endpoint mismatch 回归、project policy、MCP + thin skill、TaskPackage、EvidenceBundle、三态 Final Review、Direct Adapter 和阶段化 Pilot。
- 修正 1：worktree 是变更/验证/合并隔离，不是完整安全 sandbox。
- 修正 2：隐私底层使用数据分类 + 外发授权，而不是把 private 和一次性第三方授权混成单一枚举。
- 修正 3：RouteBinding 不内嵌 approval hash、base commit 和 workspace snapshot；这些由独立对象通过 hash 绑定。
- 修正 4：actual cost 只有供应商或账单可证明时才记录；公开费率计算只标 estimated/equivalent。
- 修正 5：WorkflowState 和 AttemptState 分层，避免主状态机状态爆炸。
- 当前状态：详细默认和替代方案已记录于 `docs/16` 的 TODO-01 至 TODO-18，等待各阶段实测后迭代。

## 2026-08-20｜一个阶段一个新对话

- 决策：S0–S10 每个阶段使用独立 Codex 主会话，只有上一阶段门通过后进入下一阶段。
- 原因：降低一次性 diff 和审查复杂度，防止在安全基础未完成时提前实现 MCP、Aider、并行或真实 Pilot。
- 执行入口：`docs/17-orchestrator-first-stage-handoffs.md`。
- 当时状态：阶段计划已形成；S0 尚未开始。后续完成状态见 2026-08-21 条目。

## 2026-08-21｜S0 退役默认 native provider 入口

- 决策：默认快捷方式安装器和 Router Terminal 只保留 Orchestrator；CLI help 使用 Orchestrator-first 表述。Restore OpenAI、native DeepSeek Flash/Pro 与无 profile OpenAI Codex 不再是默认入口。
- TODO-07 处理：native switch/profile 安装代码移入 `scripts/deprecated-experimental/native-codex/`，不删除。
- 保留理由：作为已知 provider/model/endpoint 错配的协议兼容性考古材料；默认路径不引用、不执行、不支持。
- 删除条件：Direct Adapter 完成所需协议验证，且这些脚本不再提供可复现价值。
- 验证：临时目录、mock shortcut backend、dry-run、PowerShell parser、CLI/Terminal help、TypeScript typecheck 和 28 个离线测试通过；未运行 API、benchmark 或安装。
- 当前状态：S0 阶段门通过；S1 可开始。

## 2026-08-21｜S1 冻结合同、隐私与 schema

- 决策：六类跨组件对象使用独立 snake_case 线协议；RouteBinding 不内嵌 approval hash，base/workspace evidence 只进入 ExecutionContext。
- Hash：对象键使用 locale 无关的 UTF-16 code-unit 顺序，数组保序，拒绝无法规范化的值，自身 hash 字段不参加自身哈希。
- 隐私：底层只持久化 `data_classification + egress_policy`；未分类、无 user allow、授权过期和 `secret_restricted` 禁止 DeepSeek。便利输入 `PRIVATE_THIRD_PARTY_ALLOWED` 立即拆成 private + provider/path/content-hash allow。
- Policy：project policy 只能提交 user scope 的子集、更低或相同预算和 egress 交集；user deny 永远优先。无法证明 glob 收窄时失败关闭。
- 兼容：旧 PlanPacket/RouteDecision/allowedFiles/provider invoke 不在 S1 迁移，避免提前实施 S2–S5；新合同尚未连接真实执行链。
- 验证：TypeScript `--noEmit` 与 42/42 离线测试通过；JSON Schema 和 hash-valid examples 只含合成数据，未读取 env/config/credential，未调用 API。
- 当前状态：S1 阶段门通过；S2 可开始。

## 2026-08-21｜S2 attempt 检查点、幂等锁与保守恢复

- 决策：WorkflowState 与 AttemptState 独立；task/approval 使用原子目录锁，attempt ID 稳定绑定 stage + round，重复请求返回既有记录。
- Checkpoint：provider 调用前依次持久化 PREPARED、SENDING；只有响应完整、provider/model 基础证据和阶段结构验证后写 SUCCEEDED。
- 失败：可证明未发送的本地错误才写 FAILED_BEFORE_SEND；timeout/reset/response lost、响应验证失败和重启遗留 SENDING 写 AMBIGUOUS，并使 workflow BLOCKED。
- Repair：round >= 1 创建新 attempt，不覆盖历史；不同 fingerprint 复用同一幂等键时失败关闭。
- 存储与隐私：临时文件 sync + rename；只对 Windows rename 共享冲突做有限本地重试。状态/error 统一脱敏，不持久化 response body/raw/reasoning 或用户绝对路径。
- 兼容：未修改 S1 AttemptRecord 字段/schema；当前 Orchestrator adapter 调用已接入 S2 executor，未实现 worktree、MCP、endpoint/auth 强证明或真实 API。
- 当前状态：S2 阶段门通过；S3 可开始。

## 2026-08-21｜S3 isolated worktree、dirty evidence 与归属保护

- 决策：每个批准执行使用 repository identity、完整 base commit、main workspace snapshot、dirty evidence、plan hash 和 run ID 派生 isolation hash 与逻辑 worktree ID；legacy approval/S2 approval hash 显式绑定该 isolation hash。
- 基线：dirty evidence 使用 NUL-safe Git status 捕获 modified/added/deleted/renamed/untracked，相对路径稳定排序，现存文件按原始字节计算 SHA-256。rename 在线 evidence 记录 destination，内部 snapshot 同时绑定 original path；dirty 内容不自动 overlay。
- 生命周期：默认 state/managed roots 外置且不得位于目标 repo/common Git dir 内或彼此重叠；`PREPARING` 在 `git worktree add --detach` 前落盘；owner record、owned root、common Git dir、linked `.git`、完整 HEAD、detached 与 clean status 全部匹配后才进入 `READY`。三个创建检查点中断均可在证据匹配时幂等恢复；不完整、dirty、attached 或冲突证据进入 `BLOCKED` 并保留。
- 接入：当前 EXECUTE、VALIDATE、REVIEW、REPAIR、SOL_DIAGNOSIS 都接收同一个隔离 checkout；workflow 经 `APPROVED → WORKTREE_READY → EXECUTING`。完成前主 workspace snapshot 再验证，漂移则 BLOCKED。
- cleanup：正常完成默认 `RETAINED`；只有显式、clean、owner/common-dir/base/路径均验证的 checkout 才使用非 force `git worktree remove`。dirty、unknown、partial、owner 篡改和 junction/symlink 替换均拒绝，不调用 stash、reset、prune、force remove 或递归删除未证明归属的目录。
- cleanup：先持久化 `REMOVING`，仅非 force 移除 verified clean checkout，持久化 `REMOVED` 后才清理 owner sidecar；REMOVING/GIT_REMOVED/REMOVED 三个中断点均可恢复。
- handoff：filesystem lock 绑定 approval/PID/nonce，覆盖 durable bind、prepare、`WORKTREE_READY` 与 legacy `EXECUTING` 持久化；live owner 竞争不进入 prepare，dead/ownerless owner 只在证据匹配时原子隔离回收；release 先原子移走 active target 再清理 quarantine。
- 验证：TypeScript `--noEmit` 和 116/116 离线测试通过；覆盖 clean/dirty/untracked/rename/delete、base/ref、创建/清理中断、同步并发审批、跨 Router handoff、dead/ownerless/release-race recovery、auto/approve pre-write/junction root containment、READY residual、scope 双状态、同路径冲突、worktree `dist/` 隔离、cleanup ownership 和 Orchestrator 目录接入。全部为系统临时目录 synthetic repo 和 mock provider，未联网、未读真实 config/auth/DPAPI/env/credential，未运行 API/benchmark。
- 边界：S1 六类合同/schema 未修改；worktree 不是 OS sandbox，S4 capability boundary 尚未实现；dirty overlay 仍为 TODO-02；S3 只提供 apply 前冲突 primitive，不执行 S8 apply。
- 当前状态：S3 阶段门通过；S4 可开始。

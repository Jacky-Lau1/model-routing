# 16｜Orchestrator-first 最终实施计划与阶段门

> 状态：已接受的实施基线；尚未完成下述代码整改和规定的真实验证。
>
> 更新时间：2026-08-20。
>
> 本文把 `docs/14-orchestrator-first-proposal.md`、外部评审建议和对 Draft PR #1 的代码复查合并为一条可分阶段执行的路线。每个阶段都应在独立 Codex 主会话中完成，并在通过阶段门后再进入下一阶段。

## 1. 最终目标体验

用户始终只使用常驻 GPT 模型的 Codex 主会话或 Agent 终端。GPT 是 Supervisor，负责需求理解、规划、架构判断、风险控制、最终 diff 审查和结果说明。DeepSeek 只作为后台受控执行器。本地 Orchestrator 是确定性控制面，不是第三个自由发挥的 Agent。

```text
User
  ↓
Codex GPT Supervisor
  ↓
Frozen TaskPackage + Approval
  ↓
Local Orchestrator
  ↓
Isolated Worktree + Restricted DeepSeek Executor
  ↓
Local Quality Gate
  ↓
EvidenceBundle
  ↓
Codex GPT Final Review
  ├─ PASS
  ├─ REPAIR_REQUIRED
  └─ BLOCKED
```

正常流程不得：

- 切换 Codex Desktop 全局 provider；
- 修改主 Codex 的 `config.toml`、`auth.json` 或 model catalog；
- 依赖原生模型菜单显示 DeepSeek；
- 要求用户执行 Restore OpenAI；
- 让 DeepSeek 直接写用户主 working tree；
- 让 DeepSeek 获得任意 shell、任意网络、用户 HOME 或完整环境；
- 在调用状态不明时自动重发可能计费的请求；
- 让执行模型自行宣布任务已经通过。

## 2. 当前成熟度

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 确定性路由策略 | Implemented / offline tested | 已有分类、阶段路由和预算测试，但策略将因隐私默认拒绝而调整 |
| 审批哈希 | Implemented / insufficient binding | 只绑定了部分 route 字段，未覆盖 endpoint/auth/protocol/data scope |
| DeepSeek Direct Adapter | Implemented / mock tested | 当前可读写目标目录；缺少独立 read scope、强 endpoint 断言和工作区隔离 |
| Codex CLI planning/review | Implemented / architecture mismatch | 后台另起 Codex，不等于当前 GPT 主会话承担 Supervisor |
| 主 working tree scope guard | Implemented / post-hoc only | 越界后才能发现，不能防止主目录污染 |
| 低写入状态持久化 | Implemented / incomplete crash semantics | 外部调用前检查点不足，重复 approve 可能重复执行 |
| 原生 DeepSeek 菜单/profile | Implemented experiment / deprecated as default | 与 Orchestrator-first 正常体验冲突 |
| Isolated worktree | Design only | 尚未实现 |
| Real sandbox/capability boundary | Design only | 尚未实现 |
| Immutable RouteBinding | Design only | 尚未实现 |
| Ambiguous paid-call handling | Design only | 尚未实现 |
| EvidenceBundle | Design only | 尚未实现 |
| GPT foreground MCP/skill | Design only | 尚未实现 |
| Project policy | Design only | 尚未实现 |
| Orchestrator-first live validation | Not run | 旧架构的真实调用不能替代新架构验证 |

在所有阶段门和规定的真实验证完成前，不得称为 production ready。

### 2.1 2026-08-20 官方文档基线

本计划重新核对了以下 OpenAI 官方资料：

- Codex config reference：项目级 `.codex/config.toml` 不能覆盖机器本地 `model_provider` / `model_providers`；provider 的 base URL、auth 和 wire API 是独立字段。<https://developers.openai.com/codex/config-reference>
- Codex non-interactive mode：`codex exec --ephemeral` 只是不持久化 session rollout，JSONL 可供脚本消费；它不等同于本项目所需的完整文件/网络安全边界。<https://developers.openai.com/codex/noninteractive>
- Codex MCP：Codex 支持本地 STDIO MCP，因此可以在不切换 provider 的前提下为当前 GPT 主会话增加窄 Router 工具。<https://developers.openai.com/codex/mcp>
- Codex App Server：提供更宽的 JSON-RPC、线程和审批控制面；WebSocket 部分仍有实验性边界，本项目 MVP 暂不使用。<https://developers.openai.com/codex/app-server>
- Codex SDK：适合独立应用、CI/CD 或内部工具中的 Codex 线程控制；当前目标不是重建主 Agent，因此暂缓。<https://developers.openai.com/codex/sdk>

后续每个涉及 Codex 集成的阶段都要重新核对当前官方文档，不能把本日期的行为当作永久承诺。

## 3. 已接受的架构决定

### 3.1 保留

- Codex/GPT 作为唯一用户前台和最终责任者；
- 确定性 `RouterOrchestrator`；
- 结构化任务包和规范化哈希；
- 明确审批边界；
- DeepSeek Direct API Adapter；
- 本地验证和文件范围检查；
- 默认失败关闭，不静默 provider fallback；
- 一次受控修复的上限思想；
- 脱敏、低写入的状态和证据；
- 公开/合成任务优先的 Pilot。

### 3.2 修改

- 从“在主 working tree 中受限写入”改为“隔离 worktree 中受限执行，最终显式应用”；
- 从提示词只读改为代码和 OS/capability 共同强制只读；
- 从 `RouteDecision` 改为分层的 RouteBinding、ExecutionContext、ApprovalRecord 和 AttemptRecord；
- 从关键词推断 `normal` 改为未分类默认拒绝第三方；
- 从单一隐私枚举改为“数据分类 + 外发授权”双维模型；
- 从 provider 调用异常直接抛出改为持久化 attempt 和 `AMBIGUOUS/BLOCKED`；
- 从 adapter 自报 route evidence 改为多源可核对证据；
- 从后台 Codex CLI 独立规划/审查改为当前 GPT 主会话准备任务包并做最终 Review；
- 从等价价格单一指标改为 reported/estimated/invoice/quota 分离。

### 3.3 从默认路径移除

- Desktop provider hot switch；
- 自动改写 `~/.codex/config.toml`；
- 自动 Restore OpenAI；
- DeepSeek 模型目录注入；
- 默认安装 native DeepSeek Flash/Pro 入口；
- DeepSeek unrestricted shell/network；
- 自动 merge、自动 commit 到用户主分支；
- timeout 后自动重发 LLM 请求；
- 自动 Flash → Pro → GPT 扩权式升级；
- Aider、多个 DeepSeek agent、并行 worker。

## 4. 安全边界

### 4.1 GPT Supervisor

可以：

- 与用户交互；
- 读取用户明确放入当前 Codex 工作区的内容；
- 生成最小 TaskPackage；
- 审查最终 diff、质量门和 EvidenceBundle；
- 请求扩大范围、预算或外发授权；
- 返回 PASS、REPAIR_REQUIRED 或 BLOCKED。

不应：

- 把完整聊天或 hidden reasoning 放进 TaskPackage；
- 仅凭 DeepSeek 的文字摘要判定完成；
- 绕过 Orchestrator 直接为 DeepSeek 提供主工作区权限；
- 在用户未批准时扩大 provider、数据范围、写范围或预算。

### 4.2 Orchestrator

可以：

- 验证 TaskPackage、policy、ApprovalRecord 和 RouteBinding；
- 创建隔离 worktree；
- 解析、最小化并提供允许上下文；
- 调用批准的 provider；
- 应用结构化 patch 或在隔离 worktree 中执行受限写入；
- 运行本地质量门；
- 生成脱敏 EvidenceBundle；
- 在证据不足时失败关闭。

不应：

- 自行做开放式架构决策；
- 静默切换 provider；
- 自动扩大权限；
- 在 ambiguous 请求后自动重发；
- 自动覆盖主 workspace 的用户修改；
- 自动修改主 Codex 配置或认证。

### 4.3 DeepSeek Executor

第一版只可获得：

- TaskPackage 中批准的目标、约束和验收条件；
- `read_scope` 内经过最小化的代码片段；
- 狭窄的 `read_allowed_file` / `search_allowed_code` / `get_symbol_context` 能力；
- 结构化 `propose_patch`，或隔离 worktree 中范围受控的 writer；
- 固定 provider endpoint 的网络访问仅用于模型 API 本身。

明确不得获得：

- 用户主 working tree 的写权限；
- 任意 shell；
- 任意出站网络；
- 用户 HOME、`.ssh`、`.codex`、浏览器/GitHub 登录态；
- 完整环境变量；
- OpenAI key、其它 provider key 或凭据缓存；
- `.env`、私钥、生产 dump 和未经批准的源码；
- 自动 commit、push、merge 或发布能力。

### 4.4 Worktree 的准确定位

Git worktree 是变更、验证和合并控制边界，不是真正的安全 sandbox。它与主仓库共享 Git object store；若执行器拥有任意文件系统权限，仍可能访问其它目录。因此 worktree 必须和 capability adapter、最小子进程环境及可验证的 OS sandbox 组合使用。

## 5. 核心数据结构基线

以下为实施基线，不表示已经完成最终 schema。每一阶段可以在保持语义的前提下调整字段名和拆分方式，但调整必须记录 ADR。

### 5.1 TaskPackage

```text
version
task_id
goal
background_summary
acceptance_criteria[]
non_goals[]
forbidden_actions[]
allowed_read_paths[]
allowed_write_paths[]
relevant_interfaces[]
context_manifest[]
validation_requirements[]
stop_conditions[]
data_classification
egress_request
base_commit
created_at
task_package_hash
```

`context_manifest` 不默认内嵌整个文件；每项至少标识路径、片段/符号范围、内容哈希、来源、预计字节数和是否允许外发。实际发送 payload 必须再生成独立 manifest 和 hash。

### 5.2 RouteBinding

```text
version
provider_id
adapter_id
model_id
endpoint_origin
endpoint_path
wire_protocol
auth_alias
reasoning_mode
reasoning_effort
max_input_tokens
max_output_tokens
max_tool_calls
max_wall_time_ms
max_estimated_cost
billing_mode
read_scope
write_scope
network_scope
environment_scope
command_scope
route_binding_hash
```

RouteBinding 不内嵌 `approval_hash`，避免循环依赖。`base_commit` 和 workspace snapshot 属于 ExecutionContext，不属于 provider 身份本身。

### 5.3 ExecutionContext

```text
run_id
task_id
base_commit
main_workspace_snapshot
main_workspace_dirty_evidence
worktree_path_or_id
worktree_base
policy_hash
task_package_hash
route_binding_hash
created_at
```

路径在持久化和面向用户输出中应使用相对或逻辑标识；绝对用户路径默认不进入长期日志。

### 5.4 ApprovalRecord

```text
approval_id
task_id
task_package_hash
route_binding_hash
execution_context_hash
policy_hash
approved_scope_summary
approved_at
expires_at_or_null
```

任何被覆盖对象变化都会使 ApprovalRecord 失效。

### 5.5 AttemptRecord

```text
attempt_id
run_id
stage
round
request_fingerprint
status
prepared_at
send_started_at
completed_at
failure_class
provider_request_id
response_model
response_origin
usage
redacted_error
```

Attempt status 至少区分：

```text
PREPARED
SENDING
SUCCEEDED
FAILED_BEFORE_SEND
AMBIGUOUS
CANCELLED
```

### 5.6 EvidenceBundle

```text
version
bundle_id
run_id
task_id
task_package_hash
route_binding_hash
policy_hash
base_commit
worktree_head
attempt_summaries[]
route_evidence[]
files_changed[]
diff_hash
diff_reference
quality_gate_results[]
tests_run[]
scope_violations[]
privacy_violations[]
secret_scan_summary
usage_metrics
cost_metrics
wall_clock_time_ms
repair_count
remaining_risks[]
redaction_notes[]
bundle_hash
```

完整 diff 可以保留在本地受控位置；EvidenceBundle 默认记录 hash、统计和受控引用，避免在日志或第三方请求中无意复制敏感源码。

## 6. 双层状态模型

### 6.1 WorkflowState

```text
CREATED
PLANNING
AWAITING_APPROVAL
APPROVED
WORKTREE_READY
EXECUTING
VALIDATING
REVIEW_PENDING
REPAIR_REQUIRED
APPLY_PENDING
PASSED
BLOCKED
ABORTED
```

### 6.2 AttemptState

```text
PREPARED
SENDING
SUCCEEDED
FAILED_BEFORE_SEND
AMBIGUOUS
CANCELLED
```

Workflow 和 attempt 分离，避免每种 provider 调用状态污染主状态机。所有外部副作用必须先持久化相应 workflow/attempt 检查点。

### 6.3 Final Review

GPT Final Review 只能返回：

- `PASS`：验收条件满足，质量门和路由证据通过；
- `REPAIR_REQUIRED`：问题明确、仍在原审批范围内，并且修复次数未超限；
- `BLOCKED`：需要扩大范围、权限、数据外发、provider、预算，或出现 ambiguous call、secret、冲突、路由无法验证等情况。

`PASS` 不等于自动修改主 workspace。最终应用仍是单独的 `APPLY_PENDING` 受控动作。

## 7. 分阶段执行总览

| 阶段 | 名称 | 核心产物 | 是否允许真实 API |
| --- | --- | --- | --- |
| S0 | 架构收口与旧入口退役 | 默认路径不再切 provider，文档与 CLI 不再宣传 native menu | 否 |
| S1 | 合同、隐私与 schema | TaskPackage、RouteBinding、policy、EvidenceBundle 的可验证 schema | 否 |
| S2 | Workflow/Attempt 持久化 | 调用前检查点、锁、重复 approve 和 crash recovery | 否 |
| S3 | Isolated Worktree | 基线、dirty evidence、隔离执行区和冲突检测 | 否 |
| S4 | Safe Executor | read/write/network/env/command scope 和最小 DeepSeek 工具面 | 否 |
| S5 | Endpoint 与路由身份 | origin/auth/model/protocol preflight、redirect 拒绝和 RouteEvidence | 否 |
| S6 | Quality Gate 与 EvidenceBundle | 顺序化确定性验证、diff、secret scan 和证据包 | 否 |
| S7 | GPT 前台接口 | 核心 CLI/service、STDIO MCP 和 thin skill | 否 |
| S8 | Final Review、Repair 与 Apply | 三态 review、一次修复、主 workspace 冲突保护 | 否 |
| S9 | 零费用端到端认证 | mock provider、临时 repo、crash/mismatch/privacy/worktree 套件 | 否 |
| S10 | 有限真实 Pilot | 公开/合成任务上的 GPT-only vs hybrid 对照 | 仅明确授权后 |

## 8. 各阶段详细计划

### S0｜架构收口与旧入口退役

目标：确保任何默认安装、README 或主 CLI 都不会再引导用户切换 Desktop provider。

实施内容：

1. 从默认快捷方式安装器移除 Native Menu 和 Restore OpenAI。
2. Router Terminal 默认不再提供直接进入 DeepSeek Flash/Pro Codex 终端的选项。
3. `switch-codex-native-mode.ps1` 删除或移动到明确的 deprecated/experimental 区域。
4. DeepSeek Codex profiles 如保留，只能标为隔离实验，不属于 Orchestrator 正常路径。
5. README、implementation、handoff、prompt 和 changelog 统一说明 hot switching 已废弃为主路径。
6. `live-benchmark` 保留显式命令，但不能由安装或默认检查自动触发。

零费用测试：

- 静态扫描默认脚本，不应出现修改用户 Codex 配置的调用链；
- 安装器 dry-run/临时目录测试不创建 native menu shortcut；
- CLI help 不把直接 DeepSeek Codex profile 描述为正常入口；
- `git diff --name-only` 确认不触碰 `dist/`、`node_modules/` 和用户配置。

阶段门：

- 从仓库默认文档出发，用户找不到“切换 provider/Restore OpenAI”作为推荐流程；
- 默认脚本不会写主 Codex config/auth/catalog；
- 旧实验是否删除或移动已通过 ADR 明确。

非目标：不在本阶段重写 Orchestrator；不安装任何软件；不运行 API。

### S1｜合同、隐私与 schema

目标：先冻结机器可验证的数据合同，再修改执行逻辑。

实施内容：

1. 将任务语义、路由身份、执行上下文、审批和 attempt 拆成独立类型。
2. 引入 `data_classification` 与 `egress_policy` 双维模型：
   - classification：`public | private | secret_restricted`；
   - egress：默认 `deny`，可按 provider/path/content hash 明确允许最小外发。
3. 未提供可信 project policy 或当次授权时，默认禁止 DeepSeek。
4. `read_scope` 与 `write_scope` 分离；`allowedFiles` 不再同时承担两种语义。
5. 定义规范化序列化和 hash 规则，禁止未知字段静默通过。
6. policy 只作为权限上限；仓库 policy 不能自行覆盖用户级 deny。
7. 更新 JSON Schema、示例 TaskPackage、RunReport/EvidenceBundle。

零费用测试：

- 属性顺序不影响 hash；
- 任一 route、scope、policy、budget 变化使审批失效；
- 未分类/private 默认不能生成 DeepSeek RouteBinding；
- project policy 扩大权限时旧审批失效；
- `PRIVATE_THIRD_PARTY_ALLOWED` 等便利输入能规范化为 classification + egress，而不是混成一个不可审计枚举；
- schema 拒绝额外字段、空 scope、绝对用户路径和 secret-like context。

阶段门：所有跨组件对象都能用 schema 验证、规范化 hash，并有正反例测试。

### S2｜Workflow/Attempt 持久化与幂等语义

目标：任何可能计费或写文件的动作，在发生前都有可恢复记录。

实施内容：

1. 分离 WorkflowState 和 AttemptState。
2. provider 调用前原子保存 `PREPARED`，开始发送前保存 `SENDING`。
3. 收到并验证完整响应后才能保存 `SUCCEEDED`。
4. timeout、connection reset、stream interruption 等无法证明未执行的情况保存 `AMBIGUOUS`，workflow 进入 `BLOCKED`。
5. `FAILED_BEFORE_SEND` 只用于可证明没有外部副作用的本地失败。
6. 每个 task/approval 使用执行锁或 compare-and-swap，拒绝并发 approve。
7. 重复 approve 返回既有 attempt/status，不重复调用 mock provider。
8. repair 产生新 attempt ID，不覆盖旧记录。
9. error 和状态持久化统一脱敏，禁止保存响应原文和 reasoning。

零费用测试：

- 每个 provider 阶段抛错后均能回读确定状态；
- 在 `PREPARED`、`SENDING`、`SUCCEEDED` 各点模拟进程崩溃；
- 两个并发 approve 只触发一次 mock 调用；
- `AMBIGUOUS` 重启后不自动重发；
- 本地确定性操作可在规则允许时重试；
- 状态写入中断不产生半截 JSON。

阶段门：不存在“磁盘仍为待批准、外部副作用已经发生”的可复现路径。

### S3｜Isolated Git Worktree

目标：DeepSeek 和质量门不再直接修改用户主 working tree。

实施内容：

1. 每个 run 创建独立 worktree 或等价隔离 checkout。
2. 记录 base commit、主 workspace dirty evidence、worktree logical ID 和创建状态。
3. 主 workspace 有未提交变化时默认不覆盖；记录文件/hash 证据。
4. 第一版默认从批准的 base commit 执行。需要包含 dirty changes 时必须作为单独的、可审计输入模式。
5. worktree 创建、复用、终止和保留策略全部由 run ID 管理。
6. 最终 apply 前重新比较主 workspace 与最初 snapshot；存在冲突性变化则 `BLOCKED`。
7. 禁止 `git reset --hard`、自动 stash、自动覆盖和自动删除用户工作。
8. worktree cleanup 仅处理 Orchestrator 自己创建并验证归属的路径；默认可先保留供诊断。

零费用测试：

- 临时 Git repo 的 clean/dirty/untracked/renamed/deleted 情形；
- 主 workspace 和 worktree 同名文件并发变化；
- base commit 被移动、branch 删除、worktree 创建中崩溃；
- worktree 中 build 生成 `dist/` 不影响主目录；
- cleanup 不会删除非 Orchestrator 路径；
- 无 `reset --hard`、无自动 stash。

阶段门：所有 executor 写入和质量门产物只发生在隔离区，主 workspace 零变化。

### S4｜Safe Executor 与真实权限边界

目标：DeepSeek 成为受控代码修改引擎，而不是拥有电脑权限的第二个 Codex。

实施内容：

1. Direct Adapter 作为唯一 MVP DeepSeek executor。
2. 删除默认 `list_files` 全仓枚举，或限制到 read scope manifest。
3. `read_file` 必须同时通过路径 scope、内容分类、大小、编码和 symlink/reparse point 检查。
4. 第一版优先实现 `propose_patch`；若保留 writer，也只能写隔离 worktree 且必须验证 preimage hash。
5. 不提供 shell、package install、GitHub、浏览器、任意网络或任意命令工具。
6. 子进程环境使用显式 allowlist，而不是复制完整 `process.env`。
7. API adapter 只获得所需 auth secret；secret 不进入 TaskPackage、日志或模型消息。
8. Windows sandbox/Job Object/低权限进程等技术选型作为可替换层，不把 worktree误称为 sandbox。

零费用测试：

- 路径穿越、symlink/junction、大小写、UNC、绝对路径、ADS 等 Windows 路径测试；
- read scope 外文件无法读取，即使文件名不敏感；
- `.env`、key、credential、production dump 默认拒绝；
- executor 看不到完整环境变量；
- patch 不能修改 scope 外文件；
- patch 基线 hash 不一致时失败；
- mock tool 不能调用 shell/network。

阶段门：攻击性单元测试证明模型只能访问 TaskPackage 显式能力范围。

### S5｜Immutable RouteBinding 与 endpoint/auth/model preflight

目标：彻底消除“DeepSeek model + OpenAI endpoint”一类错配。

实施内容：

1. 从批准数据构造不可变 RouteBinding，不在 invoke 时从未绑定环境静默补字段。
2. DeepSeek origin 使用规范化 HTTPS origin 和精确 API path。
3. provider、adapter、model family、auth alias、wire protocol、endpoint 必须交叉匹配。
4. 默认禁止 redirect；若未来允许，每一跳重新验证 origin 和 policy。
5. 代理策略和 DNS/host 处理明确记录；不能只检查字符串包含关系。
6. 凭据解析只按 RouteBinding 指定的 auth alias，禁止 env/DPAPI 自动换源。
7. 在读取 secret 和调用 fetch 前完成所有可完成的 preflight。
8. response model、request ID、实际 response URL/header 与批准 binding 合并为 RouteEvidence。

零费用测试：

- DeepSeek model + `api.openai.com` 在 fetch 前失败；
- OpenAI model + DeepSeek auth alias 失败；
- HTTP、userinfo、混淆 hostname、错误端口、错误路径、跨域 redirect 失败；
- tuple 任一字段变化使 approval 失效；
- adapter 自报正确但实际 response origin 错误仍失败；
- request ID 缺失按 policy 标为未完全验证，不伪造 ID。

阶段门：所有 route mismatch 回归用例 100% 在联网前失败，且 RouteEvidence 不依赖单一自报字段。

### S6｜Local Quality Gate 与 EvidenceBundle

目标：最终质量和范围由确定性证据支撑。

推荐顺序：

1. worktree 基线与 cleanliness；
2. patch/apply 前 write-scope 静态检查；
3. apply 后允许范围检查；
4. forbidden file 与 symlink/reparse 检查；
5. baseline-aware secret scan；
6. diff sanity、二进制/大文件/rename/delete 检查；
7. formatter check；
8. lint；
9. typecheck；
10. unit tests；
11. build；
12. project-specific acceptance；
13. 最终 diff 和 worktree head 冻结；
14. EvidenceBundle 生成与自校验。

实施约束：

- validation command 必须来自批准 policy/TaskPackage，不能直接执行模型任意字符串；
- formatter 默认 check-only；写格式化需纳入审批和 diff；
- secret scan 区分既有 baseline 与新增高置信度 secret；
- gate 输出必须限制大小并脱敏；
- `0` 与 `N/A` 分开；
- 完整 diff 不默认复制到长期日志。

阶段门：GPT 不依赖执行器的“Done”即可从 EvidenceBundle 判断范围、测试和风险。

### S7｜GPT 前台接口：Core CLI → STDIO MCP → Thin Skill

目标：用户只在当前 GPT/Codex 主会话工作。

实施顺序：

1. 先把 Orchestrator 核心服务接口稳定为结构化输入输出；
2. CLI 作为测试和恢复入口；
3. 在同一核心之上增加薄 STDIO MCP；
4. 增加 thin skill，说明何时使用 Router、如何准备 TaskPackage、何时必须 BLOCKED；
5. skill 不承载安全判断，所有校验都在代码中。

建议工具：

```text
router.prepare
router.execute
router.status
router.abort
router.review_evidence
router.finalize
```

接口原则：

- 不接收完整聊天历史；
- 不接收 hidden reasoning；
- 返回紧凑批准摘要；
- 后台进度只暴露状态和必要提示；
- 最终返回 EvidenceBundle 引用和质量摘要；
- MCP 注册不得修改 provider；
- 任何项目级配置写入都需用户单独授权并可撤销。

官方 OpenAI 文档支持 Codex 使用本地 STDIO MCP。App Server/SDK 在 MVP 中暂缓：它们适合构建独立客户端或更宽的线程控制面，本项目当前只需给现有主会话增加窄工具。

阶段门：一个 mock 任务可以完全在当前 GPT 主会话中完成 prepare → approve/execute → evidence → final review，期间主 Codex provider/config/auth 无变化。

### S8｜Final Review、单次 Repair 与 Apply

目标：把“质量门通过”“GPT 审查通过”和“应用到主 workspace”明确分开。

实施内容：

1. 执行和验证完成后进入 `REVIEW_PENDING`。
2. GPT 只读取需求、TaskPackage、acceptance、最终 diff、EvidenceBundle 和必要架构上下文。
3. Review 输出严格为 PASS、REPAIR_REQUIRED、BLOCKED。
4. REPAIR_REQUIRED 只能在原 scope、provider、预算和外发授权内，最多一次。
5. repair 使用新 attempt，继续在同一隔离执行区或明确的新 worktree。
6. PASS 后进入 APPLY_PENDING，而不是自动写主 workspace。
7. apply 前重新验证主 workspace snapshot、目标 preimage 和冲突。
8. 第一版不自动 commit/merge；是否应用由用户或 GPT 主会话在明确授权范围内触发。

阶段门：主 workspace 在未进入受控 apply 前始终不变；冲突或范围变化必定 BLOCKED。

### S9｜零费用端到端认证

目标：在没有真实 API、没有真实凭据、没有用户配置的条件下认证完整控制链。

测试矩阵至少覆盖：

- clean/dirty 主 repo；
- public/private/secret classification；
- allow/deny egress；
- Flash/Pro binding 的 mock 路由；
- wrong endpoint/auth/model/protocol；
- provider success/failure/timeout/reset/response lost；
- crash at every checkpoint；
- duplicate/concurrent execute；
- scope violation、secret detection、budget exceeded；
- quality gate pass/fail；
- one repair pass/fail；
- main workspace changed before apply；
- MCP/CLI identical core behavior；
- state/report redaction；
- cleanup ownership safety。

验收条件：

- 全部测试在临时目录、mock provider、合成 repo 中运行；
- 不读取真实环境变量、Codex config/auth、DPAPI 或密钥；
- 真实 API 请求数为零；
- 主 workspace 和未跟踪 `dist/`、`node_modules/` 不变；
- typecheck、lint、unit、integration、build 全部通过；
- 已知未验证项被明确列入 EvidenceBundle/文档。

### S10｜有限真实 Pilot

前置条件：S0–S9 全部通过，并且用户当次明确说“运行”。

任务来源：公开 fixture、synthetic repo、小型隔离 coding task，不使用私有源码、真实截图或完整聊天。

第一轮比较：

```text
Baseline A: GPT-only
Baseline B: GPT plan → DeepSeek execute → local gate → GPT review
```

指标：

- first-pass success；
- final acceptance；
- regression rate；
- scope/privacy/routing violation；
- ambiguous call rate；
- human intervention；
- repair count；
- GPT/DeepSeek token（可获得时）；
- wall-clock；
- provider-reported cost（如有）；
- estimated list-price cost；
- invoice cost（只有实际账单对账后）；
- ChatGPT quota usage（可获得时，否则 N/A）。

停止条件：任何 secret、越界、错误路由、预算失控、主 workspace 污染或无法解释的重复调用立即停止整批 Pilot。

结论允许为负：如果成本收益很小、延迟或返工显著增加，应明确建议不继续复杂化，而不是维护方案本身。

## 9. 失败模式与目标状态

| 失败模式 | 检测点 | 目标结果 |
| --- | --- | --- |
| wrong endpoint/provider/model/auth/protocol | preflight | 联网前 BLOCKED |
| policy/task/route hash 变化 | approval check | AWAITING_APPROVAL/BLOCKED |
| API 在发送前本地失败 | attempt | FAILED_BEFORE_SEND，可按规则重试 |
| timeout/reset/response lost | attempt | AMBIGUOUS → BLOCKED，不自动重发 |
| response model 或 request evidence 不匹配 | post-response verify | BLOCKED |
| DeepSeek 输出结构无效 | response validation | BLOCKED 或原范围内单次 repair，按阶段策略 |
| read/write scope violation | capability/patch gate | BLOCKED |
| secret detection | context/diff scan | BLOCKED，禁止外发/apply |
| validation/test failure | quality gate | REPAIR_REQUIRED 或 BLOCKED |
| 第二次实现失败 | policy | BLOCKED，交 GPT diagnosis |
| 主 workspace 变化或冲突 | apply preflight | BLOCKED |
| process crash | persisted state | 从最近检查点恢复；SENDING 未决为 AMBIGUOUS |
| duplicate/concurrent execution | lock/CAS | 返回既有 attempt，不重复副作用 |
| budget exceeded | request/tool/gate budget | BLOCKED |
| GPT review unavailable | review stage | REVIEW_PENDING/BLOCKED，不自动 PASS |
| evidence 不完整或无法脱敏 | bundle validation | BLOCKED |

## 10. 未来可做、可修改、需要调整（TODO 登记）

这些事项不是模糊的“以后优化”。每项都给出当前默认、替代方案、评估证据和改变条件。后续体验或测试可通过 ADR 修改默认。

### TODO-01｜Executor 编辑方式

- 当前默认：DeepSeek 返回结构化 patch proposal，由 Orchestrator 在隔离 worktree 应用。
- 替代：允许 DeepSeek 使用 preimage-hash 保护的受限 writer。
- 为什么待定：patch 对 rename/delete、CRLF、大文件和复杂重构可能不够稳定；writer 更灵活但权限面更大。
- 评估：首次通过率、patch 解析失败率、越界率、token、repair 次数。
- 改变条件：如果 patch 模式在公开 Pilot 中显著降低质量且 writer 的安全测试全部通过，可增加 writer 作为显式策略。

### TODO-02｜Dirty workspace 如何进入执行基线

- 当前默认：从批准的 clean base commit 创建 worktree，不自动带入用户未提交变化。
- 替代：把明确选择的 dirty diff 生成受控 overlay，并纳入 TaskPackage/Approval hash。
- 风险：overlay 可能包含无关或敏感改动；主目录继续变化会导致 review 基线漂移。
- 评估：实际用户任务中依赖未提交内容的比例、冲突率、额外审批负担。

### TODO-03｜Windows sandbox 技术

- 当前默认：先实现 capability adapter、最小环境和 worktree；不宣称 OS sandbox 已完成。
- 候选：Windows Job Object、低权限账户/AppContainer、WSL/container、独立 helper process。
- 评估：可部署性、路径隔离、网络限制、兼容性、启动开销和可测试性。
- 改变条件：S4 威胁测试明确暴露 capability adapter 无法覆盖的系统访问面。

### TODO-04｜隐私用户界面

- 当前默认：内部采用 classification + egress 双维模型；用户界面显示易懂摘要。
- 候选显示：公开、私有但本次允许最小外发、仅 GPT/本地、机密禁止外发。
- 评估：用户能否准确判断、误授权率、重复提示负担。
- 禁止：为了界面简短而丢失 provider/path/hash 等实际授权边界。

### TODO-05｜Project policy 的信任与签名

- 当前默认：repo policy 是权限上限且纳入 hash；修改后必须重新批准。
- 候选：本地批准记录、签名 policy、用户级 policy overlay。
- 风险：恶意分支修改 policy 自行扩大外发。
- 评估：跨分支体验、审计性、恢复成本。

### TODO-06｜CLI 与 MCP 的先后和长期支持

- 当前默认：核心 service + CLI 先完成，STDIO MCP 紧随其后，skill 最后。
- 替代：MCP 与 core 同阶段完成。
- 评估：接口返工、Desktop/CLI 兼容性、结构化错误质量和安装复杂度。
- App Server/SDK：暂不进入 MVP；只有需要独立 UI、线程生命周期或更宽客户端控制时重新评估。

### TODO-07｜旧 native profile 脚本去留

- 当前默认：从默认路径移除并标记 deprecated experimental。
- 替代：完全删除。
- 评估：是否仍需要协议兼容实验；维护成本和误用概率。
- 删除条件：Direct Adapter 完成必要协议验证，且没有剩余可复现价值。

### TODO-08｜Route endpoint、proxy 与 DNS 证明强度

- 当前默认：规范化 HTTPS origin、精确 path、禁止 redirect、显式代理策略。
- 待研究：系统代理、DNS rebinding、连接后实际 peer 证据在 Node/Windows 中的可观测性。
- 评估：mock 测试、受控本地代理实验、供应商 request ID/header 可用性。
- 原则：无法证明的字段标为未验证，不能伪造“100% provider identity”。

### TODO-09｜DeepSeek Chat Completions vs Responses

- 当前默认：Direct Chat Completions Adapter，因为当前实现可控、易 mock。
- 替代：Direct Responses Adapter。
- 评估：工具调用完整性、request ID、usage、缓存、reasoning 参数、错误语义和供应商稳定性。
- 禁止：为使用 Responses 而恢复 native Codex provider 切换。

### TODO-10｜Cost 真值来源

- 当前默认：分别记录 provider reported、公开费率估算、invoice 对账、ChatGPT quota；不可得填 N/A。
- 待研究：DeepSeek 是否提供可核对的用量/账单 API；Codex 主会话是否暴露可靠 quota 指标。
- 禁止：把 list-price estimate 标为 actual cash。

### TODO-11｜Secret scanner

- 当前默认：diff/context 双重扫描，baseline-aware，高置信度命中 BLOCKED。
- 候选：轻量正则 + entropy、Gitleaks/TruffleHog 等固定版本工具。
- 评估：误报、漏报、安装成本、离线能力、输出脱敏。

### TODO-12｜Final apply 体验

- 当前默认：PASS 后 APPLY_PENDING，由当前 GPT 会话展示摘要并等待明确应用动作；不自动 commit。
- 候选：apply patch 到 dirty workspace、生成独立 commit、保留 worktree 供人工 cherry-pick。
- 评估：冲突率、可恢复性、用户理解成本和审计性。
- 任何自动 commit/push 都需要单独授权，不由 Router 的执行批准隐含授权。

### TODO-13｜Repair 策略

- 当前默认：同一审批范围内最多一次 controlled repair。
- 待调整：哪些确定性失败可以自动进入 repair，哪些直接 BLOCKED。
- 评估：repair 成功率、额外费用、范围漂移、GPT 最终拒绝率。
- Provider/model/预算变化永远重新批准。

### TODO-14｜EvidenceBundle 是否保存完整 diff

- 当前默认：保存 diff hash、统计和本地引用；GPT 按需读取本地完整 diff。
- 替代：加密或短期保存完整 diff。
- 评估：恢复能力、磁盘写入、隐私、review latency。

### TODO-15｜Pilot 规模

- 当前默认：先完成小规模、每类可解释的 smoke，再决定 20–50 任务 Pilot。
- 评估：方差、失败类型覆盖、预算、任务代表性。
- 停止条件：路由/隐私/主目录污染任一非零，先修系统，不扩大样本。

### TODO-16｜DeepSeek Pro 与自动升级

- 当前默认：不自动 Flash → Pro；Pro 只有显式 RouteBinding 和审批才能使用。
- 评估：Flash 失败类别中 Pro 可恢复比例、成本和延迟。
- 进入条件：基础 Flash 路径通过真实验证，且 Pro endpoint/model/计费证据同样可验证。

### TODO-17｜Aider 与并行执行

- 当前默认：P2 禁用。
- 进入条件：Direct Adapter 已稳定，Pilot 证明 Router 本身值得继续，并且 A/B 目标明确。
- 评估：质量、token、cost、latency、repair、路由可解释性。

### TODO-18｜大型、二进制和生成文件

- 当前默认：MVP 拒绝二进制、大文件和复杂 rename/delete；生成目录由 policy 单独处理。
- 评估：真实任务覆盖率和安全处理成本。
- 扩展时必须新增专用 schema、大小预算和测试，不通过字符串 patch 临时兼容。

## 11. 每阶段新对话的共同规则

每个阶段会话必须：

1. 先读本文、`docs/17-orchestrator-first-stage-handoffs.md`、最新 ADR、变更日志和相关源码。
2. 确认所在分支、PR 状态和工作树；不删除/暂存无关文件。
3. 不读取真实 Codex/DeepSeek 配置、环境变量值、凭据或认证缓存。
4. 不运行真实 API/基准，除非用户当次明确说“运行”。
5. 开始写文件前声明阶段范围和预计文件。
6. 只实现当前阶段，不顺手推进后续 P1/P2。
7. 测试只使用临时目录、mock provider、synthetic repo 和隔离配置。
8. 结束前更新 README/ADR/Changelog/decision log/validation log/阶段交接。
9. GitHub 提交前做脱敏扫描，只暂存明确核对的路径。
10. commit 和 push 按用户当次授权执行；不把一次代码批准解释为发布授权。

## 12. 完成定义

只有在 S0–S9 全部通过后，项目才达到“可申请有限真实 Pilot”的状态。只有在 S10 完成规定次数、路由和隐私违规为零、质量/成本/延迟达到事先门槛，并完成失败恢复验证后，才可以讨论更高成熟度。

在此之前，准确表述是：

```text
Orchestrator-first architecture planned / partially implemented / mock validated
```

而不是：

```text
production ready / guaranteed cheaper / guaranteed no duplicate charge
```

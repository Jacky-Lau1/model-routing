# 14｜Orchestrator-first 模型路由方案（外部评估稿）

> 状态：架构基线已接受；详细实施阶段见 `docs/16-orchestrator-first-implementation-plan.md`。整改代码和规定的真实验证尚未完成。
>
> 目的：供其它模型或工程评审者独立评价。本文不包含 API Key、本机配置、用户路径、私有源码或原始运行日志。

## 一句话说明

用户始终在 Codex 的 GPT 主会话中工作；GPT 负责理解需求、规划、风险判断、最终质量审查和面向用户的结果说明。一个独立、确定性的本地 Orchestrator 在后台把经过批准且允许外发的实现任务交给 DeepSeek，随后运行本地测试和范围检查，再把证据交回 GPT 验收。整个过程不切换 Codex Desktop 的全局 provider，也不要求用户在原生模型菜单中选择 DeepSeek。

## 用户实际看到的体验

目标体验不是让用户观看两个模型互相对话，而是把 DeepSeek 当成后台执行资源：

1. 用户只在常驻的 GPT/Codex 主会话中描述任务。
2. GPT 或 Orchestrator 给出一份简短、可审计的执行摘要，包括目标、文件范围、验收条件、拟用模型、允许外发的数据范围和预算。
3. 用户批准后，DeepSeek 在后台执行。用户不需要查看它的逐步推理、工具循环或代码生成过程。
4. 本地质量门检查文件范围、diff、构建、测试、静态检查和项目特定验收项。
5. GPT 根据冻结计划、最终 diff 和验证证据进行审查；只有通过后才向用户报告完成。
6. 用户最终看到的是成品效果、改动摘要、测试结果、风险和实际路由证据，而不是低层执行过程。

正常工作流中，用户不需要执行“切换到 DeepSeek”或“Restore OpenAI”。Codex Desktop 始终保留原来的 OpenAI/ChatGPT 工作方式。

## 为什么选择这个方向

当前 Codex Desktop 的模型目录、全局 provider、认证方式和线程状态不是一个可由外部脚本可靠原子切换的整体。公开问题报告显示：选择模型不一定切换 provider；线程会保存 provider 身份；部分 Desktop 功能可能绕过自定义 provider；某些后台功能还可能使用硬编码的 OpenAI 模型。

因此，本方案不把 Desktop 原生模型菜单当成路由控制面。路由是否正确，只由本地 Orchestrator 的显式决策、请求前端点检查、供应商响应和本地运行报告证明。

OpenAI 官方文档支持为 Codex CLI 定义自定义 provider 和按启动进程选择 profile，也提供 Codex SDK/App Server 作为自动化或深度集成接口，但没有承诺 Desktop 原生模型菜单能够把不同目录项可靠绑定到不同 provider：

- <https://developers.openai.com/codex/config-advanced>
- <https://developers.openai.com/codex/config-reference>
- <https://developers.openai.com/codex/app-server>
- <https://developers.openai.com/codex/sdk>

相关公开问题：

- 模型目录项不能绑定 provider：<https://github.com/openai/codex/issues/37258>
- 缺少隔离的第三方 provider 扩展边界：<https://github.com/openai/codex/issues/36597>
- Desktop 自定义 provider、模型目录和历史记录冲突：<https://github.com/openai/codex/issues/29156>
- 部分预览编辑路径绕过自定义 provider：<https://github.com/openai/codex/issues/37315>
- 后台 memory writer 使用硬编码 OpenAI 模型：<https://github.com/openai/codex/issues/37009>

## 架构角色

### 1. GPT/Codex 前台

职责：

- 与用户对话并澄清目标；
- 处理架构、安全、权限、迁移和高风险判断；
- 生成或审查冻结的任务包；
- 审查最终 diff、测试证据和产品效果；
- 向用户解释结果并承担最终验收职责。

它不是通过修改全局配置来“变成”DeepSeek，也不依赖模型自述来证明后台是谁执行的。

### 2. 确定性 Orchestrator

职责：

- 根据显式策略选择阶段、provider、模型和预算；
- 验证任务包、审批哈希、文件白名单和敏感级别；
- 在网络请求前解析并检查实际目标端点；
- 启动相互隔离的 OpenAI/DeepSeek adapter；
- 记录请求 ID、实际模型、token、耗时和状态；
- 运行本地质量门；
- 失败时进入 `BLOCKED` 或显式诊断流程，禁止静默跨 provider 回退；
- 在任何外部副作用前持久化 attempt；对可能已经计费但响应未知的调用标记 `AMBIGUOUS` 并失败关闭，不自动重发。系统只能防止本地重复执行，不能绝对保证供应商没有计费。

Orchestrator 是控制面，不是另一个自由发挥的模型。

### 3. DeepSeek 后台执行器

职责：

- 只接收已批准、最小化且允许外发的任务包；
- 只读取任务明确允许且不敏感的内容；
- 只修改批准的文件；
- 在规定的 token、工具轮数、超时和修复次数内完成实现；
- 返回执行摘要、模型身份、请求 ID 和用量指标。

DeepSeek 不负责最终架构决策、权限扩大、发布、密钥处理或最终验收。

第一版 DeepSeek 不是拥有整台机器权限的完整 Agent。它只接收最小化 TaskPackage 和明确的能力：受限读取、受限搜索、符号上下文和结构化 patch proposal。它不获得任意 shell、任意网络、用户 HOME、完整环境、GitHub 登录态或其它 provider 的凭据。

### 4. 本地质量门

本地工具而非 LLM 负责执行确定性验证，例如：

- 工作区前后快照与越界文件检查；
- 格式化、类型检查、lint、单元测试和构建；
- 项目特定验收命令；
- 必要时的截图、DOM 或像素约束验证；
- 结果和运行指标的脱敏记录。

### 5. 隔离 Git worktree

DeepSeek 和质量门默认只在每个 run 独立的 Git worktree 或等价隔离 checkout 中工作，不直接写用户主 working tree。主 workspace 的 base commit、dirty evidence 和后续变化需要进入 ExecutionContext；最终应用前必须重新检查冲突。

Git worktree 是变更、验证和合并控制边界，不是真正的权限 sandbox。真实安全边界还必须包括 capability adapter、最小子进程环境、路径/网络/命令 scope，以及后续经验证的 OS 级隔离。

## 控制流

```text
用户
  ↓
GPT/Codex 主会话：澄清、规划、风险判断
  ↓
冻结任务包：目标、范围、验收、预算、外发边界
  ↓ 用户批准
本地 Orchestrator：验证审批与 RouteBinding，创建隔离 worktree
  ↓
DeepSeek 后台执行器：受控 patch proposal / 隔离实现
  ↓
本地质量门：范围、测试、构建、效果验证
  ↓
EvidenceBundle
  ↓
当前 GPT/Codex 主会话：最终审查
  ├─ 通过 → 向用户交付
  ├─ 可修复 → 一次受控修复或重新审批
  └─ 不确定/高风险 → 显式阻塞或 Sol 诊断
```

## Provider 必须作为不可拆分的绑定

每次模型调用必须冻结并审批不可拆分的 RouteBinding。任务、执行基线、审批和 attempt 使用独立对象，避免把不同生命周期字段混成循环依赖的巨型 tuple：

```text
provider_id
adapter_id
model_id
endpoint_origin
endpoint_path
auth_alias
wire_protocol
reasoning_mode
reasoning_effort
request_budget
read_scope
write_scope
network_scope
environment_scope
command_scope
```

不能只保存 `model_id`。发送前必须进行至少以下断言：

- DeepSeek 路由不能解析到 `api.openai.com`；
- OpenAI 路由不能使用 DeepSeek 认证源；
- 实际 provider、模型、endpoint、auth、协议、权限或数据范围变化会使原审批失效；
- 无法证明路由身份时，调用在联网前失败关闭。

`base_url_category` 可以保留为策略分类，但不能替代经过规范化和批准的真实 HTTPS origin。默认禁止跨 origin redirect；adapter 自报 provider 不能单独构成 route evidence。

## 数据与隐私边界

默认策略应保守，并把数据固有分类与外发授权分开：

- `data_classification` 至少区分 public、private、secret/restricted；
- `egress_policy` 默认 deny，只有明确标记为公开、合成、测试夹具，或本次按 provider/path/content hash 授权的最小数据才能进入第三方执行器；
- private repo 可以在用户明确授权后发送经过最小化的批准片段，但 private 身份不会因授权而改变；
- 不向第三方发送完整聊天、截图原件、密钥、环境变量、用户目录、本机配置、凭据文件或无关源码；
- 任务包只含目标、允许文件、必要接口、验收条件、停止条件和最小代码上下文；
- reasoning 内容不持久化，不把一个供应商的隐藏推理传给另一个供应商；
- 本地状态和报告必须脱敏。

如果实际项目属于私有源码，默认由 GPT/Codex 执行；用户可以对特定 provider、任务、路径和内容哈希明确允许最小外发。项目 policy 只能收窄权限和减少重复说明，不能因为成本目标或仓库文件自我修改而自动放宽隐私边界。

## 推理与质量分工

建议的初始策略：

- 普通分类、规划、最终审查：GPT-5.6 Terra，低或中等 effort；
- 高风险规划、重大歧义、第二次失败诊断：GPT-5.6 Sol，中等 effort；
- 普通、边界清晰且允许外发的执行：DeepSeek Flash，关闭深度思考；
- 复杂但仍可安全外发的执行：DeepSeek Pro，`high`；
- 构建、测试、diff 和范围检查：本地确定性工具。

这只是待验证的起始策略。不能在 Pilot 和真实供应商验证完成前声称质量达到生产要求。

## 用户审批应尽量简洁

用户不关心逐步实现，并不意味着取消控制边界。正常情况下只需显示一次紧凑摘要：

```text
目标：修复解析器边界条件
执行者：DeepSeek Flash
允许外发：2 个公开测试文件和 1 个公开源码文件
允许修改：src/parser.ts、test/parser.test.ts
验收：类型检查、单测、构建全部通过
预算：1 次执行，最多 1 次受控修复
```

批准后可以后台运行。只有范围、模型、provider、预算、隐私分类或验收条件发生实质变化时，才再次请求批准。

## 用户最终应收到什么

最终交付应以质量证据为中心：

- 完成了什么；
- 修改了哪些文件；
- 哪些自动化检查通过；
- 是否满足冻结的验收条件；
- 是否存在剩余风险或人工检查项；
- 实际 provider、模型和请求 ID 是否得到验证；
- 是否发生修复、重试、升级或阻塞；
- 公开价格等价成本和耗时（如已获准运行真实调用）。

默认不展示 DeepSeek 的中间推理或完整工具轨迹。

## 与当前 PR 的关系

Draft PR #1 已经包含可复用的主体：

- `RouterOrchestrator` 状态机；
- 冻结计划和审批哈希；
- DeepSeek 直连 adapter；
- Codex CLI adapter；
- 本地验证、范围保护和成本指标；
- 离线策略测试。

但当前 PR 还包含通过改写共用 Codex 配置来切换 Desktop 原生菜单的脚本。该入口与本提案的隔离原则冲突，应在后续方案中标记为实验性、移出默认安装路径或删除，而不是继续修补成主入口。

当前实现仍需补强：

1. 规划阶段必须由代码强制只读，不能只依赖提示词。
2. 所有 provider 调用都要在调用前保存 attempt/checkpoint，并在异常时持久化为 `BLOCKED`。
3. 重试必须带逻辑 attempt ID，避免重复写入和重复付费。
4. route evidence 不能仅由 adapter 自报，要加入端点解析、响应模型和供应商请求 ID 校验。
5. 敏感性默认值应保守；只有明确允许外发的数据才能进入 DeepSeek。
6. GPT 前台需要一个本地 Router 工具、skill/plugin 或受控 CLI 接口，使用户不必离开主会话。
7. 原生 DeepSeek CLI profile 只能作为隔离的手动实验入口，不能修改 Desktop 的全局 provider。

## 高层实施分组

以下 A0–A3 只保留为高层分组；可执行的最终顺序、阶段门和新对话 Prompt 已细化为 `docs/16`、`docs/17` 的 S0–S10，以后者为准。

### Phase A0：停止扩大故障面

- 不再运行或推广 Desktop 全局 provider 热切换；
- 不读取或修复用户真实配置；
- 在文档中明确 native menu 为未验证实验；
- 用 mock endpoint 复现 `DeepSeek model + OpenAI endpoint` 错配并形成回归测试。

### Phase A1：加固现有 Orchestrator

- 引入不可变 provider tuple；
- 增加发送前 endpoint/auth 断言；
- 增加调用异常检查点和幂等保护；
- 强制规划只读；
- 将隐私分类改为默认拒绝第三方；
- 增加零费用、临时目录、mock provider 的集成测试。

### Phase A2：接入 GPT/Codex 前台

- 先提供一个窄接口：`plan`、`approve`、`status`、`abort`；
- 前台 GPT 只发送结构化任务包，不发送完整聊天；
- 后台状态通过短事件展示，最终只返回质量证据；
- 不触碰 Desktop 全局 provider、auth 或模型目录。

### Phase A3：有限真实验证

- 仅在用户明确说“运行”后执行；
- 使用合成或公开夹具；
- 先验证路由身份和无跨 provider 泄漏，再验证质量、成本和耗时；
- 未达到既定门槛时保持 Phase 0/1，不宣称生产可用。

## 验收条件

最低验收条件：

1. 用户在整个任务期间只需要使用 GPT/Codex 主会话。
2. DeepSeek 执行不修改主 Codex 配置、认证或模型目录。
3. DeepSeek 路由对 `api.openai.com` 的请求数为零。
4. DeepSeek 故障不会影响主 Desktop/OpenAI 会话。
5. provider、模型、端点、认证源和数据范围全部绑定到审批记录。
6. 未获批准或敏感数据不会发给第三方。
7. 调用失败后状态明确为 `BLOCKED`，重新操作不会重复执行已完成的副作用。
8. 所有代码改动都经过范围检查和本地质量门。
9. GPT 根据 diff 和验证证据完成最终审查，而不是相信执行模型自述。
10. 真实验证未完成前，文档和 UI 不出现“生产可用”声明。

## 希望外部评审重点回答的问题

1. 取消 Desktop 全局 provider 切换后，是否还有隐藏的共享状态或认证耦合？
2. provider tuple 和发送前断言是否足以阻止模型/端点错配？
3. 如何设计最低成本的幂等执行和崩溃恢复？
4. DeepSeek 直连 adapter 与 Aider editor adapter，哪一种更适合作为首个可验证执行器？
5. GPT 前台应通过简单本地 CLI、Codex skill/plugin、Codex SDK 还是 App Server 接入？
6. 当前范围保护、任务包和隐私分类还存在哪些旁路？
7. 哪些功能必须在真实 API 验证前保持禁用？

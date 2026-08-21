# 15｜Orchestrator-first 新会话交接

> 更新时间：2026-08-20
>
> 本文保留 2026-08-20 的问题诊断与迁移背景。最终实施基线见 `docs/16-orchestrator-first-implementation-plan.md`，分阶段新对话入口见 `docs/17-orchestrator-first-stage-handoffs.md`。本文不包含密钥、本机配置、凭据、私有源码、完整日志或用户路径。

## 最新执行方式

用户已决定把整改拆成多个新对话，每个会话只完成一个阶段：S0 旧入口退役、S1 合同与隐私、S2 attempt/幂等、S3 worktree、S4 safe executor、S5 route preflight、S6 quality/evidence、S7 GPT 前台、S8 review/repair/apply、S9 零费用认证，以及经明确费用授权后的 S10 Pilot。

不要再从本文早期的宽泛“下一阶段”直接开始编码。新会话必须读取 `docs/16` 和 `docs/17`，确认上一阶段门已通过，并使用对应阶段 Prompt。

## 用户已经确认的目标体验

用户主要关注最终项目质量和效果，不需要观看低成本模型的逐步实现过程。目标体验已经确定为：

- 用户始终只面对常驻 GPT 模型的 Codex 主会话/Agent 终端；
- GPT 负责需求澄清、规划、风险控制、最终审查和结果说明；
- DeepSeek 只作为后台受控执行器；
- 本地 Orchestrator 负责真正的 provider 路由、审批、预算、范围、状态和验证；
- 正常流程不切换 Codex Desktop 的全局 provider，不把 DeepSeek 塞进原生模型菜单，也不需要 `Restore OpenAI`；
- 用户最终看到成品、diff 摘要、测试和效果证据，而不是后台推理过程。

这是下一阶段的目标架构。当前 Draft PR 已有大部分后端基础，但尚未完整实现这种前台体验，也尚未达到生产可用标准。

## 已确认的问题

用户曾通过原生 DeepSeek 菜单切换后遇到：

```text
unexpected status 401 Unauthorized:
Missing bearer or basic authentication in header
url: https://api.openai.com/v1/responses
```

随后点击 restore，现有 agent 终端也没有可靠恢复。

诊断结论：目标是 DeepSeek，但失败请求实际进入了 OpenAI Responses 端点，说明 model、global provider、auth 或线程状态发生错配。该现象与以下公开问题一致：

- <https://github.com/openai/codex/issues/37258>
- <https://github.com/openai/codex/issues/36597>
- <https://github.com/openai/codex/issues/29156>
- <https://github.com/openai/codex/issues/22484>
- <https://github.com/openai/codex/issues/37315>
- <https://github.com/openai/codex/issues/37009>

不要把这次故障诊断为“DeepSeek Key 必然无效”。错误端点本身已经证明失败请求没有走预期的 DeepSeek 路由。

## 当前仓库与 PR 状态

- GitHub 仓库：`Jacky-Lau1/model-routing`。
- Draft PR：<https://github.com/Jacky-Lau1/model-routing/pull/1>。
- PR 开发分支：`agent/implement-auto-model-router`。
- 当前本地工作区仍在 `main`；PR 中的 `docs/11-implementation.md`、`docs/12-evaluation-plan.md` 和 `docs/13-continuation-handoff.md` 尚不在本地主分支。
- 本地存在未跟踪的 `dist/` 和 `node_modules/`；视为用户现有产物，不删除、不暂存、不提交。
- 本轮只新增了 `docs/14-orchestrator-first-proposal.md` 和本文，尚未提交或推送。

新会话开始后，先确认所在分支和 PR 最新状态。不要擅自 checkout、fetch、merge、rebase、提交或推送。

## 开始前必须阅读

按顺序阅读：

1. `docs/14-orchestrator-first-proposal.md`
2. `docs/16-orchestrator-first-implementation-plan.md`
3. `docs/17-orchestrator-first-stage-handoffs.md`
4. `docs/15-orchestrator-first-handoff.md`
5. PR 分支中的 `docs/13-continuation-handoff.md`
6. PR 分支中的 `docs/11-implementation.md`
7. PR 分支中的 `docs/12-evaluation-plan.md`
8. `docs/08-decisions.md`
9. PR 中以下实现：
   - `src/orchestrator.ts`
   - `src/providers/routing.ts`
   - `src/providers/codex-cli.ts`
   - `src/providers/deepseek-chat.ts`
   - `src/policy.ts`
   - `scripts/switch-codex-native-mode.ps1`
   - `scripts/router-terminal.ps1`

同时重新核对当前 OpenAI 官方文档，不要依赖旧版本记忆：

- <https://developers.openai.com/codex/config-advanced>
- <https://developers.openai.com/codex/config-reference>
- <https://developers.openai.com/codex/app-server>
- <https://developers.openai.com/codex/sdk>

## 已接受的架构决定

### 保留

- 确定性 `RouterOrchestrator`；
- 结构化任务包；
- 计划和 route 审批哈希；
- DeepSeek 直连 adapter；
- OpenAI Codex CLI adapter；
- 本地验证和文件范围保护；
- 失败关闭；
- Terra 规划/审查、Sol 高风险诊断、DeepSeek 受控执行的初始分工；
- 低写入检查点和脱敏运行证据。

### 暂停作为默认方案

- 修改共用 `~/.codex/config.toml` 来切换 Desktop 原生模型菜单；
- 依赖模型 picker 自动切换 provider；
- 通过 restore 脚本恢复当前运行中的 Desktop/agent；
- 让 OpenAI 和 DeepSeek 共用一个易错的全局 provider/auth 状态；
- 将本地代理拦截所有原生 OpenAI 流量作为首选方案。

### 可以保留为隔离实验

- 通过独立进程和独立 profile 启动 DeepSeek Codex CLI；
- Aider Architect/Editor 作为 DeepSeek 执行 adapter 的对照实验；
- Codex SDK/App Server 作为中期前台集成候选。

## 核心接口（已由 docs/16 细化）

目标是让 GPT 前台通过一个窄的本地接口调用 Router，而不是切换模型菜单。最小接口建议：

```text
router.prepare
router.execute
router.status
router.abort
router.review_evidence
router.finalize
```

每次 route 必须绑定：

```text
provider_id / adapter_id / model_id
endpoint_origin / endpoint_path
auth_alias / wire_protocol
reasoning mode / effort
request budget
read/write/network/environment/command scope
```

完整字段和对象拆分见 `docs/16`。DeepSeek route 在读取 secret 和联网前必须断言最终目标不是 `api.openai.com`。任何 RouteBinding、TaskPackage、policy、ExecutionContext 或批准范围变化都会使审批失效。

## 当前实现已发现的加固点

1. `RouterOrchestrator.auto()` 的规划阶段没有由代码强制只读；目前主要依赖提示词。
2. provider 调用抛错时，状态可能没有可靠持久化为 `BLOCKED`。
3. approve 失败后再次执行可能产生重复调用或重复文件副作用，需要 attempt ID 和幂等保护。
4. route evidence 部分依赖 adapter 自报，需要端点、响应模型和请求 ID 的独立校验。
5. 敏感性分类不能只依赖目标文本；默认应禁止第三方，只有明确允许外发的数据才能进入 DeepSeek。
6. 当前名为 OpenAI/Codex 的无 profile 入口没有代码级保证它一定使用 built-in OpenAI provider。
7. 原生 DeepSeek profile 需要明确禁用尚未验证且可能发生 provider 泄漏的 memories、后台审查、subagent 和 Desktop 特有功能。

## 用户不可妥协的约束

1. 未得到当次明确许可，不读取、修改或打印任何本机 Codex/DeepSeek 配置、DPAPI 凭据、环境变量、认证缓存或密钥。
2. 不运行真实 DeepSeek/OpenAI API、基准或任何可能产生费用的操作，除非用户明确说“运行”。
3. 不向第三方模型发送私有源码、完整聊天、截图原件或敏感内容。
4. 不因成本目标静默降低质量门槛或扩大外发范围。
5. 先诊断并给出最小修复计划、影响范围和验收条件；涉及继续写文件、安装软件、修改模型配置或 GitHub 写操作时，先说明范围并获得授权。
6. 提交前必须做脱敏扫描，只暂存明确核对的文件；commit 和 push 分别需要明确授权。
7. 在规定的真实验证完成前，不得声称生产可用。

## 下一会话入口

架构复查和计划收敛已经完成，不再重复执行本交接原先建议的只读评估。后续从 S0 开始，一个阶段一个新对话：

1. 阅读 `docs/16-orchestrator-first-implementation-plan.md` 的阶段门和 TODO；
2. 从 `docs/17-orchestrator-first-stage-handoffs.md` 复制 S0 Prompt；
3. S0 通过并维护日志后，再开启 S1 新对话；
4. S0–S9 均不运行真实 API；S10 只有用户在当次会话明确说“运行”后才允许执行。

简版入口也保存在 `prompts/continue-model-routing.md`。

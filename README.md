# 模型路由

> 面向 Codex Desktop 的“强模型规划与验收 + 低成本模型受控执行”方案档案库。

**状态：Orchestrator-first S0–S5 已完成；S6–S9 尚未实施。** 默认入口只暴露 Orchestrator；S1–S4 已冻结合同、durable attempt、isolated worktree 和 Direct DeepSeek 最小文件 capability。S5 又把 legacy execution plan、approval 和 request fingerprint 绑定到深度冻结的 RouteBinding；Direct DeepSeek 只接受固定 origin/path、model family、protocol、auth alias、budget 与 scope，在 S2 `PREPARED` 边界完成本地 preflight 和一次 alias-specific synthetic credential resolution。mock transport 明确拒绝 redirect，并在每个工具轮次先核对 `Response.url`、model 和分别记录的 body response ID/header request ID；缺失或歧义证据保持 `null`，进入 `response_invalid → AMBIGUOUS/BLOCKED`，不自动重发。TypeScript 与 17/17 files、279/279 项离线测试通过。Codex CLI 的 bound transport 因 endpoint/auth/header 不可独立观测而在 spawn 前失败；DNS peer、系统代理/TLS、S6 完整质量门、GPT 前台和 OS sandbox 仍待后续阶段。未运行真实 API，不构成真实路由或生产可用声明。

## 目标

用户始终只在常驻 GPT 模型的 Codex 主会话工作。GPT 负责需求理解、规划、架构和风险判断以及最终 Review；DeepSeek 只在后台作为受控代码修改引擎；本地 Orchestrator 负责确定性路由、审批、隔离、预算、隐私、状态和证据。正常流程不切换 Codex Desktop provider，不依赖原生模型菜单或 Restore OpenAI。

这不是“把所有工作交给便宜模型”。它是一个有状态、可审计、失败即停止的分层工作流。

## 先读什么

- [总体方案](docs/00-overview.md)
- [参考架构](docs/01-architecture.md)
- [路由策略与状态机](docs/02-routing-policy.md)
- [上下文、记忆与兼容](docs/03-context-and-memory.md)
- [质量、安全与成本边界](docs/04-quality-and-safety.md)
- [组合兼容性验证方案](docs/05-compatibility-validation.md)
- [未来落地路线图](docs/06-implementation-roadmap.md)
- [运行与维护手册](docs/07-operations-and-maintenance.md)
- [决策记录](docs/08-decisions.md)
- [现成项目参考](docs/09-reference-projects.md)
- [未来实施交接说明](docs/10-future-implementation-brief.md)
- [最小实现与 CLI](docs/11-implementation.md)
- [混合路由测评设计](docs/12-evaluation-plan.md)
- [继续研发交接](docs/13-continuation-handoff.md)
- [Orchestrator-first 架构基线](docs/14-orchestrator-first-proposal.md)
- [迁移背景与问题诊断](docs/15-orchestrator-first-handoff.md)
- [最终实施计划、阶段门与 TODO](docs/16-orchestrator-first-implementation-plan.md)
- [分阶段新对话交接与 Prompt](docs/17-orchestrator-first-stage-handoffs.md)
- [S1 数据合同、隐私与 Schema](docs/18-s1-data-contracts.md)
- [S2 Attempt 持久化、幂等与 Crash Matrix](docs/19-s2-attempt-persistence.md)
- [S3 Isolated Git Worktree、生命周期与冲突检测](docs/20-s3-isolated-worktree.md)
- [S4 Direct DeepSeek Safe Executor 与 Capability Boundary](docs/21-s4-safe-executor.md)
- [S5 Immutable RouteBinding、Endpoint Preflight 与 RouteEvidence](docs/22-s5-route-preflight.md)

## 当前入口与运行警告

`pnpm terminal` 和 `scripts/install-router-terminal.ps1` 只提供 Orchestrator 入口。快捷方式安装器支持 `-DryRun`，自动化测试必须同时传入临时 `-ShortcutDirectories` 和 `-ShortcutBackend Mock`，不得访问真实桌面、开始菜单或 Codex 用户目录。

旧 native provider/profile 脚本仅保留在 `scripts/deprecated-experimental/native-codex/` 供协议兼容性考古；它们不属于安装、默认检查或支持路径。`live-benchmark` 是会产生真实 API 请求和费用的显式命令，不会被安装器、默认检查或 S0 测试触发；没有当次明确授权时不得运行。

## 当前约束

1. 保持 Codex Desktop 作为主工作台与最终责任者。
2. 不能假设 GPT-5.6 Sol 的原生自动委派总会选择或稳定执行自定义提供商模型；关键执行链必须由确定性工作流控制。
3. 低成本模型不可直接承担架构、权限扩大、发布、密钥处理或最终质量验收。
4. 路由不可用、身份无法证明或测试失败时，必须显式停止/升级，不能静默回退到 Sol 或其他模型。
5. 所有密钥仅保留在本机环境变量、系统凭据库或获批准的密钥管理服务中，绝不提交到本仓库。
6. 当前 Direct DeepSeek 代码执行只在 run-scoped isolated worktree 内使用 S4 manifest/preimage capability；主 workspace 的 dirty 内容不自动 overlay，完成前 snapshot 漂移会失败关闭。该 capability 测试不等于 OS sandbox。
7. 未分类数据默认禁止第三方；私有数据外发必须绑定 provider、任务、路径/内容和审批。
8. LLM 调用状态不明时进入 `AMBIGUOUS/BLOCKED`，不自动重发可能计费的请求。
9. 新跨组件对象必须通过 S1 严格 schema 与规范化哈希；legacy `allowedFiles` 仅由已批准 `writeFiles` 派生用于兼容/post-hoc 检查，不能授权读取或 Direct Adapter 写入。
10. S5 的 Direct route evidence 来自 injected mock fetch 与批准 tuple 的逐轮比对，只证明本地失败关闭逻辑；`Response.url` 不证明 DNS/socket peer、系统代理或 TLS。Codex CLI bound transport 在这些字段不可观测时发送前停止。

## 继续实施

实施已拆成一个阶段一个新对话。S0–S5 阶段门通过后，下一阶段是 S6 Local Quality Gate 与 EvidenceBundle。优先使用 [分阶段新对话交接](docs/17-orchestrator-first-stage-handoffs.md) 中对应 Prompt，并以 [最终实施计划](docs/16-orchestrator-first-implementation-plan.md) 的阶段门为准。

> 继续 `Jacky-Lau1/model-routing`，只实施 `docs/16-orchestrator-first-implementation-plan.md` 的 S6。先确认 S5 阶段门仍通过，再读 docs/14、docs/16、docs/17、docs/18、docs/19、docs/20、docs/21、docs/22、docs/08 和最新 logs。

在 GitHub 网页链接可用后，也可以直接提供仓库 URL。任何实施前都应重新核验上游 Codex 文档、模型价格、提供商 API 兼容性与当前版本限制。

## 目录

```text
docs/       方案、架构、验证与运维文档
config/     不含密钥的策略、目录与数据格式示例
examples/   任务包与运行报告示例
logs/       决策、验证、事件、成本基线的长期维护入口
.github/    Issue / PR 模板
```

## 成功定义

只有在 S0–S9 全部通过后，才可以申请有限真实 Pilot。只有规定的 S10 真实验证完成后，才可以讨论“自动路由可用”。最低条件包括：

- 路由日志可证明每次执行实际使用的提供商和模型；
- 不可路由时 100% 明确失败或升级，零静默 Sol 回退；
- 执行模型只得到最小任务包，而不是未经筛选的完整对话；
- DeepSeek 只在隔离 worktree 和真实 capability 边界内工作，主 workspace 在最终 apply 前不变；
- 每次变更都经过本地质量门与当前 GPT 主会话的最终审查；
- endpoint、auth、model、protocol、scope 和 attempt 状态均有可核对证据；
- 在固定基准任务集上，质量不低于 Sol 基线，且成本收益可量化；
- 维护日志、版本决策和回滚方式都已存在。

## 许可与贡献

本仓库采用 [MIT License](LICENSE)。提交前请阅读 [贡献与维护约定](CONTRIBUTING.md)、[安全政策](SECURITY.md) 和 [变更日志](CHANGELOG.md)。

# 模型路由

> 面向 Codex Desktop 的“强模型规划与验收 + 低成本模型受控执行”方案档案库。

**状态：Orchestrator-first S0–S9 已完成 mock/synthetic 零费用阶段门；eligible for limited live Pilot。** S9 以临时 synthetic repo/state/worktree/MCP、mock auth/fetch/provider/reviewer/local gate 认证完整 canonical 控制链，覆盖 privacy、route mismatch、crash、ambiguous、duplicate、scope、secret、quality、repair、apply conflict、redaction 和 cleanup；S9 定向 26/26、全量 25 files 368/368 通过。真实 API 请求与费用为零，未注册真实 MCP、未读取真实配置/认证/密钥，不代表 S10 已获授权或 production ready。

## 目标

用户始终只在常驻 GPT 模型的 Codex 主会话工作。GPT 负责需求理解、规划、架构和风险判断以及最终 Review；DeepSeek 只在后台作为受控代码修改引擎；本地 Orchestrator 负责确定性路由、审批、隔离、预算、隐私、状态和证据。正常流程不切换 Codex Desktop provider，不依赖原生模型菜单或 Restore OpenAI。

这不是“把所有工作交给便宜模型”。它是一个有状态、可审计、失败即停止的分层工作流。

## 当前阅读入口

后续实施只需要按以下顺序阅读：

1. [当前路线图](ROADMAP.md)
2. [最终架构、合同、安全边界与 TODO](docs/16-orchestrator-first-implementation-plan.md)
3. [三部分 Agent Team 闭环交接](docs/17-orchestrator-first-stage-handoffs.md)
4. 当前部分对应的 [三个可复制 Prompt](prompts/continue-model-routing.md)
5. [S10 preflight 证据与 blocker](docs/27-s10-preflight-remediation.md)
6. [GPT-only 成本基线 ADR](docs/28-s10-gpt-only-baseline-adr.md)
7. [决策记录](docs/08-decisions.md)与最新运行日志

`docs/00–15` 是方案背景、迁移诊断与早期设计；`docs/18–26` 是 S1–S9 已完成阶段的技术规格和离线证据。它们继续保留用于审计，但不再要求每个新 agent 全量重复读取。

## 当前入口与运行警告

`pnpm terminal` 和 `scripts/install-router-terminal.ps1` 只提供 Orchestrator 入口。S7 结构化恢复入口位于 `route router ...`，测试用 STDIO server 可由 `pnpm mcp -- <runtime JSON 参数>` 直接启动；仓库未写入用户或项目 Codex MCP 注册配置。快捷方式安装器支持 `-DryRun`，自动化测试必须同时传入临时 `-ShortcutDirectories` 和 `-ShortcutBackend Mock`，不得访问真实桌面、开始菜单或 Codex 用户目录。

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
11. S6 的质量命令仍是受信项目进程，不是 OS sandbox；完整 diff 仅存外置归属目录，长期 bundle 只保存 hash、统计和受控引用。
12. MCP 与 skill 只是同一 `RouterCoreService` 的窄前台适配层；批准、repair 和 review 分别绑定 exact approval summary 与当前 EvidenceBundle。PASS 只进入 `APPLY_PENDING`；只有显式 `router.apply` 可以在 snapshot/preimage 检查后写未提交的主 workspace 变更。

## 继续实施

后续已收敛为三个 Agent Team 部分：Part 1 离线工程闭环，Part 2 真实链路与至少 30% 的可审计降费证明，Part 3 日常能力硬化与发布闭环。当前应从 [Part 1 Prompt](prompts/part-1-offline-engineering-closure.md) 开始。

S10 前置整改已加入 EvidenceBundle v3、逐 HTTP round 成本/预算、Pilot 报告门和只预览的 MCP 注册模板，但状态仍为 **BLOCKED**：真实 runtime 质量命令、Pilot report 接线、可分发安装、真实 MCP/credential/provider 与公平 GPT-only telemetry 尚未闭环。不得把前置整改、单臂 smoke 或 DeepSeek 单价低当成整个方案已经降费。

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

# 17｜三部分 Agent Team 闭环交接

> 当前唯一执行入口。旧 S0–S10「一个阶段一个新对话」方式已经完成其历史使命，由 Git 历史保留；从现在起只按本文的三个部分推进。
>
> 当前状态：S0–S9 mock/synthetic 阶段门通过，S10 preflight 已完成离线整改但仍为 `BLOCKED`。真实 MCP、credential、provider 请求、成本对照、apply、commit 和 push 都必须遵守当次授权边界。

## 目标

用户始终在 Codex 的 GPT 主会话工作；GPT 负责需求理解、规划、风险和最终 Review，DeepSeek 只承担经过批准的后台实现，本地 Router 负责确定性审批、隔离、预算、范围、验证和证据。

最终闭环不是“DeepSeek 单价看起来较低”，而是同时满足：

1. 支持范围内没有未捕获崩溃、静默 provider fallback 或重复付费请求；
2. 外部失败进入明确、可诊断、可恢复的状态，不覆盖用户内容；
3. hybrid 最终质量不低于 GPT-only；
4. 总可审计成本包含 GPT 规划、GPT Review、DeepSeek 执行、repair 及失败/重复请求，并相对同质量 GPT-only 降低至少 30%；
5. 缺少可靠 GPT telemetry、质量下降或成本门不达标时，结论必须是 `BLOCKED`、`simplify` 或 `stop`。

## 必读顺序

新会话只需先读：

1. `README.md`
2. `ROADMAP.md`
3. `docs/16-orchestrator-first-implementation-plan.md`
4. 本文
5. 当前部分对应的 `prompts/part-*.md`
6. `docs/27-s10-preflight-remediation.md`
7. `docs/28-s10-gpt-only-baseline-adr.md`
8. `docs/08-decisions.md`
9. `logs/decision-log.md` 与 `logs/routing-validation-log.md` 的最新条目
10. 当前 Git status、diff、最近提交及当前部分涉及的源码/测试

`docs/00–15`、`docs/18–26` 是架构背景与已完成阶段证据，按需读取，不再要求每个 agent 全量重复加载。

## Agent Team 共同规则

- 主 agent 先划定文件所有权；多个 agent 不得同时修改 `router-core.ts`、`mcp.ts`、`contracts.ts`、状态机、README、ROADMAP 或 append-only 日志。
- 子 agent 可以并行做互不重叠的实现、测试和只读审计；共享核心由主 agent 串行整合。
- 真实配置写入、credential、provider 请求、`router.apply` 和用户项目写入只能由主 agent 串行执行。
- 任何真实副作用前展示 exact target、内容/hash、预算、外发范围、停止条件和回滚，并等待当次明确授权。
- 不读取或打印 secret；不把 API key 放进聊天、仓库、日志或命令参数。
- 不运行 `git reset --hard`、自动 stash、force cleanup，或覆盖不明来源修改。
- commit、push、tag、PR 和 merge 分别依用户当次授权；一个动作的授权不隐含另一个动作。

## Part 1｜离线工程闭环

入口：[`prompts/part-1-offline-engineering-closure.md`](../prompts/part-1-offline-engineering-closure.md)

范围：

- 接通 hash-bound visible tests 与本地 hidden acceptance；
- 补全 exact informed approval summary；
- 将 PilotRunRecord 接入 Core/CLI/MCP 和持久状态；
- 从编译产物运行 MCP；
- 提供 doctor、安装/卸载 dry-run、配置预览和 exact rollback；
- 在临时 Codex home/state/worktree/fixture 中完成全离线发现与回归。

阶段门：typecheck、全量测试、schema/examples、diff check、外置 build 和临时安装矩阵全部通过；EvidenceBundle 能证明 visible/hidden gate 实际运行；没有真实 API、credential 或真实 Codex 配置变更。

## Part 2｜真实链路与降费证明

入口：[`prompts/part-2-live-routing-and-cost-proof.md`](../prompts/part-2-live-routing-and-cost-proof.md)

只有 Part 1 PASS 后才可开始。范围：

- 经独立授权注册真实 MCP、重启并验证 discovery；
- 经独立授权配置 credential；
- 完成一次低预算 public/synthetic hybrid smoke；
- 建立与生产路由隔离、可审计的 GPT-only evaluation arm；
- 先做 20 对 paired Pilot，达标后才可扩至 50 对；
- 调优 TaskPackage、context、cache、预算与哪些任务允许路由。

硬门：hybrid acceptance 不低于 GPT-only；regression、scope/privacy/routing/secret/main pollution、ambiguity 和 unexplained duplicate 均为零；总可审计成本下降至少 30%。无法取得可靠 GPT-only telemetry 时保持 `BLOCKED`，不得宣称降费完成。

## Part 3｜日常能力硬化与发布闭环

入口：[`prompts/part-3-hardening-and-release.md`](../prompts/part-3-hardening-and-release.md)

只有 Part 2 给出 `expand` 且成本门通过后才可开始。范围：

- 多文件 create/update/delete/rename 与 LF/CRLF；
- transactional apply、write-ahead intent、crash recovery；
- explicit private egress 与 secret-restricted 永久拒绝；
- Windows filesystem/process/network 边界与低权限执行；
- 至少 100 次 fault injection；
- clean install、连续 10 个支持范围任务、升级/恢复/卸载和成本回归。

发布门：支持范围内无未捕获崩溃、静默 fallback、重复付费和主目录污染；所有失败有明确状态、原因和恢复动作；无 P0/P1 安全或数据完整性问题；质量与至少 30% 成本收益在最终回归中仍成立。

## 当前启动点

下一次新对话应从 Part 1 开始。Part 2 和 Part 3 的 Prompt 已准备好，但前置阶段门未通过时不得提前执行真实配置、credential、API 或能力扩展。

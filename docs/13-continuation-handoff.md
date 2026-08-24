# 13｜继续研发交接（S9 更新，2026-08-24）

> 本文是历史实现到 Orchestrator-first 的迁移交接。当前阶段基线见 `docs/16-orchestrator-first-implementation-plan.md`，逐阶段入口见 `docs/17-orchestrator-first-stage-handoffs.md`。

## 当前状态

- 仓库：`Jacky-Lau1/model-routing`；S0 工作分支为 `codex/s0-orchestrator-first`。
- S0 已把默认安装、Router Terminal、CLI help 和快捷方式收口为 Orchestrator-only。
- 默认安装器不再创建 native DeepSeek、OpenAI Codex 或 Restore OpenAI 快捷方式。
- native provider switch 与 profile 安装脚本已移到 `scripts/deprecated-experimental/native-codex/`，仅供协议兼容性考古，不受支持、不执行。
- `route live-benchmark` 仍是显式命令；安装、默认检查和 S0-S9 测试不得触发。
- 历史 S0 交接时，TypeScript Orchestrator 主体仍是整改前 Phase 0/1。当前 S1–S9 已完成 mock/synthetic 阶段门；现状以 `docs/16`、`docs/17`、`docs/25` 和 `docs/26` 为准。

## S0 的默认入口

- `pnpm terminal`：启动 Orchestrator 计划与审批流程。
- `scripts/router-terminal.ps1 -Help`：只说明 Orchestrator。
- `scripts/install-router-terminal.ps1`：只创建 `Codex Router - Orchestrator`。
- 安装器测试必须显式传入临时 `-ShortcutDirectories`、`-ShortcutBackend Mock`，需要预览时再加 `-DryRun`。

`scripts/set-deepseek-key.ps1` 和 `scripts/install-store-codex.ps1` 没有被默认入口调用。前者仍服务于 Direct Adapter 的本机凭据兼容路径；后者会安装/同步 CLI、设置用户变量并访问认证文件，只能在单独明确授权时运行，不能作为 S0 测试。

## 退役代码边界

deprecated experimental 目录中的脚本可能下载外部内容、写 Codex profile/catalog，或改写共享 Desktop provider 配置。S0 只对它们做静态和 PowerShell 语法检查，不执行、不修补、不承诺兼容。保留理由和删除条件见 ADR-012 与 `docs/16` TODO-07。

## 后续会话必须遵守

1. 不读取、写入、复制、打印或提交真实 Codex/DeepSeek 配置、DPAPI 凭据、环境变量值、认证缓存或密钥。
2. 不运行真实 API、`live-benchmark` 或其它产生费用的操作，除非用户当次明确说“运行”。
3. 脚本测试仅使用临时目录、mock path、mock provider/shortcut backend。
4. 不把私有源码、截图、完整聊天或敏感内容发给第三方。
5. 不修改 Router 核心状态机、RouteBinding 或隐私 schema，除非当前阶段明确要求。
6. 不触碰或暂存 `dist/`、`node_modules/` 和无关用户文件。
7. commit、push、PR 写操作分别需要当次明确授权。

## 历史下一阶段

本节保留 S0 完成时的交接语义：当时下一阶段是 S1，且只实施 TaskPackage、RouteBinding、ExecutionContext、ApprovalRecord、AttemptRecord、EvidenceBundle 和 privacy/policy schema 基线。当前 S1–S9 已完成；S10 只有在当次明确授权后才可启动，不得再使用本节作为当前启动指令。

## 先读哪些文件

1. `docs/14-orchestrator-first-proposal.md`
2. `docs/16-orchestrator-first-implementation-plan.md`
3. `docs/17-orchestrator-first-stage-handoffs.md`
4. `docs/08-decisions.md`
5. `README.md`、`ROADMAP.md`、`CHANGELOG.md`
6. `logs/decision-log.md`、`logs/routing-validation-log.md`
7. `docs/18-s1-data-contracts.md` 至 `docs/26-s9-zero-cost-e2e-certification.md`
8. S9 涉及的 mock provider、临时 repo、crash/mismatch/privacy/worktree 端到端套件

## S5 完成边界

S5 把 canonical/legacy RouteBinding 深度冻结，并将 legacy plan、approval、request fingerprint 与 stable adapter ID、exact endpoint/auth/model/protocol/reasoning/budget/scope 绑定。Direct DeepSeek 在 durable `PREPARED` 内完成 local preflight、alias-specific synthetic credential resolution；逐轮 mock transport 先验证 exact response URL/status/model 和分别记录的 body/header ID，redirect 不跟随。缺失证据保持 `null` 并进入 `AMBIGUOUS/BLOCKED`。Codex CLI bound transport 因 endpoint/auth/header 不可观测而 spawn 前停止。

该结论只证明 injected mock fetch 下的 observable route tuple；DNS peer、系统代理/TLS 和真实 provider identity 未验证。S5 不生成 EvidenceBundle，不得在 S6 前把 runtime RouteEvidence 当成最终质量/审计 bundle。TypeScript `--noEmit` 与 Vitest 17/17 files、279/279 tests 通过。

## S6 完成边界

S6 用固定 policy command catalog 顺序执行 local gates；snapshot 先验证物理 containment，secret baseline 用多重集比较，raw diff 在脱敏前执行 ceiling，Git 只读取 index/status/diff。QualityGateReport 完整绑定批准请求、pre/post snapshot、artifact 和 gate 顺序并带 self hash；EvidenceBundle v2 记录 attempts、route evidence、测试诊断、nullable usage、分层 cost 与剩余风险。

TypeScript、S6 定向 7/7 files 118/118 tests、全量 19/19 files 323/323 tests 通过。全部为 synthetic repo/mock provider/credential；未读取真实配置/auth/DPAPI/credential-bearing env 值（最终文档审计仅有一次非敏感 `USERPROFILE` locator 意外展开，详见 `docs/23`），未运行真实 API、live benchmark 或费用操作。受信质量命令不是 OS sandbox，legacy bridge 和启发式 secret scan 仍作为风险保留；这是 S6 完成时的边界。

## S7 完成边界

S7 用 canonical `RouterCoreService` 接通 TaskPackage、EffectivePolicy、RouteBinding、ExecutionContext、ApprovalRecord、S2 attempt/worktree、S4 SafeExecutor、S6 quality/EvidenceBundle。结构化 CLI、六工具 STDIO MCP 和 repo thin skill 只调用该 core；execute 绑定 exact approval summary hash，foreground finalize 绑定当前 EvidenceBundle hash且不 apply 主 workspace。

TypeScript、S7/共享安全定向 7/7 files 113/113 tests、全量 23/23 files 335/335 tests 通过。单一 synthetic STDIO 会话只发送一次 mock provider 请求，主 workspace 与 provider/config/auth sentinel hash 不变。未注册真实 MCP、未写 Codex 配置、未读真实 auth/credential-bearing env、未调用 API/live benchmark。真实 Codex tool discovery、private capability、OS sandbox、真实 provider/peer、S8 repair/apply 仍未验证或未实现。

## S8 完成边界

S8 将 foreground finalize 扩展为严格三态；PASS 只进入 `APPLY_PENDING`。`router.repair` 只接受当前 REPAIR_REQUIRED EvidenceBundle 与原 approval summary，同一批准下最多创建一个 round 1 attempt；runtime provider/model/budget/scope/privacy/egress 变化均 BLOCKED。`router.apply` 显式复核 main snapshot、dirty overlap、当前 bundle/worktree snapshot 与单一目标 preimage/postimage，成功只写未提交主 workspace，不 commit/merge/push，duplicate apply 幂等。

TypeScript、S8 6/6 tests、拆分全量 24 files 342/342 tests 通过。全部为 synthetic repo/mock reviewer/provider；未注册真实 MCP、未读真实配置/auth/env、未联网或产生费用。S8 apply 当前只支持 S4 单文件 UTF-8 replacement/create；多文件、rename/delete/binary 与 write/APPLIED checkpoint 间 crash recovery 仍留待后续设计。

## S9 完成边界

S9 新增 26 个全 mock E2E 场景，完整覆盖 privacy/egress、Flash/Pro 与 route mismatch、provider outcome、三 attempt checkpoint crash、ambiguous/no-resend、duplicate/concurrent、scope/usage、secret/quality、repair、apply conflict、redaction、cleanup 及 CLI/MCP 同状态。矩阵修复首次 EXECUTE 未在 patch 前复核累计 token usage 的缺陷；没有扩大 provider、scope、预算或外发。

TypeScript、diff check、S8 6/6、S9 26/26、全量 25 files 368/368 与外置临时 emit build 均通过。真实 API 请求和费用为零；没有读取真实 config/auth/credential-bearing env，没有注册 MCP 或运行 live benchmark。当前状态只为 `eligible for limited live Pilot`；S10 仍需展示公开/synthetic task、provider/model/endpoint/auth、真实 MCP/config 变更、调用/费用上限、外发 hash 和停止条件并取得当次明确“运行”授权。

## S10 preflight 后续边界

继续前先读 `docs/27-s10-preflight-remediation.md` 与 `docs/28-s10-gpt-only-baseline-adr.md`。当前状态为 BLOCKED：离线成本/轮次/预算、Pilot schema 和临时 MCP discovery 已实现，但真实 MCP 注册/当前会话 tool discovery、credential 独立授权及公平 GPT-only host telemetry 尚未满足。不得把单臂 smoke、MCP 模板或本轮 mock 证据写成 S10 通过。

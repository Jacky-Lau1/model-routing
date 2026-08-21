# 13｜继续研发交接（S4 更新，2026-08-21）

> 本文是历史实现到 Orchestrator-first 的迁移交接。当前阶段基线见 `docs/16-orchestrator-first-implementation-plan.md`，逐阶段入口见 `docs/17-orchestrator-first-stage-handoffs.md`。

## 当前状态

- 仓库：`Jacky-Lau1/model-routing`；S0 工作分支为 `codex/s0-orchestrator-first`。
- S0 已把默认安装、Router Terminal、CLI help 和快捷方式收口为 Orchestrator-only。
- 默认安装器不再创建 native DeepSeek、OpenAI Codex 或 Restore OpenAI 快捷方式。
- native provider switch 与 profile 安装脚本已移到 `scripts/deprecated-experimental/native-codex/`，仅供协议兼容性考古，不受支持、不执行。
- `route live-benchmark` 仍是显式命令；安装、默认检查和 S0-S9 测试不得触发。
- 历史 S0 交接时，TypeScript Orchestrator 主体仍是整改前 Phase 0/1。当前 S1–S4 已完成；S5–S9 的 route evidence、quality bundle、GPT 前台、apply 与 E2E 尚未完成，现状以 `docs/16`、`docs/17` 和 `docs/21` 为准。

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

本节保留 S0 完成时的交接语义：当时下一阶段是 S1，且只实施 TaskPackage、RouteBinding、ExecutionContext、ApprovalRecord、AttemptRecord、EvidenceBundle 和 privacy/policy schema 基线。当前 S1–S4 已完成，下一阶段为 S5；不得再使用本节作为当前启动指令。

## 先读哪些文件

1. `docs/14-orchestrator-first-proposal.md`
2. `docs/16-orchestrator-first-implementation-plan.md`
3. `docs/17-orchestrator-first-stage-handoffs.md`
4. `docs/08-decisions.md`
5. `README.md`、`ROADMAP.md`、`CHANGELOG.md`
6. `logs/decision-log.md`、`logs/routing-validation-log.md`
7. `docs/18-s1-data-contracts.md`、`docs/19-s2-attempt-persistence.md`、`docs/20-s3-isolated-worktree.md`、`docs/21-s4-safe-executor.md`
8. S5 涉及的 route/provider 源码、schema 和 mock 测试

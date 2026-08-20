# 模型路由

> 面向 Codex Desktop 的“强模型规划与验收 + 低成本模型受控执行”方案档案库。

**状态：Phase 0/1 最小实现。** 仓库现包含 TypeScript 确定性控制层、审批状态机、Codex/DeepSeek CLI 适配器、低写入检查点和离线路由测试。默认失败关闭；在完成真实供应商 10 次验证前，不应宣称生产可用。

## 目标

在不牺牲可验证质量的前提下，让 GPT-5.6 Terra 默认负责分类、规划与审查，只有高风险规划和二次失败诊断才升级 Sol；让 DeepSeek V4 Flash/Pro 执行边界清晰的文本或编码任务。系统必须保留可追溯任务状态，避免静默降级，并用本地测试与 Terra 审核把关。

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
- [继续研发交接](docs/13-continuation-handoff.md)

## 本地运行

```powershell
pnpm install
pnpm run check
pnpm run route benchmark
pnpm run route live-benchmark
pnpm run terminal
pnpm run route auto "修复一个局部 TypeScript bug" --project C:\path\to\project
```

`auto` 只生成计划并停在审批点。检查计划、文件范围和验收命令后，再运行输出中的 `route approve`。DeepSeek 执行可使用本机环境变量 `DEEPSEEK_API_KEY`，也可使用下述 DPAPI 凭据文件；凭据不会写入任务状态。

真实 DeepSeek 验证前运行 `powershell -File scripts/set-deepseek-key.ps1`，交互式录入的 Key 会使用当前 Windows 用户的 DPAPI 加密保存在仓库外。`live-benchmark` 会在临时 Git 仓库中运行一个受限修复任务，并把真实 token、缓存、估算成本和质量分数写入被 Git 忽略的 `logs/runs/`。

先运行 `scripts/install-codex-deepseek-profiles.ps1`，再运行 `scripts/install-router-terminal.ps1`，即可创建菜单以及 Auto、原生 DeepSeek V4 Flash、原生 DeepSeek V4 Pro、OpenAI Codex 四个独立的桌面和开始菜单入口。DeepSeek 官方现已提供 Codex 所需的 Responses API；安装器从固定 SHA-256 的官方脚本提取模型目录，并使用 Codex 的命令式认证读取 Windows DPAPI 凭据，不把 Key 明文写进 `config.toml`。

安装器还会创建 `Codex Native Menu - DeepSeek Flash`、`Codex Native Menu - DeepSeek Pro` 和 `Codex Native Menu - Restore OpenAI` 三个入口。它们会原子切换 Codex Desktop 共用的全局提供商配置，使应用重启后的原生模型下拉菜单显示对应 DeepSeek 模型；首次切换会在 `%LOCALAPPDATA%\CodexRouter\native-mode\` 保存 OpenAI 配置，恢复时校验哈希并原样还原。入口不会强制结束正在运行的 Codex，请正常关闭并重新打开应用后查看菜单。Auto 是路由工作流而非单个供应商模型，因此仍使用独立的 Router 入口，不会伪装成原生模型菜单项。

混合模型正式测评设计见 [docs/12-evaluation-plan.md](docs/12-evaluation-plan.md)，默认不自动下载或运行外部基准。

## 当前约束

1. 保持 Codex Desktop 作为主工作台与最终责任者。
2. 不能假设 GPT-5.6 Sol 的原生自动委派总会选择或稳定执行自定义提供商模型；关键执行链必须由确定性工作流控制。
3. 低成本模型不可直接承担架构、权限扩大、发布、密钥处理或最终质量验收。
4. 路由不可用、身份无法证明或测试失败时，必须显式停止/升级，不能静默回退到 Sol 或其他模型。
5. 所有密钥仅保留在本机环境变量、系统凭据库或获批准的密钥管理服务中，绝不提交到本仓库。

## 建议的未来入口

当准备继续研发时，可直接使用 [新对话继续研发 Prompt](prompts/continue-model-routing.md)；也可以对 Codex 说：

> 访问 `Jacky-Lau1/模型路由`，先阅读 `docs/10-future-implementation-brief.md`、`docs/08-decisions.md` 和 `logs/` 中最新记录；按 `docs/06-implementation-roadmap.md` 从 Phase 0 开始，只做验证通过后允许的下一阶段。

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

一次未来的实现只有在以下条件都满足后，才可以称为“自动路由已可用”：

- 路由日志可证明每次执行实际使用的提供商和模型；
- 不可路由时 100% 明确失败或升级，零静默 Sol 回退；
- 执行模型只得到最小任务包，而不是未经筛选的完整对话；
- 每次变更都经过本地质量门与定义好的 Sol 审查；
- 在固定基准任务集上，质量不低于 Sol 基线，且成本收益可量化；
- 维护日志、版本决策和回滚方式都已存在。

## 许可与贡献

本仓库采用 [MIT License](LICENSE)。提交前请阅读 [贡献与维护约定](CONTRIBUTING.md)、[安全政策](SECURITY.md) 和 [变更日志](CHANGELOG.md)。

# 模型路由

> 面向 Codex Desktop 的“强模型规划与验收 + 低成本模型受控执行”方案档案库。

**状态：设计归档，尚未实施。** 这里记录的是未来落地的规范、验证方法和运维材料；不包含任何 API 密钥、可直接调用的生产配置或自动执行脚本。

## 目标

在不牺牲可验证质量的前提下，让 GPT-5.6 Sol 负责需求澄清、架构、拆解、关键审查与升级决策；让经过验证的国内/低成本模型只执行边界清晰的编码任务。系统必须保留可追溯任务状态，避免静默降级，并用本地测试与 Sol 审核把关。

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

## 当前约束

1. 保持 Codex Desktop 作为主工作台与最终责任者。
2. 不能假设 GPT-5.6 Sol 的原生自动委派总会选择或稳定执行自定义提供商模型；关键执行链必须由确定性工作流控制。
3. 低成本模型不可直接承担架构、权限扩大、发布、密钥处理或最终质量验收。
4. 路由不可用、身份无法证明或测试失败时，必须显式停止/升级，不能静默回退到 Sol 或其他模型。
5. 所有密钥仅保留在本机环境变量、系统凭据库或获批准的密钥管理服务中，绝不提交到本仓库。

## 建议的未来入口

当准备实施时，对 Codex 说：

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

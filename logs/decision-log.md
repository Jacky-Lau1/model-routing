# 决策日志

## 2026-08-11｜初始化方案归档

- 决策：优先选择“Codex Desktop + Sol 规划/审查 + 确定性外部执行桥接”的路线。
- 证据：原生自动委派与自定义模型组合仍需逐版本实测；因此不能作为唯一的成本/质量控制机制。
- 当前状态：未实施，未选择任何国内提供商或执行模型，未保存任何凭据。
- 下一步：未来从 Phase 0 兼容性实验室开始。
- 影响：所有关于成本、兼容性和自动化程度的结论均为待验证假设。

## 2026-08-20｜收敛为 Orchestrator-first

- 决策：用户始终使用常驻 GPT 模型的 Codex 主会话；DeepSeek 只通过 Direct Adapter 做后台受控执行；Desktop provider hot switch、native menu 和 Restore OpenAI 从默认路线退役。
- 证据：Draft PR 的 switcher 会改写共用 Codex provider/config；已发生过 DeepSeek model 请求进入 OpenAI endpoint 的真实错配。OpenAI 当前配置文档说明 provider 是机器本地配置，项目配置不能覆盖 `model_provider` / `model_providers`。
- 当前状态：架构决定已接受，S0 代码退役尚未实施。
- 影响：旧 native profile/switch 只能删除或标记 deprecated experimental，不继续修补为主入口。

## 2026-08-20｜采纳外部架构评审并修正五处表述

- 采纳：isolated worktree、真实 capability scope、ambiguous paid-call、强化 RouteBinding、endpoint mismatch 回归、project policy、MCP + thin skill、TaskPackage、EvidenceBundle、三态 Final Review、Direct Adapter 和阶段化 Pilot。
- 修正 1：worktree 是变更/验证/合并隔离，不是完整安全 sandbox。
- 修正 2：隐私底层使用数据分类 + 外发授权，而不是把 private 和一次性第三方授权混成单一枚举。
- 修正 3：RouteBinding 不内嵌 approval hash、base commit 和 workspace snapshot；这些由独立对象通过 hash 绑定。
- 修正 4：actual cost 只有供应商或账单可证明时才记录；公开费率计算只标 estimated/equivalent。
- 修正 5：WorkflowState 和 AttemptState 分层，避免主状态机状态爆炸。
- 当前状态：详细默认和替代方案已记录于 `docs/16` 的 TODO-01 至 TODO-18，等待各阶段实测后迭代。

## 2026-08-20｜一个阶段一个新对话

- 决策：S0–S10 每个阶段使用独立 Codex 主会话，只有上一阶段门通过后进入下一阶段。
- 原因：降低一次性 diff 和审查复杂度，防止在安全基础未完成时提前实现 MCP、Aider、并行或真实 Pilot。
- 执行入口：`docs/17-orchestrator-first-stage-handoffs.md`。
- 当时状态：阶段计划已形成；S0 尚未开始。后续完成状态见 2026-08-21 条目。

## 2026-08-21｜S0 退役默认 native provider 入口

- 决策：默认快捷方式安装器和 Router Terminal 只保留 Orchestrator；CLI help 使用 Orchestrator-first 表述。Restore OpenAI、native DeepSeek Flash/Pro 与无 profile OpenAI Codex 不再是默认入口。
- TODO-07 处理：native switch/profile 安装代码移入 `scripts/deprecated-experimental/native-codex/`，不删除。
- 保留理由：作为已知 provider/model/endpoint 错配的协议兼容性考古材料；默认路径不引用、不执行、不支持。
- 删除条件：Direct Adapter 完成所需协议验证，且这些脚本不再提供可复现价值。
- 验证：临时目录、mock shortcut backend、dry-run、PowerShell parser、CLI/Terminal help、TypeScript typecheck 和 28 个离线测试通过；未运行 API、benchmark 或安装。
- 当前状态：S0 阶段门通过；S1 可开始。

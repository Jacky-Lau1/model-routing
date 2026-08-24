# 24｜S7 GPT 前台 Core、CLI、STDIO MCP 与 Thin Skill

> 状态：S7 离线阶段门通过（2026-08-24）。结论只覆盖 synthetic/mock、直接启动 STDIO server 的单前台会话；未注册真实 Codex MCP，未调用真实 provider。

## 1. 交付结果

S7 保持当前 Codex GPT 会话为 Supervisor，没有用 App Server/SDK 重建主 Agent，也没有修改 Desktop provider。前台入口按同一控制链收敛：

```text
structured CLI ─┐
thin STDIO MCP ─┼─> RouterCoreService ─> S1–S6 policy/route/attempt/worktree/executor/gate/evidence
repo thin skill ┘          │
                           └─> external canonical task state and EvidenceBundle references
```

- `src/router-core.ts` 是 canonical service source of truth；外置 `router-core.json` 以原子写入持久化。
- `src/cli.ts` 提供 `route router prepare|execute|status|abort|review-evidence|finalize`，用于结构化测试、恢复和诊断。
- `src/mcp.ts` 是薄 newline-delimited JSON-RPC STDIO server，只把六个工具参数转交 core 并返回 compact structured content。
- `.agents/skills/codex-router/SKILL.md` 只规定何时调用、如何保持 TaskPackage 最小化及何时 BLOCKED，不复制安全算法或脚本。

## 2. 窄接口

| 工具 | 最小输入 | 返回/副作用 |
| --- | --- | --- |
| `router.prepare` | 严格 `task_package` | 校验合同/policy/route，持久化 `AWAITING_APPROVAL`，返回 exact compact summary 与 hash；不发送 provider 请求 |
| `router.execute` | `task_id`、exact `approval_summary_hash` | 在共享锁、attempt、worktree、SafeExecutor 与 quality gate 上执行一次；重复调用返回现状而不重发 |
| `router.status` | `task_id` | 紧凑 workflow/attempt/evidence reference/next action |
| `router.abort` | `task_id` | 仅在没有活动 provider execution lock 时终止 |
| `router.review_evidence` | `task_id` | 复核受控引用与 bundle hash，返回质量、文件和 diff reference 摘要 |
| `router.finalize` | `task_id`、current bundle hash、`PASS/BLOCKED`、短摘要 | 记录当前 GPT final review；不 repair、不 apply 主 workspace |

严格 schema 不接受未知字段，因此完整聊天、`chat_history`、hidden reasoning、credential 或任意额外上下文不能穿过 MCP。prepare 生成的批准摘要绑定 TaskPackage、EffectivePolicy、RouteBinding、ExecutionContext 和 ApprovalRecord；展示后任何变化都会使 execute 拒绝。PASS 还要求当前 quality gate 已通过。

## 3. 共用核心与兼容边界

- canonical provider request 显式携带 `contract_provenance=canonical`；EvidenceBundle 保存相同 provenance。
- shared `providerRequestFingerprint` 与 `assertProviderRouteEvidence` 同时供 canonical core 和 legacy orchestrator 使用。
- route preflight 只对 `legacy_bridge` 保留 Phase 0 固定 budget/billing 兼容约束；canonical 路径使用已经由 TaskPackage 与 EffectivePolicy 收窄并 hash-bound 的 request budget，仍执行 output/tool/wall、route tuple 和 adapter 交叉核对。
- attempt 初始化、final review 与 abort 复用同一 execution lock；MCP、CLI 和 skill 没有第二套发送、重试或恢复状态机。

S4 的 Direct executor 当前只可证明 public code capability；private TaskPackage 会在 provider send 前 BLOCKED。这个限制没有在 S7 通过扩大 skill 或 MCP 权限绕开。

## 4. 配置边界

Codex 的 MCP 注册属于用户 `~/.codex/config.toml` 或受信项目 `.codex/config.toml` 的显式配置；本阶段没有获得该写入授权，因此没有创建或修改这些文件。测试直接把 synthetic client 连接到 `runStdioMcpServer`。repo skill 放在 `.agents/skills/codex-router/SKILL.md`，由仓库发现机制提供说明，但它本身不会注册 MCP。

`config/user-policy.example.json`、`config/project-policy.example.json` 和 `config/router-route-profile.example.json` 仅是无密钥 runtime 示例；auth alias 不是 secret。运行时文件加载器不会写 Codex provider/config/auth。

## 5. 零费用验收证据

```powershell
& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' --noEmit
# exit 0

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run test/skill.test.ts test/route-preflight.test.ts test/deepseek-chat.test.ts test/attempt-executor.test.ts test/structured-cli.test.ts test/mcp.test.ts test/router-core.test.ts
# exit 0; Test Files 7 passed (7); Tests 113 passed (113)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --reporter=dot
# exit 0; Test Files 23 passed (23); Tests 335 passed (335)
```

核心验收 fixture：

1. 单一 `synthetic-codex` STDIO 会话完成 initialize、tools/list、prepare、execute、review_evidence、finalize；
2. mock model `sends === 1`，重复 execute 不重发；
3. 主 repo 目标文件前后字节相同，变更只在 retained isolated worktree；
4. synthetic `provider/config/auth` sentinel 目录 hash 前后相同；
5. EvidenceBundle 通过合同校验且 `contract_provenance=canonical`，task/route/policy hash 与批准摘要一致；
6. 错误 approval/bundle hash、额外 `chat_history`、未执行 abort 和不可证明 private capability 均失败关闭且不会发送模型请求；
7. CLI 在空 environment 下读取 synthetic runtime JSON，prepare 后的磁盘 canonical state 与同 core 读取结果完全一致。

skill-creator 自带的 `quick_validate.py` 在本机 bundled Python 中因缺少 PyYAML (`ModuleNotFoundError: yaml`) 无法运行；没有为此联网或安装依赖。`test/skill.test.ts` 独立验证 frontmatter、六工具名、最小上下文/无 hidden chat 约束、共享 core 委托和无 skill scripts 目录。

## 6. 阶段门与未完成项

S7 阶段门为 **PASS（mock/synthetic only）**：同一 GPT 前台会话可以经窄 STDIO 接口完成 prepare → exact approval/execute → evidence → final review，主 workspace 与 provider/config/auth sentinels 不变。

以下没有被本结论覆盖：

- 未写真实 Codex MCP 注册，未证明 Desktop 中实际 tool discovery/invocation；
- 未读取真实配置、auth、DPAPI、credential-bearing environment，未联网或产生费用；
- 未证明真实 DeepSeek route、DNS/socket peer、系统代理、TLS、usage 或 invoice cost；
- S7 finalize 不包含 S8 的三态 repair/apply/冲突流程；
- private Direct capability、OS sandbox、TOCTOU/handle-relative confinement 仍未完成；
- 未 commit、未 push；由当前会话最终 Git 状态另行记录。

下一阶段只能实施 S8；不得把 S7 mock 通过解释为允许真实 Pilot。

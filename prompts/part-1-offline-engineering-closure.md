# Part 1｜离线工程闭环 Prompt

```text
继续项目：

G:\OneDrive\个人文档\个人AI\模型路由开发

执行“三部分 Agent Team 闭环计划”的 Part 1：离线工程闭环。

请作为主 agent 组织 agent team。开始前读取：
- README.md、ROADMAP.md、CHANGELOG.md；
- docs/16-orchestrator-first-implementation-plan.md；
- docs/17-orchestrator-first-stage-handoffs.md；
- docs/24-s7-foreground-interface.md；
- docs/25-s8-final-review-repair-apply.md；
- docs/26-s9-zero-cost-e2e-certification.md；
- docs/27-s10-preflight-remediation.md；
- docs/28-s10-gpt-only-baseline-adr.md；
- logs/decision-log.md 和 logs/routing-validation-log.md 的最新条目；
- 当前 Git status、diff、最近提交和当前实现涉及的源码/测试。

团队建议：
- Agent A：quality gate、fixture、hidden acceptance、EvidenceBundle；
- Agent B：approval summary、PilotRunRecord、CLI/MCP/schema；
- Agent C：编译分发、doctor、install/uninstall dry-run、临时 Codex 环境；
- 主 agent：共享核心、架构决策、整合、全量回归和文档。

先划定文件所有权。多个 agent 不得同时修改 router-core.ts、mcp.ts、contracts.ts、状态机、README、ROADMAP 或 append-only 日志；共享文件由子 agent 提交分析/patch 建议，主 agent 串行整合。

本部分允许修改项目文件并运行完全离线的 TypeScript、Vitest、schema、Git、构建和临时环境测试。

本部分禁止：
- 真实 provider/API 请求；
- 读取、创建或配置真实 credential；
- 修改真实 Codex config/auth/provider/model；
- 注册真实 MCP；
- 运行 legacy live-benchmark；
- apply 到用户真实项目；
- commit、push、tag、PR、merge，除非用户另行明确授权；
- reset、stash、checkout 或删除不明来源修改。

必须完成：

一、接通 canonical quality gate
1. runtime 加载严格 schema 校验、hash-bound 的 QualityGatePolicy 和 trusted command catalog。
2. executable、argv、cwd、timeout、output limits、wall limits 和 catalog hash 都进入批准边界。
3. visible tests、hidden acceptance、scope、secret、diff、freeze 结果进入同一 EvidenceBundle。
4. hidden tests/reference answer 位于模型不可读、不可外发的本地 root；只返回 bounded/redacted 结果。
5. policy、catalog、命令、fixture、base commit 变化使旧批准失效。
6. 默认 command_ids=[] 的空质量门不得用于真实 Pilot。

二、补齐 exact informed approval
prepare 的摘要及 approval_summary_hash 必须显式绑定：
- task、goal、TaskPackage hash；
- provider、adapter、model、endpoint、protocol、auth alias、reasoning；
- pricing version/hash/validity；
- classification、read/write scope；
- egress paths、content hashes、authorization、expiry；
- attempt/request/token/tool/wall/cost ceilings；
- project/state/worktree/evidence roots；
- base commit、main snapshot、isolation；
- hidden-data exclusion；
- redirect、escalation、automatic retry、apply、commit、push 限制；
- stop conditions 和 approval expiry。

任何字段变化都必须生成新 hash，并在 provider side effect 前要求重新批准。

三、把 PilotRunRecord 接入 Core/CLI/MCP
1. 从 persisted state、AttemptRecord、EvidenceBundle、quality gate 和 Final Review 自动派生。
2. 调用者不得自由声明 success、usage、cost、violation 或 recommendation。
3. 原子持久化、self-hashed、绑定当前 EvidenceBundle，拒绝 tamper/replay。
4. 输出 acceptance、visible/hidden、regression、repair、intervention、ambiguity、duplicate、usage、request count、wall time、四层成本、hard stop 和 recommendation。
5. GPT telemetry 不可得时必须保留 null 和 core_metrics_unavailable，不能写零或猜测。
6. 增加 CLI/MCP 只读获取能力，并同步更新 discovery、skill、schema、示例与测试。

四、完成可安装离线候选
1. MCP 从编译产物启动，不依赖仓库 cwd 下的 tsx/devDependencies。
2. 消除用户名、OneDrive、AppData、bundled runtime 等硬编码。
3. 提供 install --dry-run、uninstall --dry-run、config-preview、doctor、pricing-verify、credential-status。
4. doctor 验证 build hash、roots、schema、policy/catalog、pricing expiry、credential alias availability、MCP block、enabled tools、state 可写性和 main workspace snapshot。
5. install preview 展示 exact target、block、hash、diff、backup 和 rollback。
6. uninstall 只删除 exact hash-matched block；配置漂移时拒绝覆盖。
7. 不修改 auth、provider、model、profile 或其他 MCP。
8. 隔离或弃用会绕过 canonical Router 的 legacy live 路径。

五、测试
至少覆盖 visible/hidden pass/fail、hidden 泄漏、policy/catalog/executable/argv/hash 篡改、timeout、overflow、进程树、gate 修改 worktree、replay、duplicate、fixture/base commit 变化、roots 重叠、config/state 损坏、main workspace 不变，以及临时 Codex home 中 install → discovery → doctor → rollback。

结束前运行：
- TypeScript --noEmit；
- Part 1 定向测试；
- S8/S9 回归；
- 全量 Vitest；
- schema/examples 验证；
- git diff --check；
- 外置目录 production build；
- 临时环境安装/发现/回滚测试。

更新 README、ROADMAP、CHANGELOG、ADR、decision log、validation log 和 docs/17。不得把离线证据描述为真实 Pilot。

最终报告 agent team 分工、修改文件、完整测试命令/退出码/数量、EvidenceBundle/approval/Pilot 证据、阶段门逐项 PASS/BLOCKED、剩余风险、Git status，以及是否发生任何网络、credential、配置或 provider side effect。

Part 1 阶段门不完整时，不得开始真实 Pilot。
```

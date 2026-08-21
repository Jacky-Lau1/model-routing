# 17｜Orchestrator-first 分阶段新对话交接

> 用途：用户计划为每个实施阶段开启一个新的 Codex 主会话。本文提供共同上下文、阶段依赖、每阶段可直接复制的启动 Prompt 和结束交接要求。
>
> 状态：S0、S1、S2、S3、S4、S5 已于 2026-08-21 通过；S6 可开始。任何后续阶段是否实际开始、是否允许写文件、测试、commit 或 push，仍以新会话中的用户授权为准。

## 一、所有新会话先读

按顺序阅读：

1. `docs/14-orchestrator-first-proposal.md`
2. `docs/16-orchestrator-first-implementation-plan.md`
3. 本文
4. 已完成 S1 后读取 `docs/18-s1-data-contracts.md`
5. 已完成 S2 后读取 `docs/19-s2-attempt-persistence.md`
6. 已完成 S3 后读取 `docs/20-s3-isolated-worktree.md`
7. 已完成 S4 后读取 `docs/21-s4-safe-executor.md`
8. 已完成 S5 后读取 `docs/22-s5-route-preflight.md`
9. `docs/08-decisions.md`
10. `CHANGELOG.md`
11. `logs/decision-log.md`
12. `logs/routing-validation-log.md`
13. 当前分支、工作树、PR（如有）最新状态，以及当前阶段涉及的源码/测试

共同目标体验：

- 用户始终只在常驻 GPT 模型的 Codex 主会话工作；
- GPT 是 Supervisor 和最终 Reviewer；
- DeepSeek 是后台受控 Executor；
- Orchestrator 是确定性 Control Plane；
- 不切换 Desktop provider，不修改主 Codex config/auth/catalog；
- DeepSeek 不直接写主 working tree；
- 无法证明 endpoint、auth、调用状态、隐私或完成状态时必须 BLOCKED。

共同安全约束：

- 不读取、修改或打印本机 Codex/DeepSeek 配置、DPAPI、环境变量值、认证缓存或密钥，除非当次明确授权；
- 不运行真实 API、真实 benchmark 或产生费用的操作，除非用户明确说“运行”；
- 不向第三方发送私有源码、完整聊天、截图原件、附件原件或敏感内容；
- 不删除、不暂存现有无关 `dist/`、`node_modules/` 或其它用户产物；
- 不运行 `git reset --hard`、自动 stash 或覆盖用户未提交改动；
- 写文件、安装、配置切换、commit、push 均按当次授权；
- 提交前执行脱敏扫描并只暂存明确核对的文件；
- 真实验证完成前不称 production ready。

## 二、阶段依赖图

```text
S0 旧入口退役
 ↓
S1 合同/隐私/schema
 ↓
S2 状态/attempt/幂等
 ↓
S3 worktree 隔离
 ↓
S4 safe executor
 ↓
S5 route preflight/evidence
 ↓
S6 quality gate/EvidenceBundle
 ↓
S7 GPT 前台 CLI/MCP/skill
 ↓
S8 final review/repair/apply
 ↓
S9 零费用端到端认证
 ↓ 明确“运行”授权
S10 有限真实 Pilot
```

除非上一阶段的验收门已经在日志中标记通过，否则下一阶段会话应先处理阻塞项，不要跳过。

## 三、每阶段结束必须输出

每个阶段最终答复至少包含：

1. 本阶段完成了什么；
2. 实际修改、增加、删除/降级了哪些文件；
3. 运行了哪些零费用测试及结果；
4. 哪些测试没有运行，为什么；
5. 是否触碰真实配置、凭据、API 或产生费用；
6. 阶段门是否通过；
7. 新发现的风险和 TODO；
8. 下一阶段是否可以开始；
9. Git 状态、commit 和 push 状态；
10. 新会话需要先读的具体文件。

维护要求：同步更新 `README.md`、`ROADMAP.md`、`CHANGELOG.md`、`docs/08-decisions.md`（如有新决策）、`logs/decision-log.md`、`logs/routing-validation-log.md` 和本文的阶段状态表。

## 四、阶段状态表

| 阶段 | 当前状态 | 最近证据/提交 | 下一动作 |
| --- | --- | --- | --- |
| S0 | 已通过 | 2026-08-21：默认入口 Orchestrator-only；28/28 离线测试通过 | 保持退役边界，不回补 native switching |
| S1 | 已通过 | 2026-08-21：六类合同、双维隐私、严格 schema；42/42 离线测试 | 保持合同边界，不在 provider 中临时绕过 |
| S2 | 已通过 | 2026-08-21：双层状态、原子 checkpoint、幂等锁、crash recovery；67/67 离线测试 | 保持 AMBIGUOUS 禁止自动重发 |
| S3 | 已通过 | 2026-08-21：run-scoped detached worktree、dirty evidence、归属/恢复/冲突检测；116/116 离线测试 | 保持变更隔离，不误称 OS sandbox |
| S4 | 已通过 | 2026-08-21：manifest-only read、single structured patch、physical path/env boundary；169/169 离线测试 | 保持 capability/OS sandbox 边界 |
| S5 | 已通过 | 2026-08-21：immutable binding、durable preflight、逐轮 observable route-tuple evidence；279/279 离线测试 | 保持 peer/proxy 未观测边界，不伪称真实路由 |
| S6 | 可开始 | 当前只有局部 scope/validation evidence | 只实施 quality gate、secret scan、diff freeze 与 EvidenceBundle |
| S7 | 未开始 | 当前 foreground interface 未实现 | S6 通过后开始 |
| S8 | 未开始 | 当前 review/apply 语义未分离 | S7 通过后开始 |
| S9 | 未开始 | Orchestrator-first E2E 未认证 | S8 通过后开始 |
| S10 | 禁止运行 | 等待 S0–S9 和明确费用授权 | 仅用户明确说“运行”后 |

## 五、S0 新对话 Prompt：架构收口与旧入口退役（已完成，历史保留）

```markdown
继续维护 GitHub 仓库 Jacky-Lau1/model-routing 的 Draft PR #1。本会话只实施 `docs/16-orchestrator-first-implementation-plan.md` 的 S0：架构收口与旧入口退役。

开始前完整阅读 docs/14、docs/16、docs/17、docs/08、README、CHANGELOG、logs/decision-log.md、logs/routing-validation-log.md，以及 PR 中所有 native provider/profile/shortcut/terminal 脚本和相关文档。

目标：默认安装、README、CLI 和终端入口不再引导用户切换 Codex Desktop provider，不再提供 Restore OpenAI；正常路径只保留 Orchestrator。旧 native profile/switch 代码是删除还是移动到 deprecated experimental，请先按 docs/16 当前默认实施；若发现保留价值或兼容问题，记录清楚而不是继续修补为主入口。

只做 S0，不修改 Router 核心状态机、provider API 或隐私 schema。不读取真实 Codex 配置、认证、环境变量值或密钥，不运行 API/benchmark，不安装软件。所有脚本测试使用临时目录和 mock path，确保不碰真实用户目录。保留未跟踪 dist/、node_modules/。

实施前列出准确文件范围；实施后运行零费用静态/脚本测试，维护 README、ROADMAP、CHANGELOG、ADR/decision log/validation log 和 docs/17 阶段状态。提交前脱敏扫描，只暂存本阶段文件。commit/push 依当次授权。
```

S0 重点审查：

- `scripts/deprecated-experimental/native-codex/switch-codex-native-mode.ps1`
- `scripts/deprecated-experimental/native-codex/install-codex-deepseek-profiles.ps1`
- `scripts/install-router-terminal.ps1`
- `scripts/router-terminal.ps1`
- `scripts/set-deepseek-key.ps1`
- `scripts/install-store-codex.ps1`
- `README.md`
- `docs/11-implementation.md`
- `docs/13-continuation-handoff.md`
- `prompts/continue-model-routing.md`

S0 完成证据：默认安装器只生成 `Codex Router - Orchestrator`；mock backend 的实际生成与 dry-run 均通过；Router Terminal/CLI help 只把 Orchestrator 作为正常入口；`live-benchmark` 保持显式且未执行。阶段测试和扫描记录见 `logs/routing-validation-log.md`。

## 六、S1 新对话 Prompt：合同、隐私与 schema（已完成，历史保留）

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S1：TaskPackage、RouteBinding、ExecutionContext、ApprovalRecord、AttemptRecord、EvidenceBundle 和项目 policy 的类型/schema 基线。

先确认 S0 阶段门已通过并阅读最新日志。采用 docs/16 当前默认：隐私使用 data_classification + egress_policy 双维模型，默认 deny third-party；project policy 只能收窄权限，不能自行覆盖用户级 deny；RouteBinding 不内嵌 approval_hash，避免循环依赖；base commit/workspace snapshot 放 ExecutionContext。

本阶段只完成数据合同、规范化 hash、schema、示例和离线单测。不要接真实 provider、不要创建 worktree、不要实现 MCP、不要运行真实 API。若外部建议中的四级隐私显示更易懂，可作为 UI 映射保留，但底层仍使用双维模型，并在 TODO/ADR 中说明。

重点测试：字段顺序稳定、未知字段拒绝、scope/policy/budget/route 变化使审批失效、未分类/private 默认不进入 DeepSeek、绝对用户路径/secret-like context 被拒绝。完成后维护所有项目日志和 docs/17。
```

S1 预期关注文件：

- `src/types.ts`
- `src/approval.ts`
- `src/policy.ts`
- `src/classifier.ts`
- `config/*.schema.json`
- `config/routing-policy.example.yaml`
- `examples/*.json`
- 对应测试和文档

S1 完成证据：`src/contracts.ts` 提供严格解析与规范化 hash；`config/data-contracts.schema.json` 覆盖六类合同及 user/project policy；hash-valid 合成示例通过运行时校验；TypeScript 与 Vitest 42/42 通过。未接 provider、未创建 worktree、未实现 MCP、未调用 API。详细规则见 `docs/18-s1-data-contracts.md`。

## 七、S2 新对话 Prompt：状态、attempt 与幂等

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S2：双层 WorkflowState/AttemptState、外部副作用前检查点、重复/并发 execute 防护和 ambiguous paid-call 语义。

先确认 S1 schema 已通过，并阅读 `docs/18-s1-data-contracts.md`。采用默认规则：provider 调用前持久化 PREPARED，开始发送前 SENDING，只有完整响应和路由证据验证后 SUCCEEDED；timeout/reset/response lost 等无法证明服务端未执行的情况为 AMBIGUOUS → BLOCKED，不自动重发。FAILED_BEFORE_SEND 只用于可证明未发生外部副作用的本地失败。

所有测试使用 mock provider，不连接网络、不读取真实 credential。逐个模拟 planning/execution/review/repair/diagnosis 异常和进程崩溃；两个并发 approve/execute 只能触发一次 mock 调用。不要在本阶段创建真正 worktree 或实现 MCP。

完成后提供状态转换图、crash matrix、未解决恢复问题，更新日志和 docs/17。
```

## 八、S3 新对话 Prompt：Isolated Git Worktree（已完成，历史保留）

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S3：每个 run 的隔离 Git worktree、base commit、dirty evidence、生命周期和 apply 前冲突检测。

先确认 S2 的持久化/attempt 通过。把 worktree 明确定位为变更/验证/合并隔离边界，不称为 OS sandbox。所有测试只使用 mkdtemp 创建的 synthetic Git repo。禁止操作真实用户仓库以外的 worktree，禁止 reset --hard、自动 stash、自动覆盖或自动删除不属于 Router 的目录。

当前默认：从批准的 clean base commit 执行；主 workspace dirty changes 只记录 evidence，不自动带入。把 dirty overlay 作为 TODO，不要在本阶段顺便实现，除非用户明确改变计划。

测试 clean/dirty/untracked/rename/delete、创建中崩溃、主 workspace 并发变化、build 产物隔离、cleanup 归属校验。完成后证明主 workspace 在 executor/validation 期间零变化。
```

S3 完成证据：`GitWorktreeManager` 从批准的完整 commit 创建 detached checkout，持久化逻辑生命周期和 owner evidence；legacy approval 绑定 isolation hash；filesystem handoff lock 覆盖 bind/prepare/`WORKTREE_READY`/legacy `EXECUTING`。当前 EXECUTE/VALIDATE/REVIEW/REPAIR/SOL_DIAGNOSIS 均使用同一隔离 checkout。clean/modified/added/untracked/renamed/deleted、创建/清理检查点恢复、同步并发审批、跨 Router 实例竞争、dead/ownerless lock 与 release 交错恢复、auto/approve pre-write root containment、READY residual、主目录漂移、build 产物隔离、dirty/unknown/junction cleanup 负例均在临时 synthetic repo 通过；TypeScript 与 Vitest 116/116 通过。未修改 S1 schema，未实现 dirty overlay、OS sandbox、force cleanup 或 S8 apply。详细规则见 `docs/20-s3-isolated-worktree.md`。

## 九、S4 新对话 Prompt：Safe Executor（已完成，历史保留）

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S4：Direct DeepSeek Adapter 的 capability boundary。本轮仍不调用真实 DeepSeek。

先确认 S3 worktree 通过。采用当前默认：DeepSeek 是受控代码修改引擎，不是完整 autonomous Agent；无任意 shell、任意网络、用户 HOME 或完整环境；read_scope/write_scope 分离；list/read/search 只限 manifest；优先实现 structured patch proposal，由 Orchestrator 在隔离 worktree 应用。

如果 patch 机制对 Windows CRLF、rename/delete 或大文件有未解决问题，按 TODO-01 记录并保持 MVP 拒绝，不临时扩大 writer 权限。对路径穿越、symlink/junction/reparse point、UNC、绝对路径、大小写、ADS、文件大小和 secret path 做攻击性测试。子进程环境使用 allowlist，测试不得读取真实环境变量值。

不要实现 Aider、shell、package install、GitHub、浏览器、并行 worker 或真实 API。
```

S4 完成证据：legacy plan 分别审批 `readFiles`、`writeFiles`、`dataClassification`，所有 DeepSeek stage 在 S7 完整 policy 接线前仅允许 public。Direct DeepSeek code adapter 只暴露 `list_manifest`、`read_file`、`propose_patch`，删除 broad list/generic writer；capability/root 预检先于 credential/fetch，credential child 不继承 PATH 并使用绝对 PowerShell 路径。read 经过 manifest/physical path/junction/reparse/classification/size/encoding/secret/hash 检查，单文件 proposal 在 S2 async response validation 中按 write scope/preimage 原子应用，失败为 `AMBIGUOUS/BLOCKED` 且不重发。TypeScript 与 Vitest 15/15 files、169/169 tests 在 synthetic repo、mock fetch/provider 下通过。TODO-01 固定 structured patch；CRLF/binary/large/rename/delete/multi-file 均拒绝。未验证真实 endpoint/auth/model/protocol、任意 Windows reparse tag、OS sandbox 或真实 API，详见 `docs/21-s4-safe-executor.md`。

## 十、S5 新对话 Prompt：RouteBinding 与 endpoint preflight（已完成，历史保留）

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S5：不可变 RouteBinding、endpoint/auth/model/protocol preflight 和多源 RouteEvidence。全部使用 mock fetch/provider。

重点回归：DeepSeek model + api.openai.com、OpenAI model + DeepSeek auth、HTTP、错误端口/path、混淆 hostname、userinfo、跨域 redirect。所有错误必须在读取真实 secret 和联网前失败，mock fetch 调用次数为零。

RouteBinding 中使用规范化 HTTPS endpoint_origin 和 endpoint_path；auth 只能按批准 alias 解析，不允许 env/DPAPI 自动换源。默认禁止 redirect。adapter 自报 provider 不足以通过；综合批准 binding、adapter identity、实际 target/response URL、response model、provider request ID/header。不可获得的证据标 N/A/未验证，不伪造。

本阶段不运行真实 API，不读取真实 credential，不修改 Codex provider/config。
```

S5 完成证据：canonical/legacy RouteBinding 深度 clone/freeze；legacy plan、approval、request fingerprint 与 stable adapter ID、provider/model、reasoning、budget、exact origin/path、protocol、auth alias 和 scopes 绑定。hash-valid tuple mismatch 在 durable `PREPARED` 内写 `FAILED_BEFORE_SEND`，resolver/fetch 为零。Direct mock transport 使用 manual redirect，每个工具轮次先验证 exact response URL/status/model，并分别记录 body response ID 与 allowlisted header request ID；缺失证据保持 `null` 并进入 `response_invalid → AMBIGUOUS/BLOCKED`，不重发。Codex CLI bound transport 不可观测时 spawn 前停止。

TypeScript `--noEmit`、S5 定向 7/7 files 160/160 tests 和全量 17/17 files 279/279 tests 通过；全部为 synthetic repo/credential/env 和 mock provider/fetch。`route_tuple_verified_peer_unobserved` 只证明可观测 tuple，不证明 DNS peer、系统代理/TLS 或真实 provider identity。S5 未生成 EvidenceBundle，详见 `docs/22-s5-route-preflight.md`。

## 十一、S6 新对话 Prompt：Quality Gate 与 EvidenceBundle

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S6：顺序化 Local Quality Gate、baseline-aware secret scan、最终 diff 冻结和 EvidenceBundle。

先确认 S5 route mismatch 测试通过。validation command 必须来自批准 policy/TaskPackage，禁止执行模型任意字符串。formatter 默认 check-only。测试、lint、typecheck、build 都在 synthetic worktree 中运行。secret scan 区分既有 baseline 与新增高置信度 finding。

EvidenceBundle 至少绑定 task/package/route/policy/base/worktree/attempt/diff/gate/usage/cost/risk 的 hash 和摘要。完整 diff 默认使用本地引用，不复制进长期日志。provider reported、list-price estimate、invoice cost、ChatGPT quota 分开，不可得填 N/A。

完成后用通过、测试失败、scope violation、secret、预算超限等 fixture 验证 bundle 和目标状态。
```

## 十二、S7 新对话 Prompt：GPT 前台 CLI/MCP/Skill

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S7：让当前 Codex GPT 主会话通过窄接口使用 Router。

按当前默认顺序：先稳定 core service 和结构化 CLI，再在同一核心上增加薄 STDIO MCP，最后添加 thin skill。不要用 App Server/SDK 重建主 Agent，不要修改 Desktop provider。MCP/skill 只能调用 core，不能复制一套安全逻辑。

建议工具：router.prepare、router.execute、router.status、router.abort、router.review_evidence、router.finalize。接口不接收完整聊天或 hidden reasoning，只接收最小 TaskPackage；返回紧凑审批摘要、状态和 EvidenceBundle 引用。

MCP 注册或项目配置写入必须先说明范围并获得当次授权；测试可先直接启动 STDIO server，不修改真实 Codex 配置。完成后用 mock 任务证明用户只在一个 GPT 主会话完成全流程，主 provider/config/auth 哈希或 sentinel 不变。
```

## 十三、S8 新对话 Prompt：Final Review、Repair、Apply

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S8：REVIEW_PENDING、GPT 三态 Final Review、一次 controlled repair 和 APPLY_PENDING。

Final Review 只允许 PASS、REPAIR_REQUIRED、BLOCKED。PASS 不自动写主 workspace；repair 只能在原 TaskPackage、RouteBinding、预算、scope 和外发授权内，最多一次，并产生新 attempt。任何 provider/model/预算/scope/隐私变化都重新批准。

apply 前重新核对 main workspace snapshot 和目标 preimage；冲突或主目录变化必须 BLOCKED。第一版不自动 commit、merge、push，不覆盖用户 dirty changes。

全部使用 synthetic repo 和 mock reviewer。测试 review 不可用、repair 成功/失败、范围变化、main workspace 冲突和 duplicate apply。
```

## 十四、S9 新对话 Prompt：零费用端到端认证

```markdown
继续 Draft PR #1。本会话只实施 docs/16 的 S9：Orchestrator-first 的零费用端到端认证和缺陷修复。

本轮禁止真实 API、真实 credential、真实 Codex config/auth 和私有源码。使用临时 synthetic repo、mock OpenAI/DeepSeek、mock auth resolver、临时 state/worktree/MCP。运行 docs/16 S9 的完整矩阵：privacy、route mismatch、crash、ambiguous、duplicate、scope、secret、quality、repair、apply conflict、redaction 和 cleanup。

只有所有确定性测试通过才能把状态改为“eligible for limited live Pilot”。旧架构的历史 live benchmark 不算新架构通过。输出完整测试清单、未测试项、风险和真实运行前仍需的授权。
```

## 十五、S10 新对话 Prompt：有限真实 Pilot

```markdown
继续 Draft PR #1。本会话拟执行 docs/16 的 S10 有限真实 Pilot。开始前先证明 S0–S9 阶段门均已通过，并再次向我展示：任务集、provider/model、预计调用次数、最大预算、允许外发的数据、停止条件和输出指标。

除非我在本会话明确说“运行”，否则只做设计，不发出任何真实请求。真实运行只使用公开或 synthetic fixture，不发送私有源码、完整聊天、真实截图或敏感内容。

先比较 GPT-only 与 GPT plan → DeepSeek execute → local gate → GPT review。记录质量、回归、人工干预、scope/privacy/routing violation、ambiguous rate、token、wall-clock 和分层成本。任何 secret、错误路由、主目录污染、预算失控或无法解释的重复调用立即停止整批 Pilot。

允许结论为“不值得继续”：若成本下降很少、延迟或返工显著增加，应明确建议简化或停止扩展。
```

## 十六、遇到跨阶段问题时怎么处理

- 当前阶段依赖的早期缺陷：回到早期阶段修复，并在日志中标记当前阶段暂停。
- 只是未来增强：写入 `docs/16` 对应 TODO，说明默认、替代、评估证据和改变条件，不顺手实现。
- 需要扩大权限/外发/provider/预算：BLOCKED，等待用户明确决定。
- 官方 Codex/供应商能力发生变化：重新查官方文档，记录日期和影响；不要凭旧记忆修改。
- 实现与计划不同但更安全：先解释证据和取舍，更新 ADR 后再实施。
- 实现与计划不同且会扩大范围：停止并请求用户决定。

## 十七、给下一会话的最短通用 Prompt

当阶段已经明确时，可以使用：

```markdown
继续 Jacky-Lau1/model-routing Draft PR #1，只实施 docs/16 的 S<阶段编号>。先读 docs/14、docs/16、docs/17、docs/08、最新 logs 和 PR diff，确认上一阶段门已通过。

遵守 Orchestrator-first：GPT 常驻前台，DeepSeek 只做后台受控执行，不切换 Desktop provider，不读取或修改真实 Codex/DeepSeek 配置/认证/密钥，不运行真实 API，除非我明确说“运行”。使用临时目录、mock provider、synthetic repo；保留无关 dist/、node_modules/。

开始前报告准确文件和测试范围；只做本阶段；结束时维护 README、ROADMAP、CHANGELOG、ADR、decision/validation log 和 docs/17，做脱敏扫描并报告阶段门。commit/push 依本会话授权。
```

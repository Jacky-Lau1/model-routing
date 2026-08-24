# Part 2｜真实链路与降费证明 Prompt

```text
继续项目：

G:\OneDrive\个人文档\个人AI\模型路由开发

执行“三部分 Agent Team 闭环计划”的 Part 2：真实链路与可审计降费证明。

只有 Part 1 所有阶段门 PASS 才能开始。先读取 Part 1 交接、README、ROADMAP、docs/16、docs/17、docs/27、docs/28、安装/回滚文档、Pilot schema、pricing catalog、quality policy 和完整 Git 状态。

请作为主 agent 组织 agent team：
- Agent A：只读复核当前 OpenAI Codex MCP、DeepSeek/OpenAI 模型、endpoint、usage 和价格官方文档；
- Agent B：设计 public/synthetic paired task set、fixture hashes、hidden gates 和 counterbalanced 顺序；
- Agent C：审计成本统计、Pilot aggregation、null/estimate/invoice/quota 分层；
- 主 agent：唯一负责真实配置、credential 授权、exact approval、provider 请求和 hard-stop。

子 agent 不得并行执行真实配置写入、credential 操作、provider 请求或 apply。所有真实副作用由主 agent 串行执行。

权限规则：
1. 写真实 Codex config 前，展示 exact target、exact block、SHA-256、before hash、backup 和 rollback，等待用户明确批准。
2. credential 与 MCP 注册分开授权；不得让用户把 API key 粘贴到聊天、仓库、日志或命令参数。
3. 每次 provider side effect 前展示完整 approval summary、approval_summary_hash、最大 request/token/wall/cost 和 stop conditions，等待包含 exact hash 的授权。
4. 未获批准时只允许只读检查、官方资料核验、离线准备和 dry-run。
5. commit、push、tag、PR、merge 仍需单独授权。

按顺序执行：

一、真实 MCP 安装和 discovery
- 重新核验当前 OpenAI Codex MCP 官方文档。
- 运行 doctor 和 config preview。
- 获批后只写 exact Router MCP block，不改 auth/provider/model/profile 或其他 MCP。
- 写后验证配置可解析、block hash 正确、其他配置不变。
- 需要重启时停止真实执行；新会话验证全部 router.* tools 的名称、schema、annotations，以及 CLI/MCP 使用同一 state root。

二、credential 隔离
- 展示 credential alias、存储类别、用户边界、读取进程和 child environment allowlist。
- 只做 credential-status 存在性检查，不输出 secret。
- smoke approval 前不发送探测请求。

三、一次 hybrid smoke
固定边界：单一 public fixture、DeepSeek Flash、禁止 Pro escalation/redirect/private data/full chat、hidden data 不进入模型上下文、只读批准 fixture、只写 isolated worktree、最多 2 attempts/6 HTTP requests/一次 repair、禁止静默 retry、禁止 apply 到开发仓库、禁止 commit/push。

先 prepare 并展示完整 summary/hash，等待 exact hash 授权后才 execute。重复/并发调用不得重发。

通过要求：visible 与 hidden 全通过；final acceptance=true；secret/scope/privacy/routing/duplicate/main pollution=0；ambiguity=0；provider/model/endpoint/request ID/usage/round cost 完整；PilotRunRecord 可验证；开发仓库和 Codex config/auth/provider 不变。

四、建立隔离 GPT-only evaluation arm
- 仅用于评测，不作为生产 provider，也不修改 Codex Desktop 默认 provider/model/auth。
- 查询当前 OpenAI 官方模型、API、usage 和价格；由用户明确选择模型，不得自行替换。
- GPT-only 与 hybrid 使用同一 fixture/base hash/scope/visible+hidden acceptance/wall budget/顺序/Pilot schema。
- 记录权威 response model、request ID、token/cache、wall time 和 list-cost；provider/invoice/quota 缺失时保留 null。
- GPT-only 也经过 structured patch、isolated worktree、scope、secret、visible/hidden gate 和 Final Review。
- hidden tests/reference answer 不进入 GPT 输入。

无法获得可审计 GPT telemetry 时，成本验证立即 BLOCKED；只能报告 hybrid 的绝对成本，不能宣称相对 GPT-only 降费。

五、paired Pilot 与调优
先设计并展示 20 对 public/synthetic tasks，覆盖单文件 bug、小型多文件 bug、测试补充、有限重构、API 边界、文档/代码一致性和明确不应路由的任务。

每个任务展示 fixture/base hash、scope、acceptance、hidden gate、难度、arm 顺序和最大 request/token/wall/cost；等待整批 hash 和预算批准后才执行。

规则：每个 task/arm 使用全新 isolated repo/state；arm 间不泄漏输出；不人工修代码、不删除失败样本、不降低 acceptance、不把 null 当零、不忽略 GPT planning/review/repair/失败请求、不自动 Flash→Pro。任一安全/隐私/路由/主目录污染、ambiguity 或 unexplained duplicate 立即停止整批。

允许依据证据调优 TaskPackage/context 大小、稳定前缀/cache、budget、Flash 适用范围、本地门顺序和 GPT Review 输入；不得改变 paired acceptance。

Part 2 硬门：
- hybrid acceptance 不低于 GPT-only；
- regression=0；
- scope/privacy/routing/secret/main pollution=0；
- ambiguity=0；
- unexplained duplicate=0；
- intervention 不高于 baseline；
- repair 没有显著增加；
- Hybrid 总可审计成本相对 GPT-only 至少下降 30%。

成本必须包含 GPT planning + GPT Review + DeepSeek execution + repair + failed/duplicate requests，并分别列出 provider-reported、estimated list、invoice、quota。

达不到 30% 时只允许一次有证据的策略简化和复测；仍不达标则 recommendation=stop，不进入 Part 3。

最终输出 agent team 产出、MCP/config/credential 变更、所有真实请求批准 hash、smoke 结果、paired run records、聚合质量/token/cache/request/wall/成本、下降比例、失败分类、expand|simplify|stop、阶段门和 Git status。
```

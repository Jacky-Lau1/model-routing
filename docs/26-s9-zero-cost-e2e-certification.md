# 26｜S9 Orchestrator-first 零费用端到端认证

> 日期：2026-08-24
> 结论：S9 mock/synthetic 阶段门通过；项目仅达到 **eligible for limited live Pilot**，不代表 S10 已授权、真实 provider identity 已认证或 production ready。

## 认证边界

S9 全程使用系统临时目录中的 synthetic Git repository、外置 state、managed worktree、mock DeepSeek/OpenAI-review decision、mock auth resolver、injected mock fetch、mock local command 和临时 STDIO MCP。没有读取真实 Codex config/auth、DPAPI、credential-bearing environment 或私有任务源码；没有注册真实 MCP，没有发出真实 API 请求，也没有运行 `live-benchmark`。

完整控制链覆盖 `prepare → exact approval → isolated worktree → provider attempt → local quality gate → EvidenceBundle → foreground final review → repair/apply or BLOCKED`。CLI 与 MCP 只观察同一 `RouterCoreService` 和外置状态，不复制安全判断。

## 矩阵结果

| 矩阵 | 确定性结果 |
| --- | --- |
| clean / dirty main repo | clean 全链通过；非目标 dirty 文件在显式 apply 后原样保留；目标 dirty overlap 与 apply 前漂移 BLOCKED |
| privacy / egress | public + allow 可执行；private 在当前 S4 public-only capability 发送前 BLOCKED；secret/restricted 与 deny egress 在 prepare/execute 前失败关闭 |
| Flash / Pro | `deepseek-v4-flash` 与 `deepseek-v4-pro` 的 frozen mock binding、response model 和 route evidence 一致 |
| route mismatch | wrong endpoint、auth alias、model family、wire protocol 全部在 auth resolver/fetch/provider send 前拒绝 |
| provider outcomes | success 进入 REVIEW_PENDING；local preflight 为 FAILED_BEFORE_SEND；timeout/reset/failure/response-lost 为 AMBIGUOUS/BLOCKED，duplicate execute 不重发 |
| crash checkpoints | PREPARED、SENDING、SUCCEEDED 注入中断均保留 durable evidence；SENDING recovery 转 AMBIGUOUS，main workspace 不变 |
| duplicate / concurrent | 两个 execute 与后续 duplicate 收敛到同一 attempt/provider side effect，mock send=1 |
| scope / budget | scope 越界和 provider-reported token 超预算均在结构化 patch 写 worktree 前归为 response_invalid/AMBIGUOUS/BLOCKED |
| secret / quality | 新高置信度 secret 形成失败的 privacy/secret gate；mock lint failure 与 provider success 分开记录；PASS quality 生成可校验 EvidenceBundle |
| repair | 一次成功 repair 生成新 REPAIR/VALIDATE attempts 与新 bundle；invalid-scope repair 消耗唯一次数并 BLOCKED |
| apply conflict | main snapshot/preimage 变化 BLOCKED 并保留用户内容；成功 apply 仅留下未提交单文件 edit |
| redaction | credential-shaped error 与用户绝对路径不进入 compact status/attempt 持久状态 |
| cleanup | retained dirty owned worktree 的 cleanup 失败关闭并保留；既有 ownership/recovery 全套回归继续通过 |
| CLI / MCP | 结构化 CLI prepare、直接 MCP 与临时 STDIO MCP 对同一 state 返回逐字段相同状态，provider send=0 |

## 矩阵暴露并修复的缺陷

canonical 首次 EXECUTE 原先只把 token budget 写入 frozen RouteBinding，请求返回后却只在 repair round 复核累计 usage。若 mock provider 报告的 input/output usage 超过批准预算，初次结构化 patch 仍可能先写入 isolated worktree。

修复后每个 EXECUTE/REPAIR response 都在 route evidence 与 patch shape 验证之后、任何 patch apply 之前调用同一累计预算检查。超预算响应进入 `response_invalid → AMBIGUOUS/BLOCKED`；main 与 worktree 都不接受该 patch，且不会自动重发。没有扩大预算、provider、scope 或外发授权。

## 测试证据

```text
S8 启动基线:
- TypeScript --noEmit: PASS
- git diff --check: PASS
- S8 directed: 1 file / 6 tests PASS

S9 directed:
- test/s9-zero-cost-e2e.test.ts: 1 file / 26 tests PASS

Adapter isolation:
- test/deepseek-chat.test.ts: 1 file / 43 tests PASS

Full deterministic regression after S9:
- 25 files / 368 tests PASS

Build:
- TypeScript emit to a new external temporary directory: PASS, 174 generated files
- temporary build directory removed after exact-path verification
```

一次 S9 修改前的全并行基线运行在 342 个断言均通过后报告了一个临时目录已清理时的未处理 `lstat` rejection，进程 exit 1。随后 `deepseek-chat` 43/43、S9 26/26 和全并行 25 files / 368 tests 均独立通过，未复现该信号。它保留为 runner-flake 风险，不作为已修复产品缺陷，也没有据此扩大 adapter 改动。

## 未测试项与风险

- 未测试真实 Codex MCP 注册、发现和当前 GPT 会话 live tool invocation；未修改任何真实 Codex config/auth/provider。
- 未调用真实 OpenAI/DeepSeek API、真实 credential resolver、DPAPI、系统代理或供应商账单；真实 API 请求数与费用均为零。
- mock `Response.url` 只认证本地 tuple 失败关闭；DNS/socket peer、proxy、TLS、供应商 header 合同仍不可观测。
- capability/worktree 不是 OS sandbox；trusted project command 仍是受信本地进程，secret scan 仍为启发式。
- private Direct capability 仍按 S4 当前边界失败关闭；没有扩展 private provider execution。
- apply 仍只支持单个 UTF-8 replacement/create；不支持 multi-file、rename/delete/binary/CRLF。filesystem write 成功到 APPLIED checkpoint 之间的进程崩溃仍保守 BLOCKED，未认证事务恢复。
- AMBIGUOUS 只保证本地不自动重发，不能证明供应商 exactly-once 或未计费。
- 没有真实 usage、cost、invoice 或 ChatGPT quota 真值；旧架构历史 live benchmark 不计入新架构证据。
- 仓库没有独立 ESLint 配置；`git diff --check` 是当前 repository lint/whitespace gate，TypeScript strict check 是静态类型门。

## 进入真实运行前仍需的当次授权

S10 仍默认禁止。任何有限 live Pilot 必须由用户在当次会话明确授权，并在发送前展示并确认：

1. 仅公开或 synthetic 的任务集、允许外发的精确路径/content hash；
2. foreground GPT 与 DeepSeek 的 provider/model/endpoint/auth alias，以及真实 credential 使用方式；
3. 预计与最大 API 调用次数、token、费用和 ChatGPT quota 影响；
4. 是否允许注册临时真实 Codex MCP，以及配置写入、撤销和验证方案；
5. 停止条件、AMBIGUOUS 后不自动重发、主 workspace apply/commit/push 分离；
6. 真实 route/peer/usage/cost 证据与 Pilot 输出指标。

未经这些授权，不运行 S10，不读取 credential，不注册 MCP，不 apply 当前仓库变更，不 commit、push 或修改 Draft PR #1。

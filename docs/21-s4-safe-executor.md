# 21｜S4 Direct DeepSeek Safe Executor 与 Capability Boundary

> 状态：S4 已通过（2026-08-21）。全部验证使用系统临时目录、synthetic 文件/repo、mock provider/fetch 和显式 synthetic environment/credential；未读取真实 config/auth/DPAPI/env 值，未运行 API 或 benchmark。

## 实现边界

S4 只约束 Direct DeepSeek Adapter 的本地 capability surface：

- legacy plan 分别审批 `readFiles`、`writeFiles` 与 `dataClassification`，`allowedFiles` 只由 write scope 派生用于兼容和 post-hoc 检查；
- 所有 DeepSeek stage 在 S7 完整 TaskPackage/EffectivePolicy 接线前只接受显式批准的 public 分类；
- 文件能力仅在 `EXECUTE/REPAIR` 开启，非代码 DeepSeek stage 携带 filesystem grant 会在 credential/fetch 前失败；
- 模型只能看到批准 read manifest 的相对路径/metadata，并通过受控 read 获取内容；
- 模型只能提出一个完整 UTF-8 replacement/create，不能直接写文件；
- Orchestrator 只在 S3 isolated worktree 内按 write scope 和 preimage hash 应用 proposal；
- 不提供 shell、任意命令、package install、GitHub、browser 或任意模型工具网络。

这不是 OS sandbox。DeepSeek transport 本身仍需要 provider 网络；其 endpoint/auth/model/protocol/redirect 身份属于 S5。S6 才负责完整 quality gate、baseline-aware secret scan 和 EvidenceBundle。

## 实际文件范围

生产代码：

- `src/safe-executor.ts`（新增）：grant/manifest、lexical/physical path、read、proposal、atomic apply；
- `src/providers/deepseek-chat.ts`：受限工具面、capability preflight、tool/byte budget、内存 proposal；
- `src/orchestrator.ts`：独立 read/write/classification plan、grant 派生、response-validation apply；
- `src/types.ts`：legacy S4 capability/proposal 类型及 PlanPacket 兼容字段；
- `src/credentials.ts`：synthetic-injectable loader、最小 child env、绝对 PowerShell executable。

测试：

- `test/safe-executor.test.ts`（新增）；
- `test/credentials.test.ts`（新增）；
- `test/deepseek-chat.test.ts`；
- `test/orchestrator.test.ts`；
- `test/policy.test.ts`。

治理文档与日志：

- `README.md`、`ROADMAP.md`、`CHANGELOG.md`；
- `docs/08-decisions.md`、`docs/11-implementation.md`、`docs/13-continuation-handoff.md`、`docs/16-orchestrator-first-implementation-plan.md`、`docs/17-orchestrator-first-stage-handoffs.md`、本文；
- `logs/decision-log.md`、`logs/routing-validation-log.md`。

S1 六类 wire contract 与 JSON Schema 未修改；S5 route preflight、S6 quality/EvidenceBundle、S7 MCP/core、S8 main-workspace apply 和 S9 E2E 均未提前实施。

## Capability 与工具矩阵

| 能力 | 模型可见接口 | 授权来源 | 本地副作用 |
| --- | --- | --- | --- |
| 列出 | `list_manifest {}` | approved exact `readFiles` 派生的 hash manifest | 无；不枚举仓库 |
| 读取 | `read_file { path }` | manifest exact path + public classification + current hash/size | 只返回单个受控 UTF-8 内容 |
| 修改提议 | `propose_patch { path, preimageHash, replacement }` | approved `writeFiles` + existing file manifest/preimage，或 approved new path + null preimage | adapter 内存收集，不写盘 |
| shell/command/package/GitHub/browser/network | 不存在 | none | 不可调用 |

runtime 对 tool arguments 使用 exact-object 检查，unknown/missing field 失败；单轮多个 tool call 也计入总调用预算。manifest entry 数、manifest/read bytes、replacement bytes 和单文件大小均有限额。纯文本中的 diff/JSON 不会自动应用。

## Read/write 与审批绑定

planning schema 要求 `readFiles`、`writeFiles`、`dataClassification`。三者进入 plan hash、legacy approval 与 isolation-bound execution approval；derived capability grant 还进入 provider request fingerprint。read scope 不授权 write，write scope 不授权现有文件 blind overwrite：现有文件必须同时在 read manifest 且 preimage 匹配。

legacy bridge 无完整 user/project egress 解析，因此采用更保守的 public-only 默认。private 或 `secret_restricted` plan 即使 legacy sensitivity 仍为 normal，也会在任何 DeepSeek send 前 BLOCKED。S7 必须用 S1 TaskPackage/RouteBinding/EffectivePolicy 取代该 bridge，不得把 `normal` 静默解释为 public。

## 路径、内容与 manifest 规则

exact path 拒绝：

- `..`、absolute、drive-relative、UNC/device path、backslash/mixed separator、ADS、NUL/control、重复/点 segment；
- Windows trailing dot/space 与 `CON/PRN/AUX/NUL/COM*/LPT*`；
- case alias；write matcher即使在 Windows 也要求与批准 scope 字符串大小写一致；
- `?` glob（S4 MVP 不支持）；
- root、parent 或 leaf 的 symlink/junction/reparse alias；每级 `lstat + realpath + containment`；
- `.git` 精确 segment（不误伤 `.gitignore`/`.gitattributes`）、`.env*`、`.envrc`、`.ssh/.codex/.aws/.azure`、key/token/password/credential/secret basename、private-key formats 和 production dump/backup。

read manifest 只从 exact approved path 构造，不调用 Git 或递归目录枚举。文件必须是普通文件、public、在 byte limit 内、fatal UTF-8 decode 成功、无 NUL/CR、且不含高置信度 secret-like pattern；manifest 保存原始 byte SHA-256 与长度，每次 preflight/read 都重验。S4 MVP 对 CRLF/mixed CR、binary、invalid UTF-8 和 oversized file 失败关闭，不做静默换行或编码转换。

## Structured patch 与 attempt 语义

S4 选择 TODO-01 默认：structured `propose_patch`，不开放 generic/受限 writer。

- 一次 attempt 必须返回且只能返回一个 proposal；adapter 最多保留一个 pending target；
- existing replacement 必须是 manifest exact path，current bytes 同时匹配 manifest hash 和 proposal preimage；
- create 只允许 approved exact path、null preimage、existing physical parent，且不创建目录；
- replacement 必须是 size-bounded UTF-8/LF text；rename、delete、multi-file、binary、CRLF、large file 不支持；
- proposal tool turn 不写盘；final provider response 完整、provider/model 基础校验通过后，Orchestrator 在 DurableAttemptExecutor 的 async response validation 中 staged/sync 后原子 rename（existing）或 link（new）；
- apply 成功后才写 `SUCCEEDED/VALIDATING`。response 丢失、preimage/scope/apply 失败或该边界崩溃均保守为 `AMBIGUOUS/BLOCKED`，不自动重发。

单文件策略避免多文件顺序替换的 partial batch。仍存在 OS 级极窄 TOCTOU 与 rename/link/fsync 故障风险；失败时保留 isolated worktree 供诊断，不接触 main workspace。

## Environment、auth 与网络

Direct Adapter 在 code stage 的 root/grant/manifest preflight 完成后才解析 auth 和调用 fetch。credential decrypt child 只接收 `SystemRoot/WINDIR/TEMP/TMP` 中实际存在的 allowlist 项以及专用 `CODEX_ROUTER_SECRET_PATH`；不继承 PATH、PATHEXT、ComSpec 或任意 synthetic sentinel。PowerShell 路径由验证后的本地 drive `SystemRoot` 绝对构造，避免 PATH 同名程序劫持。

synthetic auth 仅在 mock transport authorization header 中出现；请求 body/messages/tool schema/result 不含 key。S2 persistence 仍不保存 response body/raw/reasoning。S5 将移除未绑定 auth source、固定 endpoint tuple 并验证 redirect/response origin；S4 不宣称 transport identity 已证明。

## 零费用测试结果

最终命令：

```text
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec vitest run
```

结果：TypeScript 通过；Vitest 15/15 files、169/169 tests 通过。S4 定向覆盖包括：

- traversal、drive/UNC/device/absolute/ADS、Windows device/trailing-dot、case、`?` scope；
- read scope 外的普通文件、missing/stale/duplicate manifest、byte/hash/classification；
- `.git` control file、env/key/token/password/credential/secret/prod dump 与高置信度 secret content；
- real Windows junction parent/root alias；POSIX file-symlink 分支与共同 `isSymbolicLink` rejection；
- byte-based size、binary、invalid UTF-8、NUL、CRLF 和 cumulative budget；
- proposal memory-only、correct/wrong preimage、out-of-write-scope、new file、unknown/duplicate/multi-target pre-write reject；
- DeepSeek tool exact allowlist、reasoning replay、auth not in body、unknown shell/network tool、proposal 后 final reset 零写入、tool-call budget、non-code grant fetch=0；
- synthetic credential direct/decrypt/failure、child env exact allowlist、absolute executable 和 invalid Windows root；
- Orchestrator isolated apply、post-hoc scope、private TEXT_EXPAND fetch=0、invalid preimage `AMBIGUOUS/response_invalid`、duplicate no resend 和 main workspace unchanged；
- S0–S3 全部回归。

## 未测试项与剩余风险

- 未运行真实 DeepSeek/OpenAI API、live benchmark 或任何费用操作；没有真实 provider cost/quality/route 结论。
- 未读取真实 config/auth/DPAPI/env 值；synthetic runner 未执行 PowerShell。
- 未验证 endpoint、auth alias、model family、protocol、redirect、DNS、response URL/header/request ID；属于 S5。
- 未实现 OS sandbox、Job Object/AppContainer、低权限账户或任意代码运行隔离；属于 TODO-03。
- 当前 Windows 主机创建 file symlink 返回权限错误；真实 Windows junction/root alias已覆盖同一 Node symlink/reparse rejection。未穷尽非 symlink reparse tag、OneDrive placeholder、ACL、hard link、网络文件系统和 Unicode normalization。
- 未做 resolve/read/rename 间精确 TOCTOU swap、真实 kill/断电、temp sync/rename/link 注入失败或杀毒软件长期锁。
- BOM、exact max boundary、复杂 Unicode normalization 的覆盖有限；MVP 对有歧义输入保持拒绝。
- S6 baseline-aware secret scanner、完整 quality sequence/EvidenceBundle，S7 MCP/core，S8 final review/main apply，S9 E2E 尚未完成。

## 阶段门

S4 PASS：Direct DeepSeek Adapter 的模型可见本地工具只访问批准 public read manifest，并只能提出一个受 write scope/preimage 约束的 structured patch；文件和 credential child capability 对无法证明的路径、内容、环境或副作用失败关闭。全部结论只来自临时 synthetic/mock 攻击测试；不等于 OS sandbox、真实 provider identity 或 production readiness。S5 可以开始。

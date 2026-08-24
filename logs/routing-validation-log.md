# 路由验证日志

| 日期 | 用例 | 候选 provider/model | 版本/网关 | 真路由证据 | 质量门 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-11 | 初始化 | 未选择 | 未实施 | 不适用 | 不适用 | 未开始 | 此表为 Phase 0 模板 |
| 2026-08-20 | Orchestrator-first 只读架构复查 | GPT 前台 + Direct DeepSeek 后台（设计） | Draft PR #1 `aa96a13` | 代码/文档只读对照；未发 API | 未运行 | 计划完成 | 发现 tuple、endpoint、只读、checkpoint、幂等、隐私和前台接入差距；不构成运行验证 |
| 2026-08-20 | 外部建议证据对照 | 同上（设计） | OpenAI Docs 2026-08-20 + Draft PR | 官方配置/MCP/CLI/App Server/SDK 文档与 PR 源码对照 | 未运行 | 部分采纳并形成阶段计划 | worktree 不等于 sandbox；隐私改双维；RouteBinding 分层；成本真值分离；Workflow/Attempt 分层 |
| 2026-08-20 | S0–S10 计划与交接 | 同上（设计） | `docs/16`、`docs/17` | 文档审查；未发 API | 未运行 | 待实施 | S0–S9 均为零费用阶段；旧 live benchmark 不证明新架构通过 |
| 2026-08-21 | S0 默认入口退役 | Orchestrator-only（离线） | `codex/s0-orchestrator-first` working tree | 默认脚本静态调用链、mock shortcut manifest、CLI/Terminal help；未发 API | PowerShell syntax；TypeScript `--noEmit`；Vitest 28/28 | 通过 | 临时目录实际生成 + dry-run 均只含 Orchestrator；未读取真实 config/auth/DPAPI/env 值，未安装，未运行 `live-benchmark` |
| 2026-08-21 | S1 合同、隐私与 schema | DeepSeek binding（仅合成数据构造） | `codex/s1-contracts-privacy-schema` working tree | Task/route/context/policy/approval hash 绑定；未发 API | JSON Schema 解析与约束；TypeScript `--noEmit`；Vitest 42/42 | 通过 | 字段顺序稳定；route/scope/policy/budget 变化失效；private/未分类/无授权默认 deny；未知字段、空 scope、危险路径和 secret-like context 拒绝；glob 无法证明收窄时拒绝；未读真实配置/env/凭据 |
| 2026-08-21 | S2 Workflow/Attempt、crash 与并发幂等 | 全部为内存 mock provider | `codex/s2-attempt-persistence-idempotency` working tree | PREPARED/SENDING/SUCCEEDED 磁盘记录、稳定 attempt ID、task/approval lock；未发 API | TypeScript `--noEmit`；Vitest 67/67 | 通过 | 三 checkpoint 崩溃、十种 Stage 异常、并发 approve 单调用、AMBIGUOUS 重启不重发、repair 历史、原子写中断和脱敏通过；未读 config/env/credential，未联网、未建 worktree、未实现 MCP |
| 2026-08-21 | S3 isolated Git worktree、dirty evidence 与冲突检测 | 不适用（synthetic Git repo、mock provider） | `codex/s3-isolated-worktree` working tree | 不适用；验证 base/snapshot/isolation hash、worktree owner/common-dir/clean detached HEAD 和路径隔离，不构成真实路由验证 | TypeScript `--noEmit`；Vitest 116/116 | 通过 | clean/modified/added/untracked/renamed/deleted、ref 移动/删除、三创建与三清理检查点中断、同步并发审批、cross-instance/dead-owner/ownerless/release-race handoff、auto/approve pre-write/junction root containment、READY residual、scope 双状态、主目录漂移、worktree `dist/` 隔离、dirty/unknown/junction cleanup 负例通过；未读 config/auth/DPAPI/env/credential，未联网、未运行 API/benchmark |
| 2026-08-21 | S4 Direct DeepSeek capability boundary | DeepSeek Direct Adapter（mock fetch；synthetic model response） | `codex/s4-safe-executor` working tree | 不适用；只验证本地 manifest/tool/patch/env capability，不发 API，不构成真实路由证据 | TypeScript `--noEmit`；Vitest 15/15 files、169/169 | 通过 | traversal/UNC/device/ADS/case/`?`、real junction、`.git`/secret path+content、scope/classification/hash/size/encoding、single patch/preimage、proposal-final reset、tool/byte budget、private text fetch=0、credential child env/absolute executable、AMBIGUOUS/no-retry/main unchanged 通过；未读取真实 config/auth/DPAPI/env 值，未运行 API/benchmark；S5 route identity 未验证 |
| 2026-08-21 | S5 immutable RouteBinding 与 route preflight | Direct DeepSeek injected mock fetch；Codex CLI bound preflight | `codex/s5-route-preflight` working tree | approved binding/hash + stable adapter ID + exact injected target/Response.url/status/model + 分源 body/header ID 的逐轮 mock evidence；`route_tuple_verified_peer_unobserved`，不构成真实 provider/peer 证据 | TypeScript `--noEmit`；S5 定向 7/7 files、160/160；全量 17/17 files、279/279 | 通过 | 11类hash-valid mismatch durable FAILED_BEFORE_SEND/resolver0/fetch0；HTTP/userinfo/host/port/path/cross-provider、301/302/303/307/308 relative/same/cross redirect、wrong/missing URL/model/ID、多轮失败、approval全字段、registry adapter ID、credential valid-once、fake evidence、missing-ID AMBIGUOUS/no-resend、Codex no-fallback 通过。Codex bound transport、DNS peer、proxy/TLS不可观测；未读真实 config/auth/DPAPI/env 值，未调用 API/benchmark |
| 2026-08-23 | S6 恢复与 WIP 安全 checkpoint | Local Quality Gate / EvidenceBundle（离线 WIP） | `codex/s6-quality-evidence` @ `4f20d6b` + 19-file WIP | 只读核对指定文档、日志、源码和 WIP diff；未发 API，不构成真实路由证据 | checkpoint 前未运行最终 typecheck/Vitest | WIP / BLOCKED | 已确认 symlink snapshot 越界、命令诊断、baseline-secret diff、共享 object store 写入、raw diff limit、schema ceiling、production timeout/overflow、artifact race、report integrity、usage unavailable 等阻塞项；详见 `docs/23-s6-quality-evidence.md`。S6 绝非 PASS，S7–S9 未开始。 |
| 2026-08-23 | S6 Local Quality Gate 与 EvidenceBundle v2 | Local validation / EvidenceBundle（synthetic/mock） | `codex/s6-quality-evidence` completion checkpoint | Local route evidence 使用独立 `local` verification 语义；QualityGateReport 绑定请求、冻结快照、artifact 与 self hash；未发 API，不构成真实 provider route | TypeScript `--noEmit` exit 0；S6 定向 7/7 files、118/118 exit 0；全量 19/19 files、323/323 exit 0；diff/check/脱敏/用户产物审计 | 通过 | symlink physical containment、bounded/redacted diagnostics、baseline secret 可审查 diff、物理只读 Git、raw byte ceiling、schema 16/4/1 MiB 与 30 min、production timeout/overflow、wall budget、artifact mutation/final forbidden、report replay/tamper、usage null/zero 均通过。完整命令见本表后的 S6 command evidence；全部为 synthetic repo/mock provider/credential；未读真实 config/auth/DPAPI/credential-bearing env 值；最终文档审计的一次非敏感 `USERPROFILE` locator 意外展开见 `docs/23`。未调用 API/benchmark；S7 尚未开始。 |
| 2026-08-24 | S7 canonical core、结构化 CLI、thin STDIO MCP/skill | Direct DeepSeek mock adapter；synthetic foreground client | `codex/s6-quality-evidence` working tree | canonical TaskPackage/policy/route/approval hash、mock response tuple 与 EvidenceBundle reference；未发 API，不构成真实 provider/peer 证据 | TypeScript `--noEmit` exit 0；S7/共享安全定向 7/7 files、113/113；全量 23/23 files、335/335 | 通过 | 单一 synthetic STDIO 会话完成 prepare→execute→review_evidence→finalize；mock send=1，重复 execute 不重发，main workspace 与 provider/config/auth sentinel hash 不变。未知 chat field、approval/bundle hash mismatch、private capability 均失败关闭。未注册真实 MCP、未写 `.codex/config.toml`、未读真实 config/auth/credential-bearing env、未联网/未运行 API/benchmark；详见 `docs/24`。 |
| 2026-08-24 | S8 GPT 三态 review、单次 repair、controlled apply | Direct DeepSeek mock adapter；mock GPT reviewer；synthetic Git repo | `codex/s6-quality-evidence` working tree | 当前 bundle + frozen approval/route/policy/runtime binding、repair 新 attempt、apply snapshot/preimage/postimage；未发 API，不构成真实 provider/peer 证据 | TypeScript `--noEmit`、diff check；S8 6/6；拆分全量 24 files、342/342 | 通过 | review unavailable 保持 REVIEW_PENDING；repair success/failure、changed scope approval、main drift、initial dirty target、duplicate apply 通过。PASS 只到 APPLY_PENDING；apply 不 commit/merge/push。未注册真实 MCP、未读真实 config/auth/env、未联网/运行 API/benchmark；详见 `docs/25`。 |
| 2026-08-24 | S9 Orchestrator-first 零费用端到端认证 | Direct DeepSeek injected mock fetch + mock auth；mock foreground review/local command；synthetic repo/MCP | `codex/s6-quality-evidence` working tree | canonical frozen contracts、mock Response.url/model/request ID、attempt checkpoints、EvidenceBundle、CLI/MCP shared state；不构成真实 provider peer 证据 | TypeScript、diff check；S8 6/6；S9 26/26；adapter 43/43；全量 25 files 368/368；外置 emit build | 通过 | privacy/egress、Flash/Pro/mismatch、success/failure/ambiguous/crash/duplicate、scope/usage/secret/quality、repair/apply、redaction/cleanup 全覆盖；修复首次 EXECUTE patch 前 usage budget 缺口。真实 API/credential/config/MCP/live benchmark 为零；仅 eligible for limited live Pilot，详见 `docs/26`。 |
| 2026-08-24 | Part 1 离线工程闭环 | 全程离线；无 provider/API/credential/config/MCP 副作用 | `codex/router-three-part-closure` working tree | canonical quality gate + hidden acceptance、exact informed approval、PilotRunRecord 接入 Core/CLI/MCP、可安装离线候选与 doctor；不构成真实 provider/peer 证据 | TypeScript `--noEmit`；Part 1 定向 2 files 17/17；S8 7/7；S9 26/26；全量 29 files 414/414；schema/examples；diff check；外置 build；临时 install→discovery→doctor→rollback | 通过 | visible/hidden pass/fail、hidden 泄漏、policy/catalog/executable/argv/hash 篡改、timeout、overflow、进程树、gate 修改 worktree、fixture/base commit 变化、roots 重叠、config/state 损坏、main workspace 不变、临时 Codex home 安装/发现/回滚全覆盖。修复 5 处未验证回归（`fs.rm` 递归挂起→manual `rmrf`、MCP 工具断言缺 `router.pilot_report`、显式超时不足、无权限 symlink 环境、legacy orchestrator `visible_tests` 投影与校验器不一致）。真实 API/credential/config/MCP/live benchmark 为零；Part 1 通过不改变 S10 `BLOCKED`，详见本表后 command evidence。 |

### S6 command evidence（2026-08-23）

以下保留完整 argv；bundled Node 的用户目录前缀按脱敏政策记为 `<codex-bundled-node.exe>`，没有通过环境变量解析或把用户绝对路径写入日志。

```powershell
& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' --noEmit
# exit 0

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/quality-gate.test.ts test/local.test.ts test/orchestrator.test.ts test/contracts.test.ts test/schema-contracts.test.ts test/scope-guard.test.ts test/policy.test.ts
# exit 0; Test Files 7 passed (7); Tests 118 passed (118)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache
# exit 0; Test Files 19 passed (19); Tests 323 passed (323)

git diff --check
# exit 0
```

### S7 command evidence（2026-08-24）

以下命令使用已有 bundled Node 与仓库依赖；只写系统临时 synthetic repos/state，不通过真实 Codex 配置注册 MCP。

```powershell
& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' --noEmit
# exit 0

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run test/skill.test.ts test/route-preflight.test.ts test/deepseek-chat.test.ts test/attempt-executor.test.ts test/structured-cli.test.ts test/mcp.test.ts test/router-core.test.ts
# exit 0; Test Files 7 passed (7); Tests 113 passed (113)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --reporter=dot
# exit 0; Test Files 23 passed (23); Tests 335 passed (335)
```

### S8 command evidence（2026-08-24）

以下命令只使用 synthetic repo、mock reviewer/provider/local gate 与外置临时 state/worktree；没有真实 API、credential 或费用操作。桌面 runner 的单次时限要求把全量与慢速 worktree 文件拆分执行。

```powershell
& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' --noEmit
# exit 0

git diff --check
# exit 0

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run test/s8-review-repair-apply.test.ts
# exit 0; Test Files 1 passed (1); Tests 6 passed (6)

# split full regression totals
# group 1: Test Files 10 passed (10); Tests 86 passed (86)
# group 2: Test Files 7 passed (7); Tests 166 passed (166)
# group 3: Test Files 6 passed (6); Tests 55 passed (55)
# worktree: Test Files 1 passed (1); Tests 35 passed (35), verified as 25 + 10 slow scenarios
# aggregate: Test Files 24 passed (24); Tests 342 passed (342)
```

### S9 command evidence（2026-08-24）

以下命令只使用已有 bundled Node、仓库依赖和系统临时 synthetic 目录；没有真实 API、credential、Codex config/auth 或 MCP 注册。

```powershell
& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' --noEmit
# exit 0

git diff --check
# exit 0

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/s8-review-repair-apply.test.ts
# exit 0; Test Files 1 passed (1); Tests 6 passed (6)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/s9-zero-cost-e2e.test.ts
# exit 0; Test Files 1 passed (1); Tests 26 passed (26)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/deepseek-chat.test.ts
# exit 0; Test Files 1 passed (1); Tests 43 passed (43)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache --reporter=dot
# exit 0; Test Files 25 passed (25); Tests 368 passed (368)

& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' -p tsconfig.json --outDir '<external-s9-temp-build>'
# exit 0; 174 generated files; exact-path verified and removed
```

### Part 1 command evidence（2026-08-24）

以下命令只使用 bundled Node、仓库依赖和系统临时 synthetic 目录；没有真实 API、credential、Codex config/auth 或 MCP 注册。

```powershell
& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' -p tsconfig.json --noEmit
# exit 0

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/part1-quality-gate.test.ts test/part1-installation.test.ts
# exit 0; Test Files 2 passed (2); Tests 17 passed (17)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/s8-review-repair-apply.test.ts
# exit 0; Test Files 1 passed (1); Tests 7 passed (7)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache test/s9-zero-cost-e2e.test.ts
# exit 0; Test Files 1 passed (1); Tests 26 passed (26)

& '<codex-bundled-node.exe>' 'node_modules\vitest\vitest.mjs' run --configLoader runner --no-cache
# exit 0; Test Files 29 passed (29); Tests 414 passed (414)

# schema/examples：config + examples 共 36 个 JSON 严格解析；quality-gate policy/catalog、pilot-run-record 与 schema 结构断言全部通过

git diff --check
# exit 0（仅既有 LF/CRLF 提示）

& '<codex-bundled-node.exe>' 'node_modules\typescript\bin\tsc' -p tsconfig.build.json --outDir '<external-part1-temp-build>'
# exit 0; 117 generated files; exact-path verified and removed
```

临时环境 install → discovery → doctor → rollback 由 `test/part1-installation.test.ts` 覆盖（7/7）：编译产物 MCP 入口预览、外部生产分发 `initialize` + `tools/list` 发现 9 工具、exact install/doctor/uninstall dry-run、漂移拒绝、auth/provider/model/profile/无关 MCP byte-for-byte 保留、roots 重叠/损坏 JSON/过期 pricing/build 篡改/snapshot mismatch 失败关闭。

修复的 5 处未验证回归：Windows `fs.rm` 递归挂起改为 manual `rmrf`（新增 `test/fs-test-utils.ts`，17 个测试文件统一使用）；MCP `tools/list` 断言补齐 `router.pilot_report`；orchestrator 3 个 + quality-gate 2 个显式 15s/10s 超时统一提到 120s（覆盖慢速 git worktree）；scope-guard symlink 测试在无「创建符号链接」权限时静默产生空文件、增加真 symlink 校验后跳过；legacy orchestrator `visible_tests` 投影由 `tests_run` 改为按 `command_ids` gate outcome 计算，消除 wall-budget 耗尽时的 acceptance projection 矛盾。

## 记录规则

“通过”需要记录 provider/model、请求 ID（可脱敏）、服务端或网关证据、任务包版本、测试命令与退出码。只写“模型回答正常”不算通过。

### S10 preflight（2026-08-24，offline only）

- versioned pricing、canonical round budget、Pilot record 与临时 MCP discovery 定向测试通过；最终全量结果以 `docs/27-s10-preflight-remediation.md` 和本会话交付摘要为准。
- 最终结果：TypeScript `--noEmit` exit 0；diff check exit 0；定向 7 files/90 tests；全量 27/27 files、390/390 tests；S8 6/6；S9 26/26；外置 emit 186 files 后 exact-path 清理。
- 真实 provider request、费用、credential read、真实 MCP/config write、apply/commit/push 均为零。
- 真实 tool discovery、provider route、invoice、peer/proxy 和公平 GPT-only telemetry 未认证；状态 BLOCKED。

### 三部分交接与工作区收口（2026-08-24，offline only）

- 使用三个并行只读 agent 分别审计文档、实现文件和三部分执行设计；共享文件由主 agent 串行整理。
- 旧逐 S 阶段 Prompt 已替换为 Part 1 离线工程闭环、Part 2 真实链路/降费证明、Part 3 日常能力硬化/发布闭环；历史 S1–S9 技术文档和证据保留。
- 重复 YAML policy mirror 已删除，runtime 示例统一为严格 JSON；MCP 示例和 S10 preflight 文档已移除用户绝对路径。
- 删除仓库内 ignored 的陈旧 `dist/`（75 files / 167894 bytes，可由 build 重建）；未删除 `node_modules` 或历史 live run evidence。
- TypeScript `--noEmit` exit 0；全量 Vitest 27/27 files、397/397 tests exit 0；`git diff --check`、JSON parse、Markdown local link audit 均通过；外置 emit build 186 files 后 exact-path 清理。
- 真实 API、credential、Codex config/auth/provider、MCP 注册、apply、commit、push 仍为零。Part 1 尚未实施，当前 S10 仍为 BLOCKED。

架构评审、文档完成或 mock 测试不得记录为“真实路由通过”。`AMBIGUOUS` 调用必须单独记录，不得用客户端重试后的成功覆盖原 attempt。

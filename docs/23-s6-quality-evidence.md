# 23｜S6 Local Quality Gate 与 EvidenceBundle

> 状态：**PASS（离线阶段门，2026-08-23）**。本文保留 S6 完成快照：当时 S7–S9 尚未开始；当前后续阶段状态见 `docs/17-orchestrator-first-stage-handoffs.md`。
>
> 结论边界：本阶段只证明 synthetic repo、mock provider/credential 下的本地失败关闭与证据完整性。未读取真实 Codex/DeepSeek config/auth、DPAPI、credential-bearing 环境变量或密钥，未调用真实 API、live benchmark 或产生费用；不构成真实路由、OS sandbox 或 production readiness 证据。最终文档字面量审计曾由 PowerShell 意外展开已知的非敏感 `USERPROFILE` runtime locator；没有枚举环境、访问认证数据或把该绝对路径写入仓库。

## 1. 恢复与安全 checkpoint

- 分支：`codex/s6-quality-evidence`
- 恢复基线：`4f20d6b87e682e197d1e94aa19bc17a1e01634f7`
- 恢复时：19 个未提交 S6 WIP 文件（14 modified、5 untracked）；S3–S5 已 PASS，S6 因额度在最终验证前暂停。
- WIP/BLOCKED checkpoint：`afc3dbf`（`wip(s6): checkpoint blocked quality evidence`），已推送到同名远端分支，先保存原始 WIP 与本页/validation log，不把 checkpoint 误记为 PASS。

恢复时 19 文件清单：

```text
M  config/data-contracts.schema.json
M  config/plan-packet.schema.json
M  examples/evidence-bundle.example.json
M  examples/run-report.example.json
M  src/cli.ts
M  src/contracts.ts
M  src/orchestrator.ts
M  src/providers/local.ts
M  src/scope-guard.ts
M  src/types.ts
M  test/contracts.test.ts
M  test/orchestrator.test.ts
M  test/policy.test.ts
M  test/schema-contracts.test.ts
?? config/quality-gate-policy.example.json
?? config/quality-gate-policy.schema.json
?? src/quality-gate.ts
?? test/local.test.ts
?? test/quality-gate.test.ts
```

## 2. 已关闭的恢复阻塞项

1. **symlink snapshot 越界**：snapshot 在读取前验证 lexical/physical containment、敏感路径和文件 identity；tracked/untracked 内容读取后再复核 identity，ignored 项只枚举路径并失败关闭、不读取内容。
2. **缺少脱敏命令诊断**：`tests_run` 保存大小受限、统一脱敏的 `output_summary`，并分别记录 `timed_out`、`output_overflowed`；失败后后续 gate 为 not-run。
3. **baseline-secret diff 不可审查**：baseline finding 按规则/值指纹多重集比较。未变化的既有 finding 不再把 artifact 降为 blocked stub；review diff 保留结构并脱敏值，新增或重复增加仍失败关闭。
4. **`git write-tree` 写共享对象库**：改为只读 index/status/diff/head 证据；Git subprocess 禁用 lazy fetch、optional locks、replace objects、textconv/ext-diff，并拒绝 assume-unchanged、skip-worktree 等非标准 index flags，不向共享 object store 写对象。
5. **raw diff 大小绕过**：先按 raw bytes 检查 16 MiB 上限，再生成脱敏 review bytes；超限只保留 blocked artifact，不允许敏感文本经脱敏收缩绕过。
6. **schema/runtime ceiling 不一致**：policy schema 与运行时统一为 raw diff 16 MiB、artifact/file 4 MiB、command output 1 MiB、总 wall time 30 分钟。
7. **生产 timeout/overflow 缺测**：真实 child-process runner 覆盖 stdout overflow 和 timeout 后的进程树终止；Windows fixture 实测 `taskkill /T /F`，POSIX 路径实现 descendant/process-group 的 TERM→KILL。总 wall deadline 贯穿 capture、checkpoint、Git、命令清理、artifact 与最终 snapshot；报告只保留脱敏摘要。
8. **artifact 竞态**：artifact 使用外置、run-owned、content-addressed 路径；创建/读取均检查 lstat/realpath/open/fstat identity 和 size ceiling，checkpoint 后复核 artifact，consumer 再校验 hash，bundle 持久化前后复核 worktree。final capture 会在写 artifact 前刷新 forbidden/reparse/ignored；晚期 forbidden mutation 只生成 blocked stub。
9. **QualityGateReport 完整性**：报告完整绑定 run/task/base/plan/approval/isolation/worktree/policy/effective-policy，记录 pre/post artifact snapshot、worktree snapshot、artifact 和固定 gate 顺序，并以 `report_hash` 自校验；consumer 拒绝重放、字段替换、gate 缺失或 pass 等式不成立。
10. **usage 0 与 unavailable**：Codex/DeepSeek provider 显式跟踪 usage availability；EvidenceBundle v2 用 `null` 表示不可得，真实零仍保持数值 `0`。Local route evidence 使用独立 local verification 状态，不伪称 provider route。

## 3. EvidenceBundle v2

S1 的 v1 只是未接执行链的合成基线。S6 增加必需的 attempt/route summaries、完整 gate/test diagnostics、scope/privacy/secret 摘要和 nullable usage，因此显式升级为 v2，并同步：

- `src/types.ts` 与 `src/contracts.ts`；
- `config/data-contracts.schema.json` 及兼容入口；
- `examples/evidence-bundle.example.json`、`examples/run-report.example.json` 的规范化 hash；
- Orchestrator legacy bridge 的创建、自校验、持久化与回读。

旧 v1 不被静默当作 v2 接受。完整合同迁移仍属于 S7；当前 bundle 明确标记 `legacy_bridge` provenance，并保留该风险。

## 4. 验证结果

请求的 `npx` 命令在当前 PowerShell 环境不可用（command not found）。没有安装任何软件；使用仓库现有依赖和 Codex bundled Node 的等价入口。Vitest 使用 `--configLoader runner --no-cache`，避免配置 loader 写 `node_modules/.vite-temp`；测试只在系统临时目录创建 synthetic repos。

| 验证 | 结果 |
| --- | --- |
| TypeScript `tsc --noEmit` 等价入口 | PASS，exit 0 |
| 指定 7 文件定向 Vitest | PASS，7/7 files、118/118 tests，exit 0 |
| 全量 Vitest | PASS，19/19 files、323/323 tests，exit 0 |
| production quality runner 专项 | PASS，真实 spawn timeout/overflow、进程树终止、总 wall budget、production Git baseline/no-lazy-fetch 路径均覆盖 |
| `git diff --check` | PASS |

定向范围严格覆盖：`quality-gate`、`local`、`orchestrator`、`contracts`、`schema-contracts`、`scope-guard`、`policy`。全量套件同时回归 S0–S5。

完整 argv 与退出码如下；bundled Node 的用户目录前缀按脱敏政策记为 `<codex-bundled-node.exe>`，没有通过环境变量解析或把用户绝对路径写入证据：

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

## 5. 最终范围、脱敏和用户产物审计

- 从恢复基线 `4f20d6b` 到最终状态累计 36 个 S6 文件（配置/schema/example、S6 production/source、S6 tests、Vitest timeout 配置与治理/证据文档）；无阶段外文件。`vitest.config.ts` 只把测试级超时提高到 15 秒，以容纳 Windows/OneDrive 上既有 orchestrator fixture 的稳定运行，不改变生产 gate timeout。
- diff secret-pattern 扫描未发现真实 private key、AWS key、Bearer、认证文件内容或用户绝对路径；命中均为测试中的 `synthetic-*` 负例或规则/字段名。
- 未读取真实配置、认证、DPAPI、credential-bearing 环境变量或密钥；除上文披露的非敏感 `USERPROFILE` locator 意外展开外，未检查或枚举环境变量。未运行网络/API/费用/benchmark；未安装软件。
- `dist/`、`node_modules/` 无 Git 变化。现有 `node_modules/.vite-temp` 是 2026-08-21 的只读 reparse 目录，本轮 runner 未写入，也未删除或修改。
- 未使用 `git write-tree`、`reset --hard`、stash、force cleanup 或其它破坏性 Git；S7–S10 源码未实现。

## 6. 剩余边界

- approved quality commands 是 trusted project processes，不是低权限 OS sandbox；TODO-03 仍开放。
- secret scan 是高置信度启发式规则，不是通用 DLP；baseline 只用于比较，不把 secret 值写入报告。
- artifact 采用文件身份、大小上限和二次校验收紧 TOCTOU，但不能替代 OS-level handle-relative sandbox；敌对同用户进程的精确 parent swap、硬链接别名和 process breakaway 仍不在证明范围内。
- EvidenceBundle 当前来自 legacy bridge projection；S7 才迁移完整 TaskPackage/EffectivePolicy core 和前台 CLI/MCP/Skill。
- DNS/socket peer、系统代理/TLS、真实 provider header 合同、真实 usage/cost/invoice 均未验证；不可得保持 `null`。

## 7. 阶段门结论

主 Agent 已复核 Agent Team 的三组只读审查、阻塞项对应实现、定向/全量回归、文档与最终审计。S6 离线阶段门判定 **PASS**。S7 具备阶段依赖，但本会话未开始 S7；开始仍需独立范围和当次授权。

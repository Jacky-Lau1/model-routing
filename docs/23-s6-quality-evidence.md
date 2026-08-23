# 23｜S6 Local Quality Gate 与 EvidenceBundle

> 状态：**WIP / BLOCKED（2026-08-23）**。S6 尚未通过阶段门；本文先保存额度中断前的实现基线和待关闭问题。S7–S9 未开始。
>
> 结论边界：当前工作区仅包含离线、synthetic/mock 质量门 WIP。尚未完成最终 TypeScript、定向 Vitest、全量 Vitest、脱敏、diff 范围和用户产物检查，因此不得记录为 PASS，也不构成真实 API、真实路由或 production readiness 证据。

## 1. 恢复基线

- 分支：`codex/s6-quality-evidence`
- HEAD：`4f20d6b87e682e197d1e94aa19bc17a1e01634f7`
- 上一阶段：S3–S5 已 PASS；S6 在最终验证前因 Codex 额度暂停。
- 恢复时工作区：19 个未提交 S6 WIP 文件，其中 14 个已跟踪修改、5 个新增。

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

## 2. 当前 WIP 方向

当前实现已经开始建立以下 S6 能力，但尚未完成阶段门：

- 固定 command ID 与 trusted executable/argv catalog，拒绝模型任意命令字符串；
- 顺序化 base/scope/forbidden path/secret/diff/approved command/final freeze gate；
- 外置、按 run 归属的 content-addressed diff artifact；
- QualityGateReport 到 EvidenceBundle 的 legacy bridge；
- baseline-aware 高置信度 secret finding 计数；
- scope/privacy/gate/test/usage/cost/risk 摘要与 bundle hash。

## 3. 当前阶段门阻塞项

只读恢复审查确认以下问题必须在 S6 内关闭：

1. `snapshotWorkingTree` 可能通过 symlink/reparse 路径读取批准 worktree 之外的目标。
2. approved command 证据缺少大小受限、已脱敏的可诊断摘要。
3. unchanged baseline secret 会使最终 diff artifact 退化为 blocked 占位符，导致通过结果不可审查。
4. `git write-tree` 会向 worktree 共享的 Git object store 写对象；质量门冻结必须改为只读 Git 证据。
5. diff 大小当前按脱敏后的 review bytes 判断，可能被大段敏感文本的压缩脱敏绕过；必须按 raw bytes 失败关闭。
6. `quality-gate-policy.schema.json` 尚未表达运行时的 16 MiB / 4 MiB / 1 MiB ceiling。
7. timeout/overflow 仅由 injected runner 模拟，尚未覆盖 production spawn/kill/output-limit 路径。
8. artifact create/verify 与 worktree/bundle freeze 的竞态证据仍需收紧并补测试。
9. QualityGateReport 缺少完整 request binding/self-integrity，存在重放或字段替换后无法自证的问题。
10. usage 不可得仍会落为数值 `0`，不能与实际零用量区分。

## 4. WIP checkpoint 验证状态

本 checkpoint 只用于防止本地进度丢失：

- 已完成：指定文档、日志、19 文件状态和 WIP diff 的只读基线核对。
- 未作为 checkpoint 前置条件运行：`tsc --noEmit`、定向 Vitest、全量 Vitest。
- 未运行：真实 API、live benchmark、安装、费用操作。
- 未读取：真实 Codex/DeepSeek config/auth、DPAPI、环境变量值或密钥。

## 5. S6 阶段门待办

完成上述修复后必须运行：

```text
npx tsc --noEmit
npx vitest run test/quality-gate.test.ts test/local.test.ts test/orchestrator.test.ts test/contracts.test.ts test/schema-contracts.test.ts test/scope-guard.test.ts test/policy.test.ts
npx vitest run
```

并同步 `README.md`、`ROADMAP.md`、`CHANGELOG.md`、`docs/08-decisions.md`、`docs/11-implementation.md`、`docs/13-continuation-handoff.md`、`docs/16-orchestrator-first-implementation-plan.md`、`docs/17-orchestrator-first-stage-handoffs.md`、本文、decision log 和 validation log；最后执行脱敏、diff 范围和用户产物检查。只有主 Agent 审查全部证据后才能把本页状态改为 PASS。S6 PASS 前禁止开始 S7。

# 25｜S8 GPT 三态 Final Review、单次 Repair 与受控 Apply

> 日期：2026-08-24
> 结论：S8 mock/synthetic 离线阶段门通过；不代表真实 MCP、provider、网络身份或 production readiness 已认证。

## 实施结果

canonical `RouterCoreService` 将三个事实分开持久化：

1. 执行和 Local Quality Gate 完成后是 `REVIEW_PENDING`；
2. foreground GPT `PASS` 后是 `APPLY_PENDING`；
3. 只有显式 controlled apply 成功后才是 `PASSED`。

Final Review 只接受 `PASS`、`REPAIR_REQUIRED`、`BLOCKED`。reviewer 不可用时没有后台 fallback，workflow 保持 `REVIEW_PENDING`，main workspace 不变。final review 始终绑定当前 EvidenceBundle hash；同 bundle 相同 review 幂等，不允许替换已记录决定。

CLI 与 STDIO MCP 现提供八个同核心入口：`prepare`、`execute`、`status`、`abort`、`review_evidence`、`finalize`、`repair`、`apply`。repo skill 只说明调用顺序，不复制安全判断。

## Controlled repair

`REPAIR_REQUIRED` 只允许一次 round 1 `REPAIR` attempt，并继续使用同一 owned isolated worktree。repair 同时核对：

- 当前 REPAIR_REQUIRED review 与 EvidenceBundle；
- 原 compact approval summary；
- TaskPackage、RouteBinding、ExecutionContext、EffectivePolicy 与 ApprovalRecord hash；
- 当前 runtime policy 与 route profile；
- provider、adapter、model、endpoint/protocol/auth、reasoning、预算和所有 capability scopes；
- 当前 worktree 与 reviewed bundle snapshot；
- 当前 read manifest 的每个 content hash 仍在 TaskPackage 与 effective egress authorization 内；
- 累计 model attempt 数和 token usage 不超过原预算。

repair 次数在 provider side effect 前持久化为 1；无论成功、preflight 失败、invalid response 或质量失败，都不会获得第二次 repair。成功后重新运行 Local Quality Gate，生成包含全部 attempt summaries、聚合 usage 和 `repair_count=1` 的新 EvidenceBundle，再回到 `REVIEW_PENDING` 等待新的 GPT review。

provider/model、预算、scope、privacy/policy、外发路径或 content hash 任一变化都不会原地更新旧批准；当前 workflow BLOCKED，必须重新 prepare/approve。

## Controlled apply

PASS 不调用 apply。`router.apply` 是单独显式动作，并在任何主目录写入前依次验证：

- workflow 正处于 `APPLY_PENDING`，PASS review 绑定当前 bundle；
- runtime approval/binding 未变化；
- main repository 与批准时 snapshot 完全一致；
- 初始 dirty path 与 reviewed changed path 不重叠；
- worktree 当前 changed-file set/hash 与 EvidenceBundle 一致；
- bundle quality、scope、privacy 和 secret gates 通过；
- 单一输出文件的 current bytes/hash 与 reviewed postimage 一致；
- 已存在目标的 main bytes/hash 与 TaskPackage full-file context preimage 一致；新文件仍不存在。

apply 使用 S4 同目录 staged、preimage recheck 的原子单文件 patch。成功只留下 main workspace 的未提交 edit；不运行 `git add`、commit、merge、push、stash 或 force operation。APPLIED record 绑定 bundle/diff/target preimage/postimage；相同 bundle 的 duplicate apply 直接返回既有 PASSED，不再次写文件。

## Synthetic/mock 验证

新增 `test/s8-review-repair-apply.test.ts` 六个场景：

- mock GPT reviewer unavailable：保持 REVIEW_PENDING；
- repair success：新 REPAIR attempt、新 validation attempt、新 EvidenceBundle、第二次 PASS 后才 apply；
- repair invalid scope：attempt BLOCKED，main 不变；
- changed approval/scope：发送前 BLOCKED；
- capture 后 main target 变化：apply BLOCKED，保留用户 edit；
- capture 时 target 已 dirty：dirty overlap BLOCKED；成功 apply 的 duplicate 调用幂等。

验证命令使用仓库已有依赖与 Codex bundled Node，Vitest 因桌面运行时单次时限拆分执行：

```text
TypeScript --noEmit: PASS
git diff --check: PASS
S8 tests: 1 file / 6 tests PASS
full split regression: 24 files / 342 tests PASS
```

其中全量按 10 files/86 tests、7 files/166 tests、6 files/55 tests 与 worktree 1 file/35 tests 分组；慢速 worktree 文件再按 25 + 10 场景分段确认。全部只使用 synthetic Git repo、mock reviewer/provider/local gate 和临时 state/worktree roots。

## 未做与剩余风险

- 未注册真实 Codex MCP，未调用真实 GPT reviewer、DeepSeek/OpenAI API 或 live benchmark；
- 未读取真实 config、auth、DPAPI、credential-bearing environment 或 secret；
- 未自动 commit、merge、push 或发布；
- apply 继承 S4 MVP：只支持一个 UTF-8 replacement/create，不支持多文件、rename、delete、binary 或 CRLF；
- filesystem write 成功但 APPLIED record 尚未持久化时若进程崩溃，恢复仍保守 BLOCKED；没有宣称跨文件事务；
- worktree/capability 不是 OS sandbox；DNS/socket peer、proxy/TLS、真实 usage/invoice 仍未验证。

## 阶段门

S8 PASS：未进入显式 controlled apply 前 main workspace 始终不变；一次 repair 不可扩 scope/route/budget/privacy；apply 遇到 snapshot、dirty overlap、preimage 或 evidence mismatch 必定 BLOCKED。S9 可以开始，S10 仍需 S9 通过和单独真实费用授权。

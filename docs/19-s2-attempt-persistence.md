# 19｜S2 Workflow/Attempt 持久化、崩溃恢复与幂等

> 状态：S2 已通过（2026-08-21）。全部验证使用内存 mock provider 和临时状态目录；未联网、未读取 credential、未创建 worktree、未实现 MCP。

## 实现边界

S2 把 Orchestrator-first `WorkflowState` 与单次副作用的 `AttemptState` 分开。S1 的 `AttemptRecord` 字段和 JSON Schema 保持冻结；S2 只增加运行时状态一致性、原子存储、锁和恢复语义。Phase 0 状态保留为 `LegacyWorkflowState`，当前 `RouterOrchestrator` 的所有 provider/local-adapter 调用已接入同一个 durable attempt executor，避免默认 CLI 绕过检查点。

持久化布局（逻辑路径）为：

```text
tasks/<task_id>/workflow.json
tasks/<task_id>/attempts/<attempt_id>.json
tasks/<task_id>/.locks/<approval_hash>/
```

attempt ID 由 `task_id + approval_hash + stage + round` 的规范化 SHA-256 稳定派生。同一审批、阶段和 round 的重复请求只能命中既有 attempt；request fingerprint 不同则冲突失败。repair 必须使用 `round >= 1`，因此产生新 ID，并保留旧记录。

## Attempt 状态转换表

| 当前状态 | 触发条件 | 下一状态 | Workflow 结果 | 是否允许自动发送/重发 |
| --- | --- | --- | --- | --- |
| 无记录 | 取得 task/approval 锁，发送前落盘 | `PREPARED` | 进入当前 provider 阶段 | 否；先完成 checkpoint |
| `PREPARED` | 本地 prepare/preflight 通过，发送即将开始 | `SENDING` | 不变 | 首次发送只在此状态已落盘后发生 |
| `PREPARED` | 可证明没有外部副作用的本地失败 | `FAILED_BEFORE_SEND` | 保持可诊断状态 | 不自动；策略可显式创建新 round |
| `SENDING` | 完整响应、provider/model 基础身份和阶段解析全部验证 | `SUCCEEDED` | 进入该阶段的成功后继 | 否；重复请求返回此 attempt |
| `SENDING` | timeout/reset/stream interruption/response lost | `AMBIGUOUS` | `BLOCKED` | 禁止自动重发 |
| `SENDING` | 进程重启，无法证明请求未执行 | `AMBIGUOUS` | `BLOCKED` | 禁止自动重发 |
| 任一终态 | 重复 approve/execute | 原状态 | 原 workflow/status | 不调用 provider |

`SUCCEEDED` 必须同时具有发送/完成时间、request ID、response model、response origin 和 usage；`FAILED_BEFORE_SEND` 必须没有 `send_started_at`；`AMBIGUOUS` 必须有发送和完成时间及脱敏错误。上述一致性在写盘和回读时都验证。

## Workflow 状态转换表

| 状态 | 正常后继（摘要） | S2 关键规则 |
| --- | --- | --- |
| `CREATED` | `PLANNING` / `AWAITING_APPROVAL` | planning 也必须有 attempt checkpoint |
| `PLANNING` | `AWAITING_APPROVAL` | 完整计划解析后才离开 |
| `AWAITING_APPROVAL` | `APPROVED` / `PLANNING` | 审批绑定 task/route hash 后才能执行 |
| `APPROVED` / `WORKTREE_READY` | `EXECUTING` | task/approval 锁串行化副作用 |
| `EXECUTING` | `VALIDATING` / `REVIEW_PENDING` | attempt 与 workflow 独立持久化 |
| `VALIDATING` | `REVIEW_PENDING` / `REPAIR_REQUIRED` | local adapter 同样使用 checkpoint |
| `REVIEW_PENDING` | `REPAIR_REQUIRED` / `APPLY_PENDING` / `PASSED` | review attempt 不能自报 workflow 已通过 |
| `REPAIR_REQUIRED` | `EXECUTING` / `VALIDATING` | repair 创建新 round，不覆盖历史 |
| 任意有风险的活动状态 | `BLOCKED` | ambiguous provider outcome 必须进入 |
| `PASSED` / `ABORTED` | 无 | 终态不可重新执行 |

## Crash matrix

| 崩溃/中断点 | 磁盘可回读状态 | mock 调用数 | 重启行为 | 风险结论 |
| --- | --- | ---: | --- | --- |
| `PREPARED` 写入前 | 无 attempt；无发送 | 0 | 可重新取得锁并首次准备 | 无外部副作用证据 |
| `PREPARED` 写入后 | `PREPARED` | 0 | duplicate 返回既有 attempt，不自动发送 | 不重复调用 |
| `SENDING` 写入后、调用前 | `SENDING` | 0 | startup recovery 保守改为 `AMBIGUOUS/BLOCKED` | 无法证明真实崩溃点未越过调用边界 |
| provider 已调用、响应丢失 | `AMBIGUOUS` | 1 | duplicate 返回既有 attempt | 禁止自动重发 |
| 完整响应返回、`SUCCEEDED` 写入前 | `SENDING` | 1 | recovery → `AMBIGUOUS/BLOCKED` | 不伪造成功 |
| `SUCCEEDED` 写入后 | `SUCCEEDED` | 1 | duplicate 返回既有 attempt | 不重复调用 |
| 临时文件同步后、rename 前 | 旧完整 JSON 或无目标文件 | 0 | 清理临时文件；不会出现半截 JSON | 本地原子写可安全重试 |
| Windows rename 遇到短暂共享冲突 | 旧完整 JSON | 0 | 只对本地 rename 做有限重试 | 不涉及 provider 重试 |

## 并发与恢复

- lock 粒度是 task + approval hash；跨进程使用原子目录创建。
- 同一幂等键的并发调用可以直接回读 `PREPARED/SENDING/SUCCEEDED/AMBIGUOUS`，不会等待后再发一次。
- 遗留 `SENDING` 只由显式 startup recovery 收敛为 `AMBIGUOUS/BLOCKED`；recovery 代码没有 send 能力。
- 锁目录如果在 attempt 写入前因真实进程死亡而遗留，后续操作失败为 busy，不会猜测清理并发送。这是保守的诊断项，不是自动 stale-lock 回收。

## 脱敏与不持久化内容

统一脱敏会移除 credential-shaped assignment、Bearer/key-shaped token 和用户绝对路径，并截断错误文本。PersistenceError 只暴露逻辑操作，不包含物理路径或底层异常。AttemptRecord 只保存 request ID、模型、逻辑 origin、usage 和脱敏错误；不保存响应正文、raw payload、reasoning 或 stack。旧 `state.json` 也不再长期保存 `result` 原文。

## 阶段门证据与剩余边界

- TypeScript `--noEmit` 通过。
- Vitest 完整离线套件 67/67 通过。
- 覆盖 PREPARED/SENDING/SUCCEEDED 崩溃、并发 approve/execute、全部十种 Stage 的发送异常、pre-send 本地失败、response validation failure、repair 历史、restart recovery、原子写中断和脱敏。
- 所有 provider 均为 mock；真实 API、网络、credential/config/env 值、真实 worktree 和 MCP 均未触碰。

S2 阶段门通过：未发现“磁盘仍待批准而外部副作用已经发生”的可复现路径。S3 可以开始。尚未实现的 endpoint/auth/protocol 强证明属于 S5；worktree 与 capability 边界分别属于 S3/S4；不能据此宣称 exactly-once、production ready 或真实 provider 已验证。

# 20｜S3 Isolated Git Worktree、生命周期与冲突检测

> 状态：S3 已通过（2026-08-21）。全部验证使用系统临时目录中的 synthetic Git repo、mock provider、独立 state root 和 managed worktree root；未联网、未读取真实配置/凭据/环境变量值、未运行 API 或 benchmark。

## 实现边界

S3 只提供变更、验证和后续 apply 的隔离边界：

- 每个批准执行从完整、不可变的 base commit 创建 detached Git worktree；
- 主 workspace 的 dirty 内容只形成 evidence，不自动复制到 worktree；
- EXECUTE、VALIDATE、REVIEW、REPAIR 和 SOL_DIAGNOSIS 使用同一隔离 checkout；
- 完成前重新比较主 workspace snapshot，发生漂移即失败关闭；
- 提供 apply 前 snapshot/路径重叠检查，但不执行 apply；
- router state 与 managed worktree root 默认分别外置于系统临时目录，位于目标 repo/common Git dir 内或彼此重叠时失败关闭；
- worktree 默认保留，cleanup 只处理可证明 owned 且 clean 的 checkout，并用持久化 removal intent 恢复中断。

worktree 共享 Git object store 和 metadata，不是 OS sandbox。read/write/network/environment/command capability 属于 S4；质量门编排属于 S6；真正 apply 属于 S8。

## 实际文件范围

生产代码：

- `src/worktree.ts`：Git inspection、dirty evidence、isolation binding、生命周期、创建/恢复/复用、主目录比较和 ownership-safe cleanup；
- `src/orchestrator.ts`：把批准、WORKTREE_READY 和所有执行后阶段接到隔离 checkout；
- `src/attempt-executor.ts`、`src/attempt-persistence.ts`：持久化 `WORKTREE_READY`、本地失败转换，以及 approval-to-worktree filesystem handoff lock；
- `src/persistence.ts`：默认 state root 外置，避免 Router 元数据改变目标仓库；
- `src/approval.ts`、`src/types.ts`：legacy approval 增加 isolation hash 绑定。

测试：

- `test/worktree.test.ts`：35 个 synthetic Git/worktree 场景；
- `test/orchestrator.test.ts`：12 个 mock workflow 场景，其中包括隔离目录接入、同步重复审批、跨 Router 实例 handoff、auto/approve pre-write root containment、scope 双状态阻断、创建前失败和主目录并发漂移；
- `test/attempt-persistence.test.ts`：filesystem handoff lock 竞争、释放和 synthetic dead-owner 恢复；
- `test/persistence.test.ts`：默认 state root 外置回归；
- `test/policy.test.ts`、`test/state-machine.test.ts`：isolation approval 失效和 WORKTREE_READY 转换。

治理文档与日志：

- `README.md`、`ROADMAP.md`、`CHANGELOG.md`；
- `docs/03-context-and-memory.md`、`docs/08-decisions.md`、`docs/11-implementation.md`、`docs/13-continuation-handoff.md`、`docs/16-orchestrator-first-implementation-plan.md`、`docs/17-orchestrator-first-stage-handoffs.md`、本文；
- `logs/decision-log.md`、`logs/routing-validation-log.md`。

S1 的 `TaskPackage`、`RouteBinding`、`ExecutionContext`、`ApprovalRecord`、`AttemptRecord`、`EvidenceBundle` 字段及 JSON Schema 均未修改。

## 基线与 isolation binding

`captureMainWorkspace()` 只执行参数化的本地 Git inspection，并生成：

```text
repository_id                 SHA-256(common Git dir 的规范化物理身份)
base_commit                  HEAD 的完整 commit object ID
head_ref                     symbolic ref 或 DETACHED
index_hash                   SHA-256(NUL-separated ls-files --stage)
dirty_details[]              status/path/original_path/content_hash
main_workspace_dirty_evidence[]
main_workspace_snapshot      上述基线的规范化 SHA-256
```

dirty status 使用 `git status --porcelain=v1 -z --untracked-files=all`，避免空格和 Unicode 路径被普通行解析破坏。modified、added、untracked 和 rename destination 的 `content_hash` 是当前工作文件原始字节 SHA-256；deleted 为 `null`。冻结的 S1 wire evidence 没有 rename source 字段，因此 wire projection 记录 destination 为 `renamed`，内部 `dirty_details` 和 snapshot 仍绑定 original path。

legacy isolation binding 绑定：

```text
run_id
worktree_id
repository_id
base_commit
main_workspace_snapshot
main_workspace_dirty_evidence
plan_hash
isolation_hash
```

`worktree_id` 由 run、repo、base、snapshot 和 plan hash 派生。legacy approval 与 S2 execution approval hash 都包含 `isolation_hash`；base、snapshot、dirty evidence、plan 或逻辑 worktree ID 变化都会失效。S7 切换新 core 后应使用真实 `ExecutionContext.execution_context_hash`，不得长期复制两套合同。

## 创建与生命周期

逻辑状态：

```text
PREPARING → READY → RETAINED → REMOVING → REMOVED
     └────────────→ BLOCKED
```

顺序：

1. 验证 non-bare repo、完整 commit、外置且互不重叠的 state/managed roots，以及 capture 后 snapshot 未漂移；
2. 在 Git 副作用前原子保存 `PREPARING`；
3. 在 manager-owned parent 写不含物理路径的 `owner.json`；
4. 运行 `git worktree add --detach <owned-checkout> <full-commit>`；
5. 验证 parent/checkout 不是 symlink/junction、owner hash、common Git dir、linked `.git`、checkout root、完整 HEAD、detached 状态和初始 clean status；
6. 再次验证主 workspace snapshot；
7. 原子保存 `READY`，才允许 workflow 进入 `WORKTREE_READY → EXECUTING`；
8. 正常完成保存 `RETAINED`，不自动删除诊断区。

生命周期记录只保存逻辑 ID、hash、状态和脱敏原因，不保存 main/worktree 绝对路径或 Git stderr。物理 checkout 路径始终由 manager-owned root 和安全 `worktree_id` 推导。

## 创建中断与恢复

| 中断点 | 持久状态/磁盘 | 重入行为 | 结论 |
| --- | --- | --- | --- |
| `PREPARING` 后、创建前 | `PREPARING`；无 checkout | 重新验证 binding/snapshot 后首次创建 | 不产生重复 registration |
| Git add 后、`READY` 前 | `PREPARING`；可能已有 linked checkout | owner/common-dir/base/path 全匹配且 checkout clean、detached 才收敛为 `READY` | dirty、attached 或证据不足即 `BLOCKED` 并保留 |
| `READY` 写入后 | `READY`；checkout 已验证 | 同 binding 返回同一 checkout | 不创建第二个 worktree |
| 预期 checkout 是普通残留目录 | `PREPARING/BLOCKED`；sentinel 保留 | 不覆盖、不认领、不递归删除 | 失败关闭 |

同一 state root/approval 的 handoff 使用 filesystem lock，owner 记录绑定 approval、PID、nonce 和时间；锁覆盖 bind/prepare/recovery、durable `WORKTREE_READY` 与 legacy `EXECUTING` 持久化。live owner 存在时重复调用直接返回既有 legacy 状态，不进入 prepare、不阻断活动 workflow；dead PID 的残留锁仅在 owner 与路径完全匹配时原子移入 quarantine、删除并重取，ownerless empty active lock 也先原子隔离后回收。release 先校验归属并原子 rename active target 到唯一 release quarantine，active 路径消失后才清理 owner/空目录；碰撞方在 target 消失时重试，不把正常交接竞态记为任务失败。`GitWorktreeManager` 内另按 state root/worktree ID 串行 prepare，使同进程直接调用也只保留一条 linked registration。S3 测试使用 checkpoint interruption 模拟进程边界；真实断电、PID 极端复用、OneDrive/杀毒软件长期锁的运维体验仍需后续验证。

## 主 workspace 与 apply 前冲突

S3 把 Orchestrator 直接执行的 Git 操作和传给内置 adapter 的 cwd/root 限定为：主 workspace 只做 Git inspection，executor、validation 和 review 使用 isolated checkout。synthetic mock 遵守该 root 时，用户文件、index、HEAD/ref 和 status 相对初始基线零增量，worktree 中的同名源码修改和 `dist/` 产物不会出现在 fixture 主目录。S4 capability 尚未实现，因此 S3 不能阻止一个拥有任意文件系统能力的恶意或失控 executor 自行越过传入 root。

`assertMainWorkspaceUnchanged()` 对 capture 后任意 snapshot 漂移失败关闭。`assertApplyPreconditions()` 还比较初始 dirty 路径与 worktree changed path；rename 的 source/destination 都参加内部重叠判断。该 primitive 只报告冲突，不复制 patch、不覆盖用户文件、不 commit/merge，真正 apply 仍属于 S8。

## cleanup ownership

cleanup 默认不自动运行。显式 cleanup 必须同时满足：

- lifecycle 为 `READY` 或 `RETAINED`；
- 目标是 manager-owned root 的直接子目录；
- parent 和 checkout 不是 symlink/junction；
- owner record、run/worktree/repository/base/isolation hash 全匹配；
- checkout 与 main 共享预期 common Git dir；
- checkout HEAD 仍是批准 base，且 status clean。

满足后先原子持久化 `REMOVING`，再调用非 force `git worktree remove`；owner 证据保留到 `REMOVED` 已持久化，最后才删除单个 owner record 和空 parent。`REMOVING`、Git 已删除和 `REMOVED` 后 sidecar 尚存三个中断点都能按 owner/registration/path 证据幂等收敛。dirty checkout、unknown run、partial directory、owner 篡改、跨 repo 或 junction 替换全部保留并失败关闭。实现不调用 `reset --hard`、stash、worktree prune、force remove、Git clean 或递归删除未证明归属的路径。

## 零费用测试结果

最终命令：

```text
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec vitest run
```

结果：TypeScript 通过；Vitest 13/13 files、116/116 tests 通过。S3 覆盖：

- clean、modified、staged added、untracked、deleted、renamed、空格/Unicode path；
- dirty evidence 原始字节 hash 和禁止 overlay；
- 完整 commit、移动/删除辅助 ref、非法/不存在/短 base；
- PREPARING、GIT_ADDED、READY 三个创建 checkpoint interruption，以及 dirty/attached residual checkout 拒绝恢复；
- REMOVING、GIT_REMOVED、REMOVED 三个 cleanup checkpoint interruption；
- duplicate/concurrent prepare 和 barrier 同步起跑的 duplicate approve；
- 两个独立 Router 实例共享 state root 时的 handoff 竞争，以及 synthetic dead-owner、ownerless release crash 和 release/contender 精确交错恢复；
- 默认外置 state root，以及 auto 首次 planning write 和 approve 首次 load/lock/write 前对 repo 内/重叠/外部 junction alias isolation roots 的拒绝；
- READY handoff 前的 tracked 与 ignored residual output 拒绝恢复；
- executor/validation/review cwd 隔离和 worktree `dist/`；
- 初始 dirty 重叠、capture 后 main 并发变化；
- partial/unknown/dirty/owner tamper/junction cleanup；
- workflow 创建失败时 provider send 为零，scope violation 时 legacy/durable 状态同时 BLOCKED；
- S0–S2 全部回归。

所有 provider 都是内存 mock；Git repo、state 和 worktree root 都在临时 fixture 内。没有真实 API、live benchmark、安装、真实 credential/config/auth/DPAPI/env 值或用户仓库 worktree。

## 未测试项与剩余风险

- 没有执行真实进程 kill、断电、磁盘损坏或长期文件锁；checkpoint interruption 只验证确定性恢复分支。
- filesystem handoff lock 以两个独立 Router 实例和 synthetic dead PID 验证；没有实际启动第二个 OS 进程或模拟 PID 复用。
- 没有验证 SHA-256 object-format repo、submodule 工作流、case-only rename、极长路径或网络文件系统；不支持的文件类型/状态应失败关闭。
- cleanup 故意拒绝 dirty worktree；人工诊断和后续显式清理体验仍需运维设计。
- planning adapter 仍属于 legacy 主路径；S3 只保证执行及其后阶段的工作目录隔离。
- capability adapter、最小环境、secret path、任意 shell/network 防护尚未实现，属于 S4。
- route identity、完整 quality gate/EvidenceBundle、MCP、三态 final review 和 apply 分别属于 S5–S8。

## 阶段门

S3 PASS：当前 Orchestrator 传给 executor 与 validation/review/repair 的 cwd/root 都是隔离 checkout，synthetic mock 的用户文件写入和生成物只发生在该 checkout；主 workspace Git-visible 用户状态相对批准基线不变，漂移时 BLOCKED；worktree 生命周期和 cleanup 对无法证明归属的目标失败关闭。S4 可以开始，但 S3 不能阻止拥有任意文件系统能力的 executor 越界，不得据此声称 Safe Executor、真实路由或 production readiness 已完成。

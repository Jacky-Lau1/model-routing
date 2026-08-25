# Part 3｜日常能力硬化与发布闭环 Prompt

```text
继续项目：

G:\OneDrive\个人文档\个人AI\模型路由开发

执行“三部分 Agent Team 闭环计划”的 Part 3：稳定化、能力扩展和最终发布验收。

【当前进度交接（2026-08-25，主 agent 已核对，直接采信勿重做）】
- Part 1 已全部 PASS 并提交（远程 `origin/codex/router-three-part-closure` = `b16ea05`）。Part 2 尚未执行；本 prompt 供 Part 2 给出 `recommendation=expand` 且 30% 降费达标后使用。
- 本机环境坑（跨会话持续，详见 `~/.workbuddy/MEMORY.md`，勿重复诊断）：
  1. Windows 非管理员 + 开发者模式未开启 → file/dir symlink 不可用，测 reparse 越界用 **junction**（免权限）。
  2. OneDrive 会实时回退 `.git` refs → 提交用 `git commit-tree` + `git push <commit>:refs/heads/<branch>` 直接推远程，不依赖本地分支指针。
  3. push credential 多值链（`helper-selector` → GCM 弹窗挂起）→ askpass 脚本输出 `gh auth token` + `GIT_CONFIG_NOSYSTEM=1` + `HOME=<空目录>` + `GIT_ASKPASS` + URL 带 username。
  4. 测试慢（git worktree 15–45s/用例），vitest 120s，bash 长跑 300s+ 或后台。
  5. http.proxy = `127.0.0.1:7890`。
- 真实副作用（写真实 config、credential、真实 provider 请求、apply、commit/push）仍需当次、逐项、带 exact hash 授权。

仅当 Part 2 recommendation=expand，且可审计数据显示 Hybrid 总成本相对 GPT-only 下降至少 30% 时开始；否则立即报告 BLOCKED。

先读取 Part 1/2 交接、paired Pilot reports、EvidenceBundle/成本证据、当前支持范围、SECURITY、安装/恢复/卸载文档和 Git status/diff。

请作为主 agent 组织 agent team：
- Agent A：多文件事务、apply、crash recovery、状态机；
- Agent B：Windows filesystem/process/network 安全和 fault injection；
- Agent C：安装/升级/卸载、运维文档、release matrix 和验收；
- 主 agent：共享核心、架构整合、真实验收、成本回归和 release verdict。

先划定文件所有权。共享状态机、contracts、router-core 和主文档由主 agent 串行修改。真实配置、credential、provider 请求、apply 和用户项目写入只能由主 agent 串行执行，并遵守 exact approval。

一、确定正式支持范围
支持 bounded UTF-8 text、多文件 create/update/delete/rename、LF/CRLF 保留、public、仅经 explicit provider/path/content-hash/expiry egress 的 private、isolated worktree 和 explicit apply。

拒绝 secret-restricted 第三方外发、未声明路径、binary、超大文件和无法可靠验证的编码/filesystem 语义。拒绝必须返回明确状态和原因，不能崩溃或隐式降级。

二、多文件事务和恢复
实现 typed operation list、逐文件 preimage/postimage、transaction hash、staging、write-ahead intent、crash checkpoints、rollback/recovery、final snapshot，以及 filesystem write 成功但 APPLIED checkpoint 未写入时的恢复。create/update/delete/rename 使用独立 schema，并保护 apply conflict 和用户并发修改。

三、Windows 与数据安全
覆盖 traversal、ADS/device/UNC、symlink/junction/reparse/hardlink、case collision、Unicode normalization、OneDrive placeholder、target replacement race、repo/common Git dir 越界、low-privilege helper、Job Object/process-tree、filesystem capability、provider-only network allowlist、最小 child environment、private egress hash/expiry/provider binding、secret scan 和最小 prompt。

无法从应用层证明的 OS、DNS、proxy、TLS 或 peer 边界必须明确列为限制，不能伪造保证。

四、fault injection
至少执行 100 次，覆盖每个持久化 checkpoint crash、concurrent/duplicate、timeout/reset/lost response、config/state corruption、disk full、permission denied、interrupted cleanup、apply conflict、stale approval/pricing、provider unavailable 和 restart recovery。

要求：无未捕获异常、无重复 paid send、所有失败进入可恢复状态、用户内容不被覆盖、main workspace 不被部分写入、诊断信息不泄密。

五、release-candidate 验收
从 clean checkout 和全新外置 state root 验证 install → restart → discovery → doctor → prepare → approval → execute → visible/hidden gate → Final Review → optional repair → explicit apply → Pilot report → cleanup → uninstall/rollback。

连续完成至少 10 个支持范围内任务，并包含 clean main、unrelated dirty main、expected BLOCKED、provider unavailable、stale pricing、missing credential、process restart、interrupted cleanup、apply conflict 和 config rollback。

重新运行 typecheck、schema/examples、全量单测、fault tests、build、临时安装矩阵、真实 smoke 回归和 paired cost regression。

最终 READY 条件：
- 支持范围内连续验收通过；
- 无未捕获 crash、静默 provider fallback、重复付费请求或主目录污染；
- scope/privacy/routing/secret=0；
- 所有错误有明确状态、原因和恢复动作；
- 用户不需手工编辑状态文件；
- doctor 能定位常见问题；
- install/upgrade/recovery/uninstall 可重复；
- acceptance 不低于 GPT-only；
- Hybrid 总可审计成本下降仍至少 30%；
- 当前 MCP、模型、endpoint 和价格兼容性已复核；
- 无 P0/P1 安全或数据完整性问题。

如果 telemetry 缺失、成本报告无法验证、下降不足 30%、存在污染/重复请求/路由不明/不可恢复状态，release verdict 必须 BLOCKED。

最终输出 agent team 产出、正式支持/拒绝矩阵、fault 汇总、连续任务结果、安装/升级/恢复/卸载证据、质量和成本回归、未解决风险、READY|READY_WITH_LIMITATIONS|BLOCKED、修改文件、Git status 和拟提交拆分。
```
